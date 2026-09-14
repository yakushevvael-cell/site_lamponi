/**
 * Чтение раскладки из файла Excel.
 *
 * Раскладка приходит книгой из Google-таблицы или из 1С: номер ячейки часто
 * стоит один раз на группу артикулов объединённой ячейкой, а лишние листы
 * лежат рядом с нужным. Поэтому разбираются все листы, объединения
 * разворачиваются, и берётся тот лист, где раскладки больше всего.
 *
 * Правила разбора живут в lib/warehouse-core.mjs и покрыты тестами, здесь
 * только работа с архивом — так же, как у ОСВ и УПД.
 */
import { strFromU8, unzipSync } from "fflate";

import { parsePlacementRows } from "./warehouse-core.mjs";
import { expandMerges, mergedRanges, sheetPaths, sheetRows } from "./xlsx-rows.mjs";

export type PlacementRow = { article: string; size: string | null; cell: string };

export type PlacementParseResult = {
  rows: PlacementRow[];
  errors: Array<{ line: number; message: string }>;
  skipped: { noArticle: number; noCell: number; empty: number };
  duplicates: number;
  carried: number;
  split: number;
  readRows: number;
  skippedHeader: boolean;
  headerRow: number;
  columns: { article: number; size: number | null; cell: number };
  merged?: number;
  sheetCount?: number;
  delimiter?: string;
};

export type PlacementParseOptions = { carryCellDown?: boolean; splitArticles?: boolean };

/** .xlsx — это zip: первые два байта «PK». */
export function looksLikeXlsx(bytes: Uint8Array) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Старый .xls — бинарник OLE2, его разбирать нечем: нужен пересохранённый файл. */
export function looksLikeOldXls(bytes: Uint8Array) {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

export function parsePlacementWorkbook(
  input: ArrayBuffer | Uint8Array,
  options: PlacementParseOptions = {},
): PlacementParseResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (looksLikeOldXls(bytes)) {
    throw new Error("Это старый формат .xls. Откройте файл в Excel и сохраните как .xlsx.");
  }
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("Не удалось открыть файл. Нужен Excel в формате .xlsx или текстовый CSV.");
  }

  const sharedStringsXml = archive["xl/sharedStrings.xml"] ? strFromU8(archive["xl/sharedStrings.xml"]) : undefined;
  const paths = sheetPaths(Object.keys(archive)) as string[];
  if (paths.length === 0) throw new Error("В файле нет листов с данными.");

  let best: PlacementParseResult | null = null;
  for (const path of paths) {
    const sheetXml = strFromU8(archive[path]);
    const rows = sheetRows({ sheetXml, sharedStringsXml, keepRowNumbers: true }) as string[][];
    const merged = expandMerges(rows, mergedRanges(sheetXml)) as number;
    const parsed = parsePlacementRows(rows, options) as PlacementParseResult;
    const candidate: PlacementParseResult = { ...parsed, merged, sheetCount: paths.length };
    if (!best || candidate.rows.length > best.rows.length) best = candidate;
  }

  if (!best) throw new Error("В файле нет строк раскладки.");
  return best;
}

/**
 * Текстовый файл может прийти из Excel в windows-1251 — тогда в UTF-8 он
 * читается крякозябрами. Замена «�» в результате как раз про это и говорит.
 */
export function decodeTextFile(bytes: Uint8Array) {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1251").decode(bytes);
  } catch {
    return utf8;
  }
}
