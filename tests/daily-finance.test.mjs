import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateOzonOperations,
  aggregateWildberriesSales,
  marketplaceDay,
} from "../lib/daily-finance-core.mjs";

test("день берётся по Москве, а время без пояса не сдвигается", () => {
  assert.equal(marketplaceDay("2026-09-01"), "2026-09-01");
  // Вечер по Москве без пояса: раньше такая строка уезжала на сутки назад.
  assert.equal(marketplaceDay("2026-09-01T23:40:00"), "2026-09-01");
  // Полночь UTC — это 03:00 в Москве того же дня.
  assert.equal(marketplaceDay("2026-09-01T00:00:00Z"), "2026-09-01");
  // 22:30 UTC — уже следующий день в Москве.
  assert.equal(marketplaceDay("2026-09-01T22:30:00Z"), "2026-09-02");
});

test("Ozon: доставка покупателю попадает в выкупы по цене продавца", () => {
  const rows = aggregateOzonOperations([
    { operationDate: "2026-09-01 12:00:00", group: "orders", postingNumber: "111-1", deliverySchema: "FBS", accrualsForSale: 5000, itemCount: 1 },
    { operationDate: "2026-09-01 18:00:00", group: "orders", postingNumber: "111-2", deliverySchema: "FBS", accrualsForSale: 3000, itemCount: 2 },
    { operationDate: "2026-09-02 10:00:00", group: "orders", postingNumber: "222-1", deliverySchema: "FBS", accrualsForSale: 1500, itemCount: 1 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    date: "2026-09-01", buyoutAmount: 8000, buyoutCount: 2, buyoutUnits: 3, returnAmount: 0, returnCount: 0,
  });
  assert.equal(rows[1].buyoutAmount, 1500);
});

test("Ozon: возвраты и сторно уходят в возвраты, а не в минус выкупам", () => {
  const rows = aggregateOzonOperations([
    { operationDate: "2026-09-03", group: "orders", postingNumber: "333-1", deliverySchema: "FBS", accrualsForSale: 4000, itemCount: 1 },
    { operationDate: "2026-09-03", group: "returns", postingNumber: "333-1", deliverySchema: "FBS", accrualsForSale: -4000, itemCount: 1 },
  ]);
  assert.equal(rows[0].buyoutAmount, 4000);
  assert.equal(rows[0].returnAmount, 4000);
  assert.equal(rows[0].returnCount, 1);
});

test("Ozon: чужие схемы и услуги не считаются", () => {
  const rows = aggregateOzonOperations([
    { operationDate: "2026-09-04", group: "orders", postingNumber: "444-1", deliverySchema: "FBO", accrualsForSale: 9000, itemCount: 1 },
    { operationDate: "2026-09-04", group: "services", postingNumber: "", deliverySchema: "FBS", accrualsForSale: 700, itemCount: 0 },
  ]);
  assert.deepEqual(rows, []);
});

test("Ozon: одно отправление с несколькими операциями считается один раз", () => {
  const rows = aggregateOzonOperations([
    { operationDate: "2026-09-05", group: "orders", postingNumber: "555-1", deliverySchema: "FBS", accrualsForSale: 1000, itemCount: 1 },
    { operationDate: "2026-09-05", group: "orders", postingNumber: "555-1", deliverySchema: "FBS", accrualsForSale: 200, itemCount: 1 },
  ]);
  assert.equal(rows[0].buyoutCount, 1);
  assert.equal(rows[0].buyoutAmount, 1200);
});

test("Wildberries: продажи и возвраты разводятся по типу строки", () => {
  const rows = aggregateWildberriesSales([
    { date: "2026-09-01T11:00:00", saleID: "S123", priceWithDisc: 4500, finishedPrice: 3800 },
    { date: "2026-09-01T20:00:00", saleID: "S124", priceWithDisc: 2500, finishedPrice: 2100 },
    { date: "2026-09-01T21:00:00", saleID: "R125", priceWithDisc: 4500 },
    { date: "2026-09-02T09:00:00", saleID: "S126", priceWithDisc: 1000, IsStorno: 1 },
  ]);
  assert.equal(rows.length, 1);
  // Берём цену продавца, а не цену с учётом скидки площадки.
  assert.equal(rows[0].buyoutAmount, 7000);
  assert.equal(rows[0].buyoutCount, 2);
  assert.equal(rows[0].buyoutUnits, 2);
  assert.equal(rows[0].returnAmount, 4500);
});

test("Wildberries: доплата добавляет деньги, но не штуки", () => {
  const rows = aggregateWildberriesSales([
    { date: "2026-09-06T10:00:00", saleID: "S1", priceWithDisc: 1000 },
    { date: "2026-09-06T12:00:00", saleID: "D2", priceWithDisc: 150 },
  ]);
  assert.equal(rows[0].buyoutAmount, 1150);
  assert.equal(rows[0].buyoutUnits, 1);
});
