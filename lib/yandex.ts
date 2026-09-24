/**
 * Клиент Partner API Яндекс Маркета (модель DBS).
 *
 * Авторизация — заголовок `Api-Key`: ключ привязан к кабинету, а не к
 * человеку, и не протухает через год, как OAuth. Ключу нужен доступ
 * «Обработка заказов и информация о них» (inventory-and-order-processing).
 *
 * Два идентификатора, которые легко перепутать: `businessId` — кабинет
 * целиком (по нему читается каталог), `campaignId` — магазин внутри кабинета
 * (по нему идут заказы). В запросах они не взаимозаменяемы.
 */
import {
  isRetryableStatus,
  pace,
  retryAfterFromHeaders,
  withRetry,
} from "@/lib/http-retry";

const YANDEX_API_BASE = "https://api.partner.market.yandex.ru";

/** Маркет разрешает 10 000 запросов в час — держим интервал с запасом. */
const YANDEX_MIN_INTERVAL_MS = 120;

export type YandexCampaign = {
  id: number;
  businessId: number | null;
  domain: string | null;
  placementType: string | null;
};

export type YandexOfferMapping = {
  offerId: string;
  name: string | null;
  archived: boolean;
};

export type YandexOrderItem = {
  id: number;
  offerId: string;
  offerName?: string | null;
  count: number;
  price: number;
  buyerPrice?: number;
};

export type YandexOrder = {
  id: number;
  status: string;
  substatus?: string | null;
  creationDate?: string | null;
  updatedAt?: string | null;
  itemsTotal?: number;
  buyerTotal?: number;
  items: YandexOrderItem[];
  delivery?: {
    type?: string | null;
    serviceName?: string | null;
    deliveryServiceId?: number | null;
    dates?: { fromDate?: string | null; toDate?: string | null; realDeliveryDate?: string | null } | null;
    shipments?: Array<{ id?: number; shipmentDate?: string | null; boxes?: Array<{ id?: number }> }> | null;
    region?: { id?: number; name?: string | null; type?: string | null; parent?: { name?: string | null } | null } | null;
    address?: {
      country?: string | null;
      city?: string | null;
      subway?: string | null;
      street?: string | null;
      house?: string | null;
      block?: string | null;
      entrance?: string | null;
      floor?: string | null;
      apartment?: string | null;
      postcode?: string | null;
      phone?: string | null;
      recipient?: string | null;
    } | null;
  } | null;
  buyer?: { firstName?: string | null; lastName?: string | null; middleName?: string | null; phone?: string | null; email?: string | null } | null;
};

export type YandexOrderAddress = NonNullable<NonNullable<YandexOrder["delivery"]>["address"]>;

export type YandexBox = {
  items: Array<{ id: number; fullCount: number; instances?: Array<Record<string, string>> }>;
};

export class YandexApiError extends Error {
  /** Заполняется, когда Маркет просит подождать дольше одного запроса. */
  public retryAfterSeconds?: number;

  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "YandexApiError";
  }
}

function asObject(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function apiMessage(status: number, payload: unknown) {
  if (status === 401) return "Яндекс Маркет отклонил Api-Key. Проверьте ключ в кабинете продавца.";
  if (status === 403) {
    return "У Api-Key Яндекс Маркета недостаточно прав. Нужен доступ «Обработка заказов и информация о них».";
  }
  if (status === 420 || status === 429) return "Яндекс Маркет временно ограничил частоту запросов. Повторите позже.";

  const value = asObject(payload);
  const errors = Array.isArray(value?.errors) ? asObject(value.errors[0]) : null;
  const detail = errors?.message ?? value?.message ?? asObject(value?.error)?.message;
  if (typeof detail === "string" && detail.trim()) return `Яндекс Маркет: ${detail.trim().slice(0, 240)}`;

  return `Яндекс Маркет вернул ошибку ${status}. Повторите операцию позже.`;
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  /** Ответ — файл (PDF ярлыка), а не JSON. */
  binary?: boolean;
};

async function yandexRequest<T>(path: string, apiKey: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  return withRetry<T>(async () => {
    await pace("yandex-market", YANDEX_MIN_INTERVAL_MS);
    let response: Response;
    try {
      response = await fetch(`${YANDEX_API_BASE}${path}`, {
        method,
        headers: {
          Accept: options.binary ? "application/pdf" : "application/json",
          "Api-Key": apiKey,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return {
        retry: true,
        status: 503,
        retryAfterMs: null,
        error: new YandexApiError(503, timeout
          ? "Яндекс Маркет не ответил за 30 секунд. Повторите операцию."
          : "Не удалось связаться с Яндекс Маркетом. Повторите операцию позже."),
      };
    }

    if (response.ok && options.binary) {
      const buffer = await response.arrayBuffer();
      return { retry: false, value: new Uint8Array(buffer) as unknown as T };
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }

    if (response.ok) return { retry: false, value: payload as T };

    const apiError = new YandexApiError(response.status, apiMessage(response.status, payload));
    if (!isRetryableStatus(response.status)) throw apiError;
    return {
      retry: true,
      status: response.status,
      retryAfterMs: retryAfterFromHeaders(response.headers),
      error: apiError,
    };
  });
}

/**
 * Магазины кабинета.
 *
 * Нужен, чтобы не заставлять администратора искать campaignId и businessId
 * руками: ключ знает свои магазины сам. Заодно это проверка связи.
 */
export async function getYandexCampaigns(apiKey: string): Promise<YandexCampaign[]> {
  const payload = await yandexRequest<{ campaigns?: Array<Record<string, unknown>> }>("/v2/campaigns", apiKey);
  return (payload.campaigns ?? []).map((campaign) => {
    const business = asObject(campaign.business);
    return {
      id: Number(campaign.id),
      businessId: business ? Number(business.id) : null,
      domain: typeof campaign.domain === "string" ? campaign.domain : null,
      placementType: typeof campaign.placementType === "string" ? campaign.placementType : null,
    };
  }).filter((campaign) => Number.isFinite(campaign.id));
}

/**
 * Каталог кабинета: артикулы продавца (offerId) и их названия.
 *
 * offerId у Маркета — наш собственный артикул с размером, поэтому сопоставление
 * с 1С идёт так же, как у Ozon, по ключу «артикул + размер».
 */
export async function getYandexOfferMappings(apiKey: string, businessId: string): Promise<YandexOfferMapping[]> {
  const offers: YandexOfferMapping[] = [];
  let pageToken = "";
  for (let page = 0; page < 200; page += 1) {
    const query = pageToken ? `?limit=200&page_token=${encodeURIComponent(pageToken)}` : "?limit=200";
    const payload = await yandexRequest<{
      result?: {
        offerMappings?: Array<{ offer?: { offerId?: string; name?: string; archived?: boolean } }>;
        paging?: { nextPageToken?: string };
      };
    }>(`/v2/businesses/${businessId}/offer-mappings${query}`, apiKey, { method: "POST", body: {} });

    for (const mapping of payload.result?.offerMappings ?? []) {
      const offerId = String(mapping.offer?.offerId ?? "").trim();
      if (!offerId) continue;
      offers.push({
        offerId,
        name: mapping.offer?.name ?? null,
        archived: mapping.offer?.archived === true,
      });
    }

    pageToken = payload.result?.paging?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return offers;
}

/** ДД-ММ-ГГГГ — формат дат в фильтрах заказов Маркета. */
function marketDate(value: Date) {
  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${value.getUTCFullYear()}`;
}

/**
 * Заказы магазина за последние дни.
 *
 * Окно ограничено 30 днями на запрос — за больший период Маркет отвечает
 * ошибкой, поэтому длинный период режется на куски. Постранично ходим по
 * page_token: параметры page/pageSize Маркет отключает 05.10.2026.
 */
export async function getYandexOrders(apiKey: string, campaignId: string, days: number): Promise<YandexOrder[]> {
  const orders: YandexOrder[] = [];
  const seen = new Set<number>();
  const now = Date.now();
  const windows = Math.max(1, Math.ceil(Math.max(1, days) / 30));

  for (let index = 0; index < windows; index += 1) {
    const toDate = new Date(now - index * 30 * 86_400_000);
    const fromMs = Math.max(now - days * 86_400_000, toDate.getTime() - 29 * 86_400_000);
    const fromDate = new Date(fromMs);
    if (fromDate.getTime() > toDate.getTime()) break;

    let pageToken = "";
    for (let page = 0; page < 200; page += 1) {
      const query = new URLSearchParams({
        fromDate: marketDate(fromDate),
        toDate: marketDate(toDate),
        limit: "50",
      });
      if (pageToken) query.set("page_token", pageToken);
      const payload = await yandexRequest<{
        orders?: YandexOrder[];
        paging?: { nextPageToken?: string };
      }>(`/v2/campaigns/${campaignId}/orders?${query.toString()}`, apiKey);

      for (const order of payload.orders ?? []) {
        const id = Number(order.id);
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        orders.push(order);
      }

      pageToken = payload.paging?.nextPageToken ?? "";
      if (!pageToken) break;
    }
  }

  return orders;
}

/** Один заказ целиком: состав, адрес, покупатель. */
export async function getYandexOrder(apiKey: string, campaignId: string, orderId: string): Promise<YandexOrder | null> {
  const payload = await yandexRequest<{ order?: YandexOrder }>(
    `/v2/campaigns/${campaignId}/orders/${orderId}`,
    apiKey,
  );
  return payload.order ?? null;
}

/**
 * Состав грузовых мест.
 *
 * Вызывается до перевода заказа в «готов к отгрузке»: без него Маркет не
 * выдаст ярлык, а УИН изделий не попадёт в заказ. Возвращает идентификаторы
 * мест — они нужны для ярлыка на отдельную коробку.
 */
export async function setYandexOrderBoxes(
  apiKey: string,
  campaignId: string,
  orderId: string,
  boxes: YandexBox[],
): Promise<number[]> {
  const payload = await yandexRequest<{ result?: { boxes?: Array<{ boxId?: number }> } }>(
    `/v2/campaigns/${campaignId}/orders/${orderId}/boxes`,
    apiKey,
    { method: "PUT", body: { boxes } },
  );
  return (payload.result?.boxes ?? []).map((box) => Number(box.boxId)).filter((id) => Number.isFinite(id));
}

/**
 * Статус заказа.
 *
 * Переходы нужно передавать по порядку: из PROCESSING/STARTED сразу в
 * DELIVERY Маркет не пускает. Последовательность строит yandexHandoverSteps.
 */
export async function updateYandexOrderStatus(
  apiKey: string,
  campaignId: string,
  orderId: string,
  status: string,
  substatus?: string | null,
) {
  await yandexRequest(
    `/v2/campaigns/${campaignId}/orders/${orderId}/status`,
    apiKey,
    { method: "PUT", body: { order: { status, ...(substatus ? { substatus } : {}) } } },
  );
}

export type YandexLabelFormat = "A9" | "A9_HORIZONTALLY" | "A7";

/** Готовые ярлыки-наклейки на все грузовые места заказа, PDF. */
export async function getYandexOrderLabels(
  apiKey: string,
  campaignId: string,
  orderId: string,
  format: YandexLabelFormat = "A7",
): Promise<Uint8Array> {
  return yandexRequest<Uint8Array>(
    `/v2/campaigns/${campaignId}/orders/${orderId}/delivery/labels?format=${format}`,
    apiKey,
    { binary: true },
  );
}

/**
 * Трек-номер посылки.
 *
 * Для DBS с Яндекс Доставкой это request_id заявки. После него Маркет сам
 * доводит заказ до «доставлен» или «отменён», а покупатель видит трекинг.
 * Передавать можно только в статусах PROCESSING, DELIVERY или PICKUP.
 */
export async function setYandexOrderTrack(
  apiKey: string,
  campaignId: string,
  orderId: string,
  trackCode: string,
  deliveryServiceId: number,
) {
  await yandexRequest(
    `/v2/campaigns/${campaignId}/orders/${orderId}/delivery/track`,
    apiKey,
    { method: "POST", body: { trackCode, deliveryServiceId } },
  );
}

export type YandexDeliveryService = { id: number; name: string };

/** Справочник служб доставки Маркета: из него берётся deliveryServiceId. */
export async function getYandexDeliveryServices(apiKey: string): Promise<YandexDeliveryService[]> {
  const payload = await yandexRequest<{ result?: { deliveryServices?: Array<{ id?: number; name?: string }> } }>(
    "/v2/delivery/services",
    apiKey,
  );
  return (payload.result?.deliveryServices ?? [])
    .map((service) => ({ id: Number(service.id), name: String(service.name ?? "") }))
    .filter((service) => Number.isFinite(service.id));
}
