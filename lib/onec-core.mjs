/**
 * Обмен с 1С: чистая логика без базы и сети — её проверяют юнит-тесты.
 *
 * 1С (внешняя обработка «ОбменFBSLamponi») сама ходит на сайт по расписанию:
 * отдаёт регистр «ШК -> УИН, артикул, размер» и забирает задания на сборку,
 * по которым создаёт черновики «Расход ГП».
 */
import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "lmp1c_";

/** Новый ключ обмена: префикс, чтобы его узнавали в логах и настройках, и 32 случайных байта. */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** В базе лежит только хеш: утёкшая база не даёт войти как 1С. */
export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** Последние символы ключа — чтобы в настройках было видно, какой ключ выпущен. */
export function tokenHint(token) {
  return String(token).slice(-4);
}

/** Ключ из заголовка `Authorization: Bearer <ключ>`; всё прочее — нет ключа. */
export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ""));
  return match ? match[1] : null;
}

/**
 * ШК бирки в том виде, в каком он хранится в 1С: 12 цифр (Код справочника
 * «Штрихкод»). Сканер читает EAN-13 — у него контрольная цифра в конце лишняя.
 */
export function normalizeBarcode(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  if (/^\d{13}$/.test(text)) return text.slice(0, 12);
  return text;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, maxLength);
}

/** Строка регистра из 1С или null, если без ШК, УИН или артикула её не сопоставить. */
export function parseRegistryItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const barcode = normalizeBarcode(cleanText(raw.barcode, 64));
  const uin = cleanText(raw.uin, 64).replace(/\s+/g, "");
  const article = cleanText(raw.article, 200);
  const size = cleanText(raw.size, 50);
  if (!barcode || !uin || !article) return null;
  return { barcode, uin, article, size: size || null };
}

/** Граница диапазона в `known`: 12 цифр кода 1С или 13 цифр EAN-13. */
const RANGE_BARCODE = /^\d{1,13}$/;

/**
 * Диапазон кодов для `GET /api/onec/registry/known?from=&to=`. При сверке 1С
 * спрашивает только ШК своей порции: в регистре около двух миллионов строк,
 * и гонять его целиком на каждую порцию нельзя.
 *
 * Обе границы включительно, сравнение строковое: коды 1С одной длины, так что
 * оно совпадает с числовым. Без параметров — весь регистр, как раньше; одна
 * граница без другой — ошибка, а не молча весь регистр.
 *
 * @param {URLSearchParams} params
 * @returns {{ range: { from: string, to: string } | null } | { error: string }}
 */
export function parseKnownRange(params) {
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  if (rawFrom === null && rawTo === null) return { range: null };
  if (rawFrom === null || rawTo === null) return { error: "Нужны оба параметра: from и to." };
  const from = normalizeBarcode(rawFrom);
  const to = normalizeBarcode(rawTo);
  if (!RANGE_BARCODE.test(from) || !RANGE_BARCODE.test(to)) {
    return { error: "from и to — коды ШК из цифр." };
  }
  if (from > to) return { error: "from больше to." };
  return { range: { from, to } };
}

/**
 * Запрос «что из регистра уже есть на сайте». С диапазоном идёт по первичному
 * ключу `barcode` и читает только строки порции.
 *
 * @param {{ from: string, to: string } | null} range
 */
export function knownRegistryQuery(range) {
  if (!range) {
    return { sql: "SELECT barcode, uin FROM dmdk_registry_items ORDER BY barcode", params: [] };
  }
  return {
    sql: "SELECT barcode, uin FROM dmdk_registry_items WHERE barcode BETWEEN ? AND ? ORDER BY barcode",
    params: [range.from, range.to],
  };
}

/** Статусы задания, которые уходят в 1С. «created» — задание ещё не выдано, документа нет. */
export const ONEC_TASK_STATUSES = ["issued", "picked", "shipped", "cancelled"];

/**
 * Строки задания для 1С: одно отсканированное изделие — одна строка.
 * Не отсканированные изделия в документ не попадают: их ещё не собрали. УИН
 * у строки может быть и без скана — его закрепляет сверка УПД, — поэтому
 * признак сборки — время скана, а не наличие УИН.
 *
 * @param {Array<{ id: number, uin: string | null, scannedAt: string | null, barcode: string | null, unitPrice: number | null }>} items
 */
export function buildTaskLines(items) {
  return items
    .filter((item) => Boolean(item.scannedAt) && typeof item.uin === "string" && item.uin.trim() !== "")
    .slice()
    .sort((left, right) => left.id - right.id)
    .map((item) => ({
      barcode: item.barcode ? normalizeBarcode(item.barcode) : "",
      uin: item.uin.trim(),
      sum: roundMoney(item.unitPrice),
    }));
}

export function roundMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

/**
 * Версия задания — отпечаток того, что уходит в 1С. Меняется, когда меняется
 * статус, состав отсканированных изделий или цена; 1С возвращает её в ответе,
 * и пока она совпадает с подтверждённой, задание в 1С повторно не отдаётся.
 */
export function taskVersion(status, lines) {
  const fingerprint = JSON.stringify({ status, lines: lines.map((line) => [line.barcode, line.uin, line.sum]) });
  return createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16);
}

/** Ответ 1С по заданию, приведённый к тому, что сохраняется в базе. */
export function parseTaskAck(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    version: cleanText(raw.version, 64),
    ok: raw.ok === true,
    document: cleanText(raw.document, 64),
    documentNumber: cleanText(raw.documentNumber, 50),
    documentDate: cleanText(raw.documentDate, 30),
    message: cleanText(raw.message, 2000),
  };
}
