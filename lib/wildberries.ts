import { isRetryableStatus, pace, retryAfterFromHeaders, withRetry } from "@/lib/http-retry";

/**
 * Wildberries считает лимит как token bucket: около 300 запросов в минуту на
 * методы Marketplace, рекомендованный интервал между запросами — 200 мс.
 * Соблюдаем интервал заранее, вместо того чтобы лечить 429 повторами.
 */
const WILDBERRIES_MIN_INTERVAL_MS = 220;

const WILDBERRIES_WAREHOUSES_URL = "https://marketplace-api.wildberries.ru/api/v3/warehouses";
const WILDBERRIES_CARDS_URL = "https://content-api.wildberries.ru/content/v2/get/cards/list";
const WILDBERRIES_NEW_ORDERS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders/new";
const WILDBERRIES_ORDERS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders";
const WILDBERRIES_ORDER_STATUS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders/status";

export type WildberriesWarehouse = {
  id: number;
  name: string;
  officeId?: number;
  cargoType?: number;
  deliveryType?: number;
  isDeleting?: boolean;
  isProcessing?: boolean;
};

export type WildberriesCardSize = {
  chrtID: number;
  techSize?: string;
  wbSize?: string;
  skus?: string[];
};

export type WildberriesCard = {
  nmID: number;
  vendorCode: string;
  title?: string;
  sizes: WildberriesCardSize[];
};

export type WildberriesOrder = {
  id: number;
  /** Поставка, за которой закреплено задание. */
  supplyId?: string;
  article?: string;
  chrtId: number;
  nmId?: number;
  warehouseId?: number;
  officeId?: number;
  createdAt: string;
  price?: number;
  convertedPrice?: number;
  finalPrice?: number;
  convertedFinalPrice?: number;
  currencyCode?: number;
  convertedCurrencyCode?: number;
  offices?: string[];
  address?: { fullAddress?: string };
};

export type WildberriesOrderStatus = {
  id: number;
  supplierStatus: string;
  wbStatus: string;
};

export class WildberriesApiError extends Error {
  /** Заполняется, когда WB просит подождать дольше, чем можно внутри одного запроса. */
  public retryAfterSeconds?: number;

  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WildberriesApiError";
  }
}

function apiMessage(status: number, payload: unknown, requiredCategory = "Marketplace") {
  if (status === 401) return "Wildberries отклонил ключ. Проверьте, что ключ действующий.";
  if (status === 403) return `У ключа нет доступа к категории ${requiredCategory}. Добавьте это разрешение в кабинете WB.`;
  if (status === 429) return "Wildberries временно ограничил частоту запросов. Повторите проверку через минуту.";

  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    const detail = value.detail ?? value.message ?? value.title;
    if (typeof detail === "string" && detail.trim()) return `Wildberries: ${detail.trim().slice(0, 240)}`;
  }

  return `Wildberries вернул ошибку ${status}. Повторите проверку позже.`;
}

async function wildberriesRequest<T>(
  url: string,
  token: string,
  init: RequestInit = {},
  requiredCategory = "Marketplace",
  timeoutMs = 15_000,
): Promise<T> {
  // 429 и временные сбои повторяются с учётом Retry-After (ТЗ, п. 9).
  // PUT /api/v3/stocks/{warehouseId} принимает абсолютные остатки, поэтому
  // повтор пакета не приводит к двойному списанию.
  return withRetry<T>(async () => {
    await pace("wildberries", WILDBERRIES_MIN_INTERVAL_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: token,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return {
        retry: true,
        status: 503,
        retryAfterMs: null,
        error: new WildberriesApiError(503, timeout
          ? `Wildberries не ответил за ${Math.round(timeoutMs / 1000)} с. Повторите операцию.`
          : "Не удалось связаться с Wildberries. Повторите операцию позже."),
      };
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }

    if (response.ok) return { retry: false, value: payload as T };

    const apiError = new WildberriesApiError(response.status, apiMessage(response.status, payload, requiredCategory));
    if (!isRetryableStatus(response.status)) throw apiError;
    return {
      retry: true,
      status: response.status,
      retryAfterMs: retryAfterFromHeaders(response.headers),
      error: apiError,
    };
  });
}

export async function getWildberriesWarehouses(token: string): Promise<WildberriesWarehouse[]> {
  const payload = await wildberriesRequest<unknown>(WILDBERRIES_WAREHOUSES_URL, token);
  if (!Array.isArray(payload)) throw new WildberriesApiError(502, "Wildberries вернул неожиданный ответ со списком складов.");

  return payload.filter((item): item is WildberriesWarehouse => {
    if (!item || typeof item !== "object") return false;
    const warehouse = item as Partial<WildberriesWarehouse>;
    return typeof warehouse.id === "number" && typeof warehouse.name === "string";
  });
}

export async function getWildberriesCardsByArticle(token: string, article: string) {
  const payload = await wildberriesRequest<{ cards?: WildberriesCard[] }>(
    WILDBERRIES_CARDS_URL,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        settings: {
          sort: { ascending: false },
          filter: { textSearch: article, withPhoto: -1 },
          cursor: { limit: 100 },
        },
      }),
    },
    "Контент",
  );
  return Array.isArray(payload.cards) ? payload.cards : [];
}

export async function getWildberriesCards(token: string) {
  const cards: WildberriesCard[] = [];
  let updatedAt: string | undefined;
  let nmID: number | undefined;

  // Страниц по 100 карточек: 40 страниц не хватало на весь ассортимент, а
  // карточки, до которых обход не дошёл, теряли размер в задании на сборку.
  for (let page = 0; page < 200; page += 1) {
    const payload = await wildberriesRequest<{
      cards?: WildberriesCard[];
      cursor?: { updatedAt?: string; nmID?: number; total?: number };
    }>(
      WILDBERRIES_CARDS_URL,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          settings: {
            sort: { ascending: true },
            filter: { withPhoto: -1 },
            cursor: { limit: 100, ...(updatedAt ? { updatedAt, nmID } : {}) },
          },
        }),
      },
      "Контент",
    );
    const rows = Array.isArray(payload.cards) ? payload.cards : [];
    cards.push(...rows);
    const nextUpdatedAt = payload.cursor?.updatedAt;
    const nextNmID = payload.cursor?.nmID;
    if (rows.length < 100 || !nextUpdatedAt || typeof nextNmID !== "number") break;
    if (nextUpdatedAt === updatedAt && nextNmID === nmID) break;
    updatedAt = nextUpdatedAt;
    nmID = nextNmID;
  }

  return [...new Map(cards.map((card) => [card.nmID, card])).values()];
}

export async function getWildberriesNewOrders(token: string) {
  const payload = await wildberriesRequest<{ orders?: WildberriesOrder[] }>(WILDBERRIES_NEW_ORDERS_URL, token);
  return Array.isArray(payload.orders) ? payload.orders : [];
}

export async function getWildberriesOrders(token: string, days: number) {
  const orders: WildberriesOrder[] = [];
  let next = 0;
  const dateFrom = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  for (let page = 0; page < 20; page += 1) {
    const url = new URL(WILDBERRIES_ORDERS_URL);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("next", String(next));
    url.searchParams.set("dateFrom", String(dateFrom));
    const payload = await wildberriesRequest<{ next?: number; orders?: WildberriesOrder[] }>(url.toString(), token);
    const rows = Array.isArray(payload.orders) ? payload.orders : [];
    orders.push(...rows);
    const nextValue = Number(payload.next ?? 0);
    if (rows.length === 0 || !Number.isFinite(nextValue) || nextValue <= 0 || nextValue === next) break;
    next = nextValue;
  }

  return [...new Map(orders.map((order) => [order.id, order])).values()];
}

export async function getWildberriesOrderStatuses(token: string, orderIds: number[]) {
  if (orderIds.length === 0) return [];
  const statuses: WildberriesOrderStatus[] = [];
  for (let start = 0; start < orderIds.length; start += 1000) {
    const payload = await wildberriesRequest<{ orders?: WildberriesOrderStatus[] }>(
      WILDBERRIES_ORDER_STATUS_URL,
      token,
      { method: "POST", body: JSON.stringify({ orders: orderIds.slice(start, start + 1000) }) },
    );
    if (Array.isArray(payload.orders)) statuses.push(...payload.orders);
  }
  return statuses;
}

export async function updateWildberriesStocks(
  token: string,
  warehouseId: string,
  stocks: Array<{ chrtId: number; amount: number }>,
) {
  for (let start = 0; start < stocks.length; start += 1000) {
    await wildberriesRequest<null>(
      `https://marketplace-api.wildberries.ru/api/v3/stocks/${encodeURIComponent(warehouseId)}`,
      token,
      { method: "PUT", body: JSON.stringify({ stocks: stocks.slice(start, start + 1000) }) },
    );
  }
}

export async function getWildberriesStocks(token: string, warehouseId: string, chrtIds: number[]) {
  const payload = await wildberriesRequest<{ stocks?: Array<{ chrtId: number; amount: number }> }>(
    `https://marketplace-api.wildberries.ru/api/v3/stocks/${encodeURIComponent(warehouseId)}`,
    token,
    { method: "POST", body: JSON.stringify({ chrtIds }) },
  );
  return Array.isArray(payload.stocks) ? payload.stocks : [];
}

/**
 * Продажи и возвраты Wildberries (Статистика).
 *
 * Marketplace-методы, на которых работает остальная синхронизация, знают только
 * статус сборочного задания: «продано» там появляется без даты выкупа. Отчёт
 * «Продажи» отдаёт каждую продажу отдельной строкой с датой и ценой:
 *   priceWithDisc — цена с учётом скидки продавца, то есть та цена, которую
 *   установил продавец (в отличие от finishedPrice, где учтена ещё и скидка WB).
 * Возвраты приходят тем же отчётом: saleID начинается с «R», а суммы у них
 * отрицательные.
 *
 * Метод лимитирован: один запрос в минуту и до 80 000 строк за раз, отвечает
 * медленно — поэтому таймаут увеличен, а вызывается он только фоновой задачей.
 */
const WILDBERRIES_SALES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/sales";

export type WildberriesSale = {
  date: string;
  lastChangeDate?: string;
  saleID?: string;
  srid?: string;
  supplierArticle?: string;
  nmId?: number;
  totalPrice?: number;
  priceWithDisc?: number;
  finishedPrice?: number;
  forPay?: number;
  quantity?: number;
  isStorno?: number;
  IsStorno?: number;
};

export async function getWildberriesSales(token: string, dateFrom: string): Promise<WildberriesSale[]> {
  const url = new URL(WILDBERRIES_SALES_URL);
  url.searchParams.set("dateFrom", dateFrom);
  url.searchParams.set("flag", "0");
  const payload = await wildberriesRequest<unknown>(url.toString(), token, {}, "Статистика", 120_000);
  if (!Array.isArray(payload)) {
    throw new WildberriesApiError(502, "Wildberries вернул неожиданный ответ с отчётом о продажах.");
  }
  return payload.filter((row): row is WildberriesSale => Boolean(row) && typeof row === "object" && typeof (row as WildberriesSale).date === "string");
}

/**
 * Заказы Wildberries (Статистика).
 *
 * Marketplace-методы, на которых работает синхронизация остатков, знают только
 * сборочные задания своего склада. В кабинете продавец видит все заказы,
 * включая склад площадки, — поэтому для дашборда заказы берём из статистики.
 * Цена — priceWithDisc, то есть с учётом скидки продавца; отменённые заказы
 * помечены isCancel.
 */
const WILDBERRIES_STAT_ORDERS_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/orders";

export type WildberriesStatOrder = {
  date: string;
  lastChangeDate?: string;
  srid?: string;
  gNumber?: string;
  supplierArticle?: string;
  nmId?: number;
  totalPrice?: number;
  discountPercent?: number;
  priceWithDisc?: number;
  finishedPrice?: number;
  isCancel?: boolean;
  cancelDate?: string;
  warehouseName?: string;
};

export async function getWildberriesStatOrders(token: string, dateFrom: string): Promise<WildberriesStatOrder[]> {
  const url = new URL(WILDBERRIES_STAT_ORDERS_URL);
  url.searchParams.set("dateFrom", dateFrom);
  url.searchParams.set("flag", "0");
  const payload = await wildberriesRequest<unknown>(url.toString(), token, {}, "Статистика", 120_000);
  if (!Array.isArray(payload)) {
    throw new WildberriesApiError(502, "Wildberries вернул неожиданный ответ с отчётом о заказах.");
  }
  return payload.filter((row): row is WildberriesStatOrder => Boolean(row) && typeof row === "object" && typeof (row as WildberriesStatOrder).date === "string");
}

/* ============================================================
   Сборочные задания FBS: отмена, УИН и стикеры (ТЗ, п. 4 и 5).
   ============================================================ */

/**
 * Отмена сборочного задания.
 *
 * Нужна, когда изделия физически нет: без УИН поставку не закрыть, и задание
 * придётся отменять. Раньше это делалось руками в кабинете.
 */
export async function cancelWildberriesOrder(token: string, orderId: string | number) {
  await wildberriesRequest<null>(
    `https://marketplace-api.wildberries.ru/api/v3/orders/${encodeURIComponent(String(orderId))}/cancel`,
    token,
    { method: "PATCH" },
  );
  return true;
}

/**
 * Передача УИН (SGTIN) по сборочному заданию.
 *
 * Для ювелирных изделий Wildberries ждёт номера экземпляров до отгрузки.
 * Ошибку не глотаем: на складе должно быть видно, что УИН не принят.
 */
export async function setWildberriesSgtin(token: string, orderId: string | number, sgtins: string[]) {
  await wildberriesRequest<null>(
    `https://marketplace-api.wildberries.ru/api/v3/orders/${encodeURIComponent(String(orderId))}/meta/sgtin`,
    token,
    { method: "PUT", body: JSON.stringify({ sgtins }) },
  );
  return true;
}

export type WildberriesSticker = {
  orderId: number;
  partA?: number;
  partB?: number;
  barcode?: string;
  file?: string;
};

/**
 * Стикеры сборочных заданий: картинка в base64.
 *
 * Размер 58×40 — стандартный термоярлык WB. Это заменяет выгрузку PDF из
 * кабинета и разбор QR-кодов из него.
 */
export async function getWildberriesStickers(
  token: string,
  orderIds: Array<string | number>,
  options: { type?: "png" | "svg"; width?: number; height?: number } = {},
) {
  const type = options.type ?? "png";
  const width = options.width ?? 58;
  const height = options.height ?? 40;
  const stickers: WildberriesSticker[] = [];
  for (let start = 0; start < orderIds.length; start += 100) {
    const chunk = orderIds.slice(start, start + 100).map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (chunk.length === 0) continue;
    const url = new URL("https://marketplace-api.wildberries.ru/api/v3/orders/stickers");
    url.searchParams.set("type", type);
    url.searchParams.set("width", String(width));
    url.searchParams.set("height", String(height));
    const payload = await wildberriesRequest<{ stickers?: WildberriesSticker[] }>(
      url.toString(),
      token,
      { method: "POST", body: JSON.stringify({ orders: chunk }) },
    );
    if (Array.isArray(payload.stickers)) stickers.push(...payload.stickers);
  }
  return stickers;
}

/* ============================================================
   Поставки FBS (ТЗ, п. 6): один склад = одна поставка.
   ============================================================ */

const WB_MARKETPLACE_BASE = "https://marketplace-api.wildberries.ru/api/v3";

/**
 * Часть методов Маркетплейса WB переехала под префикс /api/marketplace/v3,
 * а старые адреса остались работать — но не все. Проверено на живом API:
 * добавление задания в поставку, состав поставки, пункты отгрузки и способ
 * отгрузки отвечают только по новому префиксу, а по старому WB возвращает
 * 404 «path not found», даже не намекая, что метод переехал.
 */
const WB_MARKETPLACE_NEW = "https://marketplace-api.wildberries.ru/api/marketplace/v3";

export type WildberriesOffice = {
  id: number;
  name: string;
  address?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  cargoType?: number;
  deliveryType?: number;
  selected?: boolean;
};

/** Склады приёмки Wildberries — справочник точек сдачи. */
export async function getWildberriesOffices(token: string) {
  const payload = await wildberriesRequest<WildberriesOffice[]>(`${WB_MARKETPLACE_BASE}/offices`, token);
  return Array.isArray(payload) ? payload : [];
}

export type WildberriesSupplyInfo = { id: string; done?: boolean; createdAt?: string; closedAt?: string | null; scanDt?: string | null };

/**
 * Все поставки FBS продавца. Нужны ради closedAt — момента, когда поставка
 * передана в доставку: время перехода задания на этап «в доставке» Wildberries
 * у самого задания не отдаёт.
 */
export async function getWildberriesSupplies(token: string, maxPages = 50) {
  const supplies: WildberriesSupplyInfo[] = [];
  let next = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${WB_MARKETPLACE_BASE}/supplies`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("next", String(next));
    const payload = await wildberriesRequest<{ next?: number; supplies?: WildberriesSupplyInfo[] }>(url.toString(), token);
    const rows = Array.isArray(payload.supplies) ? payload.supplies : [];
    supplies.push(...rows.filter((row) => row && typeof row.id === "string"));
    const nextValue = Number(payload.next ?? 0);
    if (rows.length === 0 || !Number.isFinite(nextValue) || nextValue <= 0 || nextValue === next) break;
    next = nextValue;
  }
  return supplies;
}

/** Создание поставки. Возвращает её идентификатор WB-XXXXXXX. */
export async function createWildberriesSupply(token: string, name: string) {
  const payload = await wildberriesRequest<{ id?: string }>(
    `${WB_MARKETPLACE_BASE}/supplies`,
    token,
    { method: "POST", body: JSON.stringify({ name: name.slice(0, 128) }) },
  );
  const id = String(payload.id ?? "");
  if (!id) throw new WildberriesApiError(502, "Wildberries не вернул номер поставки.");
  return id;
}

/** Удаление пустой поставки. WB позволяет удалить только поставку без заданий. */
export async function deleteWildberriesSupply(token: string, supplyId: string) {
  await wildberriesRequest<null>(
    `${WB_MARKETPLACE_BASE}/supplies/${encodeURIComponent(supplyId)}`,
    token,
    { method: "DELETE" },
  );
}

/**
 * Добавление сборочных заданий в поставку — до 100 за раз.
 * Задания переходят в статус confirm: только после этого WB отдаёт стикеры и
 * принимает УИН.
 */
export async function addOrdersToWildberriesSupply(
  token: string,
  supplyId: string,
  orderIds: Array<string | number>,
) {
  const orders = orderIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (orders.length === 0) return;
  for (let start = 0; start < orders.length; start += 100) {
    await wildberriesRequest<null>(
      `${WB_MARKETPLACE_NEW}/supplies/${encodeURIComponent(supplyId)}/orders`,
      token,
      { method: "PATCH", body: JSON.stringify({ orders: orders.slice(start, start + 100) }) },
    );
  }
}

/** Состав поставки: ID закреплённых за ней сборочных заданий. */
export async function getWildberriesSupplyOrderIds(token: string, supplyId: string) {
  const payload = await wildberriesRequest<{ orderIds?: number[] }>(
    `${WB_MARKETPLACE_NEW}/supplies/${encodeURIComponent(supplyId)}/order-ids`,
    token,
  );
  return Array.isArray(payload.orderIds) ? payload.orderIds.map(String) : [];
}

/**
 * УИН ювелирного изделия за сборочным заданием.
 *
 * Это не sgtin: sgtin — код Честного знака, у него другое поле и другой
 * метод. Ювелирке WB ставит в requiredMeta именно uin, ровно 16 символов, и
 * принимает его только у задания в статусе confirm.
 */
export async function setWildberriesUin(token: string, orderId: string | number, uin: string) {
  await wildberriesRequest<null>(
    `${WB_MARKETPLACE_BASE}/orders/${encodeURIComponent(String(orderId))}/meta/uin`,
    token,
    { method: "PUT", body: JSON.stringify({ uin }) },
  );
}

export type WildberriesShippingPoint = {
  id: number;
  name?: string;
  address?: string;
  city?: string;
  officeType?: string;
  cargoTypes?: number[];
  latitude?: number;
  longitude?: number;
  fulfillment?: boolean;
};

/**
 * Пункты отгрузки поставок по городу.
 *
 * Именно из этого справочника берётся shippingPointId, без которого WB не
 * закрывает поставку. Старые «офисы» из /api/v3/offices здесь не годятся:
 * у них другие идентификаторы.
 */
export async function getWildberriesShippingPoints(token: string, city: string, cargoType = 1) {
  const url = new URL(`${WB_MARKETPLACE_NEW}/fbs/shipping-points`);
  url.searchParams.set("city", city);
  url.searchParams.set("cargoType", String(cargoType));
  const payload = await wildberriesRequest<{ shippingPoints?: WildberriesShippingPoint[] }>(url.toString(), token);
  return Array.isArray(payload.shippingPoints) ? payload.shippingPoints : [];
}

/**
 * Способ, дата и пункт отгрузки поставки.
 *
 * Без этих параметров «передать в доставку» возвращает 409. Ответ приходит по
 * каждой поставке отдельно, поэтому ошибку надо читать из results, а не из
 * кода ответа: HTTP 200 не означает, что поставка настроена.
 */
export async function setWildberriesShippingMethod(
  token: string,
  input: { supplyId: string; shippingPointId: number; shippingDate: string; shippingType?: "selfShipping" | "transportCompany" },
) {
  const payload = await wildberriesRequest<{
    results?: Array<{ supplyId?: string; success?: boolean; error?: { detail?: string; code?: number } }>;
  }>(
    `${WB_MARKETPLACE_NEW}/fbs/supplies/shipping-method`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({
        data: [{
          supplyId: input.supplyId,
          shippingType: input.shippingType ?? "selfShipping",
          shippingDt: input.shippingDate,
          shippingPointId: input.shippingPointId,
        }],
      }),
    },
  );
  const result = (payload.results ?? []).find((row) => row.supplyId === input.supplyId) ?? (payload.results ?? [])[0];
  if (result && result.success !== true) {
    const detail = result.error?.detail ?? "Wildberries не принял параметры отгрузки.";
    throw new WildberriesApiError(result.error?.code ?? 400, `Параметры отгрузки поставки: ${detail}`);
  }
}

/** Закрытие поставки — «передать в доставку». После этого состав не меняется. */
export async function deliverWildberriesSupply(token: string, supplyId: string) {
  await wildberriesRequest<null>(
    `${WB_MARKETPLACE_BASE}/supplies/${encodeURIComponent(supplyId)}/deliver`,
    token,
    { method: "PATCH" },
  );
}

/** QR поставки: картинка, которую клеят на груз. */
export async function getWildberriesSupplyBarcode(token: string, supplyId: string, type: "png" | "svg" = "png") {
  const url = new URL(`${WB_MARKETPLACE_BASE}/supplies/${encodeURIComponent(supplyId)}/barcode`);
  url.searchParams.set("type", type);
  const payload = await wildberriesRequest<{ barcode?: string; file?: string }>(url.toString(), token);
  const file = payload.file ?? payload.barcode ?? "";
  if (!file) throw new WildberriesApiError(502, "Wildberries не отдал QR поставки.");
  return file;
}

/** Грузоместа, уже заведённые в поставке, — чтобы повторная попытка не плодила новые. */
export async function getWildberriesSupplyBoxIds(token: string, supplyId: string) {
  const payload = await wildberriesRequest<{ trbxes?: Array<{ id?: string }> }>(
    `${WB_MARKETPLACE_BASE}/supplies/${encodeURIComponent(supplyId)}/trbx`,
    token,
  );
  return (payload?.trbxes ?? []).map((box) => String(box.id ?? "")).filter(Boolean);
}

/** Короба поставки: сколько заявлено — столько и печатается стикеров. */
export async function addWildberriesSupplyBoxes(token: string, supplyId: string, amount: number) {
  const payload = await wildberriesRequest<{ trbxIds?: string[] }>(
    `${WB_MARKETPLACE_BASE}/supplies/${encodeURIComponent(supplyId)}/trbx`,
    token,
    { method: "POST", body: JSON.stringify({ amount: Math.max(1, Math.trunc(amount)) }) },
  );
  return Array.isArray(payload.trbxIds) ? payload.trbxIds : [];
}

export type WildberriesBoxSticker = { trbxId?: string; file?: string; barcode?: string };

/** Стикеры коробов. */
export async function getWildberriesBoxStickers(
  token: string,
  supplyId: string,
  trbxIds: string[],
  type: "png" | "svg" = "png",
) {
  const url = new URL(`${WB_MARKETPLACE_BASE}/supplies/${encodeURIComponent(supplyId)}/trbx/stickers`);
  url.searchParams.set("type", type);
  const payload = await wildberriesRequest<{ stickers?: WildberriesBoxSticker[] }>(
    url.toString(),
    token,
    { method: "POST", body: JSON.stringify({ trbxIds }) },
  );
  return Array.isArray(payload.stickers) ? payload.stickers : [];
}
