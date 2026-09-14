import assert from "node:assert/strict";
import { test } from "node:test";

import { CODE39, code39Svg, encodeCode39, sanitizeCode39, taskBarcodeValue } from "../lib/barcode39.mjs";

/** Элементы символа: чередование чёрных и белых полос. */
function elements(pattern) {
  const runs = pattern.match(/1+|0+/g) ?? [];
  return runs.map((run) => run.length);
}

test("таблица Code 39 без опечаток: 9 элементов, 12 модулей, 3 широких", () => {
  for (const [char, pattern] of Object.entries(CODE39)) {
    const parts = elements(pattern);
    assert.equal(parts.length, 9, `${char}: элементов ${parts.length}`);
    assert.equal(pattern.length, 12, `${char}: модулей ${pattern.length}`);
    assert.equal(parts.filter((width) => width === 3).length, 0, `${char}: элемент шириной 3 модуля`);
    assert.equal(parts.filter((width) => width === 2).length, 3, `${char}: широких ${parts.filter((w) => w === 2).length}`);
    // Символ начинается и заканчивается чёрной полосой.
    assert.equal(pattern[0], "1", `${char}: начинается пробелом`);
    assert.equal(pattern[pattern.length - 1], "1", `${char}: заканчивается пробелом`);
  }
});

test("все символы таблицы различны", () => {
  const patterns = Object.values(CODE39);
  assert.equal(new Set(patterns).size, patterns.length);
});

test("штрихкод обрамлён символом * и разделён узкими пробелами", () => {
  const bits = encodeCode39("T7");
  assert.ok(bits.startsWith(CODE39["*"]));
  assert.ok(bits.endsWith(CODE39["*"]));
  // Четыре символа (* T 7 *) плюс три разделителя по одному модулю.
  assert.equal(bits.length, 4 * 12 + 3);
});

test("непечатаемое в Code 39 заменяется, а не ломает штрихкод", () => {
  assert.equal(sanitizeCode39("2026-09-14-WB-КАЗАНЬ"), "2026-09-14-WB-------");
  assert.equal(sanitizeCode39("t7"), "T7");
});

test("код задания для штрихкода — короткий и латинский", () => {
  assert.equal(taskBarcodeValue(42), "T42");
  const svg = code39Svg(taskBarcodeValue(42), { moduleWidth: 2, height: 60 });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes("height=\"60\""));
  assert.ok(svg.includes("<rect"));
});
