import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachCells,
  buildTaskNumber,
  cellSortOrder,
  countCells,
  groupByPosting,
  normalizeBatchSize,
  parsePlacementTable,
  sortByRoute,
  sortByWaiting,
  splitIntoBatches,
  taskDay,
  warehouseSlug,
} from "../lib/warehouse-core.mjs";

test("номер задания: Ozon по партиям, WB по складу", () => {
  assert.equal(buildTaskNumber({ day: "2026-09-14", marketplaceId: "ozon", sequence: 3 }), "2026-09-14-OZ-03");
  assert.equal(
    buildTaskNumber({ day: "2026-09-14", marketplaceId: "wildberries", warehouseName: "Казань" }),
    "2026-09-14-WB-КАЗАНЬ",
  );
  // Второе задание того же склада за день не должно совпасть с первым.
  assert.equal(
    buildTaskNumber({
      day: "2026-09-14",
      marketplaceId: "wildberries",
      warehouseName: "Казань",
      taken: ["2026-09-14-WB-КАЗАНЬ"],
    }),
    "2026-09-14-WB-КАЗАНЬ-2",
  );
});

test("имя склада в номере читается человеком", () => {
  assert.equal(warehouseSlug("Склад Санкт-Петербург №2"), "СКЛАД-САНКТ-ПЕТЕРБУРГ-2");
  assert.equal(warehouseSlug(""), "СКЛАД");
  assert.equal(warehouseSlug("   "), "СКЛАД");
});

test("день задания берётся по Москве", () => {
  // 22:30 UTC — в Москве уже следующие сутки.
  assert.equal(taskDay("2026-09-14T22:30:00Z"), "2026-09-15");
  assert.equal(taskDay("2026-09-14T06:00:00Z"), "2026-09-14");
});

test("размер партии — настройка, а не константа", () => {
  assert.equal(normalizeBatchSize(30), 30);
  assert.equal(normalizeBatchSize("45"), 45);
  assert.equal(normalizeBatchSize(0), 1);
  assert.equal(normalizeBatchSize(10000), 500);
  assert.equal(normalizeBatchSize("не число"), 30);
});

test("остаток партии отгружается как есть и не добивается", () => {
  const postings = Array.from({ length: 67 }, (_, index) => index + 1);
  const batches = splitIntoBatches(postings, 30);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.length), [30, 30, 7]);
});

test("строки заказов группируются по отправлениям, отправление не рвётся", () => {
  const grouped = groupByPosting([
    { marketplaceId: "ozon", externalOrderId: "1-1", article: "A", orderedAt: "2026-09-14T10:00:00Z" },
    { marketplaceId: "ozon", externalOrderId: "1-1", article: "B", orderedAt: "2026-09-14T09:00:00Z" },
    { marketplaceId: "ozon", externalOrderId: "2-1", article: "C", orderedAt: "2026-09-13T10:00:00Z" },
  ]);
  assert.equal(grouped.length, 2);
  const first = grouped.find((posting) => posting.externalOrderId === "1-1");
  assert.equal(first.items.length, 2);
  // У отправления берётся самая ранняя дата: оно ждёт с первого своего товара.
  assert.equal(first.orderedAt, "2026-09-14T09:00:00Z");
});

test("в задание сначала попадают те, кто ждёт дольше всех", () => {
  const sorted = sortByWaiting([
    { externalOrderId: "b", orderedAt: "2026-09-14T10:00:00Z" },
    { externalOrderId: "a", orderedAt: "2026-09-12T10:00:00Z" },
    { externalOrderId: "c", orderedAt: null },
  ]);
  assert.deepEqual(sorted.map((posting) => posting.externalOrderId), ["c", "a", "b"]);
});

test("ячейка подставляется точной парой, иначе по артикулу", () => {
  const items = [
    { article: "ART-1", size: "17" },
    { article: "ART-1", size: "18" },
    { article: "ART-2", size: null },
    { article: "ART-3", size: null },
  ];
  const withCells = attachCells(items, [
    { article: "ART-1", size: null, cellCode: "A-01-01", sortOrder: 10 },
    { article: "ART-1", size: "18", cellCode: "B-02-05", sortOrder: 25 },
    { article: "art-2", size: null, cellCode: "A-01-02", sortOrder: 11 },
  ]);
  assert.equal(withCells[0].cellCode, "A-01-01");
  assert.equal(withCells[1].cellCode, "B-02-05");
  // Регистр артикула в раскладке не должен мешать совпадению.
  assert.equal(withCells[2].cellCode, "A-01-02");
  assert.equal(withCells[3].cellCode, null);
});

test("маршрут идёт по ячейкам, строки без ячейки — в конце", () => {
  const route = sortByRoute([
    { article: "X", cellCode: null, cellSort: null },
    { article: "Y", cellCode: "B-01", cellSort: 20 },
    { article: "Z", cellCode: "A-01", cellSort: 10 },
  ]);
  assert.deepEqual(route.map((item) => item.article), ["Z", "Y", "X"]);
  assert.equal(countCells(route), 2);
});

test("номер ячейки сортируется по числам, а не по строке", () => {
  assert.ok(cellSortOrder("A-02") < cellSortOrder("A-10"));
  assert.ok(cellSortOrder("A-10") < cellSortOrder("B-01"));
  assert.ok(Number.isSafeInteger(cellSortOrder("А-99-99")));
});

test("вставленная из таблицы раскладка разбирается с заголовком и без", () => {
  const withHeader = parsePlacementTable("Артикул\tЯчейка\nART-1\tA-01-01\nART-2\tA-01-02\n");
  assert.equal(withHeader.skippedHeader, true);
  assert.deepEqual(withHeader.rows, [
    { article: "ART-1", size: null, cell: "A-01-01" },
    { article: "ART-2", size: null, cell: "A-01-02" },
  ]);

  const plain = parsePlacementTable("ART-1;A-01-01\nART-2;A-01-02");
  assert.equal(plain.skippedHeader, false);
  assert.equal(plain.rows.length, 2);

  const withSize = parsePlacementTable("артикул;размер;ячейка\nART-1;17;A-01-01");
  assert.deepEqual(withSize.rows, [{ article: "ART-1", size: "17", cell: "A-01-01" }]);

  // Повтор артикула: остаётся последняя строка, иначе непонятно, где товар.
  const repeated = parsePlacementTable("ART-1;A-01-01\nART-1;C-09-09");
  assert.deepEqual(repeated.rows, [{ article: "ART-1", size: null, cell: "C-09-09" }]);

  const broken = parsePlacementTable("ART-1;\n;A-01-01\nART-2;A-02-02");
  assert.equal(broken.rows.length, 1);
  assert.equal(broken.errors.length, 2);
});
