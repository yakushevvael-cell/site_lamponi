import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSendable,
  buildSendableRow,
  computeAvailable,
  marketplaceAmount,
} from "../lib/stock-math.mjs";

const base = { osvQty: 1, reserveQty: 0, safetyStock: 0 };
const marketplaces = ["wildberries", "ozon", "yandex"];

function sentFor(marketplaceId, basis) {
  return buildSendableRow({
    marketplaceId,
    warehouseId: "1",
    externalSku: "1001",
    ...basis,
  }).sentQty;
}

test("сценарий 1: ОСВ 1, резерв 0 — на склад уходит 1", () => {
  assert.equal(computeAvailable(base), 1);
  assert.equal(marketplaceAmount(base), 1);
});

test("сценарий 2: ОСВ 1, резерв 1 и больше — уходит 0", () => {
  assert.equal(computeAvailable({ ...base, reserveQty: 1 }), 0);
  assert.equal(computeAvailable({ ...base, reserveQty: 5 }), 0);
  assert.equal(marketplaceAmount({ ...base, reserveQty: 5 }), 0);
});

test("на WB, Ozon и Маркет уходит одно и то же число: ОСВ − резерв − страховой", () => {
  // Пример из обсуждения: ОСВ 10, резерв 2 — раньше в Ozon уходило 10, теперь 8.
  for (const marketplaceId of marketplaces) {
    assert.equal(sentFor(marketplaceId, { osvQty: 10, reserveQty: 2, safetyStock: 0 }), 8, marketplaceId);
    assert.equal(sentFor(marketplaceId, { osvQty: 10, reserveQty: 2, safetyStock: 3 }), 5, marketplaceId);
    assert.equal(sentFor(marketplaceId, { osvQty: 1, reserveQty: 0, safetyStock: 0 }), 1, marketplaceId);
  }
});

test("резерв площадки не добавляется к отправляемому значению", () => {
  // Даже если вызывающий код по старой памяти передал резерв площадки.
  const row = buildSendableRow({
    marketplaceId: "ozon",
    warehouseId: "1",
    externalSku: "П-3120з",
    osvQty: 10,
    reserveQty: 3,
    safetyStock: 0,
    remoteReserved: 3,
  });
  assert.equal(row.sentQty, 7);
  assert.equal(row.sentQty, row.computedQty);
});

test("страховой запас уменьшает отправляемое значение", () => {
  assert.equal(computeAvailable({ osvQty: 10, reserveQty: 2, safetyStock: 3 }), 5);
  assert.equal(marketplaceAmount({ osvQty: 10, reserveQty: 2, safetyStock: 3 }), 5);
});

test("ручное обнуление отправляет ровно ноль на все площадки", () => {
  const manual = { osvQty: 10, reserveQty: 0, safetyStock: 0, manualZero: true };
  for (const marketplaceId of marketplaces) {
    assert.equal(sentFor(marketplaceId, manual), 0, marketplaceId);
  }
});

test("дробные и мусорные значения приводятся к целым", () => {
  assert.equal(computeAvailable({ osvQty: 5.9, reserveQty: 0.4, safetyStock: 0 }), 5);
  assert.equal(computeAvailable({ osvQty: "3", reserveQty: null, safetyStock: undefined }), 3);
  assert.equal(computeAvailable({ osvQty: -7, reserveQty: 0, safetyStock: 0 }), 0);
});

test("гард не пропускает значение больше ОСВ", () => {
  assert.throws(
    () => assertSendable({ osvQty: 1, reserveQty: 0, computedQty: 1, sentQty: 102, warehouseId: "22" }),
    (error) => error.name === "StockGuardError",
  );
  assert.throws(
    () => assertSendable({ osvQty: 5, reserveQty: 0, computedQty: 5, sentQty: -1 }),
    (error) => error.name === "StockGuardError",
  );
  assert.equal(assertSendable({ osvQty: 5, reserveQty: 0, computedQty: 5, sentQty: 5 }), 5);
});

test("сценарий 6: два склада получают одинаковое значение, остаток не делится", () => {
  const input = {
    marketplaceId: "ozon",
    externalSku: "П-3120з",
    article: "П-3120",
    size: "з",
    osvQty: 4,
    reserveQty: 1,
    safetyStock: 0,
  };
  const first = buildSendableRow({ ...input, warehouseId: "111" });
  const second = buildSendableRow({ ...input, warehouseId: "222" });
  assert.equal(first.sentQty, second.sentQty);
  assert.equal(first.sentQty, 3);
  assert.ok(first.sentQty <= first.osvQty);
});

test("buildSendableRow отдаёт полный набор полей для журнала", () => {
  const row = buildSendableRow({
    marketplaceId: "wildberries",
    warehouseId: 1234,
    externalSku: "987654",
    productSku: "П-3120::з",
    article: "П-3120",
    size: "з",
    osvQty: 3,
    reserveQty: 1,
    safetyStock: 0,
  });
  assert.deepEqual(row, {
    marketplaceId: "wildberries",
    warehouseId: "1234",
    productSku: "П-3120::з",
    externalSku: "987654",
    article: "П-3120",
    size: "з",
    osvQty: 3,
    reserveQty: 1,
    computedQty: 2,
    sentQty: 2,
  });
});
