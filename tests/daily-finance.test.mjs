import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateOzonAccruals,
  aggregateOzonOrderPostings,
  aggregateWildberriesSales,
  aggregateWildberriesStatOrders,
  classifyOzonAccrualTypes,
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

test("типы начислений Ozon разбираются по названию", () => {
  const { sale, refund } = classifyOzonAccrualTypes([
    { id: 1, name: "Доставка покупателю", description: "" },
    { id: 2, name: "Возврат от покупателя", description: "" },
    { id: 3, name: "Комиссия за продажу", description: "" },
    { id: 4, name: "Логистика", description: "" },
  ]);
  assert.deepEqual(sale, [1]);
  assert.deepEqual(refund, [2]);
});

test("Ozon: начисления дают выкупы по цене продавца", () => {
  const classification = { sale: [1], refund: [2] };
  const rows = aggregateOzonAccruals([
    { postingNumber: "111-1", accrualDate: "2026-09-01", sellerPrice: 5000, quantity: 1, typeId: 1 },
    { postingNumber: "111-2", accrualDate: "2026-09-01", sellerPrice: 1500, quantity: 2, typeId: 1 },
    { postingNumber: "222-1", accrualDate: "2026-09-02", sellerPrice: 1500, quantity: 1, typeId: 1 },
  ], classification);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].buyoutAmount, 8000);
  assert.equal(rows[0].buyoutCount, 2);
  assert.equal(rows[0].buyoutUnits, 3);
  assert.equal(rows[1].buyoutAmount, 1500);
});

test("Ozon: возвраты не уводят выкупы в минус", () => {
  const rows = aggregateOzonAccruals([
    { postingNumber: "333-1", accrualDate: "2026-09-03", sellerPrice: 4000, quantity: 1, typeId: 1 },
    { postingNumber: "333-1", accrualDate: "2026-09-03", sellerPrice: -4000, quantity: 1, typeId: 2 },
  ], { sale: [1], refund: [2] });
  assert.equal(rows[0].buyoutAmount, 4000);
  assert.equal(rows[0].returnAmount, 4000);
  assert.equal(rows[0].returnCount, 1);
});

test("Ozon: без справочника считаем по знаку цены", () => {
  const rows = aggregateOzonAccruals([
    { postingNumber: "444-1", accrualDate: "2026-09-04", sellerPrice: 900, quantity: 1, typeId: 77 },
    { postingNumber: "444-2", accrualDate: "2026-09-04", sellerPrice: -300, quantity: 1, typeId: 88 },
    { postingNumber: "444-3", accrualDate: "2026-09-04", sellerPrice: 0, quantity: 1, typeId: 99 },
  ], { sale: [], refund: [] });
  assert.equal(rows[0].buyoutAmount, 900);
  assert.equal(rows[0].returnAmount, 300);
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
  assert.equal(rows[0].returnAmount, 4500);
});

test("Wildberries: заказы считаются по всем схемам, отмены отделяются", () => {
  const rows = aggregateWildberriesStatOrders([
    { date: "2026-08-01T10:00:00", gNumber: "A1", priceWithDisc: 3000, finishedPrice: 2000, isCancel: false },
    { date: "2026-08-01T11:00:00", gNumber: "A1", priceWithDisc: 2000, isCancel: false },
    { date: "2026-08-01T12:00:00", gNumber: "A2", priceWithDisc: 1000, isCancel: true },
    { date: "2026-08-02T12:00:00", gNumber: "A3", priceWithDisc: 500, isCancel: false },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].orderedAmount, 6000);
  assert.equal(rows[0].orderedNetAmount, 5000);
  assert.equal(rows[0].canceledAmount, 1000);
  // Две строки одного заказа — один заказ, но две единицы товара.
  assert.equal(rows[0].orderedCount, 2);
  assert.equal(rows[0].orderedUnits, 3);
});

test("Ozon: заказы складываются из отправлений обеих схем", () => {
  const rows = aggregateOzonOrderPostings([
    { postingNumber: "1-1", orderedAt: "2026-08-01T09:00:00Z", amount: 4000, units: 2, canceled: false },
    { postingNumber: "1-2", orderedAt: "2026-08-01T15:00:00Z", amount: 1000, units: 1, canceled: true },
    { postingNumber: "1-3", orderedAt: "2026-08-01T22:30:00Z", amount: 700, units: 1, canceled: false },
  ]);
  // Последнее отправление по Москве — уже 2 августа.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, "2026-08-01");
  assert.equal(rows[0].orderedAmount, 5000);
  assert.equal(rows[0].orderedNetAmount, 4000);
  assert.equal(rows[0].canceledAmount, 1000);
  assert.equal(rows[0].orderedCount, 2);
  assert.equal(rows[1].orderedAmount, 700);
});
