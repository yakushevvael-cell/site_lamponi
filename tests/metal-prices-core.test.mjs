import assert from "node:assert/strict";
import { test } from "node:test";

import { extractMetalPrices, parseQuoteNumber, parseQuoteRow } from "../lib/metal-prices-core.mjs";

// Ячейки как на живой странице 16.09.2026.
const ROWS = [
  ["Type", "Bid", "Ask", "Last", "Diff*", "Chg.", "Chg.%", "Time"],
  ["XAU/RUB", "11 785.25", "11 789.34", "11 787.37", "", "148.64", "1.28%", "14:41:13"],
  ["XAG/RUB", "175.70", "175.80", "175.75", "", "3.11", "1.80%", "14:41:13"],
  ["XPT/RUB", "4 844.27", "4 855.36", "4 849.84", "", "24.30", "0.50%", "14:41:13"],
  ["XAU/USD", "139.83", "139.85", "139.84", "", "1.84", "1.33%", "14:41:12"],
];

test("числа с пробелами тысяч, запятой и знаком минус", () => {
  assert.equal(parseQuoteNumber("11 787.37"), 11787.37);
  assert.equal(parseQuoteNumber("11 787,37"), 11787.37);
  assert.equal(parseQuoteNumber("−148.64"), -148.64);
  assert.equal(parseQuoteNumber("1.28%"), 1.28);
  assert.equal(parseQuoteNumber(""), null);
  assert.equal(parseQuoteNumber("—"), null);
});

test("золото и серебро за грамм берутся из рублёвых строк, не долларовых", () => {
  const result = extractMetalPrices(ROWS);
  assert.equal(result.ok, true);
  assert.equal(result.gold.last, 11787.37);
  assert.equal(result.gold.change, 148.64);
  assert.equal(result.gold.changePercent, 1.28);
  assert.equal(result.gold.time, "14:41:13");
  assert.equal(result.silver.last, 175.75);
});

test("пустая таблица (скрипт страницы не успел) — ошибка, а не ноль", () => {
  const result = extractMetalPrices([["XAU/RUB", "", "", "", "", "", "", ""]]);
  assert.equal(result.ok, false);
  assert.match(result.error, /XAU\/RUB/);
  assert.match(result.error, /XAG\/RUB/);
});

test("цена вне разумных границ отклоняется", () => {
  const broken = ROWS.map((cells) => (cells[0] === "XAG/RUB" ? ["XAG/RUB", "", "", "175 750.00", "", "", "", ""] : cells));
  assert.equal(extractMetalPrices(broken).ok, false);
  assert.equal(parseQuoteRow(["XAU/RUB", "1"]), null);
});
