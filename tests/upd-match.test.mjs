import assert from "node:assert/strict";
import { test } from "node:test";

import { matchKey, matchUpdToTask } from "../lib/upd-match.mjs";

const item = (id, posting, article, size = null, extra = {}) => ({
  id, externalOrderId: posting, article, size, uin: null, locked: false, ...extra,
});
const uin = (value, article, size = null) => ({ uin: value, article, size });

test("один артикул у двух покупателей: у каждого отправления свой УИН из УПД", () => {
  const result = matchUpdToTask({
    items: [item(1, "74111357-0196-1", "С-2056р004"), item(2, "0131369841-0038-1", "С-2056р004")],
    uins: [uin("6430000000000001", "с-2056р004"), uin("6430000000000002", "С-2056р004")],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assign, [
    { itemId: 1, uin: "6430000000000001" },
    { itemId: 2, uin: "6430000000000002" },
  ]);
});

test("кольца сверяются по размеру, запись размера не важна", () => {
  const result = matchUpdToTask({
    items: [
      item(1, "A", "К-1298з", "17"),
      item(2, "B", "К-1298з", "16+"),
      item(3, "C", "К-1298з (16-20)"),
    ],
    uins: [uin("U3", "К-1298з", "16-20"), uin("U2", "К-1298з", "16,0 +"), uin("U1", "К-1298з", "17,0")],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assign, [
    { itemId: 1, uin: "U1" },
    { itemId: 2, uin: "U2" },
    { itemId: 3, uin: "U3" },
  ]);
});

test("браслет без размера сходится с «б/р» и пустым размером", () => {
  assert.equal(matchKey("Б-100", null), matchKey("Б-100", "б/р"));
  assert.equal(matchKey("Б-100", "0"), matchKey("Б-100", ""));
  const result = matchUpdToTask({ items: [item(1, "A", "Б-100", "0")], uins: [uin("U", "Б-100")] });
  assert.equal(result.ok, true);
});

test("размер не совпал — ошибка, ничего не привязывается", () => {
  const result = matchUpdToTask({
    items: [item(1, "A", "К-1", "17"), item(2, "B", "С-5")],
    uins: [uin("U1", "К-1", "18"), uin("U2", "С-5")],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.assign, []);
  assert.deepEqual(result.problems, [
    "Отправление A: для К-1 / 17 нет УИН в УПД.",
    "УИН U1 (К-1 / 18) — такого изделия в задании нет.",
  ]);
});

test("УИН не хватает — ошибка с номером отправления", () => {
  const result = matchUpdToTask({
    items: [item(1, "A", "С-1"), item(2, "B", "С-1")],
    uins: [uin("U1", "С-1")],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["Отправление B: для С-1 (без размера) нет УИН в УПД."]);
});

test("лишний УИН в УПД — ошибка", () => {
  const result = matchUpdToTask({
    items: [item(1, "A", "С-1")],
    uins: [uin("U1", "С-1"), uin("U2", "С-9")],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["УИН U2 (С-9 (без размера)) — такого изделия в задании нет."]);
});

test("отсканированное изделие сохраняет свой УИН, если он есть в УПД", () => {
  const result = matchUpdToTask({
    items: [item(1, "A", "С-1", null, { uin: "U2", locked: true }), item(2, "B", "С-1")],
    uins: [uin("U1", "С-1"), uin("U2", "С-1")],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assign, [
    { itemId: 1, uin: "U2" },
    { itemId: 2, uin: "U1" },
  ]);
});

test("закреплённого УИН нет в УПД — ошибка", () => {
  const result = matchUpdToTask({
    items: [item(1, "A", "С-1", null, { uin: "OLD", locked: true })],
    uins: [uin("U1", "С-1")],
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2);
});

test("один УИН дважды в УПД — ошибка", () => {
  const result = matchUpdToTask({
    items: [item(1, "A", "С-1"), item(2, "B", "С-1")],
    uins: [uin("U1", "С-1"), uin("U1", "С-1")],
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes("УИН U1 встречается в УПД дважды."));
});
