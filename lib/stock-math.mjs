/**
 * Единственный источник истины для арифметики остатков FBS.
 *
 * Правила, которые этот модуль гарантирует (ТЗ, п. 3 и 9):
 *  - отправляемый остаток целый и не отрицательный;
 *  - отправляемый остаток никогда не превышает остаток по ОСВ;
 *  - количество складов не влияет на величину остатка;
 *  - резерв маркетплейса не может увеличить отправляемое значение выше ОСВ.
 *
 * Модуль намеренно написан на чистом JS без зависимостей: его импортируют
 * и рантайм Worker'а (через lib/stock-math.ts), и юнит-тесты `node --test`.
 */

/** @typedef {"wildberries" | "ozon"} MarketplaceId */

/**
 * @typedef {object} StockBasis
 * @property {number} osvQty          остаток по последней загруженной ОСВ
 * @property {number} reserveQty      активный резерв по заказам WB и Ozon вместе
 * @property {number} safetyStock     страховой запас
 * @property {boolean} [manualZero]   позиция принудительно обнулена администратором
 */

/** Приводит любое значение к целому неотрицательному числу. */
export function toWholeQty(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * Доступный остаток по формуле ТЗ: MAX(0; ОСВ − резерв − страховой запас).
 * Результат всегда целый и всегда не больше остатка по ОСВ.
 *
 * @param {StockBasis} basis
 * @returns {number}
 */
export function computeAvailable(basis) {
  const osv = toWholeQty(basis?.osvQty);
  if (basis?.manualZero) return 0;
  const reserve = toWholeQty(basis?.reserveQty);
  const safety = toWholeQty(basis?.safetyStock);
  const available = osv - reserve - safety;
  if (available <= 0) return 0;
  return Math.min(available, osv);
}

/**
 * Значение для PUT /api/v3/stocks/{warehouseId} Wildberries.
 * WB принимает свободный остаток — отправляем расчёт как есть.
 *
 * @param {StockBasis} basis
 * @returns {number}
 */
export function wildberriesAmount(basis) {
  return computeAvailable(basis);
}

/**
 * Значение для POST /v2/products/stocks Ozon.
 *
 * У Ozon поле `stock` — это ОБЩЕЕ количество на складе, свободным Ozon считает
 * `stock − reserved`. Поэтому, чтобы свободным осталось ровно наше «доступно»,
 * к расчёту нужно вернуть резерв. Возвращаем строго ту часть резерва, которую
 * мы сами вычли: min(reserved_ozon, наш_резерв). Это даёт два свойства сразу —
 * при совпадении учётов Ozon увидит ровно `available`, а при расхождении
 * (резерв Ozon больше нашего) результат уедет в безопасную сторону вниз и
 * НИКОГДА не превысит ОСВ. Именно неограниченное `available + reserved_ozon`
 * приводило к отправке 102 штук при остатке 1.
 *
 * @param {StockBasis} basis
 * @param {number} remoteReserved значение `reserved`, которое вернул Ozon по паре товар–склад
 * @returns {number}
 */
export function ozonTotalStock(basis, remoteReserved) {
  const available = computeAvailable(basis);
  if (basis?.manualZero) return 0;
  const osv = toWholeQty(basis?.osvQty);
  const ourReserve = toWholeQty(basis?.reserveQty);
  const theirReserve = toWholeQty(remoteReserved);
  const addBack = Math.min(ourReserve, theirReserve);
  return Math.min(available + addBack, osv);
}

/** Ошибка гарда: синхронизация обязана остановиться, ничего не отправив. */
export class StockGuardError extends Error {
  /** @param {object} row */
  constructor(row) {
    const where = [row?.article, row?.size].filter(Boolean).join(" / ") || row?.externalSku || "неизвестный товар";
    super(
      `Расчёт остатка не прошёл проверку: ${where}, склад ${row?.warehouseId ?? "?"}. ` +
      `ОСВ ${row?.osvQty}, резерв ${row?.reserveQty}, рассчитано ${row?.computedQty}, к отправке ${row?.sentQty}.`,
    );
    this.name = "StockGuardError";
    /** @type {object} */
    this.row = row ?? {};
  }
}

/**
 * Обязательная проверка перед КАЖДЫМ запросом к маркетплейсу (ТЗ, п. 9).
 * Бросает StockGuardError — вызывающий код обязан остановить синхронизацию
 * целиком, записать строку в журнал и показать ошибку администратору.
 *
 * @param {object} row
 * @returns {number} проверенное значение
 */
export function assertSendable(row) {
  const osv = toWholeQty(row?.osvQty);
  const sent = Number(row?.sentQty);
  if (!Number.isInteger(sent) || sent < 0 || sent > osv) throw new StockGuardError(row);
  return sent;
}

/**
 * Собирает строку для журнала и проверяет её гардом за один шаг.
 * Возвращает объект, готовый и для отправки, и для записи в stock_sync_log.
 *
 * @param {object} input
 * @returns {object}
 */
export function buildSendableRow(input) {
  const basis = {
    osvQty: input.osvQty,
    reserveQty: input.reserveQty,
    safetyStock: input.safetyStock,
    manualZero: input.manualZero,
  };
  const computedQty = computeAvailable(basis);
  const sentQty = input.marketplaceId === "ozon"
    ? ozonTotalStock(basis, input.remoteReserved)
    : wildberriesAmount(basis);
  const row = {
    marketplaceId: input.marketplaceId,
    warehouseId: String(input.warehouseId),
    productSku: input.productSku ?? null,
    externalSku: String(input.externalSku),
    article: input.article ?? null,
    size: input.size ?? null,
    osvQty: toWholeQty(input.osvQty),
    reserveQty: toWholeQty(input.reserveQty),
    computedQty,
    sentQty,
  };
  assertSendable(row);
  return row;
}
