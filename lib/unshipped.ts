import { parseUtc, wasAwaitingAt } from "@/lib/unshipped-core.mjs";

/** Сколько дней до среза смотреть: старше FBS-заказ уже давно отменён площадкой. */
export const UNSHIPPED_WINDOW_DAYS = 14;

/** Текущее время с точностью до минуты — время отчёта по умолчанию. */
export function currentMinute() {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

export type UnshippedOrder = {
  marketplaceId: string;
  marketplace: string;
  externalOrderId: string;
  orderedAt: string;
  shipmentDeadline: string | null;
  waitedHours: number;
  items: string;
  units: number;
  amount: number;
  status: string;
  handedOverAt: string | null;
  canceledAt: string | null;
};

type OrderRow = {
  id: number;
  marketplaceId: string;
  externalOrderId: string;
  status: string;
  amount: number;
  orderedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  canceledAt: string | null;
  shipmentDeadline: string | null;
  handedOverAt: string | null;
};

type ItemRow = { orderId: number; article: string | null; size: string | null; quantity: number };

export function marketplaceName(id: string) {
  if (id === "wildberries") return "Wildberries";
  if (id === "ozon") return "Ozon";
  if (id === "yandex") return "Яндекс Маркет";
  return id;
}

/** Заказы, которые в момент cutoff (мс UTC) ещё ждали отгрузки. */
export async function readUnshippedAt(db: D1Database, cutoff: number): Promise<UnshippedOrder[]> {
  // В SQL — грубое окно по строке даты с запасом в сутки, точный отбор — в JS:
  // даты в базе приходят с площадок в разных записях ISO.
  const from = new Date(cutoff - (UNSHIPPED_WINDOW_DAYS + 1) * 86_400_000).toISOString();
  const to = new Date(cutoff + 86_400_000).toISOString();
  const orderRows = await db.prepare(
    `SELECT id, marketplace_id AS marketplaceId, external_order_id AS externalOrderId, status, amount,
            ordered_at AS orderedAt, shipped_at AS shippedAt, delivered_at AS deliveredAt,
            canceled_at AS canceledAt, shipment_deadline AS shipmentDeadline, handed_over_at AS handedOverAt
     FROM orders
     WHERE ordered_at >= ? AND ordered_at < ?`,
  ).bind(from, to).all<OrderRow>();
  const windowStart = cutoff - UNSHIPPED_WINDOW_DAYS * 86_400_000;
  const orders = orderRows.results.filter((order) => {
    const ordered = parseUtc(order.orderedAt);
    return ordered !== null && ordered >= windowStart && wasAwaitingAt(order, cutoff);
  });
  if (!orders.length) return [];

  const itemRows = await db.prepare(
    `SELECT oi.order_id AS orderId, COALESCE(oi.seller_article, p.article, oi.external_sku) AS article,
            COALESCE(oi.size, p.size) AS size, oi.quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.source_sku = oi.product_sku
     WHERE o.ordered_at >= ? AND o.ordered_at < ?
     ORDER BY oi.id`,
  ).bind(from, to).all<ItemRow>();
  const itemsByOrder = new Map<number, ItemRow[]>();
  for (const item of itemRows.results) itemsByOrder.set(item.orderId, [...(itemsByOrder.get(item.orderId) ?? []), item]);

  return orders
    .map((order) => {
      const items = itemsByOrder.get(order.id) ?? [];
      return {
        marketplaceId: order.marketplaceId,
        marketplace: marketplaceName(order.marketplaceId),
        externalOrderId: order.externalOrderId,
        orderedAt: order.orderedAt,
        shipmentDeadline: order.shipmentDeadline,
        waitedHours: Math.floor((cutoff - (parseUtc(order.orderedAt) ?? cutoff)) / 3_600_000),
        items: items
          .map((item) => `${item.article ?? "—"}${item.size ? ` р.${item.size}` : ""} ×${Number(item.quantity)}`)
          .join("; "),
        units: items.reduce((sum, item) => sum + Number(item.quantity), 0),
        amount: Number(order.amount),
        status: order.status,
        handedOverAt: order.handedOverAt,
        canceledAt: order.canceledAt,
      };
    })
    .sort((a, b) => a.marketplace.localeCompare(b.marketplace) || (parseUtc(a.orderedAt) ?? 0) - (parseUtc(b.orderedAt) ?? 0));
}
