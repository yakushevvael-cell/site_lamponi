import assert from "node:assert/strict";
import test from "node:test";

import { buildLabelLines } from "../lib/ozon-exemplars.mjs";
import { articleBaseKey, articleKey, splitArticleSize } from "../lib/upd-parse-core.mjs";

test("размер в скобках отделяется от артикула", () => {
  assert.deepEqual(splitArticleSize("К-1298з (16-21)", null), { article: "К-1298з", size: "16-21" });
  assert.deepEqual(splitArticleSize("К-1619р(16 - 21)", ""), { article: "К-1619р", size: "16 - 21" });
  assert.deepEqual(splitArticleSize("К-100 (17,5)", null), { article: "К-100", size: "17,5" });
  assert.deepEqual(splitArticleSize("С-1 (б/р)", null), { article: "С-1", size: "б/р" });
  // Тот же размер отдельно — не мешает.
  assert.deepEqual(splitArticleSize("К-1298з (16-21)", "16-21"), { article: "К-1298з", size: "16-21" });
});

test("без скобок и при другом размере артикул не трогается", () => {
  assert.deepEqual(splitArticleSize("С-3027-2з", null), { article: "С-3027-2з", size: null });
  assert.deepEqual(splitArticleSize("К-2674зр", "21"), { article: "К-2674зр", size: "21" });
  assert.deepEqual(splitArticleSize("К-1298з (16-21)", "17"), { article: "К-1298з (16-21)", size: "17" });
  assert.deepEqual(splitArticleSize("Набор (подарок)", null), { article: "Набор (подарок)", size: null });
});

test("артикул из Ozon сходится с УИН из УПД", () => {
  assert.equal(articleKey("К-1298з (16-21)", null), articleKey("К-1298з", "16-21"));
  assert.equal(articleBaseKey("К-1298з (16-21)"), articleKey("К-1298з", null));
  assert.equal(articleBaseKey("С-3027-2з"), articleKey("С-3027-2з", null));
});

test("на этикетке размер из скобок не повторяется", () => {
  const single = { products: [{ product_id: 5, offer_id: "К-1298з (16-21)", quantity: 1 }] };
  assert.deepEqual(
    buildLabelLines(single, [{ externalSku: "5", article: "К-1298з", size: "16-21" }]),
    [{ article: "К-1298з", size: "16-21" }],
  );

  const multi = {
    products: [
      { product_id: 5, offer_id: "К-1298з (16-21)", quantity: 1 },
      { product_id: 6, offer_id: "К-2674зр", quantity: 1 },
    ],
  };
  const lines = buildLabelLines(multi, [
    { externalSku: "5", article: "К-1298з", size: "16-21" },
    { externalSku: "6", article: "К-2674зр", size: "21" },
  ], true);
  assert.deepEqual(lines, [
    { article: "К-1298з (16-21)", size: null },
    { article: "К-2674зр", size: "21" },
  ]);
});
