import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { readRemoteMappings } from "@/lib/remote-stocks";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { buildHistory } from "@/lib/stock-history-core.mjs";

/**
 * История остатков одной позиции: заказы и отмены, корректировки остатка на
 * складах площадок и проверки площадок через 10 минут после корректировки.
 *
 * Только чтение из базы — площадки здесь не спрашиваются. Глубина — до 60
 * дней: столько живёт журнал выгрузки (lib/stock-log) и проверки
 * (lib/stock-checks).
 */

const MAX_DAYS = 60;
const DEFAULT_DAYS = 7;
const IN_CHUNK = 400;

type ProductRow = { sourceSku: string; article: string | null; size: string | null };
type WarehouseRow = { marketplaceId: string; externalId: string; name: string; publishing: number };
type OrderRow = {
  orderId: number;
  externalOrderId: string;
  marketplaceId: string;
  status: string | null;
  orderedAt: string | null;
  canceledAt: string | null;
  cancellationSource: string | null;
  sellerCancelled: number;
  warehouseId: string | null;
  warehouseName: string | null;
  quantity: number;
};
type LogRow = {
  runId: string;
  marketplaceId: string;
  warehouseId: string | null;
  sentQty: number | null;
  apiStatus: string;
  apiMessage: string | null;
  createdAt: string | null;
};
type RunRow = { id: string; trigger: string; actorEmail: string | null; startedAt: string | null };
type CheckRow = { id: number; trigger: string; dueAt: string | null; status: string; checkedAt: string | null; message: string | null };
type CheckResultRow = {
  checkId: number;
  marketplaceId: string;
  warehouseId: string;
  warehouseName: string | null;
  publishing: number;
  status: string;
  amount: number | null;
  reserved: number | null;
  expectedQty: number | null;
  message: string | null;
};

function chunks<T>(items: T[]) {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += IN_CHUNK) result.push(items.slice(start, start + IN_CHUNK));
  return result;
}

/** Время для сравнения с полями базы: «ГГГГ-ММ-ДД ЧЧ:ММ:СС», UTC — как CURRENT_TIMESTAMP. */
function sqlTime(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function GET(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const url = new URL(request.url);
  const sourceSku = url.searchParams.get("sourceSku")?.trim() ?? "";
  if (!sourceSku) return Response.json({ error: "Не выбрана позиция." }, { status: 400 });
  const requestedDays = Math.trunc(Number(url.searchParams.get("days") ?? DEFAULT_DAYS));
  const days = Number.isFinite(requestedDays) ? Math.min(MAX_DAYS, Math.max(1, requestedDays)) : DEFAULT_DAYS;
  const sinceDate = new Date(Date.now() - days * 86_400_000);
  const since = sqlTime(sinceDate);
  // Заказы площадки пишут в ISO («2026-09-29T10:15:00Z»): начало периода —
  // по дате, чтобы строковое сравнение было верным для обоих форматов.
  const sinceDay = since.slice(0, 10);

  const product = await db.prepare(
    "SELECT source_sku AS sourceSku, article, size FROM products WHERE source_sku = ?",
  ).bind(sourceSku).first<ProductRow>();
  if (!product) return Response.json({ error: "Позиция не найдена." }, { status: 404 });

  const mappings = await readRemoteMappings(db, [sourceSku]);
  const marketplaces = [...new Set(mappings.map((row) => row.marketplaceId))];

  const warehouses = (await db.prepare(
    `SELECT marketplace_id AS marketplaceId, external_id AS externalId, name, publish_full_stock AS publishing
     FROM marketplace_warehouses
     WHERE remote_active = 1
     ORDER BY marketplace_id, name`,
  ).all<WarehouseRow>()).results.map((row) => ({ ...row, publishing: Boolean(row.publishing) }));

  const orders = (await db.prepare(
    `SELECT o.id AS orderId,
            o.external_order_id AS externalOrderId,
            o.marketplace_id AS marketplaceId,
            o.status,
            o.ordered_at AS orderedAt,
            o.canceled_at AS canceledAt,
            o.cancellation_source AS cancellationSource,
            o.seller_cancelled AS sellerCancelled,
            o.warehouse_external_id AS warehouseId,
            w.name AS warehouseName,
            SUM(oi.quantity) AS quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN marketplace_warehouses w
       ON w.marketplace_id = o.marketplace_id AND w.external_id = o.warehouse_external_id
     WHERE oi.product_sku = ? AND (o.ordered_at >= ? OR o.canceled_at >= ?)
     GROUP BY o.id`,
  ).bind(sourceSku, sinceDay, sinceDay).all<OrderRow>()).results;

  // Журнал выгрузки по позиции. Индекс журнала — по артикулу, поэтому
  // артикул в условии обязателен, а позицию уточняет product_sku.
  const logRows = product.article
    ? (await db.prepare(
      `SELECT run_id AS runId, marketplace_id AS marketplaceId, warehouse_id AS warehouseId,
              sent_qty AS sentQty, api_status AS apiStatus, api_message AS apiMessage, created_at AS createdAt
       FROM stock_sync_log
       WHERE article = ? AND product_sku = ? AND created_at >= ?
       ORDER BY id`,
    ).bind(product.article, sourceSku, since).all<LogRow>()).results
    : [];

  // Ошибки уровня склада и площадки пишутся без позиции: склад не принял
  // запрос целиком. Их относим к позиции, если она была в этом запуске или
  // запуск — полная синхронизация (в ней участвует весь ассортимент).
  const runLevelRows = (await db.prepare(
    `SELECT run_id AS runId, marketplace_id AS marketplaceId, warehouse_id AS warehouseId,
            sent_qty AS sentQty, api_status AS apiStatus, api_message AS apiMessage, created_at AS createdAt
     FROM stock_sync_log
     WHERE created_at >= ? AND product_sku IS NULL AND api_status <> 'success'
     ORDER BY id
     LIMIT 5000`,
  ).bind(since).all<LogRow>()).results.filter((row) => marketplaces.includes(row.marketplaceId as typeof marketplaces[number]));

  const runIds = [...new Set([...logRows, ...runLevelRows].map((row) => row.runId))];
  const runs = new Map<string, RunRow>();
  for (const part of chunks(runIds)) {
    const found = await db.prepare(
      `SELECT id, trigger, actor_email AS actorEmail, started_at AS startedAt
       FROM stock_sync_runs
       WHERE id IN (${part.map(() => "?").join(", ")})`,
    ).bind(...part).all<RunRow>();
    for (const run of found.results) runs.set(run.id, run);
  }

  const skuRunIds = new Set(logRows.map((row) => row.runId));
  const corrections = [...runs.values()]
    .filter((run) => skuRunIds.has(run.id)
      || run.trigger === "full_sync"
      || (run.trigger === "manual" && run.actorEmail === "планировщик"))
    .map((run) => ({
      runId: run.id,
      trigger: run.trigger,
      actorEmail: run.actorEmail,
      startedAt: run.startedAt,
      rows: logRows.filter((row) => row.runId === run.id),
      runRows: runLevelRows.filter((row) => row.runId === run.id),
    }));

  const checks = (await db.prepare(
    `SELECT id, trigger, due_at AS dueAt, status, checked_at AS checkedAt, message
     FROM stock_remote_checks
     WHERE product_sku = ? AND created_at >= ?
     ORDER BY id`,
  ).bind(sourceSku, since).all<CheckRow>()).results;
  const checkRows: CheckResultRow[] = [];
  for (const part of chunks(checks.map((check) => check.id))) {
    const found = await db.prepare(
      `SELECT check_id AS checkId, marketplace_id AS marketplaceId, warehouse_id AS warehouseId,
              warehouse_name AS warehouseName, publishing, status, amount, reserved,
              expected_qty AS expectedQty, message
       FROM stock_remote_check_rows
       WHERE check_id IN (${part.map(() => "?").join(", ")})`,
    ).bind(...part).all<CheckResultRow>();
    checkRows.push(...found.results);
  }

  const events = buildHistory({
    orders: orders.map((order) => ({ ...order, sellerCancelled: Boolean(order.sellerCancelled), quantity: Number(order.quantity) || 0 })),
    corrections,
    checks: checks.map((check) => ({
      ...check,
      rows: checkRows
        .filter((row) => row.checkId === check.id)
        .map((row) => ({ ...row, publishing: Boolean(row.publishing) })),
    })),
    warehouses,
    marketplaces,
    since: sinceDate.toISOString(),
  });

  return Response.json({
    product,
    marketplaces,
    days,
    since: sinceDate.toISOString(),
    generatedAt: new Date().toISOString(),
    events,
  });
}
