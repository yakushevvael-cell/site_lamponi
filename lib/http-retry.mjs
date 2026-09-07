/**
 * Повторы запросов к маркетплейсам (ТЗ, п. 9).
 *
 * Раньше 429 и временные сбои просто прерывали операцию: часть складов
 * оставалась с новыми остатками, часть — со старыми. Здесь повтор делается
 * по правилам самой площадки: если пришёл `Retry-After`, ждём именно столько,
 * иначе — экспоненциальная пауза с джиттером.
 *
 * Дублирования повтор не создаёт: и WB, и Ozon принимают АБСОЛЮТНОЕ значение
 * остатка, а не приращение, поэтому повторная отправка того же пакета приводит
 * к тому же состоянию. Защита от повторной отправки уже подтверждённого пакета
 * живёт уровнем выше — в состоянии задания синхронизации
 * (`completedWarehouseIds` и `processedMappings`).
 *
 * Чистый JS без зависимостей: модуль импортируют и рантайм, и юнит-тесты.
 */

/** Ждать дольше — значит упереться в лимит времени запроса Worker'а. */
export const MAX_SLEEP_MS = 12_000;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const BASE_DELAY_MS = 700;

/** Коды, при которых повтор имеет смысл: лимит частоты и временные сбои. */
export function isRetryableStatus(status) {
  return status === 429 || status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Разбирает заголовок `Retry-After`: и число секунд, и HTTP-дату.
 * @returns {number|null} миллисекунды ожидания
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Пауза перед попыткой номер `attempt` (начиная с 1).
 * @param {number} attempt
 * @param {number|null} retryAfterMs подсказка площадки
 * @param {() => number} random
 */
export function backoffDelay(attempt, retryAfterMs, random = Math.random) {
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    return Math.min(Math.max(0, retryAfterMs), MAX_SLEEP_MS);
  }
  const exponential = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = exponential * 0.25 * random();
  return Math.min(Math.round(exponential + jitter), MAX_SLEEP_MS);
}

/**
 * Признак «ждать дольше, чем разумно в рамках одного запроса».
 * Такую паузу отдаём наверх как retryAfterSeconds, чтобы шаг повторил клиент,
 * а не блокировал Worker.
 */
export function exceedsBudget(retryAfterMs) {
  return retryAfterMs !== null && retryAfterMs !== undefined && retryAfterMs > MAX_SLEEP_MS;
}

/**
 * Заголовки, из которых площадки сообщают время до повтора.
 *
 * Wildberries отдаёт собственные заголовки семейства `X-Ratelimit-*`, причём в
 * разных источниках встречаются разные имена, а стандартный `Retry-After` есть
 * не всегда. Поэтому читаем все известные варианты и берём первый непустой —
 * это дешевле и надёжнее, чем угадывать одно имя.
 */
export const RETRY_AFTER_HEADERS = [
  "retry-after",
  "x-ratelimit-retry",
  "x-ratelimit-retry-after",
  "x-ratelimit-reset",
];

/**
 * @param {{ get: (name: string) => string | null }} headers
 * @returns {number|null} миллисекунды ожидания
 */
export function retryAfterFromHeaders(headers, now = Date.now()) {
  if (!headers || typeof headers.get !== "function") return null;
  for (const name of RETRY_AFTER_HEADERS) {
    const parsed = parseRetryAfter(headers.get(name), now);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Минимальный интервал между запросами к одной площадке.
 *
 * У Wildberries лимит устроен как token bucket с рекомендованной паузой 200 мс:
 * соблюдая её, мы почти не попадаем в 429, а не лечим его повторами постфактум.
 */
const lastRequestAt = new Map();

export async function pace(key, minIntervalMs, wait = sleep, now = () => Date.now()) {
  if (!minIntervalMs) return;
  const previous = lastRequestAt.get(key);
  // Первый запрос к площадке уходит без задержки: ждать нам ещё нечего.
  if (previous === undefined) {
    lastRequestAt.set(key, now());
    return;
  }
  const elapsed = now() - previous;
  if (elapsed < minIntervalMs) await wait(minIntervalMs - elapsed);
  lastRequestAt.set(key, now());
}

/** Только для тестов: сбрасывает состояние ограничителя частоты. */
export function resetPacing() {
  lastRequestAt.clear();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Выполняет `attempt()` с повторами.
 *
 * `attempt()` должен вернуть `{ retry: false, value }` при успехе либо
 * `{ retry: true, status, retryAfterMs, error }`, если повтор уместен.
 *
 * @template T
 * @param {(attemptNumber: number) => Promise<{retry: boolean, value?: T, status?: number, retryAfterMs?: number|null, error?: Error}>} attempt
 * @param {{maxAttempts?: number, random?: () => number, wait?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(attempt, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const random = options.random ?? Math.random;
  const wait = options.wait ?? sleep;

  let lastError = null;
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const outcome = await attempt(attemptNumber);
    if (!outcome.retry) return outcome.value;

    lastError = outcome.error ?? new Error(`Запрос не выполнен (${outcome.status ?? "?"}).`);
    const retryAfterMs = outcome.retryAfterMs ?? null;
    const isLast = attemptNumber === maxAttempts;

    // Площадка просит подождать дольше, чем можно внутри одного запроса —
    // отдаём ошибку наверх с точным временем, шаг повторит клиент.
    if (exceedsBudget(retryAfterMs)) {
      lastError.retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
      throw lastError;
    }
    if (isLast) break;

    await wait(backoffDelay(attemptNumber, retryAfterMs, random));
  }

  throw lastError ?? new Error("Запрос не выполнен.");
}
