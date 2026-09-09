import { authorizeApi } from "@/lib/app-auth";
import { stockSyncBlocked } from "@/lib/sync-pause";
import { getMarketplaceCredentials } from "@/lib/credentials";
import { updateOzonStocks } from "@/lib/ozon";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { finishSyncRun, logStockRows, newRunId, startSyncRun, type LogRow } from "@/lib/stock-log";
import type { MarketplaceStockId } from "@/lib/stock-math";
import { updateWildberriesStocks } from "@/lib/wildberries";
import { OSV_UNITS_SQL } from "@/lib/osv-units";

type MappingRow = {
  productSku: string;
  marketplaceId: string;
  externalSku: string;
  article: string | null;
  size: string | null;
  osvQty: number;
};
type WarehouseRow = { marketplaceId: string; externalId: string };

function zeroLogRows(marketplaceId: MarketplaceStockId, warehouseId: string, mappings: MappingRow[], message?: string | null): LogRow[] {
  return mappings.map((mapping) => ({
    marketplaceId,
    warehouseId,
    productSku: mapping.productSku,
    externalSku: mapping.externalSku,
    article: mapping.article,
    size: mapping.size,
    osvQty: Number(mapping.osvQty) || 0,
    reserveQty: 0,
    computedQty: 0,
    sentQty: 0,
    apiStatus: (message ? "error" : "success") as LogRow["apiStatus"],
    apiMessage: message ?? null,
  }));
}

async function pushWildberriesZeros(
  db: D1Database,
  runtime: ReturnType<typeof getRuntimeEnv>,
  runId: string,
  actorEmail: string,
  mappings: MappingRow[],
  warehouses: WarehouseRow[],
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN || mappings.length === 0 || warehouses.length === 0) return { sent: 0, failures: [] as string[] };
  const stocks = mappings
    .map((mapping) => ({ chrtId: Number(mapping.externalSku), amount: 0 }))
    .filter((stock) => Number.isSafeInteger(stock.chrtId) && stock.chrtId > 0);
  const failures: string[] = [];
  let sent = 0;
  for (const warehouse of warehouses) {
    try {
      await updateWildberriesStocks(credentials.WB_API_TOKEN, warehouse.externalId, stocks);
      sent += stocks.length;
      await logStockRows(db, runId, actorEmail, zeroLogRows("wildberries", warehouse.externalId, mappings));
    } catch (error) {
      const message = error instanceof Error ? error.message : `WB: склад ${warehouse.externalId}`;
      failures.push(message);
      await logStockRows(db, runId, actorEmail, zeroLogRows("wildberries", warehouse.externalId, mappings, message));
    }
  }
  return { sent, failures };
}

async function pushOzonZeros(
  db: D1Database,
  runtime: ReturnType<typeof getRuntimeEnv>,
  runId: string,
  actorEmail: string,
  mappings: MappingRow[],
  warehouses: WarehouseRow[],
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY || mappings.length === 0 || warehouses.length === 0) {
    return { sent: 0, failures: [] as string[] };
  }

  // Обнуление — это ровно ноль по каждой паре товар–склад.
  // Раньше сюда уходил `reserved`, который вернул Ozon: при завышенном резерве
  // «обнулённый» товар оставался доступным для заказа.
  const targets = warehouses.flatMap((warehouse) => mappings.map((mapping) => ({
    offerId: mapping.externalSku,
    warehouseId: Number(warehouse.externalId),
    stock: 0,
  }))).filter((target) => Number.isSafeInteger(target.warehouseId));

  const failures = await updateOzonStocks(credentials.OZON_CLIENT_ID, credentials.OZON_API_KEY, targets);
  const failedKeys = new Map(failures.map((failure) => [`${failure.offerId}::${failure.warehouseId}`, failure.message]));

  for (const warehouse of warehouses) {
    const rows = zeroLogRows("ozon", warehouse.externalId, mappings).map((row) => {
      const message = failedKeys.get(`${row.externalSku}::${Number(warehouse.externalId)}`);
      return message ? { ...row, apiStatus: "error" as const, apiMessage: message } : row;
    });
    await logStockRows(db, runId, actorEmail, rows);
  }

  return { sent: Math.max(0, targets.length - failures.length), failures: failures.map((failure) => failure.message) };
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const paused = await stockSyncBlocked(runtime.DB);
  if (paused) return paused;
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as { action?: string; sourceSkus?: unknown[] } | null;
  const action = body?.action;
  const sourceSkus = [...new Set((body?.sourceSkus ?? [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))];
  if (!["zero", "restore"].includes(action ?? "")) return Response.json({ error: "Неизвестное действие." }, { status: 400 });
  if (sourceSkus.length === 0 || sourceSkus.length > 50) return Response.json({ error: "Выберите от 1 до 50 позиций." }, { status: 400 });

  const placeholders = sourceSkus.map(() => "?").join(",");
  const existing = await db.prepare(`SELECT source_sku AS sourceSku FROM products WHERE source_sku IN (${placeholders})`).bind(...sourceSkus).all<{ sourceSku: string }>();
  if (existing.results.length !== sourceSkus.length) return Response.json({ error: "Часть выбранных позиций не найдена." }, { status: 400 });

  if (action === "restore") {
    await db.prepare(`UPDATE products SET manual_zero = 0, manual_zero_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE source_sku IN (${placeholders})`).bind(...sourceSkus).run();
    return Response.json({ ok: true, action, selected: sourceSkus.length, note: "Положительный остаток на площадки не отправлялся." });
  }

  await db.prepare(`UPDATE products SET manual_zero = 1, manual_zero_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE source_sku IN (${placeholders})`).bind(...sourceSkus).run();

  const mappingRows = await db.prepare(
    `SELECT sm.product_sku AS productSku,
            sm.marketplace_id AS marketplaceId,
            sm.external_sku AS externalSku,
            p.article AS article,
            p.size AS size,
            ${OSV_UNITS_SQL} AS osvQty
     FROM sku_mappings sm
     JOIN products p ON p.source_sku = sm.product_sku
     WHERE sm.active = 1 AND sm.product_sku IN (${placeholders}) AND sm.marketplace_id IN ('wildberries', 'ozon')`,
  ).bind(...sourceSkus).all<MappingRow>();
  const warehouseRows = await db.prepare(
    `SELECT marketplace_id AS marketplaceId, external_id AS externalId
     FROM marketplace_warehouses
     WHERE remote_active = 1 AND publish_full_stock = 1 AND marketplace_id IN ('wildberries', 'ozon')`,
  ).all<WarehouseRow>();

  const runId = newRunId();
  await startSyncRun(db, { runId, trigger: "manual_zero", actorEmail: auth.user.email });

  const wbMappings = mappingRows.results.filter((row) => row.marketplaceId === "wildberries");
  const ozonMappings = mappingRows.results.filter((row) => row.marketplaceId === "ozon");
  const wbWarehouses = warehouseRows.results.filter((row) => row.marketplaceId === "wildberries");
  const ozonWarehouses = warehouseRows.results.filter((row) => row.marketplaceId === "ozon");
  const results: Record<string, unknown> = {};
  const errors: string[] = [];
  try { results.wildberries = await pushWildberriesZeros(db, runtime, runId, auth.user.email, wbMappings, wbWarehouses); }
  catch (error) { errors.push(error instanceof Error ? error.message : "Ошибка WB"); }
  try { results.ozon = await pushOzonZeros(db, runtime, runId, auth.user.email, ozonMappings, ozonWarehouses); }
  catch (error) { errors.push(error instanceof Error ? error.message : "Ошибка Ozon"); }

  await db.prepare(
    `INSERT INTO sync_events (direction, kind, status, item_count, message)
     VALUES ('outbound', 'stocks', ?, ?, ?)`,
  ).bind(errors.length ? "error" : "success", sourceSkus.length, `Ручное обнуление ${sourceSkus.length} позиций. Полная синхронизация запускается отдельно администратором.`).run();
  await finishSyncRun(db, runId, errors.length ? "partial" : "success", errors[0] ?? null);

  const mappedProducts = new Set(mappingRows.results.map((row) => row.productSku));
  return Response.json({
    ok: errors.length === 0,
    action,
    runId,
    selected: sourceSkus.length,
    mapped: mappedProducts.size,
    unmapped: sourceSkus.filter((sku) => !mappedProducts.has(sku)),
    results,
    errors,
  }, { status: errors.length ? 207 : 200 });
}
