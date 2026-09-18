import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODE39,
  PICK_SHEET_CODE_LENGTH,
  code39Svg,
  encodeCode39,
  generatePickSheetCode,
  parsePickSheetScan,
  parseTaskBarcode,
  pickSheetCode,
  sanitizeCode39,
  taskBarcodeValue,
} from "../lib/barcode39.mjs";

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

test("скан листа подбора читается при любой раскладке", () => {
  assert.equal(parseTaskBarcode(taskBarcodeValue(42)), 42);
  assert.equal(parseTaskBarcode("t42"), 42);
  assert.equal(parseTaskBarcode("Е42"), 42); // T на русской раскладке
  assert.equal(parseTaskBarcode("*T7*"), 7);
  assert.equal(parseTaskBarcode(" T15 \n"), 15);
  assert.equal(parseTaskBarcode("6432600987653957"), null); // УИН
  assert.equal(parseTaskBarcode("T0"), null);
  assert.equal(parseTaskBarcode("TX1"), null);
});

test("код листа подбора: 12 цифр, каждый раз новый", () => {
  const codes = new Set();
  for (let index = 0; index < 500; index += 1) {
    const code = generatePickSheetCode();
    assert.match(code, /^[1-8]\d{11}$/);
    assert.equal(code.length, PICK_SHEET_CODE_LENGTH);
    codes.add(code);
  }
  // Повторов быть не должно: на этом держится «один лист — одно задание».
  assert.equal(codes.size, 500);
  // Девятка первой оставлена старым заданиям, которым код выдала миграция.
  assert.equal(pickSheetCode("900000000018"), "900000000018");
});

test("лист подбора узнаётся по коду, а УИН — нет", () => {
  assert.equal(pickSheetCode("482039157701"), "482039157701");
  assert.equal(pickSheetCode("*482039157701*"), "482039157701");
  assert.equal(pickSheetCode("6432600987653957"), null); // УИН, 16 цифр
  assert.equal(pickSheetCode("48203915770"), null); // на цифру короче
  assert.deepEqual(parsePickSheetScan("482039157701"), { code: "482039157701", taskId: null });
  // Листы, напечатанные до кода, читаются по номеру задания в базе.
  assert.deepEqual(parsePickSheetScan("T18"), { code: null, taskId: 18 });
  assert.deepEqual(parsePickSheetScan("Е18"), { code: null, taskId: 18 });
  assert.equal(parsePickSheetScan("6432600987653957"), null);
  assert.equal(taskBarcodeValue("482039157701"), "482039157701");
});
