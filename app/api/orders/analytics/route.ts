import { getRuntimeEnv } from "@/lib/runtime-env";
import { authorizeApi } from "@/lib/app-auth";

type OrderRow = {
  id: number;
  marketplaceId: string;
  externalOrderId: string;
  status: string;
  amount: number;
  orderedAt: string;
  deliveredAt: string | null;
  buyoutAt: string | null;
  canceledAt: string | null;
  sellerCancelled: number;
  cancellationSource: string | null;
  region: string | null;
  city: string | null;
};

type ItemRow = {
  orderId: number;
  marketplaceId: string;
  sellerArticle: string | null;
  size: string | null;
  quantity: number;
  unitPrice: number;
  buyoutAt: string | null;
  canceledAt: string | null;
  sellerCancelled: number;
};

function marketplaceName(id: string) {
  if (id === "wildberries") return "Wildberries";
  if (id === "ozon") return "Ozon";
  if (id === "yandex") return "Яндекс Маркет";
  return id;
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function GET(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get("days") ?? 30);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const ordersResult = await runtime.DB.prepare(
    `SELECT id, marketplace_id AS marketplaceId, external_order_id AS externalOrderId,
            status, amount, ordered_at AS orderedAt, delivered_at AS deliveredAt,
            buyout_at AS buyoutAt, canceled_at AS canceledAt,
            seller_cancelled AS sellerCancelled, cancellation_source AS cancellationSource,
            region, city
     FROM orders
     WHERE ordered_at >= ?
     ORDER BY ordered_at DESC`,
  ).bind(since).all<OrderRow>();
  const orders = ordersResult.results;
  const itemResult = await runtime.DB.prepare(
    `SELECT oi.order_id AS orderId, o.marketplace_id AS marketplaceId,
            COALESCE(oi.seller_article, p.article, oi.external_sku) AS sellerArticle,
            COALESCE(oi.size, p.size) AS size, oi.quantity, oi.unit_price AS unitPrice,
            o.buyout_at AS buyoutAt, o.canceled_at AS canceledAt,
            o.seller_cancelled AS sellerCancelled
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.source_sku = oi.product_sku
     WHERE o.ordered_at >= ?`,
  ).bind(since).all<ItemRow>();
  const items = itemResult.results;

  const orderedUnits = items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const buyoutOrders = orders.filter((order) => Boolean(order.buyoutAt));
  const canceledOrders = orders.filter((order) => Boolean(order.canceledAt));
  const sellerCanceledOrders = orders.filter((order) => Boolean(order.sellerCancelled));
  const completedOrders = buyoutOrders.length + canceledOrders.length;
  const buyoutAmount = buyoutOrders.reduce((sum, order) => sum + Number(order.amount), 0);
  const deliveryValues = buyoutOrders
    .map((order) => order.deliveredAt ? (new Date(order.deliveredAt).getTime() - new Date(order.orderedAt).getTime()) / 86_400_000 : NaN)
    .filter((value) => Number.isFinite(value) && value >= 0);

  const summary = {
    orderCount: orders.length,
    orderedUnits,
    orderAmount: round(orders.reduce((sum, order) => sum + Number(order.amount), 0), 2),
    buyoutOrders: buyoutOrders.length,
    buyoutUnits: items.filter((item) => item.buyoutAt).reduce((sum, item) => sum + Number(item.quantity), 0),
    buyoutAmount: round(buyoutAmount, 2),
    canceledOrders: canceledOrders.length,
    canceledUnits: items.filter((item) => item.canceledAt).reduce((sum, item) => sum + Number(item.quantity), 0),
    sellerCanceledOrders: sellerCanceledOrders.length,
    sellerCanceledUnits: items.filter((item) => item.sellerCancelled).reduce((sum, item) => sum + Number(item.quantity), 0),
    completedOrders,
    buyoutRate: completedOrders ? round(buyoutOrders.length / completedOrders * 100) : 0,
    cancelRate: orders.length ? round(canceledOrders.length / orders.length * 100) : 0,
    sellerCancelRate: orders.length ? round(sellerCanceledOrders.length / orders.length * 100) : 0,
    averageDeliveryDays: deliveryValues.length ? round(deliveryValues.reduce((sum, value) => sum + value, 0) / deliveryValues.length) : null,
  };

  const marketplaceMap = new Map<string, OrderRow[]>();
  for (const order of orders) marketplaceMap.set(order.marketplaceId, [...(marketplaceMap.get(order.marketplaceId) ?? []), order]);
  const marketplaces = [...marketplaceMap].map(([id, rows]) => {
    const bought = rows.filter((row) => row.buyoutAt).length;
    const canceled = rows.filter((row) => row.canceledAt).length;
    const completed = bought + canceled;
    return {
      id,
      name: marketplaceName(id),
      orders: rows.length,
      amount: round(rows.reduce((sum, row) => sum + Number(row.amount), 0), 2),
      buyouts: bought,
      cancellations: canceled,
      sellerCancellations: rows.filter((row) => row.sellerCancelled).length,
      buyoutRate: completed ? round(bought / completed * 100) : 0,
      cancelRate: rows.length ? round(canceled / rows.length * 100) : 0,
    };
  }).sort((a, b) => b.orders - a.orders);

  const trendMap = new Map<string, { date: string; orders: number; amount: number; buyouts: number; cancellations: number; sellerCancellations: number }>();
  for (const order of orders) {
    const date = order.orderedAt.slice(0, 10);
    const row = trendMap.get(date) ?? { date, orders: 0, amount: 0, buyouts: 0, cancellations: 0, sellerCancellations: 0 };
    row.orders += 1;
    row.amount += Number(order.amount);
    if (order.buyoutAt) row.buyouts += 1;
    if (order.canceledAt) row.cancellations += 1;
    if (order.sellerCancelled) row.sellerCancellations += 1;
    trendMap.set(date, row);
  }
  const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ ...row, amount: round(row.amount, 2) }));

  const productMap = new Map<string, {
    article: string; orderIds: Set<number>; units: number; buyoutOrderIds: Set<number>; buyoutUnits: number;
    canceledOrderIds: Set<number>; canceledUnits: number; sellerCanceledOrderIds: Set<number>; sellerCanceledUnits: number; amount: number;
  }>();
  for (const item of items) {
    const article = item.sellerArticle?.trim() || "Не сопоставлено";
    const row = productMap.get(article) ?? {
      article, orderIds: new Set(), units: 0, buyoutOrderIds: new Set(), buyoutUnits: 0,
      canceledOrderIds: new Set(), canceledUnits: 0, sellerCanceledOrderIds: new Set(), sellerCanceledUnits: 0, amount: 0,
    };
    row.orderIds.add(item.orderId);
    row.units += Number(item.quantity);
    row.amount += Number(item.quantity) * Number(item.unitPrice);
    if (item.buyoutAt) { row.buyoutOrderIds.add(item.orderId); row.buyoutUnits += Number(item.quantity); }
    if (item.canceledAt) { row.canceledOrderIds.add(item.orderId); row.canceledUnits += Number(item.quantity); }
    if (item.sellerCancelled) { row.sellerCanceledOrderIds.add(item.orderId); row.sellerCanceledUnits += Number(item.quantity); }
    productMap.set(article, row);
  }
  const productRatings = [...productMap.values()].map((row) => ({
    article: row.article,
    orders: row.orderIds.size,
    units: row.units,
    buyouts: row.buyoutOrderIds.size,
    buyoutUnits: row.buyoutUnits,
    cancellations: row.canceledOrderIds.size,
    canceledUnits: row.canceledUnits,
    sellerCancellations: row.sellerCanceledOrderIds.size,
    sellerCanceledUnits: row.sellerCanceledUnits,
    amount: round(row.amount, 2),
  })).sort((a, b) => b.units - a.units || b.orders - a.orders).slice(0, 250);

  const geographyMap = new Map<string, { location: string; orders: number; buyouts: number; cancellations: number; amount: number }>();
  for (const order of orders) {
    const location = order.region?.trim() || order.city?.trim() || "Регион не передан";
    const row = geographyMap.get(location) ?? { location, orders: 0, buyouts: 0, cancellations: 0, amount: 0 };
    row.orders += 1;
    row.amount += Number(order.amount);
    if (order.buyoutAt) row.buyouts += 1;
    if (order.canceledAt) row.cancellations += 1;
    geographyMap.set(location, row);
  }
  const geography = [...geographyMap.values()].sort((a, b) => b.orders - a.orders).slice(0, 100).map((row) => ({ ...row, amount: round(row.amount, 2) }));

  const syncRows = await runtime.DB.prepare(
    `SELECT marketplace_id AS marketplaceId, MAX(created_at) AS lastSyncAt
     FROM sync_events WHERE kind = 'orders' AND status = 'success' GROUP BY marketplace_id`,
  ).all<{ marketplaceId: string; lastSyncAt: string | null }>();

  return Response.json({
    days,
    summary,
    marketplaces,
    trend,
    productRatings,
    geography,
    recentOrders: orders.slice(0, 100).map((order) => ({
      id: order.externalOrderId,
      marketplaceId: order.marketplaceId,
      marketplace: marketplaceName(order.marketplaceId),
      city: order.city || order.region || "—",
      amount: Number(order.amount),
      status: order.buyoutAt ? "Выкуп" : order.canceledAt ? (order.sellerCancelled ? "Отмена продавцом" : "Отмена") : order.status,
      orderedAt: order.orderedAt,
      sellerCancelled: Boolean(order.sellerCancelled),
    })),
    lastSync: syncRows.results,
  });
}
