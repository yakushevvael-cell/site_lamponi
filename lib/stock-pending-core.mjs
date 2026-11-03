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
 * Делит выбранный пакет на завершённые позиции и те, которые надо повторить.
 * Порядок исходного пакета сохраняется, повторы и посторонние SKU отбрасываются.
 */
export function partitionPendingStockSkus(sourceSkus, retrySkus) {
  const retry = new Set(Array.isArray(retrySkus) ? retrySkus : []);
  const unique = [...new Set(Array.isArray(sourceSkus) ? sourceSkus.filter((sku) => typeof sku === "string" && sku.length > 0) : [])];
  return {
    completed: unique.filter((sku) => !retry.has(sku)),
    retrying: unique.filter((sku) => retry.has(sku)),
  };
}

/**
 * Состояние одного прохода по очереди. Ошибочные позиции API переносит в хвост
 * текущего прохода; `nextLimit` не даёт выбрать их повторно раньше следующего
 * пятиминутного запуска и тем самым соблюдает ограничение Ozon на повтор SKU.
 */
export function advancePendingStockDrain(state, batch) {
  const previous = state && typeof state === "object" ? state : {};
  const current = batch && typeof batch === "object" ? batch : {};
  const totalSelected = Math.max(0, Number(previous.totalSelected) || 0) + Math.max(0, Number(current.selected) || 0);
  const totalCleared = Math.max(0, Number(previous.totalCleared) || 0) + Math.max(0, Number(current.cleared) || 0);
  const deferredRetrying = Math.max(0, Number(previous.deferredRetrying) || 0) + Math.max(0, Number(current.retrying) || 0);
  const pendingLeft = Math.max(0, Number(current.pendingLeft) || 0);
  const readyLeft = Math.max(0, pendingLeft - deferredRetrying);
  return {
    totalSelected,
    totalCleared,
    deferredRetrying,
    pendingLeft,
    readyLeft,
    nextLimit: Math.min(PENDING_STOCK_BATCH_LIMIT, readyLeft),
    complete: pendingLeft === 0,
    onlyErrorsLeft: pendingLeft > 0 && readyLeft === 0,
    shouldContinue: readyLeft > 0,
  };
}

/**
 * Сводит статусы включённых складов к одной строке на площадку.
 * Ошибка хотя бы одного склада важнее успешного ответа остальных и поэтому
 * показывается отдельно. При этом успешные SKU уже снимаются с очереди, а
 * ошибочные остаются на следующий пятиминутный запуск.
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
