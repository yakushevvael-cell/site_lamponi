import { getRuntimeEnv } from "@/lib/runtime-env";
import { stockSyncBlocked } from "@/lib/sync-pause";
import { authorizeApi } from "@/lib/app-auth";
import { getMarketplaceCredentials } from "@/lib/credentials";
import {
  getWildberriesCardsByArticle,
  getWildberriesNewOrders,
  getWildberriesOrderStatuses,
  getWildberriesStocks,
  getWildberriesWarehouses,
  updateWildberriesStocks,
  WildberriesApiError,
  type WildberriesCard,
} from "@/lib/wildberries";

const MARKETPLACE_ID = "wildberries";
const CANARY_COUNT = 3;

type LocalProduct = {
  sourceSku: string;
  article: string;
  size: string | null;
  physicalQuantity: number;
};

type CanaryMapping = LocalProduct & {
  chrtId: number;
  nmId: number;
  wbSize: string;
};

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleUpperCase("ru-RU");
}

function normalizeSize(value: string | null | undefined) {
  const normalized = normalize(value).replace(",", ".");
  return /^\d+\.0$/.test(normalized) ? normalized.slice(0, -2) : normalized;
}

function isUnsizedWbCard(card: WildberriesCard) {
  return card.sizes.length === 1 && ["", "0"].includes(normalizeSize(card.sizes[0]?.techSize));
}

async function readCanaryStatus(db: D1Database) {
  const mode = await db.prepare("SELECT value FROM settings WHERE key = 'wb_stock_mode'").first<{ value: string }>();
  const lastResult = await db.prepare("SELECT value FROM settings WHERE key = 'wb_canary_last_result'").first<{ value: string }>();
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'wb_canary_skus'").first<{ value: string }>();
  let sourceSkus: string[] = [];
  try {
    const parsed = saved?.value ? JSON.parse(saved.value) : [];
    if (Array.isArray(parsed)) sourceSkus = parsed.filter((value): value is string => typeof value === "string").slice(0, CANARY_COUNT);
  } catch {
    sourceSkus = [];
  }
  const placeholders = sourceSkus.map(() => "?").join(",");
  const results = sourceSkus.length === CANARY_COUNT ? (await db.prepare(
    `SELECT p.source_sku AS sourceSku,
            p.article,
            p.size,
            p.current_physical_qty AS physicalQuantity,
            sm.external_sku AS chrtId,
            COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reservedQuantity,
            CASE WHEN p.manual_zero = 1 THEN 0 ELSE MAX(0, p.current_physical_qty - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) - p.safety_stock) END AS availableQuantity
     FROM sku_mappings sm
     JOIN products p ON p.source_sku = sm.product_sku
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     WHERE sm.marketplace_id = ? AND sm.active = 1 AND p.source_sku IN (${placeholders})
     GROUP BY p.source_sku, p.article, p.size, p.current_physical_qty, sm.external_sku, p.safety_stock, p.manual_zero
     ORDER BY p.article, p.size`,
  ).bind(MARKETPLACE_ID, ...sourceSkus).all()).results : [];

  let parsedResult: unknown = null;
  if (lastResult?.value) {
    try { parsedResult = JSON.parse(lastResult.value); } catch { parsedResult = null; }
  }

  return { mode: mode?.value ?? "off", items: results, lastResult: parsedResult };
}

async function chooseCanaryMappings(db: D1Database, token: string): Promise<CanaryMapping[]> {
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'wb_canary_skus'").first<{ value: string }>();
  if (saved?.value) {
    try {
      const sourceSkus = JSON.parse(saved.value) as string[];
      if (Array.isArray(sourceSkus) && sourceSkus.length === CANARY_COUNT) {
        const placeholders = sourceSkus.map(() => "?").join(",");
        const { results } = await db.prepare(
          `SELECT p.source_sku AS sourceSku, p.article, p.size,
                  p.current_physical_qty AS physicalQuantity,
                  CAST(sm.external_sku AS INTEGER) AS chrtId,
                  0 AS nmId, COALESCE(p.size, 'Без размера') AS wbSize
           FROM products p
           JOIN sku_mappings sm ON sm.product_sku = p.source_sku
           WHERE sm.marketplace_id = ? AND p.source_sku IN (${placeholders})`,
        ).bind(MARKETPLACE_ID, ...sourceSkus).all<CanaryMapping>();
        if (results.length === CANARY_COUNT) return results;
      }
    } catch {
      // Поврежденная настройка будет заменена безопасно выбранным набором.
    }
  }

  const sizedArticles = await db.prepare(
    `SELECT article
     FROM products
     WHERE size IS NOT NULL AND current_physical_qty BETWEEN 1 AND 20
     GROUP BY article
     HAVING COUNT(*) >= 2
     ORDER BY article
     LIMIT 3`,
  ).all<{ article: string }>();
  const unsizedArticles = await db.prepare(
    `SELECT article
     FROM products
     WHERE size IS NULL AND current_physical_qty BETWEEN 1 AND 20
     ORDER BY article
     LIMIT 2`,
  ).all<{ article: string }>();

  const candidateArticles = [...sizedArticles.results, ...unsizedArticles.results].map((row) => row.article);
  const matches: CanaryMapping[] = [];

  for (const article of candidateArticles) {
    const cards = await getWildberriesCardsByArticle(token, article);
    const card = cards.find((item) => normalize(item.vendorCode) === normalize(article));
    if (!card) continue;

    const localRows = await db.prepare(
      `SELECT source_sku AS sourceSku, article, size, current_physical_qty AS physicalQuantity
       FROM products
       WHERE article = ? AND current_physical_qty BETWEEN 1 AND 20
       ORDER BY size`,
    ).bind(article).all<LocalProduct>();

    for (const product of localRows.results) {
      const wbSize = product.size === null
        ? (isUnsizedWbCard(card) ? card.sizes[0] : undefined)
        : card.sizes.find((size) => normalizeSize(size.techSize) === normalizeSize(product.size));
      if (!wbSize || typeof wbSize.chrtID !== "number") continue;
      matches.push({
        ...product,
        chrtId: wbSize.chrtID,
        nmId: card.nmID,
        wbSize: product.size ?? "Без размера",
      });
    }
  }

  const sized = matches.filter((item) => item.size !== null).slice(0, 2);
  const unsized = matches.filter((item) => item.size === null).slice(0, 1);
  const selected = [...sized, ...unsized];
  for (const item of matches) {
    if (selected.length >= CANARY_COUNT) break;
    if (!selected.some((selectedItem) => selectedItem.sourceSku === item.sourceSku)) selected.push(item);
  }

  if (selected.length < CANARY_COUNT) {
    throw new WildberriesApiError(422, "Не удалось автоматически найти три точных соответствия «артикул + размер» между ОСВ и карточками WB. Остатки не изменялись.");
  }

  await db.batch([
    ...selected.map((item) => db.prepare(
      `INSERT INTO sku_mappings (product_sku, marketplace_id, external_sku, active)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(marketplace_id, external_sku) DO UPDATE SET product_sku = excluded.product_sku, active = 1`,
    ).bind(item.sourceSku, MARKETPLACE_ID, String(item.chrtId))),
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('wb_canary_skus', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(JSON.stringify(selected.map((item) => item.sourceSku))),
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('wb_stock_mode', 'canary', CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = 'canary', updated_at = CURRENT_TIMESTAMP`,
    ),
  ]);

  return selected;
}

async function syncOrdersAndReservations(db: D1Database, token: string) {
  const newOrders = await getWildberriesNewOrders(token);
  let mappedOrders = 0;
  let newReservations = 0;

  for (const order of newOrders) {
    const mapping = await db.prepare(
      `SELECT product_sku AS productSku FROM sku_mappings
       WHERE marketplace_id = ? AND external_sku = ? AND active = 1`,
    ).bind(MARKETPLACE_ID, String(order.chrtId)).first<{ productSku: string }>();

    await db.prepare(
      `INSERT INTO orders
         (marketplace_id, external_order_id, status, amount, ordered_at, region, city, warehouse_external_id, updated_at)
       VALUES (?, ?, 'new', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
    ).bind(
      MARKETPLACE_ID,
      String(order.id),
      Number(order.convertedFinalPrice ?? order.finalPrice ?? 0) / 100,
      order.createdAt,
      order.address?.fullAddress ?? null,
      order.offices?.[0] ?? null,
      order.warehouseId ? String(order.warehouseId) : null,
    ).run();

    const orderRow = await db.prepare(
      "SELECT id FROM orders WHERE marketplace_id = ? AND external_order_id = ?",
    ).bind(MARKETPLACE_ID, String(order.id)).first<{ id: number }>();
    if (!orderRow) continue;

    let item = await db.prepare("SELECT id FROM order_items WHERE order_id = ? LIMIT 1").bind(orderRow.id).first<{ id: number }>();
    if (!item) {
      const inserted = await db.prepare(
        `INSERT INTO order_items (order_id, product_sku, external_sku, quantity, unit_price)
         VALUES (?, ?, ?, 1, ?) RETURNING id`,
      ).bind(orderRow.id, mapping?.productSku ?? null, String(order.chrtId), Number(order.convertedFinalPrice ?? order.finalPrice ?? 0) / 100).first<{ id: number }>();
      item = inserted ?? null;
    } else if (mapping) {
      await db.prepare("UPDATE order_items SET product_sku = ? WHERE id = ?").bind(mapping.productSku, item.id).run();
    }

    if (mapping && item) {
      mappedOrders += 1;
      const result = await db.prepare(
        `INSERT INTO stock_reservations (order_item_id, product_sku, marketplace_id, quantity, status)
         VALUES (?, ?, ?, 1, 'active')
         ON CONFLICT(order_item_id) DO NOTHING`,
      ).bind(item.id, mapping.productSku, MARKETPLACE_ID).run();
      if ((result.meta.changes ?? 0) > 0) newReservations += 1;
    }
  }

  const activeOrders = await db.prepare(
    `SELECT DISTINCT CAST(o.external_order_id AS INTEGER) AS id
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN stock_reservations r ON r.order_item_id = oi.id
     WHERE o.marketplace_id = ? AND r.status = 'active'
     ORDER BY o.id DESC LIMIT 1000`,
  ).bind(MARKETPLACE_ID).all<{ id: number }>();
  const statuses = await getWildberriesOrderStatuses(token, activeOrders.results.map((row) => row.id));
  const canceledStatuses = new Set(["canceled", "canceled_by_client", "declined_by_client", "defect"]);

  for (const status of statuses) {
    const canceled = status.supplierStatus === "cancel" || canceledStatuses.has(status.wbStatus);
    const sold = status.wbStatus === "sold";
    const shipped = status.supplierStatus === "complete" || sold;
    await db.prepare(
      `UPDATE orders SET
         status = ?,
         shipped_at = CASE WHEN ? THEN COALESCE(shipped_at, CURRENT_TIMESTAMP) ELSE shipped_at END,
         delivered_at = CASE WHEN ? THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END,
         buyout_at = CASE WHEN ? THEN COALESCE(buyout_at, CURRENT_TIMESTAMP) ELSE buyout_at END,
         canceled_at = CASE WHEN ? THEN COALESCE(canceled_at, CURRENT_TIMESTAMP) ELSE canceled_at END,
         updated_at = CURRENT_TIMESTAMP
       WHERE marketplace_id = ? AND external_order_id = ?`,
    ).bind(status.wbStatus || status.supplierStatus, shipped ? 1 : 0, sold ? 1 : 0, sold ? 1 : 0, canceled ? 1 : 0, MARKETPLACE_ID, String(status.id)).run();

    if (canceled) {
      await db.prepare(
        `UPDATE stock_reservations SET status = 'released', released_at = CURRENT_TIMESTAMP
         WHERE status = 'active' AND order_item_id IN (
           SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE o.marketplace_id = ? AND o.external_order_id = ?
         )`,
      ).bind(MARKETPLACE_ID, String(status.id)).run();
    }
  }

  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES (?, 'inbound', 'orders', 'success', ?, ?)`,
  ).bind(MARKETPLACE_ID, newOrders.length, `Новых резервов по тестовым SKU: ${newReservations}`).run();

  return { received: newOrders.length, mapped: mappedOrders, newReservations };
}

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json(await readCanaryStatus(runtime.DB));
}

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const paused = await stockSyncBlocked(runtime.DB);
  if (paused) return paused;
  const credentials = await getMarketplaceCredentials(runtime.DB, runtime, MARKETPLACE_ID);
  const token = credentials.WB_API_TOKEN;
  if (!token) return Response.json({ error: "Ключ Wildberries не добавлен." }, { status: 400 });

  try {
    const remoteWarehouses = await getWildberriesWarehouses(token);
    const activeWarehouses = remoteWarehouses.filter((warehouse) => !warehouse.isDeleting && warehouse.deliveryType === 1);
    if (activeWarehouses.length === 0) throw new WildberriesApiError(422, "Wildberries не вернул ни одного активного FBS-склада. Остатки не изменялись.");

    await runtime.DB.batch([
      ...remoteWarehouses.map((warehouse) => runtime.DB!.prepare(
        `INSERT INTO marketplace_warehouses (marketplace_id, external_id, name, remote_active, publish_full_stock)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(marketplace_id, external_id) DO UPDATE SET
           name = excluded.name,
           remote_active = excluded.remote_active,
           publish_full_stock = CASE
             WHEN excluded.remote_active = 1 THEN marketplace_warehouses.publish_full_stock
             ELSE 0
           END`,
      ).bind(
        MARKETPLACE_ID,
        String(warehouse.id),
        warehouse.name,
        !warehouse.isDeleting && warehouse.deliveryType === 1 ? 1 : 0,
      )),
      runtime.DB.prepare(
        `UPDATE marketplace_warehouses SET remote_active = 0, publish_full_stock = 0
         WHERE marketplace_id = ? AND external_id NOT IN (${remoteWarehouses.map(() => "?").join(",")})`,
      ).bind(MARKETPLACE_ID, ...remoteWarehouses.map((warehouse) => String(warehouse.id))),
    ]);
    const publishingRows = await runtime.DB.prepare(
      `SELECT external_id AS externalId
       FROM marketplace_warehouses
       WHERE marketplace_id = ? AND remote_active = 1 AND publish_full_stock = 1`,
    ).bind(MARKETPLACE_ID).all<{ externalId: string }>();
    const publishingIds = new Set(publishingRows.results.map((row) => row.externalId));
    const warehouses = activeWarehouses.filter((warehouse) => publishingIds.has(String(warehouse.id)));
    if (warehouses.length === 0) {
      throw new WildberriesApiError(422, "На вкладке «Склады» не включена выгрузка ни на один активный склад Wildberries. Остатки не изменялись.");
    }

    const mappings = await chooseCanaryMappings(runtime.DB, token);
    const orders = await syncOrdersAndReservations(runtime.DB, token);
    const sourceSkus = mappings.map((item) => item.sourceSku);
    const placeholders = sourceSkus.map(() => "?").join(",");
    const availableRows = await runtime.DB.prepare(
      `SELECT p.source_sku AS sourceSku,
              p.article,
              p.size,
              CAST(sm.external_sku AS INTEGER) AS chrtId,
              CASE WHEN p.manual_zero = 1 THEN 0 ELSE MAX(0, CAST(p.current_physical_qty - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) - p.safety_stock AS INTEGER)) END AS amount
       FROM products p
       JOIN sku_mappings sm ON sm.product_sku = p.source_sku AND sm.marketplace_id = ? AND sm.active = 1
       LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
       WHERE p.source_sku IN (${placeholders})
       GROUP BY p.source_sku, p.article, p.size, sm.external_sku, p.current_physical_qty, p.safety_stock, p.manual_zero`,
    ).bind(MARKETPLACE_ID, ...sourceSkus).all<{ sourceSku: string; article: string; size: string | null; chrtId: number; amount: number }>();

    const stocks = availableRows.results.map((row) => ({ chrtId: Number(row.chrtId), amount: Math.max(0, Math.floor(Number(row.amount))) }));
    const results: Array<{ warehouse: string; ok: boolean; message?: string }> = [];

    for (const warehouse of warehouses) {
      try {
        await updateWildberriesStocks(token, String(warehouse.id), stocks);
        const verified = await getWildberriesStocks(token, String(warehouse.id), stocks.map((stock) => stock.chrtId));
        const verifiedMap = new Map(verified.map((stock) => [Number(stock.chrtId), Number(stock.amount)]));
        const matches = stocks.every((stock) => verifiedMap.get(stock.chrtId) === stock.amount);
        if (!matches) throw new Error("WB принял обновление, но контрольное чтение пока не совпало");
        results.push({ warehouse: warehouse.name, ok: true });
        await runtime.DB.prepare(
          `UPDATE marketplace_warehouses SET last_stock_sync_at = CURRENT_TIMESTAMP
           WHERE marketplace_id = ? AND external_id = ?`,
        ).bind(MARKETPLACE_ID, String(warehouse.id)).run();
      } catch (error) {
        results.push({ warehouse: warehouse.name, ok: false, message: error instanceof Error ? error.message : "Ошибка обновления" });
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    const failed = results.filter((result) => !result.ok);
    const testedAt = new Date().toISOString();
    const summary = {
      ok: failed.length === 0,
      testedAt,
      mode: "canary",
      skuCount: stocks.length,
      warehouseCount: warehouses.length,
      verifiedWarehouseCount: results.length - failed.length,
      items: availableRows.results.map((row) => ({ article: row.article, size: row.size, amount: Number(row.amount), chrtId: Number(row.chrtId) })),
      orders,
      failures: failed,
    };

    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('wb_canary_last_result', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      ).bind(JSON.stringify(summary)),
      runtime.DB.prepare(
        `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
         VALUES (?, 'outbound', 'stocks', ?, ?, ?)`,
      ).bind(MARKETPLACE_ID, failed.length === 0 ? "success" : "error", stocks.length * (results.length - failed.length), failed.length === 0 ? "Канареечный тест остатков подтвержден контрольным чтением" : `Ошибок по складам: ${failed.length}`),
    ]);

    return Response.json(summary, { status: failed.length === 0 ? 200 : 207 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Тест Wildberries не выполнен.";
    await runtime.DB.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'outbound', 'stocks', 'error', 0, ?)`,
    ).bind(MARKETPLACE_ID, message.slice(0, 500)).run().catch(() => undefined);
    const status = error instanceof WildberriesApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
