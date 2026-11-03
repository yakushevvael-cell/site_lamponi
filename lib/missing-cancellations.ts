import { isWildberriesCancelled } from "@/lib/warehouse-core.mjs";
import { getMarketplaceCredentials } from "@/lib/credentials";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { getWildberriesOrderStatuses } from "@/lib/wildberries";
import { runMissingCancellations, CANCEL_SETTINGS_KEY } from "./missing-cancel-core.mjs";

/** No automatic retries for messages or quantity-based cancellations. */
async function request(url: string, headers: Record<string, string>, body?: unknown, method = "POST") {
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { throw new Error("Площадка вернула непонятный ответ. Проверьте результат вручную."); }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${String(data?.message ?? data?.error ?? response.statusText).slice(0,400)}`) as Error & { definitive: boolean };
    error.definitive = [400,401,403,404,409,422,429].includes(response.status);
    throw error;
  }
  return data;
}

export async function runMissingCancellationJobs(db: D1Database, runtime: AppRuntimeEnv, itemId?: number) {
  const ozon = async (path: string, body: unknown = {}) => {
    const c = await getMarketplaceCredentials(db, runtime, "ozon");
    if (!c.OZON_CLIENT_ID || !c.OZON_API_KEY) throw new Error("Не настроено подключение Ozon.");
    return request(`https://api-seller.ozon.ru${path}`, { "Client-Id": c.OZON_CLIENT_ID, "Api-Key": c.OZON_API_KEY, "Content-Type": "application/json" }, body);
  };
  const wbToken = async () => {
    const c = await getMarketplaceCredentials(db, runtime, "wildberries");
    if (!c.WB_API_TOKEN) throw new Error("Не настроено подключение WB.");
    return c.WB_API_TOKEN;
  };
  return runMissingCancellations(db, {
    ozonPosting: async (posting: string) => (await ozon("/v3/posting/fbs/get", { posting_number: posting })).result,
    ozonCheckReason: async () => {
      const data = await ozon("/v2/posting/fbs/cancel-reason/list");
      if (!data?.result?.some((r: {id: number; is_available_for_cancellation: boolean}) => r.id === 352 && r.is_available_for_cancellation)) throw new Error("Ozon не разрешает причину отмены «Товар закончился на складе продавца».");
    },
    ozonChat: async (posting: string) => {
      const data = await ozon("/v1/chat/start", { posting_number: posting });
      if (!data?.result?.chat_id) throw new Error("Ozon не создал чат. Проверьте доступ Premium Plus/Pro и права API-ключа.");
      return String(data.result.chat_id);
    },
    ozonSend: async (chat: string, text: string) => {
      const data = await ozon("/v1/chat/send/message", { chat_id: chat, text });
      if (data?.result !== "success") throw new Error("Ozon не подтвердил отправку сообщения. Автоматическая отмена остановлена.");
    },
    ozonCancel: async (posting: string, sku: string, quantity: number) => {
      const data = await ozon("/v2/posting/fbs/product/cancel", {
        posting_number: posting, cancel_reason_id: 352, cancel_reason_message: "Товар не найден при сборке",
        items: [{ sku: Number(sku), quantity }],
      });
      if (typeof data?.result !== "string") throw new Error("Ozon не подтвердил частичную отмену. Проверьте результат вручную.");
      return data.result;
    },
    wbStatus: async (posting: string) => {
      const rows = await getWildberriesOrderStatuses(await wbToken(), [Number(posting)]);
      const row = rows.find(r => String(r.id) === posting);
      if (!row) throw new Error("WB не вернул статус заказа.");
      return isWildberriesCancelled(row) ? "cancel" : row.supplierStatus;
    },
    wbCancel: async (posting: string) => request(`https://marketplace-api.wildberries.ru/api/v3/orders/${encodeURIComponent(posting)}/cancel`, { Authorization: await wbToken() }, undefined, "PATCH"),
  }, { itemId, limit: 1 });
}

export async function readMissingCancelSettings(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key=?").bind(CANCEL_SETTINGS_KEY).first<{value:string}>();
  return row ? JSON.parse(row.value) as {text:string; promo:string} : {text:"",promo:""};
}

export async function readMissingCancellations(db: D1Database, taskId: number) {
  return (await db.prepare(`SELECT id, item_id AS itemId, state, error, sent_at AS sentAt, due_at AS dueAt, message,
    cancel_requested_at AS cancelRequestedAt FROM missing_item_cancellations WHERE task_id=? ORDER BY id`).bind(taskId).all()).results;
}

export async function missingPostingBlocked(db: D1Database, marketplace: string, posting: string) {
  return Boolean(await db.prepare("SELECT id FROM missing_item_cancellations WHERE marketplace_id=? AND posting=? AND state<>'done' LIMIT 1").bind(marketplace,posting).first());
}
