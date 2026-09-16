import assert from "node:assert/strict";
import { test } from "node:test";

import { moscowDate, normalizeCity, pickShippingPoint, sameCity } from "../lib/shipping-point-core.mjs";

test("город читается при любом написании WB", () => {
  assert.equal(normalizeCity("г. Самара"), "самара");
  assert.equal(normalizeCity("г Самара"), "самара");
  assert.equal(normalizeCity("Россия, Самарская обл, г Самара"), "самара");
  assert.equal(normalizeCity("Ярославль"), "ярославль");
  assert.ok(sameCity("Россия, Ярославская обл, г Ярославль", "Ярославль"));
  assert.ok(!sameCity("Самара", "Ярославль"));
});

test("пункт подбирается по координатам склада WB", () => {
  const office = { latitude: 57.6591, longitude: 39.8457, address: "Ярославская обл, г. Ярославль. ул. Громова, д. 9" };
  const points = [
    { id: 1, latitude: 57.62, longitude: 39.88, address: "г Ярославль, пр-т Ленина 10", officeType: "pp" },
    // WB местами путает широту и долготу — такой пункт тоже должен найтись.
    { id: 2, latitude: 39.8458, longitude: 57.6592, address: "г Ярославль, улица Громова 9", officeType: "sc" },
  ];
  assert.deepEqual(pickShippingPoint(office, points)?.id, 2);
  assert.equal(pickShippingPoint(office, points)?.confident, true);
});

test("по адресу, если координат нет", () => {
  const office = { address: "Ярославская обл, г. Ярославль. ул. Громова, д. 9" };
  const points = [
    { id: 5, address: "г Ярославль, ул Громова, д 19" },
    { id: 6, address: "г Ярославль, улица Громова, 9" },
  ];
  const pick = pickShippingPoint(office, points);
  assert.equal(pick?.id, 6);
  assert.equal(pick?.confident, true);
});

test("неуверенное совпадение не выдаётся за уверенное", () => {
  const office = { latitude: 57.6591, longitude: 39.8457, address: "г. Ярославль, ул. Громова, д. 9" };
  const pick = pickShippingPoint(office, [{ id: 9, latitude: 57.7, longitude: 39.9, address: "г Ярославль, Московский пр-т 1" }]);
  assert.equal(pick?.confident, false);
  assert.equal(pickShippingPoint(office, []), null);
});

test("дата отгрузки — по Москве", () => {
  assert.equal(moscowDate(new Date("2026-09-15T22:30:00Z")), "2026-09-16");
  assert.equal(moscowDate(new Date("2026-09-16T10:00:00Z")), "2026-09-16");
});
