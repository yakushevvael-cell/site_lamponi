/**
 * Клиентский раннер полной синхронизации остатков.
 *
 * На этом хостинге объявлены только биндинги D1 и R2 (`.openai/hosting.json`):
 * ни Queues, ни Durable Objects, ни Cron Triggers недоступны, поэтому фоновой
 * задачи на сервере быть не может — Worker живёт только внутри HTTP-запроса.
 * Цикл ведёт браузер, а сервер хранит состояние задания в таблице `settings`,
 * так что каждый шаг идемпотентен и прерванный запуск можно продолжить.
 *
 * Один и тот же раннер используют кнопка «Синхронизировать остатки», загрузка
 * ОСВ и автоподхват незавершённого запуска — чтобы поведение везде совпадало.
 */

export type SyncWarehouse = { externalId: string; name: string };

export type FullSyncStart = {
  jobId: string;
  osvUploadId: number | null;
  wildberries: { warehouses: SyncWarehouse[]; mappingCount: number };
  ozon: { warehouses: SyncWarehouse[]; mappingCount: number; batchSize: number };
};

export type FullSyncStep = {
  ok?: boolean;
  retry?: boolean;
  retryAfterSeconds?: number;
  nextOffset?: number;
  done?: boolean;
  sent?: number;
  error?: string;
};

export type FullSyncSummary = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  wildberries: { mappingCount: number; warehouseCount: number; completedWarehouseCount: number; sent: number; failures: Array<{ scope: string; message: string }> };
  ozon: { mappingCount: number; warehouseCount: number; processedMappings: number; sent: number; skippedMappings: number; reserveDrift?: number; failures: Array<{ scope: string; message: string }> };
};

export type SyncRunnerOptions = {
  onProgress?: (message: string) => void;
  /**
   * Подтверждение массового обнуления. Сервер отказывается стартовать, если
   * расчёт даёт ноль больше чем по половине позиций: это почти всегда признак
   * неполных данных, а не реального отсутствия товара.
   */
  confirmMassZero?: boolean;
  /** Вызывается, когда сервер потребовал подтверждения. Верните true, чтобы продолжить. */
  onMassZero?: (info: { zeroCount: number; totalCount: number; message: string }) => Promise<boolean> | boolean;
  /** Максимум ожиданий по просьбе площадки на один шаг. */
  maxRetriesPerStep?: number;
  signal?: AbortSignal;
};

const MAX_RETRIES_PER_STEP = 5;
const MAX_WAIT_SECONDS = 120;

function wait(seconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(seconds, MAX_WAIT_SECONDS) * 1000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Синхронизация остановлена."));
    }, { once: true });
  });
}

async function request<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T & FullSyncStep> {
  const response = await fetch("/api/stocks/sync-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => ({})) as T & FullSyncStep & {
    error?: string;
    needsMassZeroConfirmation?: boolean;
    zeroCount?: number;
    totalCount?: number;
  };
  if (response.status === 429 && typeof data.retryAfterSeconds === "number") return data;
  if (response.status === 409 && data.needsMassZeroConfirmation) return data;
  if (!response.ok && response.status !== 207) throw new Error(data.error ?? "Шаг синхронизации не выполнен.");
  return data;
}

/**
 * Выполняет шаг, повторяя его, пока площадка просит подождать.
 * Повтор безопасен: сервер не сдвигает прогресс задания при ответе 429.
 */
async function stepWithRetry<T>(
  body: Record<string, unknown>,
  options: SyncRunnerOptions,
  describe: string,
): Promise<T & FullSyncStep> {
  const limit = options.maxRetriesPerStep ?? MAX_RETRIES_PER_STEP;
  for (let attempt = 0; attempt <= limit; attempt += 1) {
    const result = await request<T>(body, options.signal);
    if (!result.retry) return result;
    if (attempt === limit) throw new Error(result.error ?? "Площадка ограничила частоту запросов.");
    const seconds = Math.max(1, Number(result.retryAfterSeconds) || 5);
    options.onProgress?.(`${describe}: площадка просит подождать ${seconds} с…`);
    await wait(seconds, options.signal);
  }
  throw new Error("Шаг синхронизации не выполнен.");
}

export async function runFullStockSync(options: SyncRunnerOptions = {}): Promise<FullSyncSummary> {
  const { onProgress } = options;
  onProgress?.("Подготавливаем синхронизацию…");

  // Старт тоже может получить 429 (например, антидребезг после недавнего
  // запуска) — ждём указанное время и повторяем, а не падаем.
  let plan = await stepWithRetry<FullSyncStart>(
    { action: "start", confirmMassZero: options.confirmMassZero === true },
    options,
    "Старт",
  );

  // Сервер потребовал подтверждения массового обнуления — спрашиваем человека.
  const massZero = plan as unknown as { needsMassZeroConfirmation?: boolean; zeroCount?: number; totalCount?: number; error?: string };
  if (massZero.needsMassZeroConfirmation) {
    const approved = options.onMassZero
      ? await options.onMassZero({
        zeroCount: Number(massZero.zeroCount ?? 0),
        totalCount: Number(massZero.totalCount ?? 0),
        message: massZero.error ?? "Расчёт даёт ноль по большинству позиций.",
      })
      : false;
    if (!approved) throw new Error(massZero.error ?? "Синхронизация не запущена: расчёт даёт ноль по большинству позиций.");
    plan = await stepWithRetry<FullSyncStart>({ action: "start", confirmMassZero: true }, options, "Старт");
  }

  const jobId = plan.jobId;
  if (!jobId) throw new Error("Сервер не выдал идентификатор синхронизации.");
  let finished = false;

  try {
    if (plan.wildberries.mappingCount > 0) {
      for (let index = 0; index < plan.wildberries.warehouses.length; index += 1) {
        const warehouse = plan.wildberries.warehouses[index];
        onProgress?.(`Wildberries: склад ${index + 1} из ${plan.wildberries.warehouses.length} — ${warehouse.name}`);
        await stepWithRetry({ action: "wildberries", jobId, warehouseId: warehouse.externalId }, options, "Wildberries");
      }
    }

    let offset = 0;
    while (plan.ozon.warehouses.length > 0 && plan.ozon.mappingCount > 0 && offset < plan.ozon.mappingCount) {
      const to = Math.min(offset + plan.ozon.batchSize, plan.ozon.mappingCount);
      onProgress?.(`Ozon: товары ${Math.min(offset + 1, plan.ozon.mappingCount)}–${to} из ${plan.ozon.mappingCount}`);
      const step = await stepWithRetry<FullSyncStep>({ action: "ozon", jobId, offset }, options, "Ozon");
      const nextOffset = Number(step.nextOffset);
      if (step.done && nextOffset === offset) break;
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) throw new Error("Ozon не вернул следующий пакет синхронизации.");
      offset = nextOffset;
      if (step.done) break;
    }

    onProgress?.("Формируем итог синхронизации…");
    const summary = await request<FullSyncSummary>({ action: "finish", jobId }, options.signal);
    finished = true;
    return summary;
  } catch (error) {
    if (jobId && !finished) {
      await fetch("/api/stocks/sync-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", jobId }),
      }).catch(() => undefined);
    }
    throw error;
  }
}

export type SyncState = {
  running: boolean;
  jobId: string | null;
  startedAt: string | null;
  ownedByMe: boolean;
  stale: boolean;
  lastResult: FullSyncSummary | null;
};

/** Состояние задания: используется для автоподхвата незавершённого запуска. */
export async function readSyncState(): Promise<SyncState | null> {
  const response = await fetch("/api/stocks/sync-all", { cache: "no-store" });
  if (!response.ok) return null;
  return await response.json() as SyncState;
}

export function describeSummary(summary: FullSyncSummary) {
  const parts = [
    `WB: ${summary.wildberries.completedWarehouseCount} из ${summary.wildberries.warehouseCount} складов`,
    `Ozon: ${summary.ozon.processedMappings} из ${summary.ozon.mappingCount} товаров`,
  ];
  if (summary.ozon.reserveDrift) {
    parts.push(`расхождение резерва по ${summary.ozon.reserveDrift} позициям — проверьте загрузку заказов`);
  }
  return `${parts.join("; ")}.`;
}
