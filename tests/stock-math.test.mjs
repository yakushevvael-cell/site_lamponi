import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSendable,
  buildSendableRow,
  computeAvailable,
  ozonTotalStock,
  wildberriesAmount,
} from "../lib/stock-math.mjs";

const base = { osvQty: 1, reserveQty: 0, safetyStock: 0 };

test("сценарий 1: ОСВ 1, резерв 0 — на склад уходит 1", () => {
  assert.equal(computeAvailable(base), 1);
  assert.equal(wildberriesAmount(base), 1);
  assert.equal(ozonTotalStock(base, 0), 1);
});

test("сценарий 2: ОСВ 1, резерв 1 и больше — уходит 0", () => {
  assert.equal(computeAvailable({ ...base, reserveQty: 1 }), 0);
  assert.equal(computeAvailable({ ...base, reserveQty: 5 }), 0);
  assert.equal(wildberriesAmount({ ...base, reserveQty: 5 }), 0);
});

test("сценарий 3: резерв Ozon не может поднять остаток выше ОСВ", () => {
  // Именно этот случай давал 102 при остатке 1.
  assert.equal(ozonTotalStock(base, 101), 1);
  assert.equal(ozonTotalStock({ osvQty: 1, reserveQty: 1, safetyStock: 0 }, 101), 1);
  assert.equal(ozonTotalStock({ osvQty: 10, reserveQty: 3, safetyStock: 0 }, 3), 10);
  assert.equal(ozonTotalStock({ osvQty: 10, reserveQty: 3, safetyStock: 0 }, 99), 10);
});

test("резерв Ozon возвращается только в размере нашего собственного резерва", () => {
  // Наш резерв 3, у Ozon 1: возвращаем 1, свободным у Ozon останется ровно 7.
  assert.equal(ozonTotalStock({ osvQty: 10, reserveQty: 3, safetyStock: 0 }, 1), 8);
});

test("страховой запас уменьшает отправляемое значение", () => {
  assert.equal(computeAvailable({ osvQty: 10, reserveQty: 2, safetyStock: 3 }), 5);
  assert.equal(ozonTotalStock({ osvQty: 10, reserveQty: 2, safetyStock: 3 }, 2), 7);
});

test("ручное обнуление отправляет ровно ноль на обе площадки", () => {
  const manual = { osvQty: 10, reserveQty: 0, safetyStock: 0, manualZero: true };
  assert.equal(wildberriesAmount(manual), 0);
  assert.equal(ozonTotalStock(manual, 4), 0);
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
    remoteReserved: 1,
  };
  const first = buildSendableRow({ ...input, warehouseId: "111" });
  const second = buildSendableRow({ ...input, warehouseId: "222" });
  assert.equal(first.sentQty, second.sentQty);
  assert.equal(first.sentQty, 4);
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
