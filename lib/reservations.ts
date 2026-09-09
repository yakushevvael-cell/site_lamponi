/**
 * Пересчёт резервов по заказам (ТЗ, п. 7).
 *
 * Резерв больше не «дописывается» при каждой синхронизации заказов, а полностью
 * перестраивается из таблиц `orders` / `order_items`. Это единственный способ
 * получить верное число: раньше резервы по заказам, выпавшим из окна загрузки,
 * оставались активными навсегда, а после загрузки ОСВ гасились все отгруженные
 * заказы подряд, без сверки с датой самой ОСВ.
 *
 * Состояния резерва:
 *  - `active`        — заказ живой, товар физически лежит на складе и обещан покупателю;
 *  - `closed_by_osv` — заказ отгружен не позже даты ОСВ, значит уже списан в ОСВ;
 *  - `released`      — заказ отменён, выкуплен или протух.
 */

import { markStocksDirty } from "@/lib/stock-queue";

/** Заказ, не получивший финального статуса за это время, перестаёт держать остаток. */
export const RESERVE_TTL_DAYS = 45;

export type RebuildResult = {
  active: number;
  closedByOsv: number;
  released: number;
  balanceDate: string | null;
  reservedQuantity: number;
  /** Сколько позиций изменили резерв и поставлены в очередь на доотправку. */
  changedSkus: number;
};

/** Дата, на которую актуальна последняя загруженная ОСВ. */
export async function readBalanceDate(db: D1Database) {
  const row = await db.prepare(
    `SELECT COALESCE(balance_date, created_at) AS balanceDate
     FROM osv_uploads
     ORDER BY id DESC
     LIMIT 1`,
  ).first<{ balanceDate: string }>();
  return row?.balanceDate ?? null;
}

/** Текущий активный резерв по каждому артикулу — снимок для сравнения «до/после». */
async function readActiveReserveBySku(db: D1Database) {
  const rows = await db.prepare(
    `SELECT product_sku AS productSku, COALESCE(SUM(quantity), 0) AS quantity
     FROM stock_reservations
     WHERE status = 'active'
     GROUP BY product_sku`,
  ).all<{ productSku: string; quantity: number }>();
  return new Map(rows.results.map((row) => [row.productSku, Number(row.quantity) || 0]));
}

/**
 * Полностью перестраивает резервы. Вызывается после загрузки ОСВ, после
 * синхронизации заказов и перед стартом полной синхронизации остатков.
 */
export async function rebuildReservations(db: D1Database): Promise<RebuildResult> {
  const balanceDate = await readBalanceDate(db);
  // Снимок «до»: по разнице с состоянием «после» видно, какие именно позиции
  // изменили остаток. Только они поедут на площадки доотправкой.
  const reserveBefore = await readActiveReserveBySku(db).catch(() => null);
  // Если ОСВ ещё не загружали, считаем, что списанного нет вовсе.
  const cutoff = balanceDate ?? "0001-01-01T00:00:00Z";

  // 1. Заводим или обновляем резерв по каждой позиции сопоставленного заказа.
  //    Статус вычисляется здесь же, одним выражением, чтобы не было промежуточных
  //    состояний, в которых остаток посчитан по половине данных.
  await db.prepare(
    `INSERT INTO stock_reservations
       (order_item_id, product_sku, marketplace_id, quantity, status, order_status, reserved_at, released_at)
     SELECT oi.id,
            oi.product_sku,
            o.marketplace_id,
            oi.quantity,
            CASE
              WHEN o.canceled_at IS NOT NULL THEN 'released'
              WHEN o.buyout_at IS NOT NULL OR o.delivered_at IS NOT NULL THEN 'released'
              WHEN o.shipped_at IS NOT NULL AND o.shipped_at <= ?1 THEN 'closed_by_osv'
              WHEN o.ordered_at < datetime('now', ?2) THEN 'released'
              ELSE 'active'
            END,
            o.status,
            o.ordered_at,
            CASE
              WHEN o.canceled_at IS NOT NULL THEN o.canceled_at
              WHEN o.buyout_at IS NOT NULL THEN o.buyout_at
              WHEN o.delivered_at IS NOT NULL THEN o.delivered_at
              WHEN o.shipped_at IS NOT NULL AND o.shipped_at <= ?1 THEN o.shipped_at
              WHEN o.ordered_at < datetime('now', ?2) THEN CURRENT_TIMESTAMP
              ELSE NULL
            END
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_sku IS NOT NULL
     ON CONFLICT(order_item_id) DO UPDATE SET
       product_sku = excluded.product_sku,
       marketplace_id = excluded.marketplace_id,
       quantity = excluded.quantity,
       status = excluded.status,
       order_status = excluded.order_status,
       released_at = excluded.released_at`,
  ).bind(cutoff, `-${RESERVE_TTL_DAYS} days`).run();

  // 2. Позиция, потерявшая сопоставление с товаром, больше не держит остаток.
  await db.prepare(
    `UPDATE stock_reservations
     SET status = 'released', released_at = CURRENT_TIMESTAMP
     WHERE status = 'active'
       AND order_item_id NOT IN (SELECT id FROM order_items WHERE product_sku IS NOT NULL)`,
  ).run();

  const totals = await db.prepare(
    `SELECT
       COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
       COUNT(CASE WHEN status = 'closed_by_osv' THEN 1 END) AS closedByOsv,
       COUNT(CASE WHEN status = 'released' THEN 1 END) AS released,
       COALESCE(SUM(CASE WHEN status = 'active' THEN quantity ELSE 0 END), 0) AS reservedQuantity
     FROM stock_reservations`,
  ).first<{ active: number; closedByOsv: number; released: number; reservedQuantity: number }>();

  let changedSkus = 0;
  if (reserveBefore) {
    const reserveAfter = await readActiveReserveBySku(db).catch(() => null);
    if (reserveAfter) {
      const changed: string[] = [];
      for (const [sku, quantity] of reserveAfter) {
        if ((reserveBefore.get(sku) ?? 0) !== quantity) changed.push(sku);
      }
      for (const [sku, quantity] of reserveBefore) {
        // Позиция, у которой резерв обнулился, тоже изменилась: остаток вырос.
        if (quantity !== 0 && !reserveAfter.has(sku)) changed.push(sku);
      }
      changedSkus = await markStocksDirty(db, changed, "изменился резерв по заказам");
    }
  }

  return {
    active: Number(totals?.active ?? 0),
    closedByOsv: Number(totals?.closedByOsv ?? 0),
    released: Number(totals?.released ?? 0),
    reservedQuantity: Number(totals?.reservedQuantity ?? 0),
    balanceDate,
    changedSkus,
  };
}

export type ReserveDrift = {
  externalSku: string;
  warehouseId: string;
  ourReserve: number;
  theirReserve: number;
};

/**
 * Сверка нашего резерва с тем, что показывает маркетплейс.
 *
 * Расхождение не влияет на отправляемое число — оно ограничено ОСВ гардом, — но
 * это ранний сигнал, что заказы подтянулись не полностью. Именно такое
 * расхождение раньше раскручивало остаток вверх.
 */
export function collectReserveDrift(
  rows: Array<{ externalSku: string; warehouseId: string; reserveQty: number }>,
  remoteReserved: Map<string, number>,
  threshold = 1,
): ReserveDrift[] {
  const drift: ReserveDrift[] = [];
  for (const row of rows) {
    const theirReserve = remoteReserved.get(`${row.externalSku}::${row.warehouseId}`);
    if (theirReserve === undefined) continue;
    if (theirReserve - row.reserveQty >= threshold) {
      drift.push({
        externalSku: row.externalSku,
        warehouseId: row.warehouseId,
        ourReserve: row.reserveQty,
        theirReserve,
      });
    }
  }
  return drift;
}
