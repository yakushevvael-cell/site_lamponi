/**
 * Лист Excel → массив строк с видимыми значениями.
 *
 * Разбор такой же, как у ОСВ (lib/osv-parse-core.mjs), но без привязки к
 * содержимому: УПД приходит с произвольной шапкой, и нужен просто текст
 * ячеек по колонкам.
 */

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join(""),
  );
}

function columnIndex(column) {
  let index = 0;
  for (const character of column) index = index * 26 + (character.charCodeAt(0) - 64);
  return index;
}

/**
 * @param {{ sheetXml: string, sharedStringsXml?: string, keepRowNumbers?: boolean }} sources
 *   keepRowNumbers — сохранять номера строк листа: пустые строки становятся
 *   пустыми массивами. Нужно там, где по номеру строки разворачиваются
 *   объединённые ячейки и где номер показывают человеку.
 * @returns {string[][]} строки листа; пустые ячейки — пустые строки
 */
export function sheetRows(sources) {
  const sharedStrings = parseSharedStrings(sources.sharedStringsXml);
  const rows = [];
  for (const rowMatch of (sources.sheetXml ?? "").matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    if (sources.keepRowNumbers) {
      const rowRef = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? 0);
      // Разрыв в тысячи строк — признак мусорной строки далеко внизу листа:
      // такую пропускаем, иначе массив раздувается на пустом месте.
      if (rowRef > rows.length && rowRef - rows.length < 5000) {
        while (rows.length < rowRef - 1) rows.push([]);
      }
    }
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? null;
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const inline = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] ?? "";
      let value = raw;
      if (type === "s" && raw !== "") value = sharedStrings[Number(raw)] ?? "";
      if (type === "inlineStr") value = inline;
      const position = ref ? columnIndex(ref) - 1 : cells.length;
      while (cells.length < position) cells.push("");
      cells[position] = decodeXml(value);
    }
    rows.push(cells);
  }
  return rows;
}

/** Пути всех листов книги — УПД бывает многостраничной. */
export function sheetPaths(archiveNames) {
  return archiveNames.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
}

/**
 * Объединённые диапазоны листа: `<mergeCell ref="B2:B10"/>`.
 *
 * В раскладке склада номер ячейки обычно написан один раз на группу
 * артикулов объединённой ячейкой. Без разворота группа теряет адрес, и
 * сборщик этих артикулов не найдёт.
 *
 * @param {string} sheetXml
 * @returns {Array<{ top: number, left: number, bottom: number, right: number }>}
 */
export function mergedRanges(sheetXml) {
  const ranges = [];
  for (const match of String(sheetXml ?? "").matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
    ranges.push({
      left: columnIndex(match[1]) - 1,
      top: Number(match[2]),
      right: columnIndex(match[3]) - 1,
      bottom: Number(match[4]),
    });
  }
  return ranges;
}

/**
 * Копирует значение объединённой ячейки во все строки и столбцы диапазона.
 * Строки нумеруются с единицы, как на листе (см. keepRowNumbers).
 *
 * @param {string[][]} rows
 * @param {Array<{ top: number, left: number, bottom: number, right: number }>} ranges
 * @returns {number} сколько ячеек заполнено
 */
export function expandMerges(rows, ranges) {
  let filled = 0;
  for (const range of ranges ?? []) {
    const source = rows[range.top - 1]?.[range.left] ?? "";
    if (String(source).trim() === "") continue;
    for (let row = range.top; row <= range.bottom; row += 1) {
      const target = rows[row - 1];
      if (!target) continue;
      for (let column = range.left; column <= range.right; column += 1) {
        if (row === range.top && column === range.left) continue;
        while (target.length <= column) target.push("");
        if (String(target[column] ?? "").trim() === "") {
          target[column] = source;
          filled += 1;
        }
      }
    }
  }
  return filled;
}
