import assert from "node:assert/strict";
import test from "node:test";

import {
  advancePendingStockDrain,
  nextPendingStockRunAt,
  partitionPendingStockSkus,
  PENDING_STOCK_BATCH_LIMIT,
  PENDING_STOCK_INTERVAL_MINUTES,
  PENDING_STOCK_POLL_SECONDS,
  summarizePendingMarketplaces,
} from "../lib/stock-pending-core.mjs";

test("очередь работает пакетами по 300, раз в 5 минут, индикатор — каждые 45 секунд", () => {
  assert.equal(PENDING_STOCK_BATCH_LIMIT, 300);
  assert.equal(PENDING_STOCK_INTERVAL_MINUTES, 5);
  assert.equal(PENDING_STOCK_POLL_SECONDS, 45);
});

test("следующий запуск — ближайшая следующая пятиминутная граница", () => {
  assert.equal(nextPendingStockRunAt(new Date("2026-11-03T11:46:12.000Z")), "2026-11-03T11:50:00.000Z");
  assert.equal(nextPendingStockRunAt(new Date("2026-11-03T11:50:00.000Z")), "2026-11-03T11:55:00.000Z");
});

test("ошибка одного склада показывает ошибку всей площадки отдельно", () => {
  const statuses = summarizePendingMarketplaces([
    { marketplaceId: "wildberries", syncStatus: "ok", syncError: null, lastStockSyncAt: "2026-11-03 11:45:00" },
    { marketplaceId: "ozon", syncStatus: "ok", syncError: null, lastStockSyncAt: "2026-11-03 11:45:01" },
    { marketplaceId: "ozon", syncStatus: "error", syncError: "Ozon ограничил частоту запросов", lastStockSyncAt: "2026-11-03 11:40:00" },
  ]);

  assert.deepEqual(statuses, [
    { marketplaceId: "wildberries", status: "ok", error: null, lastStockSyncAt: "2026-11-03 11:45:00" },
    { marketplaceId: "ozon", status: "error", error: "Ozon ограничил частоту запросов", lastStockSyncAt: "2026-11-03 11:45:01" },
    { marketplaceId: "yandex", status: "inactive", error: null, lastStockSyncAt: null },
  ]);
});

test("включённый, но ещё не синхронизированный склад имеет нейтральный статус", () => {
  const statuses = summarizePendingMarketplaces([
    { marketplaceId: "yandex", syncStatus: "never", syncError: null, lastStockSyncAt: null },
  ]);
  assert.equal(statuses.find((item) => item.marketplaceId === "yandex")?.status, "waiting");
});

test("одна ошибка Ozon не удерживает остальные позиции пакета", () => {
  const sourceSkus = Array.from({ length: 300 }, (_, index) => `sku-${index + 1}`);
  const result = partitionPendingStockSkus(sourceSkus, ["sku-17"]);
  assert.equal(result.completed.length, 299);
  assert.deepEqual(result.retrying, ["sku-17"]);
  assert.equal(result.completed.includes("sku-17"), false);
});

test("ошибочные SKU откладываются, а проход продолжается по остальной очереди", () => {
  const first = advancePendingStockDrain({}, { selected: 300, cleared: 299, retrying: 1, pendingLeft: 1197 });
  assert.equal(first.shouldContinue, true);
  assert.equal(first.nextLimit, 300);
  assert.equal(first.deferredRetrying, 1);

  const penultimate = advancePendingStockDrain(first, { selected: 300, cleared: 300, retrying: 0, pendingLeft: 297 });
  assert.equal(penultimate.nextLimit, 296);
  assert.equal(penultimate.onlyErrorsLeft, false);

  const last = advancePendingStockDrain(penultimate, { selected: 296, cleared: 296, retrying: 0, pendingLeft: 1 });
  assert.equal(last.shouldContinue, false);
  assert.equal(last.onlyErrorsLeft, true);
  assert.equal(last.deferredRetrying, 1);
});

test("даже полностью ошибочный первый пакет не блокирует следующие пакеты", () => {
  const first = advancePendingStockDrain({}, { selected: 300, cleared: 0, retrying: 300, pendingLeft: 1496 });
  assert.equal(first.shouldContinue, true);
  assert.equal(first.readyLeft, 1196);
  assert.equal(first.nextLimit, 300);

  const last = advancePendingStockDrain(first, { selected: 296, cleared: 296, retrying: 0, pendingLeft: 300 });
  assert.equal(last.onlyErrorsLeft, true);
  assert.equal(last.nextLimit, 0);
});
