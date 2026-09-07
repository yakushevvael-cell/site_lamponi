/**
 * Журнал синхронизации остатков (ТЗ, п. 12).
 *
 * Каждая отправка пишется построчно: маркетплейс, ID склада, артикул, размер,
 * остаток по ОСВ, резерв, рассчитанный остаток, переданное значение, ответ API,
 * статус и пользователь. API-ключи и любые секреты сюда не попадают.
 */
import type { SendableRow } from "@/lib/stock-math";

export type SyncTrigger = "manual" | "osv_upload" | "orders_sync" | "warehouse_enabled" | "warehouse_disabled" | "manual_zero" | "canary";
export type SyncRunStatus = "running" | "success" | "partial" | "error" | "cancelled";
export type LogStatus = "success" | "error" | "blocked" | "skipped";

const LOG_RETENTION_DAYS = 60;
const BATCH_SIZE = 50;

export type LogRow = Partial<SendableRow> & {
  marketplaceId: string;
  warehouseId?: string | number | null;
  apiStatus: LogStatus;
  apiMessage?: string | null;
};

function text(value: unknown, limit = 500) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, limit);
}

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function newRunId() {
  return crypto.randomUUID();
}

export async function startSyncRun(
  db: D1Database,
  options: { runId?: string; trigger: SyncTrigger; actorEmail: string; osvUploadId?: number | null },
) {
  const runId = options.runId ?? newRunId();
  await db.prepare(
    `INSERT INTO stock_sync_runs (id, status, trigger, osv_upload_id, actor_email, started_at)
     VALUES (?, 'running', ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(runId, options.trigger, options.osvUploadId ?? null, options.actorEmail).run();
  return runId;
}

export async function finishSyncRun(
  db: D1Database,
  runId: string,
  status: SyncRunStatus,
  message?: string | null,
) {
  await db.prepare(
    `UPDATE stock_sync_runs
     SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(status, text(message), runId).run();
  await db.prepare(
    `DELETE FROM stock_sync_log
     WHERE created_at < datetime('now', ?)`,
  ).bind(`-${LOG_RETENTION_DAYS} days`).run().catch(() => undefined);
}

/** Пишет пачку строк журнала. Ошибка записи журнала никогда не роняет синхронизацию. */
export async function logStockRows(
  db: D1Database,
  runId: string,
  actorEmail: string,
  rows: LogRow[],
) {
  if (rows.length === 0) return;
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO stock_sync_log
       (run_id, marketplace_id, warehouse_id, product_sku, external_sku, article, size,
        osv_qty, reserve_qty, computed_qty, sent_qty, api_status, api_message, actor_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    runId,
    row.marketplaceId,
    text(row.warehouseId, 64),
    text(row.productSku, 200),
    text(row.externalSku, 200),
    text(row.article, 200),
    text(row.size, 64),
    num(row.osvQty),
    num(row.reserveQty),
    num(row.computedQty),
    num(row.sentQty),
    row.apiStatus,
    text(row.apiMessage),
    actorEmail,
  ));

  try {
    for (let start = 0; start < statements.length; start += BATCH_SIZE) {
      await db.batch(statements.slice(start, start + BATCH_SIZE));
    }
  } catch {
    // Журнал — вспомогательный контур: его сбой не должен прерывать основную операцию.
  }
}

/** Однострочная запись — для событий уровня склада (включение, отключение, блокировка гардом). */
export async function logStockEvent(
  db: D1Database,
  runId: string,
  actorEmail: string,
  row: LogRow,
) {
  await logStockRows(db, runId, actorEmail, [row]);
}
