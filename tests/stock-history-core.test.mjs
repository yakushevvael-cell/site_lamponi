import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistory,
  correctionKind,
  CORRECTION_ERROR_TITLE,
  CORRECTION_OK_TITLE,
  isCheckMismatch,
  summarizeCorrection,
  toIso,
} from "../lib/stock-history-core.mjs";

const warehouses = [
  { marketplaceId: "wildberries", externalId: "101", name: "WB Москва", publishing: true },
  { marketplaceId: "wildberries", externalId: "102", name: "WB Казань", publishing: false },
  { marketplaceId: "ozon", externalId: "201", name: "Ozon Москва", publishing: true },
  { marketplaceId: "yandex", externalId: "301", name: "Яндекс Маркет · DBS", publishing: false },
];

const success = (marketplaceId, warehouseId, sentQty) => ({ marketplaceId, warehouseId, sentQty, apiStatus: "success", apiMessage: null });

test("время SQLite без пояса читается как UTC", () => {
  assert.equal(toIso("2026-09-29 10:15:00"), "2026-09-29T10:15:00Z");
  assert.equal(toIso("2026-09-29T10:15:00+03:00"), "2026-09-29T10:15:00+03:00");
  assert.equal(toIso(null), null);
});

test("все склады ответили успешно — одна строка «успешно», отключённые помечены", () => {
  const summary = summarizeCorrection({
    rows: [success("wildberries", "101", 3), success("ozon", "201", 4)],
    warehouses,
    marketplaces: ["wildberries", "ozon", "yandex"],
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.title, CORRECTION_OK_TITLE);
  assert.deepEqual(
    summary.warehouses.map((item) => [item.warehouseId, item.status, item.sentQty]),
    [["101", "success", 3], ["102", "disabled", null], ["201", "success", 4], ["301", "disabled", null]],
  );
});

test("ошибка хоть на одном складе — «Ошибка корректировки остатков»", () => {
  const summary = summarizeCorrection({
    rows: [success("wildberries", "101", 3), { marketplaceId: "ozon", warehouseId: "201", sentQty: 4, apiStatus: "error", apiMessage: "timeout" }],
    warehouses,
    marketplaces: ["wildberries", "ozon"],
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.title, CORRECTION_ERROR_TITLE);
  assert.equal(summary.failed, 1);
  assert.equal(summary.warehouses.find((item) => item.warehouseId === "201").message, "timeout");
});

test("«пропущено» показывается как есть и ошибкой не считается", () => {
  const summary = summarizeCorrection({
    rows: [success("wildberries", "101", 3), { marketplaceId: "ozon", warehouseId: "201", sentQty: 4, apiStatus: "skipped", apiMessage: "нет на складе" }],
    warehouses,
    marketplaces: ["wildberries", "ozon"],
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.warehouses.find((item) => item.warehouseId === "201").status, "skipped");
});

test("ошибка без строки по позиции ложится на склады с выгрузкой", () => {
  const summary = summarizeCorrection({
    rows: [success("ozon", "201", 2)],
    runRows: [{ marketplaceId: "wildberries", warehouseId: "101", sentQty: null, apiStatus: "error", apiMessage: "401" }],
    warehouses,
    marketplaces: ["wildberries", "ozon"],
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.warehouses.find((item) => item.warehouseId === "101").status, "error");
  assert.equal(summary.warehouses.find((item) => item.warehouseId === "102").status, "disabled");
});

test("полная синхронизация от планировщика — плановая, в том числе старая запись manual", () => {
  assert.equal(correctionKind("full_sync", "планировщик"), "scheduled_full_sync");
  assert.equal(correctionKind("manual", "планировщик"), "scheduled_full_sync");
  assert.equal(correctionKind("manual", "manager@lamponi.store"), "manual");
  assert.equal(correctionKind("orders_sync", "планировщик"), "orders_sync");
});

test("расхождение — только на складе с выгрузкой и известным отправленным значением", () => {
  assert.equal(isCheckMismatch({ publishing: true, status: "ok", amount: 3, expectedQty: 3 }), false);
  assert.equal(isCheckMismatch({ publishing: true, status: "ok", amount: 2, expectedQty: 3 }), true);
  assert.equal(isCheckMismatch({ publishing: false, status: "ok", amount: 2, expectedQty: 3 }), false);
  assert.equal(isCheckMismatch({ publishing: true, status: "missing", amount: null, expectedQty: 1 }), true);
  assert.equal(isCheckMismatch({ publishing: true, status: "missing", amount: null, expectedQty: 0 }), false);
  assert.equal(isCheckMismatch({ publishing: true, status: "error", amount: null, expectedQty: 3 }), false);
});

test("лента: заказ → корректировка → проверка, плановые синхронизации свёрнуты", () => {
  const rows = [success("wildberries", "101", 3)];
  const events = buildHistory({
    orders: [{
      orderId: 1,
      externalOrderId: "A-1",
      marketplaceId: "ozon",
      orderedAt: "2026-09-29T10:02:00Z",
      canceledAt: "2026-09-29 12:00:00",
      cancellationSource: "customer",
      sellerCancelled: false,
      warehouseId: "201",
      warehouseName: "Ozon Москва",
      quantity: 1,
      status: "cancelled",
    }],
    corrections: [
      { runId: "r1", trigger: "full_sync", actorEmail: "планировщик", startedAt: "2026-09-29 08:10:00", rows },
      { runId: "r2", trigger: "full_sync", actorEmail: "планировщик", startedAt: "2026-09-29 09:10:00", rows },
      { runId: "r3", trigger: "orders_sync", actorEmail: "планировщик", startedAt: "2026-09-29 10:15:00", rows },
    ],
    checks: [
      { id: 7, trigger: "orders_sync", dueAt: "2026-09-29 10:25:00", status: "done", checkedAt: "2026-09-29 10:26:00", message: null, rows: [
        { marketplaceId: "wildberries", warehouseId: "101", warehouseName: "WB Москва", publishing: true, status: "ok", amount: 2, reserved: null, expectedQty: 3, message: null },
      ] },
      { id: 8, trigger: "manual", dueAt: "2026-09-29 12:30:00", status: "pending", checkedAt: null, message: null, rows: [] },
    ],
    warehouses,
    marketplaces: ["wildberries"],
  });

  assert.deepEqual(events.map((event) => event.type), ["correction", "order", "correction", "check", "cancel", "check_pending"]);
  assert.equal(events[0].count, 2);
  assert.equal(events[0].until, "2026-09-29T09:10:00Z");
  assert.equal(events[2].label, "Корректировка после заказов");
  assert.equal(events[3].mismatches, 1);
  assert.equal(events[4].source, "customer");
});

test("события раньше начала периода отбрасываются, отмена в периоде остаётся", () => {
  const events = buildHistory({
    orders: [{
      orderId: 1, externalOrderId: "A-1", marketplaceId: "wildberries", orderedAt: "2026-09-01T10:00:00Z",
      canceledAt: "2026-09-28 10:00:00", cancellationSource: null, sellerCancelled: true,
      warehouseId: "101", warehouseName: null, quantity: 1, status: "cancel",
    }],
    corrections: [],
    checks: [],
    warehouses,
    marketplaces: [],
    since: "2026-09-22T00:00:00Z",
  });
  assert.deepEqual(events.map((event) => [event.type, event.source]), [["cancel", "seller"]]);
});
