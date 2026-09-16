import assert from "node:assert/strict";
import { test } from "node:test";

import { isAwaitingHandover, isHandedOver, moscowDay, overdueHandover, shipmentsByDay } from "../lib/fbs-shipments-core.mjs";

test("Ozon: отгружен с этапа «доставляется», awaiting_deliver ещё у нас", () => {
  assert.equal(isHandedOver("ozon", "delivering"), true);
  assert.equal(isHandedOver("ozon", "delivered"), true);
  assert.equal(isHandedOver("ozon", "awaiting_deliver"), false);
  assert.equal(isHandedOver("ozon", "cancelled"), false);
  assert.equal(isAwaitingHandover("ozon", "awaiting_packaging"), true);
  assert.equal(isAwaitingHandover("ozon", "delivering"), false);
});

test("WB: complete — в доставке, new/confirm — ещё у нас, отмена — ни то ни другое", () => {
  assert.equal(isHandedOver("wildberries", "complete/waiting"), true);
  assert.equal(isHandedOver("wildberries", "confirm/sorted"), true);
  assert.equal(isHandedOver("wildberries", "confirm/waiting"), false);
  assert.equal(isAwaitingHandover("wildberries", "confirm/waiting"), true);
  assert.equal(isAwaitingHandover("wildberries", "new/waiting"), true);
  assert.equal(isAwaitingHandover("wildberries", "cancel/canceled"), false);
  assert.equal(isAwaitingHandover("wildberries", "confirm/canceled_by_client"), false);
});

test("день считается по Москве", () => {
  assert.equal(moscowDay("2026-09-15T22:30:00Z"), "2026-09-16");
  assert.equal(moscowDay("2026-09-16T20:59:00Z"), "2026-09-16");
  assert.equal(moscowDay(null), null);
});

test("отгрузки по дням: нули в пустые дни, площадки отдельно", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  const series = shipmentsByDay([
    { marketplaceId: "ozon", handedOverAt: "2026-09-16T08:00:00Z" },
    { marketplaceId: "ozon", handedOverAt: "2026-09-16T09:00:00Z" },
    { marketplaceId: "wildberries", handedOverAt: "2026-09-14T10:00:00Z" },
    { marketplaceId: "wildberries", handedOverAt: "2026-08-01T10:00:00Z" },
    { marketplaceId: "ozon", handedOverAt: null },
  ], { days: 3, now, marketplaces: ["ozon", "wildberries"] });
  assert.deepEqual(series, [
    { date: "2026-09-14", ozon: 0, wildberries: 1 },
    { date: "2026-09-15", ozon: 0, wildberries: 0 },
    { date: "2026-09-16", ozon: 2, wildberries: 0 },
  ]);
});

test("больше 40 часов без передачи в доставку", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  const hoursAgo = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const result = overdueHandover([
    { marketplaceId: "ozon", status: "awaiting_packaging", orderedAt: hoursAgo(41), canceledAt: null, handedOverAt: null, units: 2 },
    { marketplaceId: "ozon", status: "awaiting_deliver", orderedAt: hoursAgo(72), canceledAt: null, handedOverAt: null, units: 1 },
    { marketplaceId: "ozon", status: "awaiting_packaging", orderedAt: hoursAgo(39), canceledAt: null, handedOverAt: null, units: 1 },
    { marketplaceId: "ozon", status: "delivering", orderedAt: hoursAgo(90), canceledAt: null, handedOverAt: hoursAgo(10), units: 1 },
    { marketplaceId: "wildberries", status: "confirm/waiting", orderedAt: hoursAgo(50), canceledAt: null, handedOverAt: null, units: 1 },
    { marketplaceId: "wildberries", status: "cancel/canceled", orderedAt: hoursAgo(50), canceledAt: hoursAgo(1), handedOverAt: null, units: 1 },
  ], { marketplaces: ["ozon", "wildberries"], now });
  assert.deepEqual(result.ozon, { orders: 2, units: 3, oldestHours: 72 });
  assert.deepEqual(result.wildberries, { orders: 1, units: 1, oldestHours: 50 });
});
