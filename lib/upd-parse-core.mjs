/**
 * Разбор УПД: пары «артикул + УИН».
 *
 * УПД приходит из 1С таблицей. Артикул лежит в колонке «Код товара/работ,
 * услуг», а УИН — внутри наименования товара, там же иногда указан размер.
 * Правила повторяют то, что годами работало в Google-таблице, включая
 * нестандартные пробелы и разные виды тире в артикулах.
 */

/** Заголовки таблицы бывают в две строки и с неразрывными пробелами. */
export function normalizeUpdHeader(value) {
  return String(value ?? "")
    .replace(/ /g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .trim()
    .toLowerCase();
}

/** Колонка с артикулом: «Код товара/работ, услуг». */
export function isUpdCodeHeader(value) {
  const header = normalizeUpdHeader(value);
  return header.includes("код товара") && (header.includes("услуг") || header.includes("работ"));
}

/** Колонка с наименованием, внутри которого УИН. */
export function isUpdDescriptionHeader(value) {
  const header = normalizeUpdHeader(value);
  return header.includes("наименование товара")
    && (header.includes("описание") || header.includes("имущественного права") || header.includes("оказанных услуг"));
}

/** Артикул: без кавычек, с обычными пробелами и одинаковыми тире. */
export function normalizeArticle(value) {
  return String(value ?? "")
    .replace(/^﻿/, "")
    .replace(/ /g, " ")
    .replace(/[«»"]/g, "")
    .replace(/[‐-—−]/g, "-")
    .trim();
}

/** Для сравнения артикулов: без регистра и без пробелов. */
export function articleKey(value, size) {
  const article = normalizeArticle(value).replace(/\s+/g, "").toUpperCase();
  const normalizedSize = String(size ?? "").replace(/\s+/g, "").toUpperCase().replace(",", ".");
  return `${article}::${normalizedSize}`;
}

/** УИН из наименования: «... УИН 6431234567890123 ...». */
export function extractUin(value) {
  const match = String(value ?? "").match(/УИН\s*[:№#-]?\s*([0-9]{10,})/i);
  return match ? match[1] : "";
}

/** Размер из наименования: числовой или буквенный. */
export function extractSize(value) {
  const text = String(value ?? "").replace(/ /g, " ");
  const match = text.match(
    /(?:^|[\s,;|])(?:размер|size)\s*[:№#=-]?\s*\(?\s*([0-9]{1,3}(?:[.,][0-9]{1,2})?|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL)\s*\)?/i,
  );
  if (!match) return null;
  const raw = match[1].replace(",", ".").toUpperCase();
  // Размеры вида 17.0 и 17 — один и тот же размер.
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return String(numeric);
  return raw;
}

/**
 * Проходит строки таблицы и собирает пары «артикул + УИН».
 *
 * Шапка ищется в каждой строке: в УПД она повторяется на каждой странице, и
 * колонки просто определяются заново. Строки без УИН или без артикула
 * пропускаются — в УПД это итоги и служебные строки.
 */
export function extractUpdItems(rows) {
  const items = [];
  const errors = [];
  let codeColumn = -1;
  let descriptionColumn = -1;
  let headerFound = false;

  for (const [rowIndex, row] of (rows ?? []).entries()) {
    const cells = row ?? [];
    let rowIsHeader = false;
    for (const [columnIndex, cell] of cells.entries()) {
      if (isUpdCodeHeader(cell)) {
        codeColumn = columnIndex;
        rowIsHeader = true;
        headerFound = true;
      }
      if (isUpdDescriptionHeader(cell)) {
        descriptionColumn = columnIndex;
        rowIsHeader = true;
        headerFound = true;
      }
    }
    if (rowIsHeader || codeColumn < 0 || descriptionColumn < 0) continue;

    const article = normalizeArticle(cells[codeColumn]);
    const description = String(cells[descriptionColumn] ?? "");
    const uin = extractUin(description);
    if (!article && !uin) continue;
    if (!uin) continue;
    if (!article) {
      errors.push({ row: rowIndex + 1, message: `УИН ${uin} без артикула` });
      continue;
    }
    items.push({ article, uin, size: extractSize(description), description: description.slice(0, 500) });
  }

  // Один и тот же УИН в файле дважды — оставляем последнюю строку.
  const unique = new Map();
  for (const item of items) unique.set(item.uin, item);

  return { items: [...unique.values()], errors, headerFound };
}
