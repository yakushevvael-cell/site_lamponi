import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { applyMigrations } from "../lib/migrate.mjs";
import {
  TOKEN_PREFIX,
  bearerToken,
  buildTaskLines,
  generateToken,
  hashToken,
  knownRegistryQuery,
  normalizeBarcode,
  parseKnownRange,
  parseRegistryItem,
  parseTaskAck,
  taskVersion,
  tokenHint,
} from "../lib/onec-core.mjs";
import { openDatabase } from "../lib/sqlite-d1.mjs";

test("ключ 1С: случайный, с префиксом, в базе только хеш", () => {
  const first = generateToken();
  const second = generateToken();
  assert.ok(first.startsWith(TOKEN_PREFIX));
  assert.ok(first.length >= TOKEN_PREFIX.length + 40);
  assert.notEqual(first, second);
  assert.equal(hashToken(first), hashToken(first));
  assert.notEqual(hashToken(first), hashToken(second));
  assert.ok(!hashToken(first).includes(first));
  assert.equal(tokenHint("lmp1c_abcdWXYZ"), "WXYZ");
});

test("ключ берётся только из заголовка Bearer", () => {
  assert.equal(bearerToken("Bearer lmp1c_abc"), "lmp1c_abc");
  assert.equal(bearerToken("bearer   lmp1c_abc  "), "lmp1c_abc");
  assert.equal(bearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(bearerToken("Bearer"), null);
  assert.equal(bearerToken(null), null);
});

test("ШК бирки: EAN-13 со сканера сходится с 12 цифрами кода 1С", () => {
  assert.equal(normalizeBarcode("2000000123451"), "200000012345");
  assert.equal(normalizeBarcode(" 200000012345 "), "200000012345");
  assert.equal(normalizeBarcode("ABC-1"), "ABC-1");
});

test("строка регистра без ШК, УИН или артикула не принимается", () => {
  assert.deepEqual(
    parseRegistryItem({ barcode: "200000012345", ean13: "2000000123451", uin: " 1234567890123456 ", article: "К-1298з", size: "17,5" }),
    { barcode: "200000012345", uin: "1234567890123456", article: "К-1298з", size: "17,5" },
  );
  assert.deepEqual(
    parseRegistryItem({ barcode: "2000000123451", uin: "1", article: "С-1", size: "" }),
    { barcode: "200000012345", uin: "1", article: "С-1", size: null },
  );
  assert.equal(parseRegistryItem({ barcode: "", uin: "1", article: "С-1" }), null);
  assert.equal(parseRegistryItem({ barcode: "200000012345", uin: "", article: "С-1" }), null);
  assert.equal(parseRegistryItem({ barcode: "200000012345", uin: "1", article: "  " }), null);
  assert.equal(parseRegistryItem(null), null);
});

test("диапазон known: обе границы или ни одной, только цифры, from не больше to", () => {
  const range = (query) => parseKnownRange(new URLSearchParams(query));
  assert.deepEqual(range(""), { range: null });
  assert.deepEqual(range("from=970000000001&to=970000050000"), { range: { from: "970000000001", to: "970000050000" } });
  // EAN-13 со сканера приводится к 12 цифрам кода 1С, как и в регистре.
  assert.deepEqual(range("from=9700000000013&to=+970000050000+"), { range: { from: "970000000001", to: "970000050000" } });
  assert.deepEqual(range("from=970000000001&to=970000000001"), { range: { from: "970000000001", to: "970000000001" } });
  assert.ok("error" in range("from=970000000001"));
  assert.ok("error" in range("to=970000000001"));
  assert.ok("error" in range("from=&to=970000000001"));
  assert.ok("error" in range("from=97-1&to=970000000001"));
  assert.ok("error" in range("from=970000050000&to=970000000001"));
});

test("known по диапазону: границы включительно, по возрастанию, по первичному ключу", async () => {
  const db = openDatabase(":memory:");
  await applyMigrations(db, join(import.meta.dirname, "..", "drizzle"));
  await db.batch(["920000243279", "970000000001", "970000000002", "970000049999", "970000050000", "970000050001"].map(
    (barcode, index) => db.prepare("INSERT INTO dmdk_registry_items (barcode, uin, article) VALUES (?, ?, 'С-1')").bind(barcode, `U${index}`),
  ));
  const read = async (range) => {
    const query = knownRegistryQuery(range);
    return (await db.prepare(query.sql).bind(...query.params).all()).results.map((row) => row.barcode);
  };

  assert.deepEqual(await read({ from: "970000000001", to: "970000050000" }),
    ["970000000001", "970000000002", "970000049999", "970000050000"]);
  assert.deepEqual(await read({ from: "970000050002", to: "970000099999" }), []);
  assert.equal((await read(null)).length, 6);

  // Два миллиона строк: порция должна искаться по индексу, а не просмотром таблицы.
  const query = knownRegistryQuery({ from: "970000000001", to: "970000050000" });
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all()).results
    .map((row) => row.detail).join("\n");
  assert.match(plan, /SEARCH dmdk_registry_items USING .*barcode>\? AND barcode<\?/);
});

test("строки задания: только отсканированные изделия, по порядку, цена на изделие", () => {
  const scanned = "2026-09-29T10:00:00.000Z";
  const lines = buildTaskLines([
    { id: 3, uin: "U3", scannedAt: scanned, barcode: "2000000000031", unitPrice: 1990.499 },
    { id: 1, uin: "U1", scannedAt: scanned, barcode: "200000000001", unitPrice: 3490 },
    { id: 2, uin: null, scannedAt: null, barcode: null, unitPrice: 100 },
    { id: 4, uin: "U4", scannedAt: scanned, barcode: null, unitPrice: null },
    // УИН закреплён сверкой УПД, но изделие ещё не сканировали — не собрано.
    { id: 5, uin: "U5", scannedAt: null, barcode: "200000000005", unitPrice: 500 },
  ]);
  assert.deepEqual(lines, [
    { barcode: "200000000001", uin: "U1", sum: 3490 },
    { barcode: "200000000003", uin: "U3", sum: 1990.5 },
    { barcode: "", uin: "U4", sum: 0 },
  ]);
});

test("версия задания меняется со статусом, составом и ценой", () => {
  const lines = [{ barcode: "200000000001", uin: "U1", sum: 3490 }];
  const base = taskVersion("issued", lines);
  assert.equal(base, taskVersion("issued", [{ ...lines[0] }]));
  assert.notEqual(base, taskVersion("picked", lines));
  assert.notEqual(base, taskVersion("issued", [{ ...lines[0], sum: 3000 }]));
  assert.notEqual(base, taskVersion("issued", [...lines, { barcode: "200000000002", uin: "U2", sum: 0 }]));
});

test("ответ 1С по заданию", () => {
  assert.deepEqual(
    parseTaskAck({ id: 15, version: "abc", ok: true, document: "uuid", documentNumber: "0000123", documentDate: "2026-09-28T10:15:00", message: "ok" }),
    { id: 15, version: "abc", ok: true, document: "uuid", documentNumber: "0000123", documentDate: "2026-09-28T10:15:00", message: "ok" },
  );
  assert.equal(parseTaskAck({ id: 15, ok: "true" })?.ok, false);
  assert.equal(parseTaskAck({ id: 0 }), null);
  assert.equal(parseTaskAck({}), null);
});
