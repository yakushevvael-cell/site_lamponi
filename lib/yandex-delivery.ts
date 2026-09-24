/**
 * Клиент API Яндекс Доставки (b2b-платформа).
 *
 * На DBS доставку организует продавец: по собранному заказу Маркета мы сами
 * создаём заявку на курьера. Путь — offers/create (варианты вывоза) →
 * offers/confirm (бронь) → request_id. Этот request_id уходит в Маркет
 * трек-номером, после чего Маркет сам доводит заказ до «доставлен».
 *
 * Авторизация — Bearer-токен из личного кабинета Яндекс Доставки; он бессрочный
 * и не имеет отношения к Api-Key Маркета: это две разные системы.
 */
import {
  isRetryableStatus,
  pace,
  retryAfterFromHeaders,
  withRetry,
} from "@/lib/http-retry";

const DELIVERY_API_BASE = "https://b2b-authproxy.taxi.yandex.net";

/** Тестовый контур Яндекс Доставки: включается переменной окружения. */
const DELIVERY_TEST_BASE = "https://b2b.taxi.tst.yandex.net";

const DELIVERY_MIN_INTERVAL_MS = 200;

export type DeliveryOffer = {
  offerId: string;
  expiresAt: string | null;
  pricing: string | null;
  pricingTotal: string | null;
  from: string | null;
  to: string | null;
};

export type DeliveryRequestInfo = {
  requestId: string;
  status: string | null;
  sharingUrl: string | null;
  /** Номер, который видит покупатель и по которому ищут посылку в поддержке. */
  fullItemsPrice: string | null;
};

export class YandexDeliveryApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "YandexDeliveryApiError";
  }
}

function asObject(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function apiMessage(status: number, payload: unknown) {
  if (status === 401 || status === 403) {
    return "Яндекс Доставка отклонила токен. Проверьте Bearer-токен в личном кабинете Доставки.";
  }
  if (status === 429) return "Яндекс Доставка временно ограничила частоту запросов. Повторите позже.";

  const value = asObject(payload);
  const message = value?.message ?? asObject(value?.error)?.message;
  const code = typeof value?.code === "string" ? value.code : null;
  if (typeof message === "string" && message.trim()) {
    return `Яндекс Доставка: ${message.trim().slice(0, 240)}${code ? ` (${code})` : ""}`;
  }
  return `Яндекс Доставка вернула ошибку ${status}. Повторите операцию позже.`;
}

function baseUrl() {
  return process.env.YANDEX_DELIVERY_TEST === "1" ? DELIVERY_TEST_BASE : DELIVERY_API_BASE;
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string>;
  binary?: boolean;
};

async function deliveryRequest<T>(path: string, token: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "POST";
  const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
  return withRetry<T>(async () => {
    await pace("yandex-delivery", DELIVERY_MIN_INTERVAL_MS);
    let response: Response;
    try {
      response = await fetch(`${baseUrl()}${path}${query}`, {
        method,
        headers: {
          Accept: options.binary ? "application/pdf" : "application/json",
          "Accept-Language": "ru",
          Authorization: `Bearer ${token}`,
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
        error: new YandexDeliveryApiError(503, timeout
          ? "Яндекс Доставка не ответила за 30 секунд. Повторите операцию."
          : "Не удалось связаться с Яндекс Доставкой. Повторите операцию позже."),
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

    const apiError = new YandexDeliveryApiError(response.status, apiMessage(response.status, payload));
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
 * Варианты вывоза по заявке.
 *
 * Возвращает офферы с ценой и интервалом; действуют они недолго, поэтому
 * подтверждать нужный надо сразу, а не откладывать до конца смены.
 */
export async function createDeliveryOffers(token: string, request: unknown): Promise<DeliveryOffer[]> {
  const payload = await deliveryRequest<{ offers?: Array<Record<string, unknown>> }>(
    "/api/b2b/platform/offers/create",
    token,
    { body: request },
  );
  return (payload.offers ?? []).map((offer) => {
    const details = asObject(offer.offer_details);
    const interval = asObject(details?.delivery_interval);
    return {
      offerId: String(offer.offer_id ?? ""),
      expiresAt: typeof offer.expires_at === "string" ? offer.expires_at : null,
      pricing: typeof details?.pricing === "string" ? details.pricing : null,
      pricingTotal: typeof details?.pricing_total === "string" ? details.pricing_total : null,
      from: typeof interval?.min === "string" ? interval.min : null,
      to: typeof interval?.max === "string" ? interval.max : null,
    };
  }).filter((offer) => offer.offerId);
}

/** Бронирование оффера. Возвращает request_id — он же трек-номер для Маркета. */
export async function confirmDeliveryOffer(token: string, offerId: string): Promise<string> {
  const payload = await deliveryRequest<{ request_id?: string }>(
    "/api/b2b/platform/offers/confirm",
    token,
    { body: { offer_id: offerId } },
  );
  const requestId = String(payload.request_id ?? "").trim();
  if (!requestId) throw new YandexDeliveryApiError(502, "Яндекс Доставка не вернула номер заявки.");
  return requestId;
}

/**
 * Заявка на ближайшее время без выбора оффера.
 *
 * Запасной путь, когда офферов не пришло: Доставка сама подберёт ближайший
 * вывоз. Тело запроса то же самое, что у offers/create.
 */
export async function createDeliveryRequest(token: string, request: unknown): Promise<string> {
  const payload = await deliveryRequest<{ request_id?: string }>(
    "/api/b2b/platform/request/create",
    token,
    { body: request },
  );
  const requestId = String(payload.request_id ?? "").trim();
  if (!requestId) throw new YandexDeliveryApiError(502, "Яндекс Доставка не вернула номер заявки.");
  return requestId;
}

/** Состояние заявки: статус и ссылка на отслеживание для покупателя. */
export async function getDeliveryRequestInfo(token: string, requestId: string): Promise<DeliveryRequestInfo> {
  const payload = await deliveryRequest<Record<string, unknown>>(
    "/api/b2b/platform/request/info",
    token,
    { method: "GET", query: { request_id: requestId } },
  );
  const state = asObject(payload.state);
  return {
    requestId: String(payload.request_id ?? requestId),
    status: typeof state?.status === "string" ? state.status : typeof payload.status === "string" ? payload.status : null,
    sharingUrl: typeof payload.sharing_url === "string" ? payload.sharing_url : null,
    fullItemsPrice: typeof payload.full_items_price === "string" ? payload.full_items_price : null,
  };
}

/** Отмена заявки: заказ отменили на Маркете или собрать его не смогли. */
export async function cancelDeliveryRequest(token: string, requestId: string) {
  await deliveryRequest("/api/b2b/platform/request/cancel", token, { query: { request_id: requestId } });
}

/**
 * Ярлыки на места заявок, PDF.
 *
 * Печатаются перед приездом курьера: по ним Доставка принимает посылки.
 */
export async function generateDeliveryLabels(token: string, requestIds: string[]): Promise<Uint8Array> {
  return deliveryRequest<Uint8Array>(
    "/api/b2b/platform/request/generate-labels",
    token,
    { body: { request_ids: requestIds }, binary: true },
  );
}

/**
 * Акт приёма-передачи по заявкам, PDF.
 *
 * Это документ, который курьер подписывает при заборе: аналог акта Ozon и
 * QR поставки Wildberries.
 */
export async function getDeliveryHandoverAct(token: string, requestIds: string[]): Promise<Uint8Array> {
  return deliveryRequest<Uint8Array>(
    "/api/b2b/platform/request/get-handover-act",
    token,
    { body: { request_ids: requestIds }, binary: true },
  );
}

export type DeliveryPickupPoint = {
  id: string;
  name: string;
  address: string | null;
  type: string | null;
};

/** Точки самопривоза и ПВЗ: нужны, чтобы выбрать станцию отправления. */
export async function listDeliveryPickupPoints(token: string, filter: Record<string, unknown> = {}) {
  const payload = await deliveryRequest<{ points?: Array<Record<string, unknown>> }>(
    "/api/b2b/platform/pickup-points/list",
    token,
    { body: filter },
  );
  return (payload.points ?? []).map((point): DeliveryPickupPoint => {
    const address = asObject(point.address);
    return {
      id: String(point.id ?? ""),
      name: String(point.name ?? ""),
      address: typeof address?.full_address === "string" ? address.full_address : null,
      type: typeof point.type === "string" ? point.type : null,
    };
  }).filter((point) => point.id);
}
