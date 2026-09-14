/**
 * Чтение файла УПД целиком: распаковка .xlsx и разбор всех листов.
 *
 * Правила разбора живут в lib/upd-parse-core.mjs и покрыты тестами, здесь
 * только работа с архивом — так же, как у ОСВ (lib/osv-parser.ts).
 */
import { strFromU8, unzipSync } from "fflate";

import { extractUpdItems } from "./upd-parse-core.mjs";
import { sheetPaths, sheetRows } from "./xlsx-rows.mjs";

export type UpdItem = {
  article: string;
  uin: string;
  size: string | null;
  description: string;
};

export type UpdParseResult = {
  items: UpdItem[];
  errors: Array<{ row: number; message: string }>;
  sheetCount: number;
  headerFound: boolean;
};

export function parseUpdWorkbook(input: ArrayBuffer | Uint8Array): UpdParseResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("Не удалось открыть файл. Нужен файл Excel в формате .xlsx — старый .xls сохраните как .xlsx.");
  }

  const sharedStringsXml = archive["xl/sharedStrings.xml"] ? strFromU8(archive["xl/sharedStrings.xml"]) : undefined;
  const paths = sheetPaths(Object.keys(archive)) as string[];
  if (paths.length === 0) throw new Error("В файле нет листов с данными.");

  const items: UpdItem[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  let headerFound = false;

  for (const path of paths) {
    const rows = sheetRows({ sheetXml: strFromU8(archive[path]), sharedStringsXml }) as string[][];
    const parsed = extractUpdItems(rows) as UpdParseResult;
    if (parsed.headerFound) headerFound = true;
    items.push(...parsed.items);
    errors.push(...parsed.errors);
  }

  // Один УИН встречается в книге один раз: если лист повторяется, остаётся последняя строка.
  const unique = new Map<string, UpdItem>();
  for (const item of items) unique.set(item.uin, item);

  return { items: [...unique.values()], errors, sheetCount: paths.length, headerFound };
}
