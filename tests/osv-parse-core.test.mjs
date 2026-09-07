import assert from "node:assert/strict";
import test from "node:test";

import { parseOsvSheet } from "../lib/osv-parse-core.mjs";

/**
 * Мини-конструктор листа. Стили заданы так же, как их выгружает 1С:
 *  - стиль 1 — заголовок (полужирный),
 *  - стиль 3 — строка счёта или итога (полужирный, другой шрифт),
 *  - стиль 7 — строка номенклатуры (полужирный),
 *  - стиль 10 — строка размера (обычный).
 */
const STYLES_XML = `
<styleSheet>
  <fonts count="4">
    <font><sz val="11"/></font>
    <font><sz val="8"/><name val="Arial"/></font>
    <font><b/><sz val="10"/><name val="Arial"/></font>
    <font><b/><sz val="8"/><name val="Arial"/></font>
  </fonts>
  <cellXfs count="11">
    <xf fontId="0"/><xf fontId="2"/><xf fontId="2"/><xf fontId="2"/>
    <xf fontId="0"/><xf fontId="0"/><xf fontId="0"/>
    <xf fontId="3"/>
    <xf fontId="0"/><xf fontId="0"/>
    <xf fontId="1"/>
  </cellXfs>
</styleSheet>`;

function sheet(rows) {
  const xml = rows.map((cells, rowIndex) => {
    const number = rowIndex + 1;
    const body = cells.map(([column, value, style]) => {
      if (value === null || value === undefined) return `<c r="${column}${number}" s="${style}"/>`;
      const isText = typeof value === "string";
      return isText
        ? `<c r="${column}${number}" s="${style}" t="inlineStr"><is><t>${value}</t></is></c>`
        : `<c r="${column}${number}" s="${style}"><v>${value}</v></c>`;
    }).join("");
    return `<row r="${number}">${body}</row>`;
  }).join("");
  return `<worksheet><sheetData>${xml}</sheetData></worksheet>`;
}

/** Шапка как в реальной выгрузке: группы в объединённых ячейках B1:C1, D1:E1, F1:G1. */
const HEADER = [
  [["A", "Счет, Наименование", 1], ["B", "Сальдо начальное", 2], ["D", "Обороты", 2], ["F", "Сальдо конечное", 2]],
  [["A", "Субконто3", 1], ["B", "Дт", 1], ["C", "Кт", 1], ["D", "Дт", 1], ["E", "Кт", 1], ["F", "Дт", 1], ["G", "Кт", 1]],
  [["A", "Субконто4", 1], ["B", "Количество", 1], ["C", "Количество", 1], ["D", "Количество", 1], ["E", "Количество", 1], ["F", "Количество", 1], ["G", "Количество", 1]],
];

function parse(dataRows) {
  return parseOsvSheet({
    sheetXml: sheet([...HEADER, ...dataRows]),
    stylesXml: STYLES_XML,
    sheetName: "Лист1",
  });
}

test("колонка количества берётся из заголовка «Сальдо конечное / Дт / Количество»", () => {
  const result = parse([
    [["A", "0.СГП.1, Склад ГП упакованный", 3], ["B", 10, 3], ["F", 7, 3]],
    [["A", "П-3120з", 7], ["B", 10, 7], ["F", 7, 7]],
    [["A", "<Пустое субконто4>", 10], ["B", 10, 10], ["F", 7, 10]],
    [["A", "Итого", 3], ["B", 10, 3], ["F", 7, 3]],
  ]);
  assert.equal(result.quantityColumn, "F");
  assert.equal(result.headerRowNumber, 3);
  assert.equal(result.totalQuantity, 7);
  assert.equal(result.reportedTotal, 7);
  assert.deepEqual(result.blockers, []);
});

test("размеры, начинающиеся с цифры, не принимаются за строку счёта", () => {
  // Именно на «16,0 +» ломалась привязка к содержимому строки.
  const result = parse([
    [["A", "0.СГП.1, Склад ГП упакованный", 3], ["F", 33, 3]],
    [["A", "П-3120", 7], ["F", 33, 7]],
    [["A", "16,0 +", 10], ["F", 9, 10]],
    [["A", "18,0 +", 10], ["F", 19, 10]],
    [["A", "35,0 +", 10], ["F", 5, 10]],
    [["A", "Итого", 3], ["F", 33, 3]],
  ]);
  assert.equal(result.variantCount, 3);
  assert.equal(result.sizedVariantCount, 3);
  assert.equal(result.totalQuantity, 33);
  assert.deepEqual(result.products.map((item) => item.size), ["16,0 +", "18,0 +", "35,0 +"]);
  assert.deepEqual(result.blockers, []);
});

test("<Пустое субконто4> даёт позицию без размера", () => {
  const result = parse([
    [["A", "0.СГП.1, Склад", 3], ["F", 4, 3]],
    [["A", "Б-1316зр", 7], ["F", 4, 7]],
    [["A", "<Пустое субконто4>", 10], ["F", 4, 10]],
    [["A", "Итого", 3], ["F", 4, 3]],
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].size, null);
  assert.equal(result.products[0].variantKey, "Б-1316зр");
});

test("одинаковые сочетания артикул+размер складываются", () => {
  const result = parse([
    [["A", "0.СГП.1, Склад", 3], ["F", 5, 3]],
    [["A", "П-1", 7], ["F", 5, 7]],
    [["A", "40", 10], ["F", 2, 10]],
    [["A", "40", 10], ["F", 3, 10]],
    [["A", "Итого", 3], ["F", 5, 3]],
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].quantity, 5);
  assert.ok(result.warnings.some((text) => text.includes("Объединено повторяющихся")));
});

test("несходимость итога попадает в блокирующие расхождения", () => {
  const result = parse([
    [["A", "0.СГП.1, Склад", 3], ["F", 100, 3]],
    [["A", "П-1", 7], ["F", 5, 7]],
    [["A", "40", 10], ["F", 5, 10]],
    [["A", "Итого", 3], ["F", 100, 3]],
  ]);
  assert.equal(result.totalQuantity, 5);
  assert.equal(result.reportedTotal, 100);
  assert.equal(result.blockers.length, 1);
  assert.ok(result.blockers[0].includes("не совпадает с итогом"));
});

test("сумма размеров, не сошедшаяся со строкой артикула, тоже блокирует", () => {
  const result = parse([
    [["A", "0.СГП.1, Склад", 3], ["F", 5, 3]],
    [["A", "П-1", 7], ["F", 9, 7]],
    [["A", "40", 10], ["F", 5, 10]],
    [["A", "Итого", 3], ["F", 5, 3]],
  ]);
  assert.ok(result.blockers.some((text) => text.includes("не сошлась со строкой артикула")));
});

test("перенумерация стилей не ломает разбор", () => {
  // Те же данные, но индексы стилей сдвинуты: жирный артикул теперь 2, размер 8.
  const shifted = parseOsvSheet({
    sheetXml: sheet([
      [["A", "Счет, Наименование", 1], ["F", "Сальдо конечное", 1]],
      [["A", "Субконто3", 1], ["F", "Дт", 1]],
      [["A", "Субконто4", 1], ["F", "Количество", 1]],
      [["A", "0.СГП.1, Склад", 1], ["F", 6, 1]],
      [["A", "П-3120з", 2], ["F", 6, 2]],
      [["A", "<Пустое субконто4>", 8], ["F", 6, 8]],
      [["A", "Итого", 1], ["F", 6, 1]],
    ]),
    stylesXml: STYLES_XML,
    sheetName: "Лист1",
  });
  assert.equal(shifted.variantCount, 1);
  assert.equal(shifted.totalQuantity, 6);
  assert.deepEqual(shifted.blockers, []);
});

test("отчёт без строк размеров отвергается понятной ошибкой", () => {
  assert.throws(
    () => parse([
      [["A", "0.СГП.1, Склад", 3], ["F", 1, 3]],
      [["A", "П-1", 7], ["F", 1, 7]],
      [["A", "П-2", 7], ["F", 1, 7]],
    ]),
    /номенклатуры и размеров/,
  );
});

test("пустой лист отвергается", () => {
  assert.throws(() => parseOsvSheet({ sheetXml: "<worksheet/>" }), /пуст/);
});
