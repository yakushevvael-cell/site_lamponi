import { authorizeApi } from "@/lib/app-auth";
import { stockSyncBlocked } from "@/lib/sync-pause";
import { getMarketplaceCredentials } from "@/lib/credentials";
import { getOzonStocksByWarehouse, updateOzonStocks } from "@/lib/ozon";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { finishSyncRun, logStockRows, newRunId, startSyncRun, type LogRow } from "@/lib/stock-log";
import { buildSendableRow, isStockGuardError, type SendableRow } from "@/lib/stock-math";
import { updateWildberriesStocks } from "@/lib/wildberries";
import { OSV_UNITS_SQL } from "@/lib/osv-units";

const ACTIVE_JOB_TTL_MS = 30 * 60 * 1000;
const OZON_LOOKUP_CHUNK = 1000;

type MarketplaceId = "wildberries" | "ozon";

type WarehouseRow = {
  marketplaceId: MarketplaceId;
  externalId: string;
  name: string;
  remoteActive: number;
  publishFullStock: number;
};

type StockBasisRow = {
  sourceSku: string;
  externalSku: string;
  article: string | null;
  size: string | null;
  osvQty: number;
  reserveQty: number;
  safetyStock: number;
  manualZero: number;
};

async function hasActiveStockJob(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'stocks_full_sync_job'").first<{ value: string }>();
  if (!row?.value) return false;
  try {
    const job = JSON.parse(row.value) as { startedAt?: string };
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
    return Number.isFinite(startedAt) && Date.now() - startedAt < ACTIVE_JOB_TTL_MS;
  } catch {
    return false;
  }
}

async function readStockBasis(db: D1Database, marketplaceId: MarketplaceId) {
  const rows = await db.prepare(
    `SELECT p.source_sku AS sourceSku,
            sm.external_sku AS externalSku,
            p.article AS article,
            p.size AS size,
            ${OSV_UNITS_SQL} AS osvQty,
            COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reserveQty,
            p.safety_stock AS safetyStock,
            p.manual_zero AS manualZero
     FROM products p
     JOIN sku_mappings sm ON sm.product_sku = p.source_sku AND sm.marketplace_id = ? AND sm.active = 1
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     GROUP BY p.source_sku, sm.external_sku, p.article, p.size,
              p.current_physical_qty, p.safety_stock, p.manual_zero
     ORDER BY sm.external_sku`,
  ).bind(marketplaceId).all<StockBasisRow>();
  return rows.results;
}

/** Резерв Ozon по паре товар–склад: нужен, чтобы вернуть в `stock` ровно ту часть, что мы вычли. */
async function readOzonReserved(clientId: string, apiKey: string, offerIds: string[], warehouseId: string) {
  const reserved = new Map<string, number>();
  for (let start = 0; start < offerIds.length; start += OZON_LOOKUP_CHUNK) {
    const chunk = offerIds.slice(start, start + OZON_LOOKUP_CHUNK);
    const remote = await getOzonStocksByWarehouse(clientId, apiKey, chunk);
    for (const stock of remote) {
      if (String(stock.warehouseId) !== warehouseId) continue;
      reserved.set(stock.offerId, Number(stock.reserved) || 0);
    }
  }
  return reserved;
}

/**
 * Отправляет на склад рассчитанный остаток (mode = "publish") либо честный ноль
 * (mode = "zero", ТЗ п. 6). Возвращает строки для журнала. Любая ошибка API
 * пробрасывается наверх — вызывающий код обязан НЕ менять настройку склада.
 */
async function pushWarehouseStock(
  db: D1Database,
  runtime: ReturnType<typeof getRuntimeEnv>,
  marketplaceId: MarketplaceId,
  warehouseId: string,
  mode: "publish" | "zero",
) {
  const basis = await readStockBasis(db, marketplaceId);
  if (basis.length === 0) return { rows: [] as SendableRow[], sent: 0 };

  if (marketplaceId === "wildberries") {
    const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
    if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
    const rows = basis.map((item) => buildSendableRow({
      marketplaceId: "wildberries",
      warehouseId,
      externalSku: item.externalSku,
      productSku: item.sourceSku,
      article: item.article,
      size: item.size,
      osvQty: item.osvQty,
      reserveQty: item.reserveQty,
      safetyStock: item.safetyStock,
      manualZero: mode === "zero" ? true : Boolean(item.manualZero),
    }));
    const stocks = rows
      .map((row) => ({ chrtId: Number(row.externalSku), amount: row.sentQty }))
      .filter((stock) => Number.isSafeInteger(stock.chrtId) && stock.chrtId > 0);
    if (stocks.length === 0) throw new Error("Нет корректных сопоставлений товаров Wildberries.");
    await updateWildberriesStocks(credentials.WB_API_TOKEN, warehouseId, stocks);
    return { rows, sent: stocks.length };
  }

  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Client-Id или API-ключ Ozon не добавлен.");
  const reserved = mode === "publish"
    ? await readOzonReserved(credentials.OZON_CLIENT_ID, credentials.OZON_API_KEY, basis.map((item) => item.externalSku), warehouseId)
    : new Map<string, number>();

  const rows = basis.map((item) => buildSendableRow({
    marketplaceId: "ozon",
    warehouseId,
    externalSku: item.externalSku,
    productSku: item.sourceSku,
    article: item.article,
    size: item.size,
    osvQty: item.osvQty,
    reserveQty: item.reserveQty,
    safetyStock: item.safetyStock,
    // При отключении склада передаём ровно ноль — не «резерв», как было раньше.
    manualZero: mode === "zero" ? true : Boolean(item.manualZero),
    remoteReserved: reserved.get(item.externalSku) ?? 0,
  }));

  const failures = await updateOzonStocks(
    credentials.OZON_CLIENT_ID,
    credentials.OZON_API_KEY,
    rows.map((row) => ({ offerId: row.externalSku, warehouseId: Number(row.warehouseId), stock: row.sentQty })),
  );
  if (mode === "zero" && failures.length > 0) {
    throw new Error(`Ozon не обнулил ${failures.length} позиций: ${failures[0]?.message ?? "неизвестная ошибка"}`);
  }
  return { rows, sent: rows.length - failures.length };
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const paused = await stockSyncBlocked(runtime.DB);
  if (paused) return paused;
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as {
    marketplaceId?: unknown;
    warehouseId?: unknown;
    publishFullStock?: unknown;
  } | null;
  const marketplaceId = body?.marketplaceId;
  const warehouseId = typeof body?.warehouseId === "string" ? body.warehouseId.trim() : "";
  const publishFullStock = body?.publishFullStock;
  if ((marketplaceId !== "wildberries" && marketplaceId !== "ozon") || !warehouseId || typeof publishFullStock !== "boolean") {
    return Response.json({ error: "Некорректные параметры склада." }, { status: 400 });
  }
  if (await hasActiveStockJob(db)) {
    return Response.json({ error: "Дождитесь завершения текущей синхронизации остатков." }, { status: 409 });
  }

  const warehouse = await db.prepare(
    `SELECT marketplace_id AS marketplaceId,
            external_id AS externalId,
            name,
            remote_active AS remoteActive,
            publish_full_stock AS publishFullStock
     FROM marketplace_warehouses
     WHERE marketplace_id = ? AND external_id = ?`,
  ).bind(marketplaceId, warehouseId).first<WarehouseRow>();
  if (!warehouse) return Response.json({ error: "Склад не найден. Обновите список складов." }, { status: 404 });
  if (publishFullStock && !warehouse.remoteActive) {
    return Response.json({ error: "Этот склад находится в архиве или отключён в кабинете маркетплейса." }, { status: 409 });
  }
  if (Boolean(warehouse.publishFullStock) === publishFullStock) {
    return Response.json({ ok: true, marketplaceId, warehouseId, publishFullStock, unchanged: true });
  }

  const runId = newRunId();
  await startSyncRun(db, {
    runId,
    trigger: publishFullStock ? "warehouse_enabled" : "warehouse_disabled",
    actorEmail: auth.user.email,
  });

  let rows: SendableRow[] = [];
  let sent = 0;
  try {
    // И включение, и отключение сначала работают с API и только при успехе меняют флаг.
    const result = await pushWarehouseStock(db, runtime, marketplaceId, warehouseId, publishFullStock ? "publish" : "zero");
    rows = result.rows;
    sent = result.sent;
  } catch (error) {
    const guard = isStockGuardError(error);
    const message = error instanceof Error ? error.message : "Не удалось изменить настройку склада.";
    await logStockRows(db, runId, auth.user.email, [{
      ...(guard ? (error as { row: Partial<SendableRow> }).row : { warehouseId }),
      marketplaceId,
      apiStatus: guard ? "blocked" : "error",
      apiMessage: message,
    } as LogRow]);
    await db.prepare(
      `UPDATE marketplace_warehouses SET sync_status = 'error', sync_error = ?
       WHERE marketplace_id = ? AND external_id = ?`,
    ).bind(message.slice(0, 500), marketplaceId, warehouseId).run();
    await db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'outbound', 'stocks', 'error', 0, ?)`,
    ).bind(marketplaceId, `${publishFullStock ? "Включение" : "Отключение"} склада «${warehouse.name}» отменено: ${message}`.slice(0, 500)).run().catch(() => undefined);
    await finishSyncRun(db, runId, "error", message);
    return Response.json({
      error: publishFullStock
        ? `Склад не включён: ${message}`
        : `Склад не отключён: ${message}`,
      guard,
    }, { status: guard ? 422 : 502 });
  }

  await logStockRows(db, runId, auth.user.email, rows.map((row): LogRow => ({ ...row, apiStatus: "success" })));
  await db.batch([
    db.prepare(
      `UPDATE marketplace_warehouses
       SET publish_full_stock = ?,
           sync_status = 'ok',
           sync_error = NULL,
           last_stock_sync_at = CURRENT_TIMESTAMP,
           publish_enabled_by = CASE WHEN ? = 1 THEN ? ELSE NULL END,
           publish_enabled_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE marketplace_id = ? AND external_id = ?`,
    ).bind(
      publishFullStock ? 1 : 0,
      publishFullStock ? 1 : 0,
      auth.user.email,
      publishFullStock ? 1 : 0,
      marketplaceId,
      warehouseId,
    ),
    db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'outbound', 'warehouses', 'success', ?, ?)`,
    ).bind(
      marketplaceId,
      sent,
      publishFullStock
        ? `Выгрузка включена для склада «${warehouse.name}». Отправлено позиций: ${sent}.`
        : `Выгрузка отключена для склада «${warehouse.name}». Обнулено позиций: ${sent}.`,
    ),
  ]);
  await finishSyncRun(db, runId, "success", null);

  const publishing = await db.prepare(
    `SELECT COUNT(*) AS count FROM marketplace_warehouses
     WHERE marketplace_id = ? AND remote_active = 1 AND publish_full_stock = 1`,
  ).bind(marketplaceId).first<{ count: number }>();
  const publishingCount = Number(publishing?.count ?? 0);

  return Response.json({
    ok: true,
    marketplaceId,
    warehouseId,
    publishFullStock,
    runId,
    sent,
    zeroed: publishFullStock ? 0 : sent,
    publishingCount,
    // ТЗ, п. 10: остаток между складами не делится — предупреждаем явно.
    warning: publishFullStock && publishingCount > 1
      ? "На каждый выбранный склад будет передан полный доступный остаток. Остаток между складами не распределяется."
      : null,
  });
}
