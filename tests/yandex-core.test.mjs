import assert from "node:assert/strict";
import { test } from "node:test";

import { isAwaitingHandover, isHandedOver } from "../lib/fbs-shipments-core.mjs";
import {
  buildDeliveryRequest,
  buildYandexBoxes,
  isoFromMarketDate,
  normalizeNds,
  parseYandexStatus,
  splitRecipientName,
  toKopecks,
  yandexHandoverSteps,
  yandexOrderAmount,
  yandexShipmentDeadline,
  yandexStatusInfo,
  yandexStatusKey,
} from "../lib/yandex-core.mjs";

test("статус пишется одной строкой и разбирается обратно", () => {
  assert.equal(yandexStatusKey("processing", "started"), "PROCESSING/STARTED");
  assert.equal(yandexStatusKey("DELIVERED", null), "DELIVERED");
  assert.deepEqual(parseYandexStatus("DELIVERY/DELIVERY_SERVICE_RECEIVED"), {
    status: "DELIVERY",
    substatus: "DELIVERY_SERVICE_RECEIVED",
  });
});

test("разбор статуса: отмена магазином отличается от отказа покупателя", () => {
  const shop = yandexStatusInfo("CANCELLED", "SHOP_FAILED");
  assert.equal(shop.canceled, true);
  assert.equal(shop.sellerCancelled, true);
  assert.equal(shop.cancellationSource, "seller");

  const user = yandexStatusInfo("CANCELLED", "USER_CHANGED_MIND");
  assert.equal(user.sellerCancelled, false);
  assert.equal(user.cancellationSource, "customer");

  const other = yandexStatusInfo("CANCELLED", "PROCESSING_EXPIRED");
  assert.equal(other.cancellationSource, "marketplace");
});

test("на сборку идут только заказы в PROCESSING/STARTED", () => {
  assert.equal(yandexStatusInfo("PROCESSING", "STARTED").awaitingPicking, true);
  assert.equal(yandexStatusInfo("PROCESSING", "READY_TO_SHIP").awaitingPicking, false);
  assert.equal(yandexStatusInfo("DELIVERY", "DELIVERY_SERVICE_RECEIVED").awaitingPicking, false);
});

test("доставленный заказ считается и отгруженным, и выкупленным", () => {
  const delivered = yandexStatusInfo("DELIVERED", "DELIVERY_SERVICE_DELIVERED");
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.shipped, true);
  assert.equal(delivered.canceled, false);
});

test("Яндекс: в PROCESSING заказ у нас, после передачи курьеру — отгружен", () => {
  assert.equal(isAwaitingHandover("yandex", "PROCESSING/STARTED"), true);
  assert.equal(isAwaitingHandover("yandex", "PROCESSING/READY_TO_SHIP"), true);
  assert.equal(isAwaitingHandover("yandex", "DELIVERY/DELIVERY_SERVICE_RECEIVED"), false);
  assert.equal(isHandedOver("yandex", "DELIVERY/DELIVERY_SERVICE_RECEIVED"), true);
  assert.equal(isHandedOver("yandex", "DELIVERED/DELIVERY_SERVICE_DELIVERED"), true);
  assert.equal(isHandedOver("yandex", "PROCESSING/STARTED"), false);
  assert.equal(isHandedOver("yandex", "CANCELLED/SHOP_FAILED"), false);
});

test("переходы статуса идут по порядку: сначала «готов к отгрузке»", () => {
  assert.deepEqual(yandexHandoverSteps("PROCESSING/STARTED"), [
    { status: "PROCESSING", substatus: "READY_TO_SHIP" },
    { status: "DELIVERY", substatus: "DELIVERY_SERVICE_RECEIVED" },
  ]);
  // Заказ уже подготовлен — повторять «готов к отгрузке» не нужно.
  assert.deepEqual(yandexHandoverSteps("PROCESSING/READY_TO_SHIP"), [
    { status: "DELIVERY", substatus: "DELIVERY_SERVICE_RECEIVED" },
  ]);
  // Заказ уже уехал: переводить нечего.
  assert.deepEqual(yandexHandoverSteps("DELIVERY/DELIVERY_SERVICE_RECEIVED"), []);
});

test("даты Маркета читаются как ДД-ММ-ГГГГ по Москве", () => {
  assert.equal(isoFromMarketDate("16-09-2026"), "2026-09-16T00:00:00+03:00");
  assert.equal(isoFromMarketDate("16-09-2026 14:30:00"), "2026-09-16T14:30:00+03:00");
  assert.equal(isoFromMarketDate(""), null);
  assert.equal(isoFromMarketDate(null), null);
});

test("дедлайн отгрузки берётся из отгрузок заказа", () => {
  assert.equal(
    yandexShipmentDeadline({ delivery: { shipments: [{ shipmentDate: "17-09-2026" }] } }),
    "2026-09-17T00:00:00+03:00",
  );
  assert.equal(
    yandexShipmentDeadline({ delivery: { dates: { fromDate: "18-09-2026" } } }),
    "2026-09-18T00:00:00+03:00",
  );
  assert.equal(yandexShipmentDeadline({}), null);
});

test("сумма заказа считается по цене покупателя", () => {
  assert.equal(yandexOrderAmount({ items: [{ buyerPrice: 1500, count: 2 }, { price: 700, count: 1 }] }), 3700);
  assert.equal(yandexOrderAmount({}), 0);
});

test("состав коробки: все изделия в одном месте, УИН рядом с изделием", () => {
  const boxes = buildYandexBoxes([
    { id: 11, count: 1, uin: "1234567890123456" },
    { id: 12, count: 2, uin: null },
  ]);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].items[0], { id: 11, fullCount: 1, instances: [{ uin: "1234567890123456" }] });
  assert.deepEqual(boxes[0].items[1], { id: 12, fullCount: 2 });
  assert.deepEqual(buildYandexBoxes([]), []);
});

test("имя получателя разбирается на фамилию и имя", () => {
  assert.deepEqual(splitRecipientName("Иванова Мария Петровна"), {
    first_name: "Мария",
    last_name: "Иванова",
    patronymic: "Петровна",
  });
  assert.deepEqual(splitRecipientName("Мария"), { first_name: "Мария", last_name: "Мария" });
  assert.deepEqual(splitRecipientName("  "), { first_name: "Получатель", last_name: "Заказа" });
});

test("копейки и ставка НДС приводятся к тому, что принимает Доставка", () => {
  assert.equal(toKopecks(1499.99), 149999);
  assert.equal(toKopecks(0), 0);
  assert.equal(toKopecks(null), 0);
  assert.equal(normalizeNds(22), 22);
  assert.equal(normalizeNds(20), -1);
  assert.equal(normalizeNds(undefined), -1);
});

test("заявка Доставки: одно место, оплата уже прошла, цены в копейках", () => {
  const request = buildDeliveryRequest({
    orderId: "123456",
    items: [{ article: "К-123-17", name: "Кольцо", count: 1, price: 4200 }],
    recipient: { name: "Иванова Мария", phone: "+79990000000", email: "m@example.com" },
    address: { full: "Москва, ул. Ленина, 1, кв. 2" },
    stationId: "station-1",
    barcode: "LM123456",
  });

  assert.equal(request.info.operator_request_id, "123456");
  assert.equal(request.source.platform_station.platform_id, "station-1");
  assert.equal(request.destination.type, "custom_location");
  assert.equal(request.destination.custom_location.details.full_address, "Москва, ул. Ленина, 1, кв. 2");
  assert.equal(request.items[0].place_barcode, "LM123456");
  assert.equal(request.items[0].billing_details.unit_price, 420000);
  assert.equal(request.items[0].billing_details.nds, -1);
  assert.equal(request.places.length, 1);
  assert.equal(request.places[0].barcode, "LM123456");
  assert.equal(request.places[0].physical_dims.weight_gross, 500);
  assert.equal(request.billing_info.payment_method, "already_paid");
  assert.equal(request.recipient_info.first_name, "Мария");
  assert.equal(request.recipient_info.last_name, "Иванова");
  assert.equal(request.recipient_info.phone, "+79990000000");
  assert.equal(request.last_mile_policy, "time_interval");
});
