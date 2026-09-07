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
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return {
        retry: true,
        status: 503,
        retryAfterMs: null,
        error: new WildberriesApiError(503, timeout
          ? "Wildberries не ответил за 15 секунд. Повторите операцию."
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

  for (let page = 0; page < 40; page += 1) {
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
