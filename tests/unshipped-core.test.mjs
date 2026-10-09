import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMoscow, moscowInputToTime, parseUtc, timeToMoscowInput, toCsv, wasAwaitingAt } from "../lib/unshipped-core.mjs";

const cutoff = Date.parse("2026-10-05T11:00:00Z"); // 05.10.2026 14:00 по Москве

test("время из поля формы читается по Москве", () => {
  assert.equal(moscowInputToTime("2026-10-05T14:00"), cutoff);
  assert.equal(timeToMoscowInput(cutoff), "2026-10-05T14:00");
  assert.equal(moscowInputToTime("2026-02-31T10:00"), null);
  assert.equal(moscowInputToTime("2026-10-05T25:00"), null);
  assert.equal(moscowInputToTime("вчера"), null);
});

test("строка без часового пояса из SQLite — это UTC", () => {
  assert.equal(parseUtc("2026-10-05 11:00:00"), cutoff);
  assert.equal(parseUtc("2026-10-05T11:00:00.000Z"), cutoff);
  assert.equal(parseUtc("2026-10-05T14:00:00+03:00"), cutoff);
  assert.equal(parseUtc(null), null);
  assert.equal(formatMoscow("2026-10-05T11:00:00Z"), "05.10.2026 14:00");
});

test("ждал отгрузки: оформлен до среза, передан после", () => {
  const order = { orderedAt: "2026-10-04T08:00:00Z", handedOverAt: "2026-10-05T12:30:00Z" };
  assert.equal(wasAwaitingAt(order, cutoff), true);
});

test("не ждал: передан, отгружен, доставлен или отменён до среза", () => {
  const base = { orderedAt: "2026-10-04T08:00:00Z" };
  assert.equal(wasAwaitingAt({ ...base, handedOverAt: "2026-10-05T10:59:00Z" }, cutoff), false);
  assert.equal(wasAwaitingAt({ ...base, shippedAt: "2026-10-05T09:00:00Z" }, cutoff), false);
  assert.equal(wasAwaitingAt({ ...base, deliveredAt: "2026-10-05T09:00:00Z" }, cutoff), false);
  assert.equal(wasAwaitingAt({ ...base, canceledAt: "2026-10-04T20:00:00Z" }, cutoff), false);
});

test("отменён после среза — на срез ещё ждал; оформлен после среза — нет", () => {
  assert.equal(wasAwaitingAt({ orderedAt: "2026-10-04T08:00:00Z", canceledAt: "2026-10-06T08:00:00Z" }, cutoff), true);
  assert.equal(wasAwaitingAt({ orderedAt: "2026-10-05T11:00:00Z" }, cutoff), false);
  assert.equal(wasAwaitingAt({ orderedAt: "" }, cutoff), false);
});

test("CSV: BOM, «;» и кавычки там, где нужно", () => {
  const csv = toCsv(["Номер", "Товары"], [["1", "Кольцо; р.17"], ["2", 'Серьги "Луна"']]);
  assert.equal(csv, '﻿Номер;Товары\r\n1;"Кольцо; р.17"\r\n2;"Серьги ""Луна"""\r\n');
});
