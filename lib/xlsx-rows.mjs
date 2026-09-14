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
 * @param {{ sheetXml: string, sharedStringsXml?: string }} sources
 * @returns {string[][]} строки листа; пустые ячейки — пустые строки
 */
export function sheetRows(sources) {
  const sharedStrings = parseSharedStrings(sources.sharedStringsXml);
  const rows = [];
  for (const rowMatch of (sources.sheetXml ?? "").matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
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
