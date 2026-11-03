import assert from "node:assert/strict";
import test from "node:test";

import {
  nextPendingStockRunAt,
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
