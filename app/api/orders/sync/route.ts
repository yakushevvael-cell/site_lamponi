import { getMarketplaceCredentials } from "@/lib/credentials";
import { authorizeApi } from "@/lib/app-auth";
import {
  matchOzonCatalog,
  matchWildberriesCatalog,
  type LocalProductIdentity,
  type MarketplaceMapping,
} from "@/lib/product-matching";
import { rebuildReservations } from "@/lib/reservations";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { getOzonPostings, getOzonProductCatalog, type OzonPosting } from "@/lib/ozon";
import {
  getWildberriesCards,
  getWildberriesOrders,
  getWildberriesOrderStatuses,
  type WildberriesOrder,
  type WildberriesOrderStatus,
} from "@/lib/wildberries";

type NormalizedItem = {
  externalSku: string;
  productSku: string | null;
  sellerArticle: string;
  size: string | null;
  quantity: number;
  unitPrice: number;
};

type NormalizedOrder = {
  externalOrderId: string;
  status: string;
  amount: number;
  orderedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  buyoutAt: string | null;
  canceledAt: string | null;
  cancellationSource: string | null;
  sellerCancelled: boolean;
  region: string | null;
  city: string | null;
  warehouseExternalId: string | null;
  final: boolean;
  items: NormalizedItem[];
};

async function runStatements(db: D1Database, statements: D1PreparedStatement[]) {
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }
}

async function readLocalProducts(db: D1Database) {
  const rows = await db.prepare(
    "SELECT source_sku AS sourceSku, article, size FROM products WHERE article <> ''",
  ).all<LocalProductIdentity>();
  return rows.results;
}

async function saveMappings(db: D1Database, marketplaceId: string, mappings: MarketplaceMapping[]) {
  await runStatements(db, mappings.map((mapping) => db.prepare(
    `INSERT INTO sku_mappings (product_sku, marketplace_id, external_sku, active)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(marketplace_id, external_sku) DO UPDATE SET
       product_sku = excluded.product_sku,
       active = 1`,
  ).bind(mapping.sourceSku, marketplaceId, mapping.externalSku)));
}

async function readMappingIndex(db: D1Database, marketplaceId: string) {
  const rows = await db.prepare(
    `SELECT sm.external_sku AS externalSku,
            p.source_sku AS sourceSku,
            p.article,
            p.size
     FROM sku_mappings sm
     JOIN products p ON p.source_sku = sm.product_sku
     WHERE sm.marketplace_id = ? AND sm.active = 1`,
  ).bind(marketplaceId).all<MarketplaceMapping>();
  return new Map(rows.results.map((row) => [row.externalSku, row]));
}

function combineItems(items: NormalizedItem[]) {
  const combined = new Map<string, NormalizedItem>();
  for (const item of items) {
    const current = combined.get(item.externalSku);
    if (current) current.quantity += item.quantity;
    else combined.set(item.externalSku, { ...item });
  }
  return [...combined.values()];
}

async function persistOrders(
  db: D1Database,
  marketplaceId: "wildberries" | "ozon",
  marketplaceName: string,
  orders: NormalizedOrder[],
) {
  await db.prepare(
    `INSERT INTO marketplaces (id, name, enabled, connection_status)
     VALUES (?, ?, 1, 'connected')
     ON CONFLICT(id) DO UPDATE SET enabled = 1, connection_status = 'connected'`,
  ).bind(marketplaceId, marketplaceName).run();

  await runStatements(db, orders.map((order) => db.prepare(
    `INSERT INTO orders
       (marketplace_id, external_order_id, status, amount, ordered_at, shipped_at, delivered_at,
        buyout_at, canceled_at, cancellation_source, seller_cancelled, region, city,
        warehouse_external_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET
       status = excluded.status,
       amount = excluded.amount,
       shipped_at = COALESCE(excluded.shipped_at, orders.shipped_at),
       delivered_at = COALESCE(excluded.delivered_at, orders.delivered_at),
       buyout_at = COALESCE(excluded.buyout_at, orders.buyout_at),
       canceled_at = COALESCE(excluded.canceled_at, orders.canceled_at),
       cancellation_source = excluded.cancellation_source,
       seller_cancelled = excluded.seller_cancelled,
       region = COALESCE(excluded.region, orders.region),
       city = COALESCE(excluded.city, orders.city),
       warehouse_external_id = COALESCE(excluded.warehouse_external_id, orders.warehouse_external_id),
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    marketplaceId,
    order.externalOrderId,
    order.status,
    order.amount,
    order.orderedAt,
    order.shippedAt,
    order.deliveredAt,
    order.buyoutAt,
    order.canceledAt,
    order.cancellationSource,
    order.sellerCancelled ? 1 : 0,
    order.region,
    order.city,
    order.warehouseExternalId,
  )));

  const orderRows = await db.prepare(
    "SELECT id, external_order_id AS externalOrderId FROM orders WHERE marketplace_id = ?",
  ).bind(marketplaceId).all<{ id: number; externalOrderId: string }>();
  const orderIdByExternal = new Map(orderRows.results.map((row) => [row.externalOrderId, row.id]));
  const touchedIds = orders.map((order) => orderIdByExternal.get(order.externalOrderId)).filter((id): id is number => typeof id === "number");
  await runStatements(db, touchedIds.map((id) => db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(id)));

  const itemStatements: D1PreparedStatement[] = [];
  for (const order of orders) {
    const orderId = orderIdByExternal.get(order.externalOrderId);
    if (!orderId) continue;
    for (const item of combineItems(order.items)) {
      itemStatements.push(db.prepare(
        `INSERT INTO order_items
           (order_id, product_sku, external_sku, seller_article, size, quantity, unit_price)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(orderId, item.productSku, item.externalSku, item.sellerArticle, item.size, item.quantity, item.unitPrice));
    }
  }
  await runStatements(db, itemStatements);

  // Резервы больше не дописываются здесь по одному: после загрузки заказов
  // они пересчитываются целиком в rebuildReservations (lib/reservations.ts),
  // чтобы заказы, выпавшие из окна загрузки, не держали остаток вечно.

  await db.batch([
    db.prepare("UPDATE marketplaces SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?").bind(marketplaceId),
    db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'inbound', 'orders', 'success', ?, ?)`,
    ).bind(marketplaceId, orders.length, `Загружены реальные заказы: ${orders.length}`),
  ]);
}

function wbStatusInfo(status: WildberriesOrderStatus | undefined) {
  const supplierStatus = status?.supplierStatus ?? "new";
  const wbStatus = status?.wbStatus ?? "waiting";
  const sellerCancelled = supplierStatus === "cancel";
  const customerCanceled = new Set(["canceled_by_client", "declined_by_client"]).has(wbStatus);
  const otherCanceled = new Set(["canceled", "defect"]).has(wbStatus);
  const canceled = sellerCancelled || customerCanceled || otherCanceled;
  const bought = wbStatus === "sold";
  const shipped = bought || ["supply", "complete"].includes(supplierStatus);
  return {
    status: `${supplierStatus}/${wbStatus}`,
    sellerCancelled,
    canceled,
    bought,
    shipped,
    cancellationSource: sellerCancelled ? "seller" : customerCanceled ? "customer" : otherCanceled ? "marketplace" : null,
  };
}

async function syncWildberries(db: D1Database, runtime: ReturnType<typeof getRuntimeEnv>, days: number) {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) return { marketplace: "wildberries", skipped: true, reason: "Ключ не добавлен" };
  const token = credentials.WB_API_TOKEN;
  await db.prepare(
    `INSERT INTO marketplaces (id, name, enabled, connection_status)
     VALUES ('wildberries', 'Wildberries', 1, 'connected')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  const localProducts = await readLocalProducts(db);
  try {
    const cards = await getWildberriesCards(token);
    await saveMappings(db, "wildberries", matchWildberriesCatalog(localProducts, cards));
  } catch {
    // Заказы остаются доступны даже если у ключа нет отдельного права «Контент».
  }
  const mappingIndex = await readMappingIndex(db, "wildberries");
  const remoteOrders = await getWildberriesOrders(token, days);
  const statuses = await getWildberriesOrderStatuses(token, remoteOrders.map((order) => order.id));
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const syncedAt = new Date().toISOString();
  const normalized = remoteOrders.map((order: WildberriesOrder): NormalizedOrder => {
    const externalSku = String(order.chrtId);
    const mapping = mappingIndex.get(externalSku);
    const info = wbStatusInfo(statusById.get(order.id));
    const price = Number(order.convertedFinalPrice ?? order.convertedPrice ?? order.finalPrice ?? order.price ?? 0) / 100;
    return {
      externalOrderId: String(order.id),
      status: info.status,
      amount: price,
      orderedAt: order.createdAt,
      shippedAt: info.shipped ? syncedAt : null,
      deliveredAt: info.bought ? syncedAt : null,
      buyoutAt: info.bought ? syncedAt : null,
      canceledAt: info.canceled ? syncedAt : null,
      cancellationSource: info.cancellationSource,
      sellerCancelled: info.sellerCancelled,
      region: null,
      city: order.address?.fullAddress ?? null,
      warehouseExternalId: order.warehouseId ? String(order.warehouseId) : null,
      final: info.bought || info.canceled,
      items: [{
        externalSku,
        productSku: mapping?.sourceSku ?? null,
        sellerArticle: mapping?.article ?? order.article ?? externalSku,
        size: mapping?.size ?? null,
        quantity: 1,
        unitPrice: price,
      }],
    };
  });
  await persistOrders(db, "wildberries", "Wildberries", normalized);
  return { marketplace: "wildberries", skipped: false, orders: normalized.length };
}

function ozonCancellationSource(posting: OzonPosting) {
  const cancellation = posting.cancellation;
  const combined = `${cancellation?.cancellation_type ?? ""} ${cancellation?.cancellation_initiator ?? ""}`.toLowerCase();
  if (combined.includes("seller") || combined.includes("продав")) return "seller";
  if (combined.includes("client") || combined.includes("customer") || combined.includes("покуп")) return "customer";
  return posting.status === "cancelled" || posting.status === "canceled" ? "marketplace" : null;
}

async function syncOzon(db: D1Database, runtime: ReturnType<typeof getRuntimeEnv>, days: number) {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) return { marketplace: "ozon", skipped: true, reason: "Ключи не добавлены" };
  await db.prepare(
    `INSERT INTO marketplaces (id, name, enabled, connection_status)
     VALUES ('ozon', 'Ozon', 1, 'connected')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  const localProducts = await readLocalProducts(db);
  const catalog = await getOzonProductCatalog(credentials.OZON_CLIENT_ID, credentials.OZON_API_KEY);
  await saveMappings(db, "ozon", matchOzonCatalog(localProducts, catalog));
  const mappingIndex = await readMappingIndex(db, "ozon");
  const postings = await getOzonPostings(credentials.OZON_CLIENT_ID, credentials.OZON_API_KEY, days);
  const syncedAt = new Date().toISOString();
  const normalized = postings.map((posting): NormalizedOrder => {
    const products = Array.isArray(posting.products) ? posting.products : [];
    const status = posting.status || "unknown";
    const canceled = status === "cancelled" || status === "canceled";
    const bought = status === "delivered";
    const source = ozonCancellationSource(posting);
    const items = products.map((product): NormalizedItem => {
      const mapping = mappingIndex.get(product.offer_id);
      const unitPrice = Number(product.price?.amount ?? 0);
      return {
        externalSku: product.offer_id || String(product.sku),
        productSku: mapping?.sourceSku ?? null,
        sellerArticle: mapping?.article ?? product.offer_id ?? String(product.sku),
        size: mapping?.size ?? null,
        quantity: Math.max(1, Number(product.quantity ?? 1)),
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      };
    });
    const amount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    return {
      externalOrderId: posting.posting_number,
      status,
      amount,
      orderedAt: posting.in_process_at ?? posting.shipment_date ?? syncedAt,
      shippedAt: ["awaiting_deliver", "delivering", "driver_pickup", "delivered"].includes(status) ? (posting.shipment_date ?? syncedAt) : null,
      deliveredAt: bought ? (posting.delivering_date ?? syncedAt) : null,
      buyoutAt: bought ? (posting.delivering_date ?? syncedAt) : null,
      canceledAt: canceled ? syncedAt : null,
      cancellationSource: source,
      sellerCancelled: source === "seller",
      region: posting.analytics_data?.region ?? null,
      city: posting.analytics_data?.city ?? null,
      warehouseExternalId: posting.delivery_method?.warehouse_id ? String(posting.delivery_method.warehouse_id) : null,
      final: bought || canceled,
      items,
    };
  });
  await persistOrders(db, "ozon", "Ozon", normalized);
  return { marketplace: "ozon", skipped: false, orders: normalized.length };
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  let days = 30;
  let force = false;
  try {
    const body = await request.json() as { days?: number; force?: boolean };
    if ([7, 30, 90].includes(Number(body.days))) days = Number(body.days);
    force = body.force === true;
  } catch {
    // По умолчанию загружаем 30 дней.
  }

  if (!force) {
    const lastSync = await runtime.DB.prepare(
      "SELECT value FROM settings WHERE key = 'orders_full_sync_at'",
    ).first<{ value: string }>();
    const lastSyncMs = lastSync?.value ? new Date(lastSync.value).getTime() : 0;
    if (Number.isFinite(lastSyncMs) && Date.now() - lastSyncMs < 15 * 60 * 1000) {
      return Response.json({ ok: true, days, cached: true, results: [], errors: [] });
    }
  }

  const results: unknown[] = [];
  const errors: Array<{ marketplace: string; message: string }> = [];
  for (const [marketplace, sync] of [
    ["wildberries", () => syncWildberries(runtime.DB!, runtime, days)],
    ["ozon", () => syncOzon(runtime.DB!, runtime, days)],
  ] as const) {
    try {
      results.push(await sync());
    } catch (error) {
      errors.push({ marketplace, message: error instanceof Error ? error.message : "Ошибка синхронизации" });
    }
  }

  // Единый пересчёт резервов по обеим площадкам сразу после загрузки заказов.
  let reservations = null;
  if (errors.length < 2) {
    try {
      reservations = await rebuildReservations(runtime.DB);
    } catch (error) {
      errors.push({ marketplace: "reservations", message: error instanceof Error ? error.message : "Не удалось пересчитать резервы" });
    }
  }

  if (results.length > 0) {
    await runtime.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('orders_full_sync_at', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(new Date().toISOString()).run();
  }

  return Response.json({ ok: errors.length === 0, days, results, errors, reservations }, { status: errors.length ? 207 : 200 });
}
