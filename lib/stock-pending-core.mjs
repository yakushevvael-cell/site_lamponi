/**
 * Общие правила короткой доотправки остатков.
 *
 * Модуль без зависимостей: его используют API, интерфейс и unit-тесты. Саму
 * отправку он не запускает и данные не меняет.
 */

export const PENDING_STOCK_BATCH_LIMIT = 300;
export const PENDING_STOCK_INTERVAL_MINUTES = 5;
export const PENDING_STOCK_POLL_SECONDS = 45;

const MARKETPLACES = ["wildberries", "ozon", "yandex"];

/** Ближайшая пятиминутная граница после указанного момента. */
export function nextPendingStockRunAt(now = Date.now()) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  const safeNow = Number.isFinite(value) ? value : Date.now();
  const interval = PENDING_STOCK_INTERVAL_MINUTES * 60_000;
  return new Date(Math.floor(safeNow / interval) * interval + interval).toISOString();
}

/**
 * Сводит статусы включённых складов к одной строке на площадку.
 * Ошибка хотя бы одного склада важнее успешного ответа остальных: очередь
 * снимается только тогда, когда весь пакет приняли все площадки.
 */
export function summarizePendingMarketplaces(rows) {
  return MARKETPLACES.map((marketplaceId) => {
    const warehouses = rows.filter((row) => row.marketplaceId === marketplaceId);
    if (warehouses.length === 0) {
      return { marketplaceId, status: "inactive", error: null, lastStockSyncAt: null };
    }

    const failed = warehouses.find((row) => row.syncStatus === "error");
    const lastStockSyncAt = warehouses
      .map((row) => row.lastStockSyncAt)
      .filter((value) => typeof value === "string" && value.length > 0)
      .sort()
      .at(-1) ?? null;
    if (failed) {
      return {
        marketplaceId,
        status: "error",
        error: failed.syncError || "Площадка не приняла остатки. Проверьте журнал выгрузки.",
        lastStockSyncAt,
      };
    }

    const waiting = warehouses.some((row) => row.syncStatus !== "ok");
    return {
      marketplaceId,
      status: waiting ? "waiting" : "ok",
      error: null,
      lastStockSyncAt,
    };
  });
}
