/**
 * Сведение данных площадок в суммы по дням.
 *
 * Живёт в .mjs, чтобы логику без сборки проверяли юнит-тесты
 * (`node --test tests/daily-finance.test.mjs`). Приложение импортирует
 * типизированную обёртку lib/daily-finance.ts.
 */

const MOSCOW_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * День операции.
 *
 * Площадки отдают дату по-разному: Wildberries — местное московское время без
 * пояса («2026-09-01T12:33:00»), Ozon — с поясом. Строку без пояса нельзя
 * передавать в `new Date`: сервер прочитает её как UTC, и вечерние операции
 * уедут на сутки назад. Поэтому такие строки просто обрезаются до даты, а
 * строки с поясом переводятся в московское время.
 *
 * @param {string} value
 * @returns {string} дата в формате ГГГГ-ММ-ДД
 */
export function marketplaceDay(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const hasZone = /(Z|z|[+-]\d{2}:?\d{2})$/.test(text);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) && !hasZone) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  return MOSCOW_DATE.format(parsed);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Выкупы и возвраты                                                    */
/* ------------------------------------------------------------------ */

function buyoutBucket(map, date) {
  const existing = map.get(date);
  if (existing) return existing;
  const created = {
    date,
    buyoutAmount: 0,
    buyoutCount: 0,
    buyoutUnits: 0,
    returnAmount: 0,
    returnCount: 0,
    postings: new Set(),
  };
  map.set(date, created);
  return created;
}

function finalizeBuyouts(map) {
  return [...map.values()]
    .map(({ postings, ...row }) => ({
      ...row,
      buyoutCount: postings.size > 0 ? postings.size : row.buyoutCount,
      buyoutAmount: round(row.buyoutAmount),
      buyoutUnits: round(row.buyoutUnits),
      returnAmount: round(row.returnAmount),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Разбор справочника начислений Ozon.
 *
 * Начисление привязано к типу числом, а расшифровка типов лежит в отдельном
 * методе и у разных продавцов набор различается. Поэтому типы разбираем по
 * названию, а не по зашитым идентификаторам.
 */
export function classifyOzonAccrualTypes(types) {
  // \w в JS не покрывает кириллицу, поэтому окончания слов ловим через \S.
  const FEE = /комисс|услуг|логистик|штраф|хранен|обработ|эквайр|реклам|подписк|утилиз|возмещ/;
  const REFUND = /возврат|сторно|отмен/;
  const SALE = /достав\S* покупател|продаж|реализац|выкуп/;
  const sale = [];
  const refund = [];
  for (const type of types ?? []) {
    if (!type?.id) continue;
    const text = `${type?.name ?? ""} ${type?.description ?? ""}`.toLowerCase();
    // Комиссии и услуги — не движение товара, в суммы дашборда они не входят.
    if (FEE.test(text)) continue;
    if (REFUND.test(text)) refund.push(type.id);
    else if (SALE.test(text)) sale.push(type.id);
  }
  return { sale, refund };
}

/**
 * Начисления Ozon → суммы выкупов и возвратов по дням.
 *
 * Берётся seller_price — цена, которую установил продавец. Если справочник
 * типов ничего не подсказал, за продажу считаем любое начисление с
 * положительной ценой, за возврат — с отрицательной: так метод продолжает
 * работать, даже когда Ozon переименует типы.
 */
export function aggregateOzonAccruals(accruals, classification) {
  const saleTypes = new Set(classification?.sale ?? []);
  const refundTypes = new Set(classification?.refund ?? []);
  const map = new Map();

  for (const accrual of accruals ?? []) {
    const price = Number(accrual?.sellerPrice);
    if (!Number.isFinite(price) || price === 0) continue;
    const quantity = Math.max(1, Number(accrual?.quantity) || 1);
    const amount = Math.abs(price) * quantity;
    const isRefund = refundTypes.has(accrual.typeId) || price < 0;
    const isSale = !isRefund && (saleTypes.has(accrual.typeId) || saleTypes.size === 0);
    if (!isRefund && !isSale) continue;

    const bucket = buyoutBucket(map, marketplaceDay(accrual.accrualDate));
    if (isRefund) {
      bucket.returnAmount += amount;
      bucket.returnCount += 1;
      continue;
    }
    bucket.buyoutAmount += amount;
    bucket.buyoutUnits += quantity;
    if (accrual.postingNumber) bucket.postings.add(accrual.postingNumber);
    else bucket.buyoutCount += 1;
  }

  return finalizeBuyouts(map);
}

/**
 * Отчёт «Продажи» Wildberries → суммы выкупов и возвратов по дням.
 *
 * Берётся priceWithDisc — цена с учётом скидки продавца, то есть та цена,
 * которую установил продавец (в finishedPrice учтена ещё и скидка WB).
 * Тип строки определяется по первой букве saleID: S — продажа, R — возврат,
 * D — доплата. Сторнированные строки площадка присылает заново, поэтому их
 * учитывать нельзя.
 */
export function aggregateWildberriesSales(sales) {
  const map = new Map();
  for (const sale of sales ?? []) {
    if (Number(sale.IsStorno ?? sale.isStorno ?? 0) === 1) continue;
    const kind = String(sale.saleID ?? "").trim().charAt(0).toUpperCase();
    if (kind !== "S" && kind !== "R" && kind !== "D") continue;
    const price = Number(sale.priceWithDisc ?? sale.finishedPrice ?? sale.totalPrice ?? 0);
    if (!Number.isFinite(price) || price === 0) continue;
    const bucket = buyoutBucket(map, marketplaceDay(sale.date));
    if (kind === "R") {
      bucket.returnAmount += Math.abs(price);
      bucket.returnCount += 1;
      continue;
    }
    bucket.buyoutAmount += Math.abs(price);
    bucket.buyoutCount += 1;
    // Доплата (D) — деньги без нового товара, штуки по ней не растут.
    if (kind === "S") bucket.buyoutUnits += 1;
  }
  return finalizeBuyouts(map);
}

/* ------------------------------------------------------------------ */
/* Заказы                                                               */
/* ------------------------------------------------------------------ */

function orderBucket(map, date) {
  const existing = map.get(date);
  if (existing) return existing;
  const created = {
    date,
    orderedAmount: 0,
    orderedNetAmount: 0,
    canceledAmount: 0,
    orderedCount: 0,
    orderedUnits: 0,
    keys: new Set(),
  };
  map.set(date, created);
  return created;
}

function finalizeOrders(map) {
  return [...map.values()]
    .map(({ keys, ...row }) => ({
      ...row,
      orderedCount: keys.size > 0 ? keys.size : row.orderedCount,
      orderedAmount: round(row.orderedAmount),
      orderedNetAmount: round(row.orderedNetAmount),
      canceledAmount: round(row.canceledAmount),
      orderedUnits: round(row.orderedUnits),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Отчёт «Заказы» Wildberries → суммы заказов по дням.
 *
 * Строка отчёта — одна единица товара. Заказы считаем по номеру заказа
 * (gNumber): в одном заказе может быть несколько строк.
 */
export function aggregateWildberriesStatOrders(orders) {
  const map = new Map();
  for (const order of orders ?? []) {
    const price = Number(order?.priceWithDisc ?? order?.finishedPrice ?? order?.totalPrice ?? 0);
    if (!Number.isFinite(price) || price === 0) continue;
    const bucket = orderBucket(map, marketplaceDay(order.date));
    const key = order.gNumber || order.srid;
    if (key) bucket.keys.add(String(key));
    else bucket.orderedCount += 1;
    bucket.orderedAmount += price;
    bucket.orderedUnits += 1;
    if (order.isCancel) bucket.canceledAmount += price;
    else bucket.orderedNetAmount += price;
  }
  return finalizeOrders(map);
}

/**
 * Отправления Ozon (FBS и FBO) → суммы заказов по дням.
 *
 * На вход — уже разобранные отправления: день заказа, сумма по цене продавца,
 * количество единиц и признак отмены.
 */
export function aggregateOzonOrderPostings(postings) {
  const map = new Map();
  for (const posting of postings ?? []) {
    const amount = Number(posting?.amount);
    if (!Number.isFinite(amount)) continue;
    const bucket = orderBucket(map, marketplaceDay(posting.orderedAt));
    if (posting.postingNumber) bucket.keys.add(String(posting.postingNumber));
    else bucket.orderedCount += 1;
    bucket.orderedAmount += amount;
    bucket.orderedUnits += Math.max(0, Number(posting.units) || 0);
    if (posting.canceled) bucket.canceledAmount += amount;
    else bucket.orderedNetAmount += amount;
  }
  return finalizeOrders(map);
}
