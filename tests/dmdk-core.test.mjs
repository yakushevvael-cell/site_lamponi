import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AMOUNT_TYPES,
  BATCH_CHUNK,
  VAT_RATES,
  chunkBatches,
  isSettingsReady,
  missingSettings,
  specificationTotals,
  toGiisAmount,
  toKopecks,
  vatFromGross,
  vatPercent,
} from "../lib/dmdk-core.mjs";

const READY = {
  shipperOgrn: "1",
  consigneeOgrn: "2",
  dealId: "3",
  carrierOgrn: "4",
  amountType: "P_SALE",
  currency: "RUB",
  priceSource: "order",
  vatRate: "NDS_22",
};

test("справочник ставок НДС содержит 22% и совпадает по процентам", () => {
  assert.ok(VAT_RATES.some((rate) => rate.code === "NDS_22"));
  assert.equal(vatPercent("NDS_22"), 22);
  assert.equal(vatPercent("NDS_NULL"), 0);
  assert.equal(vatPercent("чего-то нет"), 0);
});

test("тип стоимости для отгрузки на площадку есть в списке", () => {
  assert.ok(AMOUNT_TYPES.some((type) => type.code === "P_SALE"));
});

test("рубли переводятся в копейки без потери на двоичном округлении", () => {
  assert.equal(toKopecks(1234.56), 123456);
  assert.equal(toKopecks(1234.565), 123457);
  assert.equal(toKopecks("1 0.5".replace(" ", "")), 1050);
  assert.equal(toKopecks("12,34"), 1234);
  assert.equal(toKopecks(0.07), 7);
  assert.equal(toKopecks(undefined), 0);
  assert.equal(toKopecks("не число"), 0);
});

test("в ГИИС сумма уходит рублями с коэффициентом 10 000", () => {
  // 1234,56 ₽ → 123456 копеек → 12 345 600 в формате ГИИС
  assert.equal(toGiisAmount(123456), 12345600);
  assert.equal(toGiisAmount(0), 0);
});

test("НДС выделяется из цены, а не начисляется сверху", () => {
  // 1220 ₽ с НДС 22% — это 1000 ₽ и 220 ₽ налога.
  assert.equal(vatFromGross(122000, "NDS_22"), 22000);
  assert.equal(vatFromGross(120000, "NDS_20"), 20000);
  assert.equal(vatFromGross(100000, "NDS_NULL"), 0);
  assert.equal(vatFromGross(100000, "NDS_0"), 0);
});

test("итоги считаются построчно: сумма построчных налогов не теряет копейки", () => {
  const items = [{ price: 1234.56 }, { price: 999.99 }, { priceKopecks: 50000 }];
  const totals = specificationTotals(items, "NDS_22");
  assert.equal(totals.itemCount, 3);
  assert.equal(totals.amountKopecks, 123456 + 99999 + 50000);
  const expectedVat =
    Math.round((123456 * 22) / 122) + Math.round((99999 * 22) / 122) + Math.round((50000 * 22) / 122);
  assert.equal(totals.vatKopecks, expectedVat);
  assert.equal(totals.amountExVatKopecks, totals.amountKopecks - totals.vatKopecks);
  assert.equal(totals.amount, totals.amountKopecks * 100);
  assert.equal(totals.amountVAT, totals.vatKopecks * 100);
});

test("пустая спецификация даёт нули, а не NaN", () => {
  const totals = specificationTotals([], "NDS_22");
  assert.equal(totals.amountKopecks, 0);
  assert.equal(totals.vatKopecks, 0);
  assert.equal(specificationTotals(undefined, "NDS_22").itemCount, 0);
});

test("список УИН режется по 100 партий на запрос", () => {
  assert.equal(BATCH_CHUNK, 100);
  const uins = Array.from({ length: 237 }, (_, index) => `UIN${index}`);
  const chunks = chunkBatches(uins);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 37]);
  assert.equal(chunks.flat().length, 237);
  assert.deepEqual(chunkBatches([]), []);
  // Пустые значения не должны занимать место в запросе.
  assert.deepEqual(chunkBatches(["A", "", null, "B"]), [["A", "B"]]);
});

test("незаполненные реквизиты называются подписями полей", () => {
  assert.deepEqual(missingSettings(READY), []);
  assert.ok(isSettingsReady(READY));
  const missing = missingSettings({ ...READY, consigneeOgrn: "  ", dealId: "" });
  assert.deepEqual(missing, ["Грузополучатель", "Номер контракта"]);
  assert.equal(isSettingsReady(null), false);
});
