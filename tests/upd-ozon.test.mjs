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
  neededUinCount,
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
  // Ключ сравнения: похожие русские буквы приводятся к латинским,
  // поэтому «с-3064зр» из карточки WB и «С-3064зр» из 1С — один артикул.
  assert.equal(articleKey("к-1234", "17"), "K-1234::17");
  assert.equal(articleKey("К 1234", "17,5"), "K1234::17.5");
  assert.equal(articleKey("с-3064зр", null), articleKey("С-3064ЗР", ""));
  assert.equal(articleKey("Бр-2665-009р", "16,0 +"), articleKey("Бр-2665-009р", "16+"));
  assert.equal(articleKey("К-1820р", "17,0"), articleKey("К-1820р", "17"));
  assert.notEqual(articleKey("К-1820р", "16-20"), articleKey("К-1820р", "16"));
});

test("УИН и размер вынимаются из наименования", () => {
  assert.equal(extractUin("Кольцо золотое, УИН 6431234567890123, вес 1,5 г"), "6431234567890123");
  assert.equal(extractUin("Кольцо золотое УИН: 643123456789"), "643123456789");
  assert.equal(extractUin("Кольцо золотое без номера"), "");
  assert.equal(extractSize("Кольцо, размер 17, УИН 6431234567890123"), "17");
  assert.equal(extractSize("Кольцо, размер 17,5"), "17.5");
  assert.equal(extractSize("Футболка, size: XL"), "XL");
  assert.equal(extractSize("Кольцо без размера"), null);
  // Размеры колец: диапазон и «с плюсом» раньше обрезались до первого числа.
  assert.equal(extractSize("Кольцо, размер 16-20, УИН 6431234567890123"), "16-20");
  assert.equal(extractSize("Кольцо, размер 16,0 +"), "16+");
  assert.equal(extractSize("Кольцо, размер 18,0 +"), "18+");
  assert.equal(extractSize("Браслет, размер б/р"), "Б/Р");
  assert.equal(extractSize("Кольцо, размер 17,0"), "17");
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

// Отправление из трёх изделий: два одного товара и одно другого.
const createdMulti = {
  result: {
    multi_box_qty: 0,
    products: [
      {
        product_id: 555,
        offer_id: "с-3005р",
        quantity: 2,
        is_jw_uin_needed: true,
        exemplars: [{ exemplar_id: 1 }, { exemplar_id: 2 }],
      },
      {
        product_id: 777,
        offer_id: "Б-1316",
        quantity: 1,
        is_jw_uin_needed: true,
        exemplars: [{ exemplar_id: 3 }],
      },
    ],
  },
};

test("в отправлении с несколькими товарами каждому изделию уходит свой УИН", () => {
  assert.equal(neededUinCount(createdMulti), 3);
  assert.equal(countExemplars(createdMulti), 3);

  const { mustSet, payload, problems, marks } = buildExemplarSetPayload("1111-0002-1", createdMulti, {
    byProduct: { 555: ["6431", "6432"], 777: ["6433"] },
    pool: ["6431", "6432", "6433"],
  });
  assert.equal(mustSet, true);
  assert.deepEqual(problems, []);
  assert.equal(marks, 3);
  const [first, second] = payload.products;
  assert.deepEqual(first.exemplars.map((row) => row.marks[0].mark), ["6431", "6432"]);
  assert.deepEqual(second.exemplars.map((row) => row.marks[0].mark), ["6433"]);
  // Один УИН не может уехать дважды.
  const all = payload.products.flatMap((product) => product.exemplars.map((row) => row.marks[0].mark));
  assert.equal(new Set(all).size, all.length);
});

test("УИН находится и по offer_id, когда product_id не совпал", () => {
  const { payload, problems } = buildExemplarSetPayload("1111-0002-1", createdMulti, {
    byProduct: { "с-3005р": ["6431", "6432"], "Б-1316": ["6433"] },
    pool: ["6431", "6432", "6433"],
  });
  assert.deepEqual(problems, []);
  assert.equal(payload.products[1].exemplars[0].marks[0].mark, "6433");
});

test("нехватка УИН на отправление названа до обращения к Ozon", () => {
  const { problems, mustSet } = buildExemplarSetPayload("1111-0002-1", createdMulti, {
    byProduct: { 555: ["6431"] },
    pool: ["6431"],
  });
  assert.equal(mustSet, true);
  assert.ok(problems.some((message) => message.includes("Не хватает УИН")));
});

test("одиночный УИН строкой по-прежнему работает", () => {
  const { payload, marks } = buildExemplarSetPayload("1111-0001-1", created, "6431111111111111");
  assert.equal(marks, 1);
  assert.equal(payload.products[0].exemplars[0].marks.at(-1).mark, "6431111111111111");
});
