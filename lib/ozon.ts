import { isRetryableStatus, pace, retryAfterFromHeaders, withRetry } from "@/lib/http-retry";

const OZON_API_BASE = "https://api-seller.ozon.ru";

/**
 * Минимальная пауза между запросами к Ozon.
 *
 * Отдельно действует жёсткое правило площадки: остаток по одному артикулу
 * можно обновлять не чаще одного раза в 2 минуты (ошибка TOO_MANY_REQUESTS
 * «Вы слишком часто обновляли остатки для одного артикула»). Его соблюдает
 * логика синхронизации: каждый артикул отправляется один раз за запуск,
 * а повторный запуск блокируется антидребезгом в app/api/stocks/sync-all.
 */
const OZON_MIN_INTERVAL_MS = 120;

export type OzonWarehouse = {
  id: number;
  name: string;
  isRfbs: boolean;
  status: string;
  active: boolean;
};

export type OzonProduct = {
  productId: number;
  offerId: string;
  archived: boolean;
};

export type OzonPostingProduct = {
  sku: number;
  offer_id: string;
  quantity: number;
  price?: { amount?: number | string; currency?: string };
};

export type OzonPosting = {
  posting_number: string;
  status: string;
  in_process_at?: string;
  shipment_date?: string;
  delivering_date?: string;
  delivery_method?: { warehouse_id?: number; warehouse?: string };
  analytics_data?: { region?: string; city?: string; warehouse_id?: number };
  cancellation?: {
    cancel_reason_id?: number;
    cancel_reason?: string;
    cancellation_type?: string;
    cancellation_initiator?: string;
    cancelled_after_ship?: boolean;
  };
  products?: OzonPostingProduct[];
};

export type OzonWarehouseStock = {
  offerId: string;
  productId: number;
  warehouseId: number;
  warehouseName: string;
  freeStock: number;
  present: number;
  reserved: number;
};

export type OzonStockUpdate = {
  offerId: string;
  warehouseId: number;
  stock: number;
};

export class OzonApiError extends Error {
  /** Заполняется, когда Ozon просит подождать дольше, чем можно внутри одного запроса. */
  public retryAfterSeconds?: number;

  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OzonApiError";
  }
}

function apiMessage(status: number, payload: unknown) {
  if (status === 401) return "Ozon отклонил Client-Id или API-ключ. Проверьте реквизиты подключения.";
  if (status === 403) return "У API-ключа Ozon недостаточно прав. Нужен доступ к товарам, остаткам, складам и FBS-заказам.";
  if (status === 429) return "Ozon временно ограничил частоту запросов. Повторите операцию позже.";

  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    const details = Array.isArray(value.details) ? asObject(value.details[0]) : null;
    const detail = value.message ?? value.error ?? value.description ?? details?.message ?? details?.description;
    if (typeof detail === "string" && detail.trim()) return `Ozon: ${detail.trim().slice(0, 240)}`;
  }

  return `Ozon вернул ошибку ${status}. Повторите проверку позже.`;
}

async function ozonRequest<T>(
  path: string,
  clientId: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<T> {
  // 429 и временные сбои повторяются с учётом Retry-After (ТЗ, п. 9).
  // Дублирования это не создаёт: /v2/products/stocks принимает абсолютное
  // количество, поэтому повтор того же пакета даёт то же состояние.
  return withRetry<T>(async () => {
    await pace("ozon", OZON_MIN_INTERVAL_MS);
    let response: Response;
    try {
      response = await fetch(`${OZON_API_BASE}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Client-Id": clientId,
          "Api-Key": apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return {
        retry: true,
        status: 503,
        retryAfterMs: null,
        error: new OzonApiError(503, timeout
          ? "Ozon не ответил за 20 секунд. Повторите операцию."
          : "Не удалось связаться с Ozon. Повторите операцию позже."),
      };
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }

    if (response.ok) return { retry: false, value: payload as T };

    const apiError = new OzonApiError(response.status, apiMessage(response.status, payload));
    if (!isRetryableStatus(response.status)) throw apiError;
    return {
      retry: true,
      status: response.status,
      retryAfterMs: retryAfterFromHeaders(response.headers),
      error: apiError,
    };
  });
}

function asObject(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getOzonWarehouses(clientId: string, apiKey: string) {
  const warehouses: OzonWarehouse[] = [];
  let cursor = "";

  for (let page = 0; page < 10; page += 1) {
    const payload = await ozonRequest<Record<string, unknown>>(
      "/v2/warehouse/list",
      clientId,
      apiKey,
      { limit: 200, cursor },
    );
    const rows = Array.isArray(payload.warehouses) ? payload.warehouses : [];
    for (const row of rows) {
      const item = asObject(row);
      const id = asNumber(item?.warehouse_id ?? item?.id);
      const name = item?.name ?? item?.warehouse_name;
      if (id !== null && typeof name === "string" && name.trim()) {
        const status = typeof item?.status === "string" ? item.status.trim().toLowerCase() : "";
        warehouses.push({
          id,
          name: name.trim(),
          isRfbs: item?.is_rfbs === true,
          status,
          active: status === "created" || status === "active" || status === "enabled",
        });
      }
    }

    if (payload.has_next !== true || typeof payload.cursor !== "string" || !payload.cursor) break;
    cursor = payload.cursor;
  }

  return [...new Map(warehouses.map((warehouse) => [warehouse.id, warehouse])).values()];
}

export async function getOzonProductCatalog(clientId: string, apiKey: string) {
  const products: OzonProduct[] = [];
  let lastId = "";

  for (let page = 0; page < 10; page += 1) {
    const payload = await ozonRequest<{ result?: { items?: unknown[]; last_id?: string } }>(
      "/v3/product/list",
      clientId,
      apiKey,
      {
        filter: { offer_id: [], product_id: [], visibility: "ALL" },
        last_id: lastId,
        limit: 1000,
      },
    );
    const rows = Array.isArray(payload.result?.items) ? payload.result.items : [];
    for (const row of rows) {
      const item = asObject(row);
      const productId = asNumber(item?.product_id);
      const offerId = item?.offer_id;
      if (productId !== null && typeof offerId === "string" && offerId.trim()) {
        products.push({ productId, offerId: offerId.trim(), archived: item?.archived === true });
      }
    }

    const next = payload.result?.last_id;
    if (rows.length < 1000 || typeof next !== "string" || !next || next === lastId) break;
    lastId = next;
  }

  return [...new Map(products.map((product) => [product.offerId, product])).values()];
}

export async function getOzonRoles(clientId: string, apiKey: string) {
  return ozonRequest<Record<string, unknown>>("/v1/roles", clientId, apiKey, {});
}

export async function getOzonUnfulfilledPostings(clientId: string, apiKey: string) {
  const postings: OzonPosting[] = [];
  let cursor = "";
  const cutoffFrom = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
  const cutoffTo = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString();

  for (let page = 0; page < 10; page += 1) {
    const payload = await ozonRequest<{
      postings?: OzonPosting[];
      cursor?: string;
      has_next?: boolean;
      result?: { postings?: OzonPosting[]; cursor?: string; has_next?: boolean };
    }>(
      "/v4/posting/fbs/unfulfilled/list",
      clientId,
      apiKey,
      {
        cursor,
        filter: {
          cutoff_from: cutoffFrom,
          cutoff_to: cutoffTo,
          status: [
            "awaiting_registration",
            "acceptance_in_progress",
            "awaiting_approve",
            "awaiting_packaging",
            "awaiting_deliver",
            "arbitration",
            "client_arbitration",
            "delivering",
            "driver_pickup",
          ],
        },
        limit: 100,
        sort_dir: "ASC",
        with: { analytics_data: true, financial_data: false, legal_info: false, barcodes: false },
      },
    );
    const pageResult = payload.result ?? payload;
    const rows = Array.isArray(pageResult.postings) ? pageResult.postings : [];
    postings.push(...rows.filter((posting) => posting && typeof posting.posting_number === "string"));
    if (pageResult.has_next !== true || typeof pageResult.cursor !== "string" || !pageResult.cursor || pageResult.cursor === cursor) break;
    cursor = pageResult.cursor;
  }

  return postings;
}

export async function getOzonPostings(clientId: string, apiKey: string, days: number) {
  const postings: OzonPosting[] = [];
  let cursor = "";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();

  for (let page = 0; page < 30; page += 1) {
    const payload = await ozonRequest<{
      postings?: OzonPosting[];
      cursor?: string;
      has_next?: boolean;
    }>(
      "/v4/posting/fbs/list",
      clientId,
      apiKey,
      {
        cursor,
        filter: { since, to },
        limit: 100,
        sort_dir: "ASC",
        with: { analytics_data: true, financial_data: false, legal_info: false, barcodes: false },
      },
    );
    const rows = Array.isArray(payload.postings) ? payload.postings : [];
    postings.push(...rows.filter((posting) => posting && typeof posting.posting_number === "string"));
    if (payload.has_next !== true || typeof payload.cursor !== "string" || !payload.cursor || payload.cursor === cursor) break;
    cursor = payload.cursor;
  }

  return [...new Map(postings.map((posting) => [posting.posting_number, posting])).values()];
}

export async function updateOzonStocks(
  clientId: string,
  apiKey: string,
  stocks: OzonStockUpdate[],
) {
  const failures: Array<{ offerId: string; warehouseId: number; message: string }> = [];
  for (let start = 0; start < stocks.length; start += 100) {
    const chunk = stocks.slice(start, start + 100);
    const payload = await ozonRequest<{ result?: unknown[] }>(
      "/v2/products/stocks",
      clientId,
      apiKey,
      {
        stocks: chunk.map((stock) => ({
          offer_id: stock.offerId,
          stock: stock.stock,
          warehouse_id: stock.warehouseId,
        })),
      },
    );
    const result = Array.isArray(payload.result) ? payload.result : [];
    for (const row of result) {
      const item = asObject(row);
      const errors = Array.isArray(item?.errors) ? item.errors : [];
      if (item?.updated === false || errors.length > 0) {
        const firstError = asObject(errors[0]);
        failures.push({
          offerId: String(item?.offer_id ?? ""),
          warehouseId: Number(item?.warehouse_id ?? 0),
          message: String(firstError?.message ?? firstError?.code ?? "Ozon не подтвердил обновление"),
        });
      }
    }
    if (result.length !== chunk.length) {
      const acknowledged = new Set(result.map((row) => {
        const item = asObject(row);
        return `${String(item?.offer_id ?? "")}::${String(item?.warehouse_id ?? "")}`;
      }));
      for (const stock of chunk) {
        if (!acknowledged.has(`${stock.offerId}::${stock.warehouseId}`)) {
          failures.push({ offerId: stock.offerId, warehouseId: stock.warehouseId, message: "Ozon не вернул подтверждение для пары товар-склад" });
        }
      }
    }
  }
  return failures;
}

export async function getOzonStocksByWarehouse(
  clientId: string,
  apiKey: string,
  offerIds: string[],
) {
  const stocks: OzonWarehouseStock[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const payload = await ozonRequest<Record<string, unknown>>(
      "/v2/product/info/stocks-by-warehouse/fbs",
      clientId,
      apiKey,
      { offer_id: offerIds, limit: 1000, cursor },
    );
    const rows = Array.isArray(payload.products) ? payload.products : [];
    for (const row of rows) {
      const item = asObject(row);
      const offerId = item?.offer_id;
      const productId = asNumber(item?.product_id);
      const warehouseId = asNumber(item?.warehouse_id);
      if (typeof offerId !== "string" || productId === null || warehouseId === null) continue;
      stocks.push({
        offerId,
        productId,
        warehouseId,
        warehouseName: typeof item?.warehouse_name === "string" ? item.warehouse_name : String(warehouseId),
        freeStock: asNumber(item?.free_stock) ?? 0,
        present: asNumber(item?.present) ?? 0,
        reserved: asNumber(item?.reserved) ?? 0,
      });
    }
    if (payload.has_next !== true || typeof payload.cursor !== "string" || !payload.cursor || payload.cursor === cursor) break;
    cursor = payload.cursor;
  }
  return stocks;
}
