/**
 * Правила формирования заданий на сборку — без базы и без сети.
 *
 * Вынесено отдельным файлом, чтобы нумерацию, деление на партии и маршрут по
 * ячейкам можно было проверять тестами (tests/warehouse-core.test.mjs), а не
 * на живом складе.
 */

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

/** Ключ раскладки: артикул и размер. Размер может отсутствовать. */
export function placementKey(article, size) {
  return `${String(article ?? "").trim().toUpperCase()}::${String(size ?? "").trim().toUpperCase()}`;
}

/**
 * Подставляет ячейку каждой строке.
 *
 * Сначала ищется точная пара «артикул + размер», потом раскладка на артикул
 * целиком: размеры одного артикула обычно лежат в одной ячейке.
 */
export function attachCells(items, placements) {
  const index = new Map();
  for (const placement of placements) {
    index.set(placementKey(placement.article, placement.size), placement);
  }
  return items.map((item) => {
    const exact = index.get(placementKey(item.article, item.size));
    const byArticle = exact ?? index.get(placementKey(item.article, null));
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
 * Разбор вставленной таблицы раскладки «артикул → ячейка».
 *
 * Сотрудник копирует два столбца из Google-таблицы и вставляет их в поле, либо
 * загружает CSV. Разделитель определяется сам: табуляция, точка с запятой или
 * запятая. Первая строка считается заголовком, только если это действительно
 * заголовок, а не данные.
 */
export function parsePlacementTable(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  const errors = [];
  if (lines.length === 0) return { rows, errors, skippedHeader: false };

  const delimiter = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delimiter).map((value) => value.toLowerCase());
  const looksLikeHeader = header.some((value) => /артикул|article|sku/.test(value))
    || header.some((value) => /ячей|cell|адрес/.test(value));
  const columns = looksLikeHeader ? mapColumns(header) : { article: 0, size: null, cell: 1 };
  const body = looksLikeHeader ? lines.slice(1) : lines;

  for (const [index, line] of body.entries()) {
    const parts = splitLine(line, delimiter);
    const article = clean(parts[columns.article]);
    const cell = clean(parts[columns.cell]);
    const size = columns.size === null ? "" : clean(parts[columns.size]);
    if (!article && !cell) continue;
    if (!article || !cell) {
      errors.push({ line: index + (looksLikeHeader ? 2 : 1), message: !article ? "нет артикула" : "нет ячейки" });
      continue;
    }
    rows.push({ article, size: size || null, cell });
  }

  // Один артикул лежит в одной ячейке: если он встретился дважды, остаётся
  // последняя строка — так вставка новой выгрузки перезаписывает старую.
  const unique = new Map();
  for (const row of rows) unique.set(placementKey(row.article, row.size), row);

  return { rows: [...unique.values()], errors, skippedHeader: looksLikeHeader, delimiter };
}

function clean(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

function detectDelimiter(line) {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  if (line.includes(",")) return ",";
  return "\t";
}

function splitLine(line, delimiter) {
  return String(line).split(delimiter);
}

function mapColumns(header) {
  const find = (pattern) => {
    const index = header.findIndex((value) => pattern.test(value));
    return index === -1 ? null : index;
  };
  return {
    article: find(/артикул|article|sku|номенклат/) ?? 0,
    size: find(/размер|size/),
    cell: find(/ячей|cell|адрес|место/) ?? 1,
  };
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
