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

/**
 * Русские буквы, неотличимые на вид от латинских.
 *
 * Артикул в карточке маркетплейса и артикул в 1С набирали разные люди: «С-3064»
 * встречается и кириллицей, и латиницей, и в нижнем регистре. Для сравнения
 * приводим к одному виду, иначе изделие «не находится ни в одном задании».
 */
const CONFUSABLE = {
  А: "A", В: "B", Е: "E", Ё: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
};

function confusable(value) {
  let result = "";
  for (const character of String(value ?? "")) result += CONFUSABLE[character] ?? character;
  return result;
}

/**
 * Размер «как он написан»: 17,0 → 17, «16,0 +» → 16+, «б/р» → Б/Р, 16-20 → 16-20.
 *
 * Размеры колец приходят из трёх мест — 1С, карточка WB, УПД, — и пишутся
 * по-разному. Сравнивать их надо по смыслу, а не посимвольно.
 */
export function normalizeSizeValue(value) {
  const text = String(value ?? "")
    .replace(/ /g, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[‐-—−]/g, "-");
  if (!text) return "";
  if (/^(Б\/?Р\.?|Б\.Р\.?|БЕЗРАЗМЕРА)$/.test(text)) return "Б/Р";
  // 17.0 и 17 — один размер, 16.0+ и 16+ — тоже.
  return text.replace(/(\d)\.0(?!\d)/g, "$1");
}

/**
 * Размер, вписанный в артикул скобками: «К-1298з (16-21)».
 *
 * Ozon отдаёт артикул продавца как есть, и у части карточек размер записан
 * прямо в нём, а отдельного размера нет. В 1С и в УПД то же изделие — «К-1298з»
 * с размером «16-21», и без разбора оно не сходится ни с УИН, ни с раскладкой.
 * Делится только размер в скобках в самом конце: тире внутри артикула
 * («С-3027-2з») размером не считается. Если отдельный размер есть и он другой —
 * не угадываем, артикул остаётся как был.
 *
 * @returns {{ article: string, size: string | null }}
 */
export function splitArticleSize(value, size) {
  const article = normalizeArticle(value);
  const own = size == null ? "" : String(size).trim();
  const match = article.match(ARTICLE_SIZE_PATTERN);
  if (!match) return { article, size: own || null };
  const inner = match[2].trim();
  if (own && normalizeSizeValue(own) !== normalizeSizeValue(inner)) return { article, size: own };
  return { article: match[1].trim(), size: own || inner };
}

/** Для сравнения артикулов: без регистра, без пробелов и без похожих букв. */
export function articleKey(value, size) {
  const split = splitArticleSize(value, size);
  const article = confusable(split.article.replace(/\s+/g, "").toUpperCase());
  return `${article}::${normalizeSizeValue(split.size)}`;
}

/** Ключ артикула без размера — в том числе без размера, вписанного в скобки. */
export function articleBaseKey(value) {
  return articleKey(splitArticleSize(value, null).article, null);
}

/** УИН из наименования: «... УИН 6431234567890123 ...». */
export function extractUin(value) {
  const match = String(value ?? "").match(/УИН\s*[:№#-]?\s*([0-9]{10,})/i);
  return match ? match[1] : "";
}

/**
 * Размер из наименования.
 *
 * Кроме обычных «17» и «17,5» у колец встречаются «б/р», диапазоны «16-20» и
 * размеры с плюсом «16,0 +». Раньше из «16-20» вычитывалось «16», и изделие
 * переставало сходиться с заказом — поэтому варианты перечислены целиком и
 * в порядке от длинного к короткому.
 */
const SIZE_VALUE = [
  "Б\\s*/\\s*Р\\.?",
  "БЕЗ\\s+РАЗМЕРА",
  "[0-9]{1,3}(?:[.,][0-9]{1,2})?\\s*[-–—]\\s*[0-9]{1,3}(?:[.,][0-9]{1,2})?",
  "[0-9]{1,3}(?:[.,][0-9]{1,2})?\\s*\\+",
  "[0-9]{1,3}(?:[.,][0-9]{1,2})?",
  "XXXXL|XXXL|XXL|XL|XXXS|XXS|XS|S|M|L",
].join("|");

const ARTICLE_SIZE_PATTERN = new RegExp(`^(.*?\\S)\\s*[(\\[]\\s*(${SIZE_VALUE})\\s*[)\\]]$`, "i");

const SIZE_PATTERN = new RegExp(
  `(?:^|[\\s,;(|])(?:размер|size)\\s*[:№#=-]?\\s*\\(?\\s*(${SIZE_VALUE})\\s*\\)?`,
  "i",
);

export function extractSize(value) {
  const text = String(value ?? "").replace(/ /g, " ");
  const match = text.match(SIZE_PATTERN);
  if (!match) return null;
  // «без размера» в 1С и «б/р» — одно и то же.
  return normalizeSizeValue(match[1]) || null;
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
