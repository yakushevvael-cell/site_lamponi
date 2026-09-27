import assert from "node:assert/strict";
import { test } from "node:test";

import { planUinBinding } from "../lib/upd-binding.mjs";

const item = (id, article, size = null, extra = {}) => ({ id, article, size, uin: null, locked: false, ...extra });
const uin = (value, article, size = null) => ({ uin: value, article, size });

test("одинаковый артикул в двух отправлениях: у каждого изделия свой УИН из УПД", () => {
  const plan = planUinBinding({
    items: [item(1, "С-2056р004"), item(2, "С-2056р004")],
    uins: [uin("6430000000000001", "С-2056р004"), uin("6430000000000002", "с-2056р004")],
  });
  assert.deepEqual(plan.assign, [
    { itemId: 1, uin: "6430000000000001" },
    { itemId: 2, uin: "6430000000000002" },
  ]);
  assert.deepEqual(plan.unbound, []);
  assert.deepEqual(plan.extra, []);
});

test("УИН не из этой УПД не выдаётся: не хватает — изделие остаётся без УИН", () => {
  const plan = planUinBinding({
    items: [item(1, "С-2056р004"), item(2, "С-2056р004")],
    uins: [uin("6430000000000001", "С-2056р004")],
  });
  assert.deepEqual(plan.assign, [{ itemId: 1, uin: "6430000000000001" }]);
  assert.deepEqual(plan.unbound.map((row) => [row.itemId, row.reason]), [[2, "shortage"]]);
});

test("лишний УИН в УПД виден при загрузке", () => {
  const plan = planUinBinding({
    items: [item(1, "К-1")],
    uins: [uin("1", "К-1"), uin("2", "К-1"), uin("3", "С-9")],
  });
  assert.deepEqual(plan.assign, [{ itemId: 1, uin: "1" }]);
  assert.deepEqual(plan.extra.map((row) => row.uin), ["2", "3"]);
});

test("размер из УПД выбирает изделие своего размера", () => {
  const plan = planUinBinding({
    items: [item(1, "К-1298з", "17"), item(2, "К-1298з", "18")],
    uins: [uin("18A", "К-1298з", "18,0"), uin("17A", "К-1298з", "17")],
  });
  assert.deepEqual(plan.assign, [
    { itemId: 1, uin: "17A" },
    { itemId: 2, uin: "18A" },
  ]);
});

test("разные размеры, а в УПД размера нет: не угадываем, УИН назначится при скане", () => {
  const plan = planUinBinding({
    items: [item(1, "К-1298з", "17"), item(2, "К-1298з", "18")],
    uins: [uin("A", "К-1298з"), uin("B", "К-1298з")],
  });
  assert.deepEqual(plan.assign, []);
  assert.deepEqual(plan.unbound.map((row) => [row.itemId, row.reason]), [[1, "size"], [2, "size"]]);
  // Эти УИН не лишние: они ждут скана.
  assert.deepEqual(plan.extra, []);
});

test("один размер у изделий, в УПД размер записан иначе — привязка по артикулу", () => {
  const plan = planUinBinding({
    items: [item(1, "К-1", "16-20"), item(2, "К-1", "16-20")],
    uins: [uin("A", "К-1", "б/р"), uin("B", "К-1")],
  });
  assert.deepEqual(plan.assign, [
    { itemId: 1, uin: "A" },
    { itemId: 2, uin: "B" },
  ]);
});

test("отсканированное или переданное площадке изделие сохраняет свой УИН", () => {
  const plan = planUinBinding({
    items: [item(1, "С-1", null, { uin: "B", locked: true }), item(2, "С-1", null, { uin: "OLD" })],
    uins: [uin("A", "С-1"), uin("B", "С-1")],
  });
  assert.deepEqual(plan.kept, [{ itemId: 1, uin: "B" }]);
  // Незакреплённый старый УИН заменяется УИН из УПД.
  assert.deepEqual(plan.assign, [{ itemId: 2, uin: "A" }]);
  assert.deepEqual(plan.lockedMissing, []);
});

test("закреплённый УИН, которого нет в новой УПД, попадает в предупреждения", () => {
  const plan = planUinBinding({
    items: [item(1, "С-1", null, { uin: "X", locked: true })],
    uins: [uin("A", "С-1")],
  });
  assert.deepEqual(plan.lockedMissing, [{ itemId: 1, uin: "X", article: "С-1" }]);
  assert.deepEqual(plan.extra.map((row) => row.uin), ["A"]);
});

test("повтор УИН в файле не выдаётся двум изделиям", () => {
  const plan = planUinBinding({
    items: [item(1, "С-1"), item(2, "С-1")],
    uins: [uin("A", "С-1"), uin("A", "С-1")],
  });
  assert.deepEqual(plan.assign, [{ itemId: 1, uin: "A" }]);
  assert.equal(plan.unbound.length, 1);
});
