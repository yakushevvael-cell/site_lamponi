import assert from "node:assert/strict";
import { test } from "node:test";

import {
  articleKey,
  extractSize,
  extractUin,
  extractUpdItems,
  isUpdCodeHeader,
  isUpdDescriptionHeader,
  normalizeArticle,
} from "../lib/upd-parse-core.mjs";
import {
  buildExemplarSetPayload,
  buildShipProducts,
  countExemplars,
  exemplarStatusErrors,
  normalizeLabelPostings,
} from "../lib/ozon-exemplars.mjs";

test("заголовки УПД узнаются в две строки и с неразрывными пробелами", () => {
  assert.equal(isUpdCodeHeader("Код товара/работ,\nуслуг"), true);
  assert.equal(isUpdCodeHeader("Код товара / работ, услуг"), true);
  assert.equal(isUpdCodeHeader("Количество"), false);
  assert.equal(isUpdDescriptionHeader("Наименование товара (описание выполненных работ)"), true);
  assert.equal(isUpdDescriptionHeader("Наименование товара, имущественного права"), true);
  assert.equal(isUpdDescriptionHeader("Наименование покупателя"), false);
});

test("артикул чистится от кавычек, длинных тире и неразрывных пробелов", () => {
  assert.equal(normalizeArticle(" «К—1234» "), "К-1234");
  assert.equal(normalizeArticle("К 1234"), "К 1234");
  assert.equal(articleKey("к-1234", "17"), "К-1234::17");
  assert.equal(articleKey("К 1234", "17,5"), "К1234::17.5");
});

test("УИН и размер вынимаются из наименования", () => {
  assert.equal(extractUin("Кольцо золотое, УИН 6431234567890123, вес 1,5 г"), "6431234567890123");
  assert.equal(extractUin("Кольцо золотое УИН: 643123456789"), "643123456789");
  assert.equal(extractUin("Кольцо золотое без номера"), "");
  assert.equal(extractSize("Кольцо, размер 17, УИН 6431234567890123"), "17");
  assert.equal(extractSize("Кольцо, размер 17,5"), "17.5");
  assert.equal(extractSize("Футболка, size: XL"), "XL");
  assert.equal(extractSize("Кольцо без размера"), null);
});

test("из строк УПД собираются пары артикул + УИН", () => {
  const rows = [
    ["УПД № 123 от 14.09.2026"],
    ["№", "Код товара/работ, услуг", "Наименование товара (описание выполненных работ)", "Кол-во"],
    ["1", "К-1234", "Кольцо, размер 17, УИН 6431111111111111", "1"],
    ["2", "К-1235", "Серьги, УИН 6432222222222222", "1"],
    ["3", "", "Строка без артикула, УИН 6433333333333333", "1"],
    ["", "", "Итого", "3"],
    // Шапка повторяется на второй странице — колонки определяются заново.
    ["№", "Код товара/работ, услуг", "Наименование товара (описание выполненных работ)", "Кол-во"],
    ["4", "К-1236", "Подвеска, УИН 6434444444444444", "1"],
  ];
  const { items, errors, headerFound } = extractUpdItems(rows);
  assert.equal(headerFound, true);
  assert.deepEqual(items.map((item) => item.uin), [
    "6431111111111111",
    "6432222222222222",
    "6434444444444444",
  ]);
  assert.equal(items[0].size, "17");
  assert.equal(items[1].size, null);
  assert.equal(errors.length, 1);
});

test("повторный УИН в файле не даёт двух записей", () => {
  const rows = [
    ["Код товара/работ, услуг", "Наименование товара (описание)"],
    ["К-1", "УИН 6431111111111111"],
    ["К-2", "УИН 6431111111111111"],
  ];
  const { items } = extractUpdItems(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].article, "К-2");
});

const created = {
  result: {
    multi_box_qty: 0,
    products: [
      {
        product_id: 555,
        quantity: 1,
        is_jw_uin_needed: true,
        is_gtd_needed: false,
        is_rnpt_needed: false,
        is_weight_needed: false,
        exemplars: [{ exemplar_id: 777, marks: [{ mark: "0104", mark_type: "gs1" }] }],
      },
    ],
  },
};

test("УИН уходит маркой jw_uin, прежние марки сохраняются", () => {
  const { mustSet, payload, problems } = buildExemplarSetPayload("1111-0001-1", created, "6431111111111111");
  assert.equal(mustSet, true);
  assert.deepEqual(problems, []);
  assert.equal(payload.posting_number, "1111-0001-1");
  const exemplar = payload.products[0].exemplars[0];
  assert.equal(exemplar.exemplar_id, 777);
  assert.deepEqual(exemplar.marks, [
    { mark: "0104", mark_type: "gs1" },
    { mark: "6431111111111111", mark_type: "jw_uin" },
  ]);
});

test("обязательные поля Ozon называются до отправки, а не после ошибки", () => {
  const demanding = {
    products: [{
      product_id: 1,
      quantity: 1,
      is_jw_uin_needed: true,
      is_gtd_needed: true,
      is_weight_needed: true,
      exemplars: [{ exemplar_id: 2, marks: [] }],
    }],
  };
  const { problems } = buildExemplarSetPayload("1-1", demanding, "643");
  assert.equal(problems.length, 2);
  assert.ok(problems.some((message) => message.includes("ГТД")));
  assert.ok(problems.some((message) => message.includes("вес")));
});

test("состав отправления и счёт экземпляров", () => {
  assert.deepEqual(buildShipProducts(created, 0), [{ product_id: 555, quantity: 1 }]);
  assert.deepEqual(buildShipProducts({}, 42), [{ product_id: 42, quantity: 1 }]);
  assert.equal(countExemplars(created), 1);
  assert.equal(countExemplars({ products: [{ quantity: 2 }] }), 2);
});

test("номера отправлений для этикетки не превращаются в [object Object]", () => {
  assert.deepEqual(normalizeLabelPostings(["1-1", "2-1"], "3-1"), ["1-1", "2-1"]);
  assert.deepEqual(normalizeLabelPostings([{ posting_number: "1-1" }], "3-1"), ["1-1"]);
  assert.deepEqual(normalizeLabelPostings({ result: [{ posting_number: "1-1" }] }, "3-1"), ["1-1"]);
  assert.deepEqual(normalizeLabelPostings(null, "3-1"), ["3-1"]);
  assert.deepEqual(normalizeLabelPostings([{}], "3-1"), ["3-1"]);
});

test("ошибки проверки УИН читаются человеком", () => {
  const message = exemplarStatusErrors({
    products: [{ exemplars: [{ marks: [{ mark_type: "jw_uin", errors: ["not_found"] }] }] }],
  });
  assert.ok(message.includes("jw_uin"));
  assert.ok(exemplarStatusErrors({}).includes("не назвал"));
});
