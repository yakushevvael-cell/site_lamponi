/**
 * Разбор листа Excel с раскладкой.
 *
 * Распаковка архива здесь не участвует — она в lib/placement-parser.ts и
 * зависит от fflate. Проверяется то, из-за чего терялась половина раскладки:
 * номера строк, объединённые ячейки и склейка с разбором пар.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { expandMerges, mergedRanges, sheetRows } from "../lib/xlsx-rows.mjs";
import { parsePlacementRows } from "../lib/warehouse-core.mjs";

function sheet(rows, merges = []) {
  const cells = rows
    .map(([number, values]) =>
      `<row r="${number}">${values
        .map((value, index) => `<c r="${String.fromCharCode(65 + index)}${number}" t="inlineStr"><is><t>${value}</t></is></c>`)
        .join("")}</row>`)
    .join("");
  const merged = merges.length > 0
    ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
    : "";
  return `<worksheet><sheetData>${cells}</sheetData>${merged}</worksheet>`;
}

test("номера строк листа сохраняются, пустые строки не съедаются", () => {
  const xml = sheet([[1, ["Раскладка"]], [3, ["Артикул", "Ячейка"]], [4, ["ART-1", "1"]]]);
  const rows = sheetRows({ sheetXml: xml, keepRowNumbers: true });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], []);
  assert.deepEqual(rows[2], ["Артикул", "Ячейка"]);

  const collapsed = sheetRows({ sheetXml: xml });
  assert.equal(collapsed.length, 3);
});

test("объединённая ячейка разворачивается на всю группу", () => {
  const xml = sheet(
    [
      [1, ["Артикул", "Ячейка"]],
      [2, ["ART-1", "7"]],
      [3, ["ART-2"]],
      [4, ["ART-3"]],
      [5, ["ART-4", "8"]],
    ],
    ["B2:B4"],
  );
  const rows = sheetRows({ sheetXml: xml, keepRowNumbers: true });
  assert.equal(mergedRanges(xml).length, 1);
  assert.equal(expandMerges(rows, mergedRanges(xml)), 2);

  const parsed = parsePlacementRows(rows);
  assert.equal(parsed.headerRow, 1);
  assert.deepEqual(parsed.rows, [
    { article: "ART-1", size: null, cell: "7" },
    { article: "ART-2", size: null, cell: "7" },
    { article: "ART-3", size: null, cell: "7" },
    { article: "ART-4", size: null, cell: "8" },
  ]);
  assert.equal(parsed.carried, 0);
});

test("объединение не затирает уже заполненные ячейки", () => {
  const xml = sheet([[1, ["ART-1", "7"]], [2, ["ART-2", "9"]]], ["B1:B2"]);
  const rows = sheetRows({ sheetXml: xml, keepRowNumbers: true });
  expandMerges(rows, mergedRanges(xml));
  assert.equal(rows[1][1], "9");
});

test("длинный лист из 422 ячеек по несколько артикулов разбирается целиком", () => {
  const rows = [[1, ["Артикул", "Ячейка"]]];
  let line = 2;
  for (let cell = 1; cell <= 422; cell += 1) {
    for (let item = 1; item <= 3; item += 1) {
      rows.push([line, item === 1 ? [`ART-${cell}-${item}`, String(cell)] : [`ART-${cell}-${item}`]]);
      line += 1;
    }
  }
  const xml = sheet(rows);
  const parsed = parsePlacementRows(sheetRows({ sheetXml: xml, keepRowNumbers: true }));
  assert.equal(parsed.rows.length, 422 * 3);
  assert.equal(parsed.carried, 422 * 2);
  assert.equal(new Set(parsed.rows.map((row) => row.cell)).size, 422);
  assert.equal(parsed.rows.at(-1).cell, "422");
});
