import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_DELAY_MS,
  MAX_SLEEP_MS,
  backoffDelay,
  exceedsBudget,
  isRetryableStatus,
  pace,
  parseRetryAfter,
  resetPacing,
  retryAfterFromHeaders,
  withRetry,
} from "../lib/http-retry.mjs";

test("повторяем только временные ошибки", () => {
  for (const status of [429, 408, 425, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} должен повторяться`);
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} повторять нельзя`);
  }
});

test("Retry-After читается и числом секунд, и HTTP-датой", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("  "), null);
  assert.equal(parseRetryAfter("не число"), null);

  const now = Date.parse("2026-08-31T12:00:00Z");
  assert.equal(parseRetryAfter("Mon, 31 Aug 2026 12:00:20 GMT", now), 20_000);
  // Дата в прошлом не даёт отрицательной паузы.
  assert.equal(parseRetryAfter("Mon, 31 Aug 2026 11:59:00 GMT", now), 0);
});

test("пауза растёт экспоненциально и упирается в потолок", () => {
  const noJitter = () => 0;
  assert.equal(backoffDelay(1, null, noJitter), BASE_DELAY_MS);
  assert.equal(backoffDelay(2, null, noJitter), BASE_DELAY_MS * 2);
  assert.equal(backoffDelay(3, null, noJitter), BASE_DELAY_MS * 4);
  assert.equal(backoffDelay(10, null, noJitter), MAX_SLEEP_MS);
});

test("подсказка Retry-After важнее экспоненты", () => {
  assert.equal(backoffDelay(1, 5_000, () => 0), 5_000);
  assert.equal(backoffDelay(3, 1_000, () => 0), 1_000);
  // Слишком долгая пауза обрезается потолком.
  assert.equal(backoffDelay(1, 600_000, () => 0), MAX_SLEEP_MS);
});

test("слишком долгое ожидание отдаётся наверх, а не удерживает запрос", () => {
  assert.equal(exceedsBudget(MAX_SLEEP_MS + 1), true);
  assert.equal(exceedsBudget(1_000), false);
  assert.equal(exceedsBudget(null), false);
});

test("успех со второй попытки возвращает значение", async () => {
  const waits = [];
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls === 1) return { retry: true, status: 429, retryAfterMs: 2_000 };
    return { retry: false, value: "ok" };
  }, { wait: async (ms) => { waits.push(ms); }, random: () => 0 });

  assert.equal(value, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});

test("после исчерпания попыток отдаётся последняя ошибка", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      return { retry: true, status: 503, error: new Error("Ozon недоступен") };
    }, { maxAttempts: 3, wait: async () => {}, random: () => 0 }),
    /Ozon недоступен/,
  );
  assert.equal(calls, 3);
});

test("долгий Retry-After прекращает попытки и сообщает точное время", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      return { retry: true, status: 429, retryAfterMs: 90_000, error: new Error("Лимит частоты") };
    }, { wait: async () => {}, random: () => 0 }),
    (error) => error.retryAfterSeconds === 90,
  );
  // Ждать полторы минуты внутри запроса нельзя — повторяет клиент.
  assert.equal(calls, 1);
});

test("непроходная ошибка пробрасывается сразу, без повторов", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new Error("401: ключ отклонён");
    }, { wait: async () => {} }),
    /401/,
  );
  assert.equal(calls, 1);
});

test("время до повтора читается из всех известных заголовков WB и Ozon", () => {
  const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

  assert.equal(retryAfterFromHeaders(headers({ "retry-after": "5" })), 5_000);
  // Wildberries отдаёт собственные заголовки вместо стандартного Retry-After.
  assert.equal(retryAfterFromHeaders(headers({ "x-ratelimit-retry": "7" })), 7_000);
  assert.equal(retryAfterFromHeaders(headers({ "x-ratelimit-retry-after": "9" })), 9_000);
  assert.equal(retryAfterFromHeaders(headers({ "x-ratelimit-reset": "11" })), 11_000);
  // Стандартный заголовок имеет приоритет.
  assert.equal(retryAfterFromHeaders(headers({ "retry-after": "2", "x-ratelimit-retry": "30" })), 2_000);
  assert.equal(retryAfterFromHeaders(headers({})), null);
  assert.equal(retryAfterFromHeaders(null), null);
});

test("ограничитель частоты выдерживает минимальный интервал", async () => {
  resetPacing();
  const waits = [];
  let clock = 0;
  const wait = async (ms) => { waits.push(ms); clock += ms; };
  const now = () => clock;

  await pace("wb", 220, wait, now);   // первый запрос идёт сразу
  await pace("wb", 220, wait, now);   // второй ждёт полный интервал
  clock += 100;
  await pace("wb", 220, wait, now);   // прошло 100 мс — ждём остаток
  await pace("ozon", 220, wait, now); // другая площадка считается отдельно

  assert.deepEqual(waits, [220, 120]);
  resetPacing();
});
