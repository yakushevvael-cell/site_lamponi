/**
 * Разбор листа ОСВ.
 *
 * Чистый JS без зависимостей: распаковкой .xlsx занимается `lib/osv-parser.ts`,
 * а сюда приходит уже готовый XML — благодаря этому логику разбора можно
 * прогонять юнит-тестами через `node --test`.
 *
 * Все признаки, на которые опирается разбор, смысловые, а не позиционные:
 *  - колонка количества ищется по заголовку «Сальдо конечное → Дт → Количество»,
 *    а не берётся жёстко как колонка F;
 *  - строка номенклатуры отличается от строки размера начертанием шрифта;
 *  - класс стиля номенклатуры определяется по структуре отчёта (полужирная
 *    строка, за которой идёт неполужирная), а не по конкретному номеру стиля.
 *
 * Прежняя версия привязывалась к значению атрибута `s=` первой найденной строки,
 * и любая правка форматирования выгрузки 1С либо ломала загрузку, либо — хуже —
 * заставляла принять строки размеров за артикулы.
 */

/**
 * @typedef {{ ref: string, style: number | null, value: string }} ParsedCell
 * @typedef {{ number: number, cells: Map<string, ParsedCell> }} ParsedRow
 * @typedef {{ variantKey: string, article: string, size: string | null, quantity: number }} OsvProduct
 */

const QUANTITY_FALLBACK_COLUMN = "F";

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join(""),
  );
}

function parseCells(rowXml, sharedStrings) {
  const cells = new Map();
  for (const match of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = match[1];
    const body = match[2] ?? "";
    const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
    if (!ref) continue;
    const styleAttr = attrs.match(/\bs="(\d+)"/)?.[1];
    const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? null;
    const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
    const inline = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] ?? "";
    let value = raw;
    if (type === "s" && raw !== "") value = sharedStrings[Number(raw)] ?? "";
    if (type === "inlineStr") value = decodeXml(inline);
    cells.set(ref, { ref, style: styleAttr === undefined ? null : Number(styleAttr), value: decodeXml(value) });
  }
  return cells;
}

/** Таблица «индекс стиля → полужирный шрифт». */
function parseBoldStyles(stylesXml) {
  const bold = new Map();
  if (!stylesXml) return bold;

  const fontsBlock = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1] ?? "";
  const fontBold = [...fontsBlock.matchAll(/<font\b[^>]*(?:\/>|>([\s\S]*?)<\/font>)/g)]
    .map((match) => /<b\s*\/>|<b>/.test(match[1] ?? ""));

  const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const xfs = [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)];
  xfs.forEach((match, index) => {
    const fontId = Number(match[1].match(/\bfontId="(\d+)"/)?.[1] ?? "0");
    bold.set(index, fontBold[fontId] === true);
  });
  return bold;
}

function columnIndex(column) {
  let index = 0;
  for (const character of column) index = index * 26 + (character.charCodeAt(0) - 64);
  return index;
}

function columnName(index) {
  let name = "";
  let rest = index;
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

function normalizeHeader(value) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
}

/**
 * Ищет колонку «Сальдо конечное → Дт → Количество».
 *
 * Заголовок ОСВ занимает несколько строк, а группы («Сальдо конечное») лежат в
 * объединённых ячейках. Значение объединённой ячейки хранится только в левой
 * колонке, поэтому переносим его вправо до следующего непустого — так получается
 * полный заголовок каждой колонки без разбора mergeCells.
 */
function findQuantityColumn(headerRows, lastColumn) {
  const combined = new Map();
  for (const row of headerRows) {
    let carried = "";
    for (let index = 2; index <= lastColumn; index += 1) {
      const column = columnName(index);
      const value = row.cells.get(column)?.value.trim() ?? "";
      if (value) carried = value;
      const parts = combined.get(column) ?? [];
      parts.push(normalizeHeader(carried));
      combined.set(column, parts);
    }
  }

  for (const [column, parts] of combined) {
    const header = parts.join(" ");
    if (header.includes("сальдо конечное") && header.includes("дт") && header.includes("количество")) return column;
  }
  // Запасной вариант: конечное сальдо без явного «Дт» — так бывает в part выгрузок.
  for (const [column, parts] of combined) {
    const header = parts.join(" ");
    if (header.includes("сальдо конечное") && header.includes("количество")) return column;
  }
  return null;
}

function toQuantity(value) {
  if (!value) return 0;
  const parsed = Number(value.replace(/\s| /g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function variantKey(article, size) {
  return size === null ? article : `${article}::${size}`;
}

function isTotalRow(value) {
  const normalized = normalizeHeader(value);
  return normalized === "итого" || normalized === "всего" || normalized.startsWith("итого ");
}

/**
 * @param {{ sheetXml: string, sharedStringsXml?: string, stylesXml?: string, sheetName?: string }} sources
 */
export function parseOsvSheet(sources) {
  const sharedStrings = sources.sharedStringsXml ? parseSharedStrings(sources.sharedStringsXml) : [];
  const boldByStyle = parseBoldStyles(sources.stylesXml);
  const sheetXml = sources.sheetXml ?? "";

  /** @type {ParsedRow[]} */
  const rows = [...sheetXml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((match) => ({
    number: Number(match[1]),
    cells: parseCells(match[2], sharedStrings),
  }));
  if (rows.length === 0) throw new Error("Лист ОСВ пуст.");

  // Заголовок занимает несколько строк: «Субконто3», затем «Субконто4».
  // Нужна последняя из них — ниже неё начинаются данные.
  const headerCandidates = rows
    .slice(0, 20)
    .filter((row) => normalizeHeader(row.cells.get("A")?.value ?? "").startsWith("субконто"));
  const headerRow = headerCandidates[headerCandidates.length - 1];
  if (!headerRow) {
    throw new Error("Не найдена ожидаемая структура ОСВ: строка заголовка «Субконто…» отсутствует.");
  }

  const lastColumn = rows.slice(0, 20).reduce((max, row) => {
    let current = max;
    for (const ref of row.cells.keys()) current = Math.max(current, columnIndex(ref));
    return current;
  }, 2);
  const headerRows = rows.filter((row) => row.number <= headerRow.number);
  const detectedColumn = findQuantityColumn(headerRows, lastColumn);
  const quantityColumn = detectedColumn ?? QUANTITY_FALLBACK_COLUMN;

  const warnings = [];
  const blockers = [];
  if (!detectedColumn) {
    warnings.push(`Колонка «Сальдо конечное / Количество» не опознана по заголовку, взята колонка ${QUANTITY_FALLBACK_COLUMN}. Проверьте итоги.`);
  }

  const dataRows = rows.filter((row) => row.number > headerRow.number);
  const isBold = (cell) => (cell?.style === null || cell?.style === undefined ? false : boldByStyle.get(cell.style) === true);

  /**
   * Самокалибровка: строка номенклатуры — полужирная строка, за которой идёт
   * неполужирная (размер). Строка счёта или склада тоже полужирная, но за ней
   * сразу следует другая полужирная строка. Так класс стиля номенклатуры
   * выводится из структуры отчёта и переживает переформатирование выгрузки.
   */
  let articleStyle = null;
  for (let index = 0; index < dataRows.length - 1; index += 1) {
    const cell = dataRows[index].cells.get("A");
    const next = dataRows[index + 1].cells.get("A");
    if (!cell?.value.trim() || !next?.value.trim()) continue;
    if (isBold(cell) && !isBold(next)) {
      articleStyle = cell.style ?? null;
      break;
    }
  }
  if (articleStyle === null) {
    throw new Error("Не удалось различить строки номенклатуры и размеров в ОСВ. Проверьте, что отчёт выгружен с субконто «Номенклатура» и «Размер».");
  }

  const totalRow = dataRows.find((row) => isTotalRow(row.cells.get("A")?.value ?? ""))
    ?? dataRows.find((row) => {
      const cell = row.cells.get("A");
      return Boolean(cell?.value.trim()) && isBold(cell) && cell?.style !== articleStyle;
    });

  /** @type {Map<string, OsvProduct>} */
  const aggregated = new Map();
  const articles = new Set();
  let duplicateCount = 0;
  let parentWithoutChildrenCount = 0;
  let parentMismatchCount = 0;
  let orphanSizeCount = 0;
  let currentArticle = null;
  let currentParentQuantity = 0;
  let currentChildrenQuantity = 0;
  let currentChildrenCount = 0;

  const closeCurrentArticle = () => {
    if (!currentArticle) return;
    if (currentChildrenCount === 0) parentWithoutChildrenCount += 1;
    if (Math.abs(currentParentQuantity - currentChildrenQuantity) > 0.001) parentMismatchCount += 1;
  };

  for (const row of dataRows) {
    const cellA = row.cells.get("A");
    if (!cellA) continue;
    const value = cellA.value.trim();
    if (!value) continue;

    if (cellA.style === articleStyle) {
      closeCurrentArticle();
      currentArticle = value;
      currentParentQuantity = toQuantity(row.cells.get(quantityColumn)?.value);
      currentChildrenQuantity = 0;
      currentChildrenCount = 0;
      articles.add(value);
      continue;
    }

    if (isBold(cellA) || isTotalRow(value)) {
      // Строка счёта, склада или итога — граница, а не номенклатура.
      closeCurrentArticle();
      currentArticle = null;
      currentChildrenCount = 0;
      currentChildrenQuantity = 0;
      currentParentQuantity = 0;
      continue;
    }

    if (!currentArticle) {
      orphanSizeCount += 1;
      continue;
    }

    // Размеры вроде «16,0 +» начинаются с цифры — по содержимому их от строки
    // счёта не отличить, поэтому классификация идёт только по начертанию.
    const size = value === "<Пустое субконто4>" ? null : value;
    const quantity = toQuantity(row.cells.get(quantityColumn)?.value);
    const key = variantKey(currentArticle, size);
    currentChildrenQuantity += quantity;
    currentChildrenCount += 1;

    const existing = aggregated.get(key);
    if (existing) {
      duplicateCount += 1;
      existing.quantity += quantity;
    } else {
      aggregated.set(key, { variantKey: key, article: currentArticle, size, quantity });
    }
  }
  closeCurrentArticle();

  const products = [...aggregated.values()];
  if (products.length === 0) {
    throw new Error("В ОСВ не найдено ни одной товарной позиции. Проверьте, что отчёт выгружен с субконто «Номенклатура» и «Размер».");
  }

  const totalQuantity = products.reduce((sum, item) => sum + item.quantity, 0);
  const reportedTotal = totalRow ? toQuantity(totalRow.cells.get(quantityColumn)?.value) : null;

  if (duplicateCount > 0) warnings.push(`Объединено повторяющихся сочетаний «артикул + размер»: ${duplicateCount}.`);
  if (parentWithoutChildrenCount > 0) warnings.push(`Артикулов без строки размера или <Пустое субконто4>: ${parentWithoutChildrenCount}.`);
  if (orphanSizeCount > 0) warnings.push(`Строк размера без артикула: ${orphanSizeCount}. Они пропущены.`);
  if (reportedTotal === null) warnings.push("В отчёте не найдена итоговая строка — сверить общий остаток не с чем.");

  // Блокирующие расхождения: с такими данными отправлять остатки нельзя.
  if (parentMismatchCount > 0) {
    blockers.push(`Артикулов, у которых сумма размеров не сошлась со строкой артикула: ${parentMismatchCount}.`);
  }
  if (reportedTotal !== null && Math.abs(reportedTotal - totalQuantity) > 0.001) {
    blockers.push(`Сумма строк (${totalQuantity}) не совпадает с итогом ОСВ (${reportedTotal}).`);
  }

  return {
    products,
    articleCount: articles.size,
    variantCount: products.length,
    sizedVariantCount: products.filter((item) => item.size !== null).length,
    unsizedVariantCount: products.filter((item) => item.size === null).length,
    totalQuantity,
    zeroQuantityCount: products.filter((item) => item.quantity === 0).length,
    warnings,
    blockers,
    reportedTotal,
    sheetName: sources.sheetName ?? "",
    quantityColumn,
    headerRowNumber: headerRow.number,
  };
}
