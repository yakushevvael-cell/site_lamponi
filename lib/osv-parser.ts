import { strFromU8, unzipSync } from "fflate";

import { parseOsvSheet } from "./osv-parse-core.mjs";

export type OsvProduct = {
  variantKey: string;
  article: string;
  size: string | null;
  quantity: number;
};

export type OsvParseResult = {
  products: OsvProduct[];
  articleCount: number;
  variantCount: number;
  sizedVariantCount: number;
  unsizedVariantCount: number;
  totalQuantity: number;
  zeroQuantityCount: number;
  /** Замечания: загрузку не блокируют. */
  warnings: string[];
  /** Расхождения, при которых загружать ОСВ можно только с явным подтверждением администратора. */
  blockers: string[];
  reportedTotal: number | null;
  /** Диагностика разбора — показывается администратору до применения. */
  sheetName: string;
  quantityColumn: string;
  headerRowNumber: number;
};

function decodeXmlAttribute(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Выбирает лист, который в книге идёт первым, а не первый по имени файла. */
function pickSheet(archive: Record<string, Uint8Array>) {
  const workbookXml = archive["xl/workbook.xml"] ? strFromU8(archive["xl/workbook.xml"]) : "";
  const relsXml = archive["xl/_rels/workbook.xml.rels"] ? strFromU8(archive["xl/_rels/workbook.xml.rels"]) : "";

  const firstSheet = workbookXml.match(/<sheet\b[^>]*?\/?>/)?.[0] ?? "";
  const sheetName = firstSheet.match(/\bname="([^"]*)"/)?.[1] ?? "";
  const relationId = firstSheet.match(/\br:id="([^"]*)"/)?.[1] ?? "";

  if (relationId) {
    const relation = relsXml.match(new RegExp(`<Relationship\\b[^>]*Id="${relationId}"[^>]*>`))?.[0] ?? "";
    const target = relation.match(/\bTarget="([^"]*)"/)?.[1] ?? "";
    if (target) {
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      if (archive[path]) return { path, name: sheetName ? decodeXmlAttribute(sheetName) : path };
    }
  }

  const fallback = Object.keys(archive)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  return fallback ? { path: fallback, name: sheetName ? decodeXmlAttribute(sheetName) : fallback } : null;
}

export function parseOsvWorkbook(input: ArrayBuffer | Uint8Array): OsvParseResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("Не удалось открыть файл. Нужен файл Excel в формате .xlsx.");
  }

  const sheet = pickSheet(archive);
  if (!sheet) throw new Error("В файле не найден лист с данными ОСВ.");

  return parseOsvSheet({
    sheetXml: strFromU8(archive[sheet.path]),
    sharedStringsXml: archive["xl/sharedStrings.xml"] ? strFromU8(archive["xl/sharedStrings.xml"]) : undefined,
    stylesXml: archive["xl/styles.xml"] ? strFromU8(archive["xl/styles.xml"]) : undefined,
    sheetName: sheet.name,
  }) as OsvParseResult;
}
