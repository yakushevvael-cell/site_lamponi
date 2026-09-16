/**
 * Цены на золото и серебро с ProFinance — чистые правила разбора.
 *
 * Страница https://www.profinance.ru/gold-rub/ показывает таблицу «Расчётные
 * цены на драгоценные металлы в рублях за 1 грамм». Строки заполняет скрипт
 * страницы, поэтому их читает настоящий браузер (scripts/fetch-metal-prices.mjs),
 * а здесь — только разбор текста ячеек и проверка на здравый смысл. Без сети и
 * базы, чтобы правила покрывались тестами.
 */

export const METAL_SOURCE_URL = "https://www.profinance.ru/gold-rub/";

/** Разумные границы цены за грамм в рублях: всё, что за ними, — сбой разбора. */
export const METAL_BOUNDS = {
  gold: { min: 1_000, max: 200_000 },
  silver: { min: 10, max: 5_000 },
};

/** «11 787.37», «11 787,37», «−148.64», «1.28%» → число. */
export function parseQuoteNumber(value) {
  const text = String(value ?? "")
    .replace(/[\s  ]/g, "")
    .replace(/[−–]/g, "-")
    .replace("%", "")
    .replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * Строка таблицы → котировка.
 * Порядок столбцов на ProFinance: Type, Bid, Ask, Last, Diff*, Chg., Chg.%, Time.
 *
 * @param {string[]} cells
 * @returns {{ last: number, bid: number | null, ask: number | null, change: number | null, changePercent: number | null, time: string | null } | null}
 */
export function parseQuoteRow(cells) {
  if (!Array.isArray(cells) || cells.length < 4) return null;
  const last = parseQuoteNumber(cells[3]);
  if (last === null) return null;
  const time = String(cells[7] ?? "").trim();
  return {
    last,
    bid: parseQuoteNumber(cells[1]),
    ask: parseQuoteNumber(cells[2]),
    change: parseQuoteNumber(cells[5]),
    changePercent: parseQuoteNumber(cells[6]),
    time: /^\d{1,2}:\d{2}(:\d{2})?$/.test(time) ? time : null,
  };
}

/**
 * Все строки таблиц страницы → золото и серебро за грамм в рублях.
 * Ошибка разбора не подменяется нулём: лучше показать прошлое значение с
 * пометкой, чем неверную цену.
 *
 * @param {string[][]} rows ячейки каждой строки таблиц на странице
 */
export function extractMetalPrices(rows) {
  const find = (ticker) => (rows ?? []).find((cells) => String(cells?.[0] ?? "").replace(/\s/g, "").toUpperCase() === ticker);
  const goldRow = find("XAU/RUB");
  const silverRow = find("XAG/RUB");
  const gold = goldRow ? parseQuoteRow(goldRow) : null;
  const silver = silverRow ? parseQuoteRow(silverRow) : null;

  const problems = [];
  if (!gold) problems.push("не найдена строка XAU/RUB с ценой");
  else if (gold.last < METAL_BOUNDS.gold.min || gold.last > METAL_BOUNDS.gold.max) problems.push(`цена золота вне границ: ${gold.last}`);
  if (!silver) problems.push("не найдена строка XAG/RUB с ценой");
  else if (silver.last < METAL_BOUNDS.silver.min || silver.last > METAL_BOUNDS.silver.max) problems.push(`цена серебра вне границ: ${silver.last}`);

  return problems.length > 0 ? { ok: false, error: problems.join("; ") } : { ok: true, gold, silver };
}
