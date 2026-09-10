/**
 * Сведение финансовых данных площадок в суммы по дням.
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

function bucketFor(map, date) {
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

function round(value) {
  return Math.round(value * 100) / 100;
}

function finalize(map) {
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

/** Продажа со склада продавца: свои схемы учитываем, FBO и трансграничку — нет. */
function isSellerSchema(schema) {
  const normalized = String(schema ?? "").trim().toUpperCase();
  return normalized === "" || normalized.startsWith("FBS") || normalized.startsWith("RFBS");
}

/**
 * Финансовые операции Ozon → суммы выкупов и возвратов по дням.
 *
 * Берётся `accruals_for_sale` — стоимость товаров по цене продавца. Продажа
 * приходит положительной суммой, возврат и сторно доставки — отрицательной.
 */
export function aggregateOzonOperations(operations) {
  const map = new Map();
  for (const operation of operations ?? []) {
    if (operation.group !== "orders" && operation.group !== "returns") continue;
    if (!isSellerSchema(operation.deliverySchema)) continue;
    const amount = Number(operation.accrualsForSale);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const bucket = bucketFor(map, marketplaceDay(operation.operationDate));
    if (amount > 0) {
      bucket.buyoutAmount += amount;
      bucket.buyoutUnits += Math.max(1, Number(operation.itemCount) || 1);
      if (operation.postingNumber) bucket.postings.add(operation.postingNumber);
      else bucket.buyoutCount += 1;
    } else {
      bucket.returnAmount += -amount;
      bucket.returnCount += 1;
    }
  }
  return finalize(map);
}

/**
 * Отчёт «Продажи» Wildberries → суммы выкупов и возвратов по дням.
 *
 * Берётся `priceWithDisc` — цена с учётом скидки продавца, то есть та цена,
 * которую установил продавец (в `finishedPrice` учтена ещё и скидка WB).
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
    const bucket = bucketFor(map, marketplaceDay(sale.date));
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
  return finalize(map);
}
