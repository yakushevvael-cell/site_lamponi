/**
 * Кратность позиции: перевод остатка из единиц 1С в единицы площадки.
 *
 * Серьги в 1С лежат штуками, а на Wildberries и Ozon продаются парой: остаток
 * «10 штук» — это 5 товаров для покупателя. Без пересчёта на площадки уходило
 * вдвое больше, чем есть, и заказы приходили на то, чего физически нет.
 *
 * Коэффициент хранится у товара (products.units_per_item) и задаётся вручную на
 * странице «Остатки». По умолчанию 1 — то есть для всего остального
 * ассортимента ничего не меняется.
 *
 * Округление всегда вниз: половина пары — не пара.
 *
 * Важно: делится ТОЛЬКО остаток из ОСВ. Резерв приходит из заказов площадки и
 * уже измеряется в её единицах, страховой запас задаётся человеком там же —
 * их пересчитывать нельзя, иначе остаток уедет в другую сторону.
 */

/** Остаток ОСВ в единицах площадки. Требует, чтобы таблица products была под алиасом p. */
export const OSV_UNITS_SQL =
  "CAST(p.current_physical_qty / MAX(COALESCE(p.units_per_item, 1), 1) AS INTEGER)";

/** То же самое без алиаса — для запросов, где products идёт без сокращения. */
export const OSV_UNITS_SQL_BARE =
  "CAST(current_physical_qty / MAX(COALESCE(units_per_item, 1), 1) AS INTEGER)";

export const MIN_UNITS_PER_ITEM = 1;
export const MAX_UNITS_PER_ITEM = 100;

/** Приводит введённое пользователем значение к допустимому целому. */
export function normalizeUnitsPerItem(value: unknown) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_UNITS_PER_ITEM || parsed > MAX_UNITS_PER_ITEM) return null;
  return parsed;
}
