/**
 * Правила формирования заданий на сборку — без базы и без сети.
 *
 * Вынесено отдельным файлом, чтобы нумерацию, деление на партии и маршрут по
 * ячейкам можно было проверять тестами (tests/warehouse-core.test.mjs), а не
 * на живом складе.
 */
import { normalizeSizeValue } from "./upd-parse-core.mjs";

/** Код площадки в номере задания. */
export const MARKETPLACE_PREFIX = {
  ozon: "OZ",
  wildberries: "WB",
};

export const DEFAULT_OZON_BATCH_SIZE = 30;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 500;

/** Ozon: сколько отправлений в партии. Настройка интерфейса, не константа кода. */
export function normalizeBatchSize(value, fallback = DEFAULT_OZON_BATCH_SIZE) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.trunc(parsed);
  if (whole < MIN_BATCH_SIZE) return MIN_BATCH_SIZE;
  if (whole > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return whole;
}

/**
 * Имя склада в номере задания: 2026-09-14-WB-КАЗАНЬ.
 * Русские буквы остаются как есть — номер читает человек на листе подбора.
 */
export function warehouseSlug(name, limit = 24) {
  const cleaned = String(name ?? "")
    .toUpperCase()
    .replace(/[^0-9A-ZА-ЯЁ]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return "СКЛАД";
  return cleaned.slice(0, limit).replace(/-+$/g, "") || "СКЛАД";
}

/** Дата в номере задания — по московскому времени, ГГГГ-ММ-ДД. */
export function taskDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const moscow = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return moscow.toISOString().slice(0, 10);
}

/**
 * Номер задания.
 *
 * Ozon — порядковый номер партии за день: 2026-09-14-OZ-03.
 * Wildberries — имя регионального склада: 2026-09-14-WB-КАЗАНЬ. Если склад за
 * день получает второе задание, к номеру добавляется -2.
 *
 * Типы параметров описаны явно: без них уже занятые номера выводятся из
 * пустого значения по умолчанию как never[], и сборка не проходит проверку.
 *
 * @param {{
 *   day: string,
 *   marketplaceId: string,
 *   warehouseName?: string | null,
 *   sequence?: number,
 *   taken?: string[],
 * }} options
 * @returns {string}
 */
export function buildTaskNumber({ day, marketplaceId, warehouseName, sequence = 1, taken = [] }) {
  const prefix = MARKETPLACE_PREFIX[marketplaceId] ?? String(marketplaceId ?? "XX").slice(0, 2).toUpperCase();
  const busy = new Set(taken);
  const base = marketplaceId === "wildberries"
    ? `${day}-${prefix}-${warehouseSlug(warehouseName)}`
    : `${day}-${prefix}-${String(sequence).padStart(2, "0")}`;
  if (!busy.has(base)) return base;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!busy.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Делит отобранные отправления на партии.
 *
 * Остаток отгружается как есть: последняя партия — сколько осталось, добивать
 * её до размера партии нельзя, иначе заказ ждёт следующего дня.
 */
export function splitIntoBatches(postings, batchSize) {
  const size = normalizeBatchSize(batchSize);
  const batches = [];
  for (let start = 0; start < postings.length; start += size) {
    batches.push(postings.slice(start, start + size));
  }
  return batches;
}

/**
 * Группирует строки заказов по отправлениям.
 * Партия считается отправлениями, а не штуками: в отправлении Ozon может быть
 * несколько изделий, и разрывать его между заданиями нельзя.
 */
export function groupByPosting(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.marketplaceId}::${row.externalOrderId}`;
    const existing = map.get(key);
    if (existing) {
      existing.items.push(row);
      if (row.orderedAt && (!existing.orderedAt || row.orderedAt < existing.orderedAt)) existing.orderedAt = row.orderedAt;
      continue;
    }
    map.set(key, {
      key,
      marketplaceId: row.marketplaceId,
      externalOrderId: row.externalOrderId,
      warehouseExternalId: row.warehouseExternalId ?? null,
      orderedAt: row.orderedAt ?? null,
      shipmentDeadline: row.shipmentDeadline ?? null,
      items: [row],
    });
  }
  return [...map.values()];
}

/**
 * Приоритет отбора — по сроку ожидания: в задание попадают заказы, которые
 * ждут дольше всех. Пустая дата считается самой старой: такой заказ уже висит.
 */
export function sortByWaiting(postings) {
  return [...postings].sort((left, right) => {
    const a = left.orderedAt ?? "";
    const b = right.orderedAt ?? "";
    if (a === b) return String(left.externalOrderId).localeCompare(String(right.externalOrderId));
    if (!a) return -1;
    if (!b) return 1;
    return a < b ? -1 : 1;
  });
}

/**
 * Ключ раскладки: артикул и размер. Размер может отсутствовать.
 *
 * Размер приводится к одному виду: в раскладке пишут «16,0+», в заказе с WB
 * приходит «16,0 +», а в 1С — «16,0». Это один и тот же размер.
 */
export function placementKey(article, size) {
  return `${String(article ?? "").trim().toUpperCase()}::${normalizeSizeValue(size)}`;
}

/**
 * Русские буквы, неотличимые на вид от латинских.
 *
 * В раскладке рядом живут «с-3005р» русскими буквами и «c-3005p» латинскими:
 * в таблице их набирали руками, и на глаз они одинаковые. Для хранения это
 * разные артикулы — переписывать их молча нельзя, — но для поиска и для
 * подстановки ячейки в задание сравнивать надо по виду, иначе изделие уедет
 * в конец листа подбора «без адреса», хотя адрес у него есть.
 */
// Только буквы в буквы. «З» в «3» не превращается: «С-2293з» и «С-22933» —
// разные артикулы, и склеить их было бы хуже, чем не найти похожий.
const CONFUSABLE = {
  А: "A", В: "B", Е: "E", Ё: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
};

/** Артикул «как он выглядит»: верхний регистр и русские двойники — латиницей. */
export function confusableArticle(value) {
  const text = String(value ?? "").trim().toUpperCase();
  let result = "";
  for (const character of text) result += CONFUSABLE[character] ?? character;
  return result;
}

export function placementLooseKey(article, size) {
  return `${confusableArticle(article)}::${normalizeSizeValue(size)}`;
}

/**
 * Подставляет ячейку каждой строке.
 *
 * Сначала ищется точная пара «артикул + размер», потом раскладка на артикул
 * целиком: размеры одного артикула обычно лежат в одной ячейке.
 */
export function attachCells(items, placements) {
  const index = new Map();
  const loose = new Map();
  for (const placement of placements) {
    index.set(placementKey(placement.article, placement.size), placement);
    // Первая запись выигрывает: точное совпадение важнее похожего.
    const looseWithSize = placementLooseKey(placement.article, placement.size);
    if (!loose.has(looseWithSize)) loose.set(looseWithSize, placement);
    const looseArticle = placementLooseKey(placement.article, null);
    if (!loose.has(looseArticle)) loose.set(looseArticle, placement);
  }
  return items.map((item) => {
    const byArticle = index.get(placementKey(item.article, item.size))
      ?? index.get(placementKey(item.article, null))
      ?? loose.get(placementLooseKey(item.article, item.size))
      ?? loose.get(placementLooseKey(item.article, null));
    return {
      ...item,
      cellCode: byArticle?.cellCode ?? null,
      cellSort: byArticle ? Number(byArticle.sortOrder ?? 0) : null,
    };
  });
}

/**
 * Маршрут сборщика: порядок внутри задания строится по близости ячеек, чтобы
 * склад пройти один раз. Строки без ячейки уходят в конец — их ищут отдельно.
 */
export function sortByRoute(items) {
  return [...items].sort((left, right) => {
    const leftHas = left.cellCode !== null && left.cellCode !== undefined;
    const rightHas = right.cellCode !== null && right.cellCode !== undefined;
    if (leftHas !== rightHas) return leftHas ? -1 : 1;
    if (leftHas && rightHas) {
      const leftSort = Number(left.cellSort ?? 0);
      const rightSort = Number(right.cellSort ?? 0);
      if (leftSort !== rightSort) return leftSort - rightSort;
      const byCell = String(left.cellCode).localeCompare(String(right.cellCode), "ru");
      if (byCell !== 0) return byCell;
    }
    const byArticle = String(left.article ?? "").localeCompare(String(right.article ?? ""), "ru");
    if (byArticle !== 0) return byArticle;
    return String(left.size ?? "").localeCompare(String(right.size ?? ""), "ru");
  });
}

/** Сколько разных ячеек в задании — показатель длины маршрута для отчётов. */
export function countCells(items) {
  return new Set(items.filter((item) => item.cellCode).map((item) => item.cellCode)).size;
}

/**
 * Разбор таблицы раскладки «артикул → ячейка».
 *
 * На входе строки таблицы: из Excel, из CSV или из вставки двух столбцов.
 * Молча потерянная строка раскладки — это изделие, которого сборщик не
 * найдёт, поэтому наружу отдаётся не только результат, но и разбор пропусков:
 * сколько строк и почему не взяли.
 *
 * Три особенности настоящих выгрузок, из-за которых наивный разбор теряет
 * половину раскладки:
 *  - заголовок стоит не в первой строке, а под названием таблицы;
 *  - номер ячейки написан один раз на группу артикулов (объединённая ячейка),
 *    а у остальных строк группы это поле пустое;
 *  - в одном поле перечислено несколько артикулов через запятую или перенос
 *    строки — в ячейке лежит не один артикул.
 *
 * @param {string[][]} rawRows строки таблицы; индекс 0 — первая строка
 * @param {{ carryCellDown?: boolean, splitArticles?: boolean }} [options]
 */
export function parsePlacementRows(rawRows, options = {}) {
  const carryCellDown = options.carryCellDown !== false;
  const splitArticles = options.splitArticles !== false;
  const list = Array.isArray(rawRows) ? rawRows : [];
  const rows = [];
  const errors = [];
  const skipped = { noArticle: 0, noCell: 0, empty: 0 };

  let headerRow = 0;
  let columns = { article: 0, size: null, cell: 1 };
  const searchLimit = Math.min(list.length, 20);
  for (let index = 0; index < searchLimit; index += 1) {
    const candidate = (list[index] ?? []).map((value) => String(value ?? "").trim().toLowerCase());
    if (!isPlacementHeader(candidate)) continue;
    columns = mapColumns(candidate);
    headerRow = index + 1;
    break;
  }

  // Столбцы проверяются по данным, а не только по заголовку: в таблице
  // раскладки первым столбцом обычно идёт номер ячейки, а заголовок у него
  // пустой — по одному слову «Артикул» порядок не угадать. Номера ячеек —
  // целые числа, артикул всегда с буквами, поэтому колонку из одних чисел
  // берём за ячейку.
  const swapped = shouldSwapColumns(list, headerRow, columns);
  if (swapped) columns = { ...columns, article: columns.cell, cell: columns.article };

  let carried = "";
  let carriedCount = 0;
  let splitCount = 0;
  for (let index = headerRow; index < list.length; index += 1) {
    const parts = list[index] ?? [];
    const lineNumber = index + 1;
    const articleField = clean(parts[columns.article]);
    let cell = cleanCell(parts[columns.cell]);
    const size = columns.size === null ? "" : clean(parts[columns.size]);

    if (!articleField && !cell) {
      skipped.empty += 1;
      continue;
    }
    // Номер ячейки, написанный один раз на группу: без этого вся группа,
    // кроме первой строки, остаётся без адреса.
    if (!cell && carryCellDown && carried) {
      cell = carried;
      carriedCount += 1;
    }
    if (cell) carried = cell;

    if (!articleField || !cell) {
      if (!articleField) skipped.noArticle += 1;
      else skipped.noCell += 1;
      if (errors.length < 200) {
        errors.push({ line: lineNumber, message: !articleField ? "нет артикула" : "нет номера ячейки" });
      }
      continue;
    }

    const articles = splitArticles ? splitArticleField(articleField) : [articleField];
    if (articles.length > 1) splitCount += articles.length - 1;
    for (const article of articles) rows.push({ article, size: size || null, cell });
  }

  // Один артикул лежит в одной ячейке: если он встретился дважды, остаётся
  // последняя строка — так новая выгрузка перезаписывает старую.
  const unique = new Map();
  let duplicates = 0;
  for (const row of rows) {
    const key = placementKey(row.article, row.size);
    if (unique.has(key)) duplicates += 1;
    unique.set(key, row);
  }

  return {
    rows: [...unique.values()],
    errors,
    skipped,
    duplicates,
    swapped,
    carried: carriedCount,
    split: splitCount,
    readRows: Math.max(0, list.length - headerRow),
    skippedHeader: headerRow > 0,
    headerRow,
    columns,
  };
}

/**
 * Разбор вставленного или загруженного текста.
 *
 * Делится не построчно, а разбором по символам: в выгрузке из таблицы поле с
 * несколькими артикулами приходит в кавычках и с переносами строк внутри, и
 * деление по строкам рвёт такое поле пополам — а вместе с ним и всё, что идёт
 * ниже в файле.
 *
 * @param {string} text
 * @param {{ carryCellDown?: boolean, splitArticles?: boolean }} [options]
 */
export function parsePlacementTable(text, options = {}) {
  const body = String(text ?? "").replace(/^﻿/, "");
  if (body.trim() === "") {
    return { ...emptyPlacementResult(), delimiter: "\t" };
  }
  const delimiter = detectDelimiter(body);
  const parsed = parsePlacementRows(splitTable(body, delimiter), options);
  return { ...parsed, delimiter };
}

/**
 * Похоже ли, что столбцы перепутаны местами.
 *
 * @param {string[][]} list
 * @param {number} headerRow
 * @param {{ article: number, size: number | null, cell: number }} columns
 * @returns {boolean}
 */
function shouldSwapColumns(list, headerRow, columns) {
  if (columns.article === columns.cell) return false;
  const numberShare = (index) => {
    let filled = 0;
    let numbers = 0;
    for (let row = headerRow; row < list.length && filled < 200; row += 1) {
      const value = clean((list[row] ?? [])[index]);
      if (!value) continue;
      filled += 1;
      if (/^\d{1,5}$/.test(value)) numbers += 1;
    }
    return filled === 0 ? 0 : numbers / filled;
  };
  return numberShare(columns.article) > 0.8 && numberShare(columns.cell) < 0.5;
}

function emptyPlacementResult() {
  return {
    rows: [], errors: [], skipped: { noArticle: 0, noCell: 0, empty: 0 },
    duplicates: 0, swapped: false, carried: 0, split: 0, readRows: 0,
    skippedHeader: false, headerRow: 0, columns: { article: 0, size: null, cell: 1 },
  };
}

function clean(value) {
  return String(value ?? "")
    .replace(/ /g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(/[ \t]{2,}/g, " ");
}

/** Код ячейки приводится к верхнему регистру: «а-01» и «А-01» — одна ячейка. */
function cleanCell(value) {
  return clean(value).toUpperCase();
}

/**
 * Несколько артикулов в одном поле.
 *
 * Перенос строки и точка с запятой делят всегда — такого внутри артикула не
 * бывает. Запятая делит только если каждая часть похожа на артикул, то есть
 * короткая и с цифрой: иначе название «Кольцо, большое» развалится на два
 * несуществующих артикула, и оба окажутся без товара.
 */
export function splitArticleField(value) {
  const text = String(value ?? "");
  let parts = text.split(/[\n;]+/).map((part) => clean(part)).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1 && parts[0].includes(",")) {
    const byComma = parts[0].split(",").map((part) => clean(part)).filter(Boolean);
    const looksLikeArticles = byComma.every((part) => part.length <= 40 && /\d/.test(part) && !/\s{2}/.test(part));
    if (byComma.length > 1 && looksLikeArticles) parts = byComma;
  }
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const key = part.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result;
}

function isPlacementHeader(header) {
  return header.some((value) => /артикул|article|sku|номенклат/.test(value))
    || header.some((value) => /ячей|cell|адрес|место|полка/.test(value));
}

/** Разделитель берётся по большинству строк: одна строка легко обманывает. */
function detectDelimiter(body) {
  const sample = String(body).split(/\r\n|\r|\n/).slice(0, 200);
  const score = (delimiter) => sample.reduce((sum, line) => sum + (line.includes(delimiter) ? 1 : 0), 0);
  const tabs = score("\t");
  const semicolons = score(";");
  const commas = score(",");
  if (tabs > 0 && tabs >= semicolons && tabs >= commas) return "\t";
  if (semicolons > 0 && semicolons >= commas) return ";";
  if (commas > 0) return ",";
  return "\t";
}

/**
 * Текст → строки таблицы, с учётом кавычек и переносов внутри поля.
 * @param {string} body
 * @param {string} delimiter
 * @returns {string[][]}
 */
export function splitTable(body, delimiter) {
  const text = String(body ?? "");
  const rows = [];
  let row = [];
  let current = "";
  let quoted = false;
  const pushCell = () => { row.push(current); current = ""; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { current += '"'; index += 1; }
        else quoted = false;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === delimiter) { pushCell(); continue; }
    if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    if (character === "\n") { pushRow(); continue; }
    current += character;
  }
  if (current !== "" || row.length > 0) pushRow();
  while (rows.length > 0 && rows[rows.length - 1].every((value) => String(value).trim() === "")) rows.pop();
  return rows;
}

function mapColumns(header) {
  const find = (pattern) => {
    const index = header.findIndex((value) => pattern.test(value));
    return index === -1 ? null : index;
  };
  const article = find(/артикул|article|sku|номенклат/) ?? 0;
  const cell = find(/ячей|cell|адрес|место|полка/) ?? (article === 1 ? 0 : 1);
  return { article, size: find(/размер|size/), cell };
}

/**
 * Порядок сортировки ячейки из её кода.
 *
 * Код вида A-02-14 разбирается на части, и числа сравниваются как числа:
 * иначе ячейка 10 встанет перед ячейкой 2, и маршрут получится рваный.
 */
export function cellSortOrder(code) {
  const parts = String(code ?? "").toUpperCase().match(/\d+|[A-ZА-ЯЁ]+/gu) ?? [];
  let order = 0;
  for (const part of parts.slice(0, 3)) {
    const value = /^\d+$/.test(part)
      ? Math.min(9999, Number(part))
      : Math.min(9999, part.split("").reduce((sum, letter) => sum * 33 + (letter.codePointAt(0) % 100), 0));
    order = order * 10000 + value;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, order);
}
