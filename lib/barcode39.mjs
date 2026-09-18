/**
 * Штрихкод Code 39 без внешних библиотек.
 *
 * Номер задания печатается на листе подбора крупно и дублируется штрихкодом
 * (ТЗ, п. 3). Code 39 выбран потому, что читается любым сканером без
 * настройки, кодирует цифры и латиницу и не требует контрольной суммы —
 * тянуть в проект пакет ради одного штрихкода не за чем.
 *
 * В самом штрихкоде едет короткий код задания (T + номер в базе): русские
 * буквы в названиях складов Code 39 не кодирует, а человек читает номер
 * глазами — он напечатан рядом крупным шрифтом.
 */

/** Каждый символ — 12 модулей: девять элементов, ровно три из них широкие. */
export const CODE39 = {
  "0": "101001101101",
  "1": "110100101011",
  "2": "101100101011",
  "3": "110110010101",
  "4": "101001101011",
  "5": "110100110101",
  "6": "101100110101",
  "7": "101001011011",
  "8": "110100101101",
  "9": "101100101101",
  A: "110101001011",
  B: "101101001011",
  C: "110110100101",
  D: "101011001011",
  E: "110101100101",
  F: "101101100101",
  G: "101010011011",
  H: "110101001101",
  I: "101101001101",
  J: "101011001101",
  K: "110101010011",
  L: "101101010011",
  M: "110110101001",
  N: "101011010011",
  O: "110101101001",
  P: "101101101001",
  Q: "101010110011",
  R: "110101011001",
  S: "101101011001",
  T: "101011011001",
  U: "110010101011",
  V: "100110101011",
  W: "110011010101",
  X: "100101101011",
  Y: "110010110101",
  Z: "100110110101",
  "-": "100101011011",
  ".": "110010101101",
  " ": "100110101101",
  $: "100100100101",
  "/": "100100101001",
  "+": "100101001001",
  "%": "101001001001",
  "*": "100101101101",
};

/** Что Code 39 не кодирует, в штрихкод не попадает: заменяем на дефис. */
export function sanitizeCode39(value) {
  return String(value ?? "")
    .toUpperCase()
    .split("")
    .map((char) => (CODE39[char] && char !== "*" ? char : "-"))
    .join("");
}

/** Длина кода листа подбора: 12 цифр набираются руками без ошибок и не похожи на УИН (16). */
export const PICK_SHEET_CODE_LENGTH = 12;

/**
 * Новый код листа подбора: 12 цифр, первая — от 1 до 8.
 *
 * Код у каждого задания свой и не повторяется: на нём держится вся работа со
 * столом упаковки и поставками, а перепечатка листа код не меняет.
 * Девятка зарезервирована за старыми заданиями, которым код выдала миграция,
 * ноль первым не ставим — сканер и человек читают его как пустое место.
 *
 * @returns {string}
 */
export function generatePickSheetCode() {
  let code = String(1 + Math.floor(Math.random() * 8));
  while (code.length < PICK_SHEET_CODE_LENGTH) code += String(Math.floor(Math.random() * 10));
  return code;
}

/** Код листа подбора, если строка им является: 12 цифр. */
export function pickSheetCode(value) {
  const text = String(value ?? "").trim().replace(/^\*/, "").replace(/\*$/, "").replace(/\s+/g, "");
  return new RegExp(`^\\d{${PICK_SHEET_CODE_LENGTH}}$`).test(text) ? text : null;
}

/** Короткий код задания для штрихкода: код листа, а для старых заданий — номер в базе. */
export function taskBarcodeValue(taskOrCode) {
  const code = pickSheetCode(taskOrCode);
  return code ?? `T${Number(taskOrCode)}`;
}

/**
 * Лист подбора из скана.
 *
 * Возвращает либо код листа (12 цифр), либо номер задания в базе со старого
 * листа вида «T18»: такие листы уже напечатаны и работать с ними надо.
 * Сканер «печатает» штрихкод как клавиатура: при русской раскладке T
 * превращается в «Е», а при латинской может прийти строчная t. УИН (16 цифр)
 * листом подбора не считается.
 *
 * @param {string | null | undefined} value
 * @returns {{ code: string | null, taskId: number | null } | null}
 */
export function parsePickSheetScan(value) {
  const code = pickSheetCode(value);
  if (code) return { code, taskId: null };
  const text = String(value ?? "").trim();
  const match = text.match(/^\*?[TtТтЕе](\d{1,9})\*?$/u);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? { code: null, taskId: id } : null;
}

/**
 * Номер задания из скана старого листа подбора.
 *
 * Оставлено для листов, напечатанных до появления кода: там в штрихкоде едет
 * номер задания в базе.
 *
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
export function parseTaskBarcode(value) {
  const scan = parsePickSheetScan(value);
  return scan?.taskId ?? null;
}

/** Строка из нулей и единиц: 1 — чёрный модуль. */
export function encodeCode39(value) {
  const text = sanitizeCode39(value);
  const parts = ["*", ...text.split(""), "*"].map((char) => CODE39[char]);
  // Между символами — один узкий пробел, иначе сканер видит один длинный символ.
  return parts.join("0");
}

/**
 * SVG штрихкода. Возвращается разметка, а не картинка: печать идёт из
 * браузера, и векторный штрихкод не мылится на термопринтере.
 *
 * @param {string} value
 * @param {{ moduleWidth?: number, height?: number }} [options]
 * @returns {string}
 */
export function code39Svg(value, options = {}) {
  const moduleWidth = Number(options.moduleWidth ?? 2);
  const height = Number(options.height ?? 70);
  const bits = encodeCode39(value);
  const width = bits.length * moduleWidth;
  const rects = [];
  let index = 0;
  while (index < bits.length) {
    if (bits[index] === "0") {
      index += 1;
      continue;
    }
    let run = 0;
    while (index + run < bits.length && bits[index + run] === "1") run += 1;
    rects.push(`<rect x="${index * moduleWidth}" y="0" width="${run * moduleWidth}" height="${height}" />`);
    index += run;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="#000" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
