import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";

/**
 * Журнал синхронизации остатков (ТЗ, п. 12).
 * Секретов здесь нет и быть не может: в stock_sync_log пишутся только
 * количества, идентификаторы складов и текст ответа API.
 */
export async function GET(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна.", rows: [], runs: [] }, { status: 500 });

  const url = new URL(request.url);
  const article = url.searchParams.get("article")?.trim() ?? "";
  const warehouseId = url.searchParams.get("warehouseId")?.trim() ?? "";
  const status = url.searchParams.get("status")?.trim() ?? "";
  const runId = url.searchParams.get("runId")?.trim() ?? "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200), 1), 1000);

  const rows = await runtime.DB.prepare(
    `SELECT l.id,
            l.run_id AS runId,
            l.marketplace_id AS marketplaceId,
            l.warehouse_id AS warehouseId,
            w.name AS warehouseName,
            l.article,
            l.size,
            l.external_sku AS externalSku,
            l.osv_qty AS osvQty,
            l.reserve_qty AS reserveQty,
            l.computed_qty AS computedQty,
            l.sent_qty AS sentQty,
            l.api_status AS apiStatus,
            l.api_message AS apiMessage,
            l.actor_email AS actorEmail,
            l.created_at AS createdAt
     FROM stock_sync_log l
     LEFT JOIN marketplace_warehouses w
       ON w.marketplace_id = l.marketplace_id AND w.external_id = l.warehouse_id
     WHERE (? = '' OR l.article LIKE '%' || ? || '%' OR l.external_sku LIKE '%' || ? || '%')
       AND (? = '' OR l.warehouse_id = ?)
       AND (? = '' OR l.api_status = ?)
       AND (? = '' OR l.run_id = ?)
     ORDER BY l.id DESC
     LIMIT ?`,
  ).bind(article, article, article, warehouseId, warehouseId, status, status, runId, runId, limit).all();

  const runs = await runtime.DB.prepare(
    `SELECT id, status, trigger, osv_upload_id AS osvUploadId, actor_email AS actorEmail,
            message, started_at AS startedAt, finished_at AS finishedAt
     FROM stock_sync_runs
     ORDER BY started_at DESC
     LIMIT 25`,
  ).all();

  return Response.json({ rows: rows.results, runs: runs.results });
}
