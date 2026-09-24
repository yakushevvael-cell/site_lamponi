/**
 * Отгрузки FBS: когда заказ передан площадке и какие заказы застряли.
 *
 * «Отгружен» — заказ перешёл на этап «доставляется»: на Ozon это статус
 * delivering и всё, что после него; на Wildberries — сборочное задание в
 * статусе complete («в доставке») или дальше по пути к покупателю. До этого
 * товар физически у нас: собирается, упаковывается или ждёт передачи.
 *
 * Яндекс Маркет работает по модели DBS, но для склада разницы нет: пока заказ
 * в PROCESSING, он у нас; передан курьеру Яндекс Доставки — значит отгружен.
 *
 * Чистые правила без базы и сети — их проверяют тесты.
 */
import { YANDEX_AFTER_HANDOVER, parseYandexStatus } from "./yandex-core.mjs";

/** Ozon: статусы, в которых отправление ещё не передано в доставку. */
export const OZON_BEFORE_DELIVERY = new Set([
  "awaiting_registration",
  "acceptance_in_progress",
  "awaiting_approve",
  "awaiting_verification",
  "awaiting_packaging",
  "awaiting_deliver",
]);

const OZON_CANCELLED = new Set(["cancelled", "canceled"]);

/** WB: этапы после передачи в доставку по статусу Wildberries. */
const WB_DELIVERY_STATUSES = new Set(["sorted", "sold", "ready_for_pickup", "postponed_delivery"]);

/**
 * Передан ли заказ в доставку.
 *
 * @param {string} marketplaceId
 * @param {string} status для WB — «supplierStatus/wbStatus», для Ozon — статус отправления
 */
export function isHandedOver(marketplaceId, status) {
  const value = String(status ?? "");
  if (marketplaceId === "ozon") {
    return Boolean(value) && value !== "unknown" && !OZON_BEFORE_DELIVERY.has(value) && !OZON_CANCELLED.has(value);
  }
  if (marketplaceId === "wildberries") {
    const [supplier = "", wb = ""] = value.split("/");
    if (supplier === "cancel") return false;
    return supplier === "complete" || WB_DELIVERY_STATUSES.has(wb);
  }
  if (marketplaceId === "yandex") {
    return YANDEX_AFTER_HANDOVER.has(parseYandexStatus(value).status);
  }
  return false;
}

/** Ждёт ли заказ передачи в доставку — ещё не отгружен и не отменён. */
export function isAwaitingHandover(marketplaceId, status) {
  const value = String(status ?? "");
  if (marketplaceId === "ozon") return OZON_BEFORE_DELIVERY.has(value);
  if (marketplaceId === "wildberries") {
    const [supplier = "", wb = ""] = value.split("/");
    if (supplier === "cancel" || /cancel|declined|defect/.test(wb)) return false;
    return (supplier === "new" || supplier === "confirm") && !WB_DELIVERY_STATUSES.has(wb);
  }
  if (marketplaceId === "yandex") {
    // Заказ ждёт отгрузки всё время, пока он в обработке: и «отдан на сборку»,
    // и «готов к отгрузке» — это товар, который ещё стоит на нашем складе.
    return parseYandexStatus(value).status === "PROCESSING";
  }
  return false;
}

/** День по Москве, ГГГГ-ММ-ДД. */
export function moscowDay(value) {
  const time = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return null;
  return new Date(time + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Отгрузки по дням и площадкам. Дни без отгрузок — нули: линия графика не
 * должна перепрыгивать через пустой день.
 *
 * @param {Array<{ marketplaceId: string, handedOverAt: string | null }>} rows
 * @param {{ days: number, now?: number, marketplaces: string[] }} options
 * @returns {Array<Record<string, string | number>>}
 */
export function shipmentsByDay(rows, options) {
  const now = options.now ?? Date.now();
  const days = Math.max(1, Math.trunc(options.days));
  const series = [];
  const index = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = moscowDay(now - offset * 86_400_000);
    if (!date || index.has(date)) continue;
    const row = { date };
    for (const id of options.marketplaces) row[id] = 0;
    index.set(date, row);
    series.push(row);
  }
  for (const order of rows ?? []) {
    const date = moscowDay(order.handedOverAt);
    const row = date ? index.get(date) : null;
    if (!row || !(order.marketplaceId in row)) continue;
    row[order.marketplaceId] = Number(row[order.marketplaceId]) + 1;
  }
  return series;
}

/**
 * Заказы, которые ждут передачи в доставку дольше порога (по умолчанию 40 ч).
 *
 * @param {Array<{ marketplaceId: string, status: string, orderedAt: string, canceledAt: string | null, handedOverAt: string | null, units: number }>} rows
 * @param {{ marketplaces: string[], now?: number, thresholdHours?: number }} options
 */
export function overdueHandover(rows, options) {
  const now = options.now ?? Date.now();
  const threshold = (options.thresholdHours ?? 40) * 3_600_000;
  const result = Object.fromEntries(options.marketplaces.map((id) => [id, { orders: 0, units: 0, oldestHours: null }]));
  for (const order of rows ?? []) {
    const bucket = result[order.marketplaceId];
    if (!bucket || order.canceledAt || order.handedOverAt) continue;
    if (!isAwaitingHandover(order.marketplaceId, order.status)) continue;
    const ordered = Date.parse(order.orderedAt);
    if (!Number.isFinite(ordered)) continue;
    const age = now - ordered;
    if (age <= threshold) continue;
    bucket.orders += 1;
    bucket.units += Math.max(1, Number(order.units) || 1);
    const hours = Math.floor(age / 3_600_000);
    bucket.oldestHours = bucket.oldestHours === null ? hours : Math.max(bucket.oldestHours, hours);
  }
  return result;
}
