/**
 * Правила работы с заказами Яндекс Маркета по модели DBS — без базы и без сети.
 *
 * DBS отличается от FBS тем, что доставку организует продавец. У Lamponi это
 * Яндекс Доставка: заказ собирается на складе как обычно, а вместо поставки на
 * склад площадки создаётся заявка на курьера, и её номер (request_id) уходит в
 * Маркет трек-номером. Дальше «доставлен» и «отменён» проставляет сам Маркет.
 *
 * Статус заказа хранится строкой «STATUS/SUBSTATUS» — так же, как у
 * Wildberries хранится «supplierStatus/wbStatus»: одно поле на обе половины
 * состояния, и его видно в таблице заказов без расшифровки.
 *
 * Чистые правила вынесены сюда, чтобы их проверяли тесты
 * (tests/yandex-core.test.mjs), а не живой склад.
 */

/** Статусы, в которых заказ ещё у нас: собирается, пакуется, ждёт курьера. */
export const YANDEX_BEFORE_DELIVERY = new Set(["PROCESSING", "RESERVED", "UNPAID", "PENDING", "PLACING"]);

/** Статусы, после которых заказ уже уехал к покупателю. */
export const YANDEX_AFTER_HANDOVER = new Set([
  "DELIVERY",
  "PICKUP",
  "DELIVERED",
  "PARTIALLY_RETURNED",
  "RETURNED",
]);

/** Подстатус заказа, который Маркет отдал магазину на сборку. */
export const YANDEX_PICK_SUBSTATUS = "STARTED";

/** Отмена по вине магазина — остальные причины считаются покупательскими. */
const SHOP_CANCEL_SUBSTATUSES = new Set(["SHOP_FAILED", "SHOP_PENDING_CANCELLED", "RESERVATION_EXPIRED"]);

/** Отмены, которые инициировал покупатель. */
const USER_CANCEL_SUBSTATUSES = new Set([
  "USER_CHANGED_MIND",
  "USER_NOT_PAID",
  "USER_REFUSED_DELIVERY",
  "USER_REFUSED_PRODUCT",
  "USER_REFUSED_QUALITY",
  "USER_UNREACHABLE",
  "USER_BOUGHT_CHEAPER",
]);

/** Статус заказа одной строкой: «PROCESSING/STARTED». */
export function yandexStatusKey(status, substatus) {
  const head = String(status ?? "").trim().toUpperCase() || "UNKNOWN";
  const tail = String(substatus ?? "").trim().toUpperCase();
  return tail ? `${head}/${tail}` : head;
}

/** Разбирает строку статуса обратно на статус и подстатус. */
export function parseYandexStatus(value) {
  const [status = "", substatus = ""] = String(value ?? "").split("/");
  return { status: status.toUpperCase(), substatus: substatus.toUpperCase() };
}

/**
 * Что означает статус заказа: отменён, доставлен, передан в доставку.
 *
 * @param {string} status
 * @param {string | null} [substatus] Маркет присылает null, когда подстатуса нет
 */
export function yandexStatusInfo(status, substatus) {
  const key = yandexStatusKey(status, substatus);
  const parsed = parseYandexStatus(key);
  const canceled = parsed.status === "CANCELLED";
  const delivered = parsed.status === "DELIVERED";
  const shipped = delivered || YANDEX_AFTER_HANDOVER.has(parsed.status);
  const sellerCancelled = canceled && SHOP_CANCEL_SUBSTATUSES.has(parsed.substatus);
  const customerCancelled = canceled && USER_CANCEL_SUBSTATUSES.has(parsed.substatus);
  return {
    status: key,
    canceled,
    delivered,
    shipped,
    sellerCancelled,
    cancellationSource: sellerCancelled ? "seller" : customerCancelled ? "customer" : canceled ? "marketplace" : null,
    /** Заказ отдан магазину на сборку — из него формируется задание на склад. */
    awaitingPicking: parsed.status === "PROCESSING" && parsed.substatus === YANDEX_PICK_SUBSTATUS,
  };
}

/**
 * Последовательность переходов, которой Маркет ждёт от магазина на DBS.
 *
 * Порядок нарушать нельзя: Маркет отвечает ошибкой, если из PROCESSING/STARTED
 * сразу перевести заказ в DELIVERY. Отсюда две ступени — сначала «готов к
 * отгрузке», потом «передан в доставку».
 */
export function yandexHandoverSteps(current) {
  const { status, substatus } = parseYandexStatus(current);
  const steps = [];
  if (status === "PROCESSING" && substatus !== "READY_TO_SHIP") {
    steps.push({ status: "PROCESSING", substatus: "READY_TO_SHIP" });
  }
  if (status === "PROCESSING") {
    steps.push({ status: "DELIVERY", substatus: "DELIVERY_SERVICE_RECEIVED" });
  }
  return steps;
}

/** Время до отгрузки: у Маркета это дата отгрузки в блоке delivery.shipments. */
export function yandexShipmentDeadline(order) {
  const shipments = Array.isArray(order?.delivery?.shipments) ? order.delivery.shipments : [];
  const dates = shipments.map((shipment) => shipment?.shipmentDate).filter(Boolean);
  if (dates.length > 0) return isoFromMarketDate(dates[0]);
  return isoFromMarketDate(order?.delivery?.dates?.fromDate ?? null);
}

/**
 * Дата Маркета в ISO.
 *
 * Маркет отдаёт даты как ДД-ММ-ГГГГ, а время — как ДД-ММ-ГГГГ ЧЧ:ММ:СС.
 * Обычный Date.parse такую строку читает неверно, поэтому разбираем сами.
 */
export function isoFromMarketDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, day, month, year, hour = "00", minute = "00", second = "00"] = match;
    // Время Маркета — московское, приводим к UTC явным смещением.
    return `${year}-${month}-${day}T${hour}:${minute}:${second}+03:00`;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Сумма заказа по позициям: цена покупателя за штуку на количество. */
export function yandexOrderAmount(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.reduce((sum, item) => {
    const price = Number(item?.buyerPrice ?? item?.price ?? 0);
    const count = Number(item?.count ?? 1);
    return sum + (Number.isFinite(price) ? price : 0) * (Number.isFinite(count) ? count : 1);
  }, 0);
}

/**
 * Состав коробок для метода «Подготовка заказа».
 *
 * Изделия одного заказа уезжают одной посылкой: курьер Яндекс Доставки
 * забирает её целиком. УИН передаётся в instances — по нему ГИИС ДМДК потом
 * сходится с тем, что физически уехало.
 *
 * @param {Array<{ id: number, count?: number, uin?: string | null }>} items
 */
export function buildYandexBoxes(items) {
  const rows = (items ?? []).filter((item) => Number.isFinite(Number(item?.id)));
  if (rows.length === 0) return [];
  return [{
    items: rows.map((item) => {
      const box = { id: Number(item.id), fullCount: Math.max(1, Math.trunc(Number(item.count ?? 1))) };
      const uin = String(item.uin ?? "").trim();
      if (uin) box.instances = [{ uin }];
      return box;
    }),
  }];
}

/**
 * Габариты места по умолчанию: ювелирная посылка.
 * Стороны — сантиметры, вес — граммы: так их принимает Яндекс Доставка.
 */
export const DEFAULT_PLACE_DIMENSIONS = { dx: 20, dy: 15, dz: 5, weight_gross: 500 };

/**
 * Имя получателя по частям.
 *
 * Яндекс Доставка требует и имя, и фамилию. Маркет отдаёт одну строку, и она
 * бывает пустой — тогда курьеру нужно хоть что-то, иначе заявка не создастся.
 */
export function splitRecipientName(value) {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: "Получатель", last_name: "Заказа" };
  if (parts.length === 1) return { first_name: parts[0], last_name: parts[0] };
  // Маркет отдаёт «Фамилия Имя Отчество»: фамилия идёт первой.
  const [last, first, ...rest] = parts;
  const patronymic = rest.join(" ");
  return { first_name: first, last_name: last, ...(patronymic ? { patronymic } : {}) };
}

/**
 * Тело заявки для Яндекс Доставки по собранному заказу Маркета.
 *
 * Заявка создаётся на весь заказ: одно место, один получатель. Оплата уже
 * прошла на Маркете — поэтому payment_method «already_paid», а цена изделия
 * идёт в объявленную ценность, а не в сумму к оплате курьеру.
 *
 * Тем же телом вызываются и offers/create, и request/create: у методов
 * одинаковая схема, различается только то, что возвращается в ответ.
 *
 * @param {{
 *   orderId: string,
 *   items: Array<{ article: string, name?: string | null, count: number, price: number }>,
 *   recipient: { name?: string | null, phone?: string | null, email?: string | null },
 *   address: { full: string },
 *   stationId: string,
 *   place?: { dx: number, dy: number, dz: number, weight_gross: number },
 *   barcode?: string | null,
 *   comment?: string | null,
 *   merchantId?: string | null,
 *   interval?: { from: string, to: string } | null,
 *   nds?: number | null,
 * }} input
 */
export function buildDeliveryRequest(input) {
  const place = { ...DEFAULT_PLACE_DIMENSIONS, ...(input.place ?? {}) };
  const barcode = String(input.barcode ?? input.orderId);
  const itemDims = { dx: place.dx, dy: place.dy, dz: place.dz };
  const items = (input.items ?? []).map((item) => ({
    count: Math.max(1, Math.trunc(Number(item.count ?? 1))),
    name: String(item.name ?? item.article ?? "Ювелирное изделие").slice(0, 150),
    article: String(item.article ?? ""),
    place_barcode: barcode,
    billing_details: {
      unit_price: toKopecks(item.price),
      assessed_unit_price: toKopecks(item.price),
      // Ставка та же, что в спецификациях ГИИС ДМДК, — 22 %.
      nds: normalizeNds(input.nds ?? 22),
    },
    physical_dims: itemDims,
  }));

  return {
    info: {
      operator_request_id: String(input.orderId),
      ...(input.merchantId ? { merchant_id: String(input.merchantId) } : {}),
      comment: input.comment ?? `Заказ Яндекс Маркета ${input.orderId}`,
    },
    source: {
      platform_station: { platform_id: String(input.stationId) },
      ...(input.interval ? { interval_utc: input.interval } : {}),
    },
    destination: {
      type: "custom_location",
      custom_location: { details: { full_address: String(input.address?.full ?? "") } },
    },
    items,
    places: [{
      barcode,
      physical_dims: { dx: place.dx, dy: place.dy, dz: place.dz, weight_gross: place.weight_gross },
      description: `Заказ ${input.orderId}`,
    }],
    billing_info: { payment_method: "already_paid", delivery_cost: 0 },
    recipient_info: {
      ...splitRecipientName(input.recipient?.name),
      phone: String(input.recipient?.phone ?? ""),
      ...(input.recipient?.email ? { email: String(input.recipient.email) } : {}),
    },
    last_mile_policy: "time_interval",
    particular_items_refuse: false,
  };
}

/** Допустимые ставки НДС Яндекс Доставки; -1 — без НДС. */
export const NDS_VALUES = new Set([-1, 0, 5, 7, 10, 22]);

/** Ставка НДС для заявки: чужое значение площадка не примет. */
export function normalizeNds(value) {
  const parsed = Math.trunc(Number(value));
  return NDS_VALUES.has(parsed) ? parsed : -1;
}

/** Рубли в копейки: Яндекс Доставка принимает стоимость целым числом копеек. */
export function toKopecks(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100);
}
