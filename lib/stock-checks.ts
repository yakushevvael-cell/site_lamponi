import type { AppRuntimeEnv } from "@/lib/runtime-env";
import {
  readRemoteMappings,
  readRemoteStocks,
  remoteKey,
  REMOTE_MARKETPLACES,
  type RemoteWarehouseStock,
} from "@/lib/remote-stocks";
import type { SyncTrigger } from "@/lib/stock-log";

/**
 * Проверка площадок после корректировки остатка.
 *
 * Корректировка сообщает только, что площадка приняла запрос. Что в итоге
 * лежит на складе, видно лишь в кабинете: площадка применяет значение не
 * мгновенно, а заказ, сделанный в ту же минуту, может его тут же уменьшить.
 * Поэтому через 10 минут после корректировки сервис сам читает остатки
 * со всех складов WB, Ozon и Яндекс Маркета и сохраняет результат — он
 * показывается в «Истории» позиции на странице «Остатки».
 *
 * Проверка назначается только после доотправки по заказам и ручной выгрузки
 * выбранных позиций. После ежечасной полной синхронизации — нет: это чтение
 * всего ассортимента со всех складов раз в час, лимиты API площадок нужнее
 * самой выгрузке.
 *
 * Назначенные проверки забирает таймер lamponi-stock-checks (каждые 2 минуты).
 */

export const CHECK_DELAY_MINUTES = 10;
const CHECK_TRIGGERS = new Set<SyncTrigger>(["orders_sync", "manual"]);
const RETENTION_DAYS = 60;
const BATCH_LIMIT = 100;
/** Проверка, взятая в работу и не завершённая за это время, считается брошенной. */
const STALE_RUNNING_MINUTES = 30;

type CheckRow = { id: number; runId: string | null; productSku: string };
type SentRow = { marketplaceId: string; warehouseId: string | null; sentQty: number | null; apiStatus: string };

type CheckResultRow = {
  marketplaceId: string;
  warehouseId: string;
  warehouseName: string;
  publishing: boolean;
  status: "ok" | "missing" | "error";
  amount: number | null;
  reserved: number | null;
  expectedQty: number | null;
  message: string | null;
};

/** Назначает проверку площадок через 10 минут. Сбой здесь не должен ронять выгрузку. */
export async function scheduleRemoteChecks(
  db: D1Database,
  options: { runId: string; trigger: SyncTrigger; sourceSkus: string[] },
) {
  if (!CHECK_TRIGGERS.has(options.trigger)) return;
  const skus = [...new Set(options.sourceSkus)];
  if (skus.length === 0) return;
  const statements = skus.map((sku) => db.prepare(
    `INSERT INTO stock_remote_checks (run_id, product_sku, trigger, due_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  ).bind(options.runId, sku, options.trigger, `+${CHECK_DELAY_MINUTES} minutes`));
  try {
    for (let start = 0; start < statements.length; start += 100) {
      await db.batch(statements.slice(start, start + 100));
    }
  } catch {
    // История — вспомогательный контур: без проверки остатки всё равно уехали.
  }
}

function buildRows(
  sku: string,
  mappings: Awaited<ReturnType<typeof readRemoteMappings>>,
  remote: Awaited<ReturnType<typeof readRemoteStocks>>,
  sent: SentRow[],
): CheckResultRow[] {
  const rows: CheckResultRow[] = [];
  for (const marketplaceId of REMOTE_MARKETPLACES) {
    const mapping = mappings.find((row) => row.sourceSku === sku && row.marketplaceId === marketplaceId);
    if (!mapping) continue;
    const marketplaceError = remote.errors.get(`${marketplaceId}::*`) ?? null;
    const stocks = remote.stocks.get(remoteKey(marketplaceId, mapping.externalSku)) ?? [];
    const byWarehouse = new Map<string, RemoteWarehouseStock>(stocks.map((stock) => [stock.warehouseId, stock]));

    // Все склады площадки из нашего списка плюс те, что площадка показала сверх него.
    const warehouses = new Map<string, { name: string; publishing: boolean }>();
    for (const warehouse of remote.warehouses[marketplaceId]) {
      warehouses.set(warehouse.externalId, { name: warehouse.name, publishing: Boolean(warehouse.publishFullStock) });
    }
    for (const stock of stocks) {
      if (!warehouses.has(stock.warehouseId)) warehouses.set(stock.warehouseId, { name: stock.warehouseName, publishing: stock.publishing });
    }

    if (warehouses.size === 0 && marketplaceError) {
      rows.push({
        marketplaceId,
        warehouseId: "*",
        warehouseName: "Все склады",
        publishing: false,
        status: "error",
        amount: null,
        reserved: null,
        expectedQty: null,
        message: marketplaceError,
      });
      continue;
    }

    for (const [warehouseId, warehouse] of warehouses) {
      const expected = sent.find((row) => row.marketplaceId === marketplaceId
        && String(row.warehouseId ?? "") === warehouseId
        && row.apiStatus === "success"
        && row.sentQty !== null);
      const error = marketplaceError ?? remote.errors.get(`${marketplaceId}::${warehouseId}`) ?? null;
      const stock = byWarehouse.get(warehouseId);
      rows.push({
        marketplaceId,
        warehouseId,
        warehouseName: warehouse.name,
        publishing: warehouse.publishing,
        status: error ? "error" : stock ? "ok" : "missing",
        amount: error || !stock ? null : stock.amount,
        reserved: error || !stock ? null : stock.reserved,
        expectedQty: expected ? Number(expected.sentQty) : null,
        message: error,
      });
    }
  }
  return rows;
}

/** Выполняет проверки, срок которых подошёл. Возвращает, сколько сделано и сколько ждёт. */
export async function runDueRemoteChecks(db: D1Database, runtime: AppRuntimeEnv) {
  const due = await db.prepare(
    `SELECT id, run_id AS runId, product_sku AS productSku
     FROM stock_remote_checks
     WHERE (status = 'pending' AND due_at <= datetime('now'))
        OR (status = 'running' AND checked_at < datetime('now', ?))
     ORDER BY due_at
     LIMIT ?`,
  ).bind(`-${STALE_RUNNING_MINUTES} minutes`, BATCH_LIMIT).all<CheckRow>();
  const checks = due.results;

  let checked = 0;
  const failures: string[] = [];
  if (checks.length > 0) {
    const ids = checks.map((check) => check.id);
    const placeholders = ids.map(() => "?").join(", ");
    // Отметка «в работе» защищает от двойной проверки, если запуск наложился на запуск.
    await db.prepare(
      `UPDATE stock_remote_checks SET status = 'running', checked_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders})`,
    ).bind(...ids).run();

    const skus = [...new Set(checks.map((check) => check.productSku))];
    const mappings = await readRemoteMappings(db, skus);
    const remote = await readRemoteStocks(db, runtime, mappings);
    failures.push(...remote.failures);

    for (const check of checks) {
      const sent = check.runId
        ? (await db.prepare(
          `SELECT marketplace_id AS marketplaceId, warehouse_id AS warehouseId, sent_qty AS sentQty, api_status AS apiStatus
           FROM stock_sync_log
           WHERE run_id = ? AND product_sku = ?`,
        ).bind(check.runId, check.productSku).all<SentRow>()).results
        : [];
      const rows = buildRows(check.productSku, mappings, remote, sent);
      const statements: D1PreparedStatement[] = [
        db.prepare("DELETE FROM stock_remote_check_rows WHERE check_id = ?").bind(check.id),
        ...rows.map((row) => db.prepare(
          `INSERT INTO stock_remote_check_rows
             (check_id, marketplace_id, warehouse_id, warehouse_name, publishing, status, amount, reserved, expected_qty, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          check.id,
          row.marketplaceId,
          row.warehouseId,
          row.warehouseName.slice(0, 200),
          row.publishing ? 1 : 0,
          row.status,
          row.amount,
          row.reserved,
          row.expectedQty,
          row.message?.slice(0, 300) ?? null,
        )),
      ];
      const noMapping = rows.length === 0;
      const allFailed = rows.length > 0 && rows.every((row) => row.status === "error");
      statements.push(db.prepare(
        `UPDATE stock_remote_checks SET status = ?, message = ?, checked_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).bind(
        noMapping || allFailed ? "error" : "done",
        noMapping ? "Позиция не сопоставлена ни с одной площадкой." : allFailed ? "Площадки не ответили." : null,
        check.id,
      ));
      await db.batch(statements);
      checked += 1;
    }
  }

  await db.prepare(
    `DELETE FROM stock_remote_check_rows
     WHERE check_id IN (SELECT id FROM stock_remote_checks WHERE created_at < datetime('now', ?))`,
  ).bind(`-${RETENTION_DAYS} days`).run().catch(() => undefined);
  await db.prepare("DELETE FROM stock_remote_checks WHERE created_at < datetime('now', ?)")
    .bind(`-${RETENTION_DAYS} days`).run().catch(() => undefined);

  const left = await db.prepare(
    "SELECT COUNT(*) AS count FROM stock_remote_checks WHERE status = 'pending' AND due_at <= datetime('now')",
  ).first<{ count: number }>();

  return { checked, dueLeft: Number(left?.count ?? 0), failures };
}
