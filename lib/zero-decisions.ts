/**
 * Подтверждение остатка обнулённых позиций по новой ОСВ.
 *
 * Позиция с нулевым остатком — не найденная при сборке или обнулённая вручную —
 * сама в продажу не возвращается, сколько бы ни показывала ОСВ: в учёте товар
 * может числиться годами, а на полке его нет. Если в ОСВ по такой позиции
 * остаток больше нуля, человек отвечает, верен ли он:
 *
 * - «Да» — обнуление снимается, блокировка «не найден» тоже, и остаток по ОСВ
 *   сразу уходит на площадки;
 * - «Нет» — позиция остаётся с нулём, а количество, на которое ответили,
 *   запоминается (products.zero_declined_qty). Повторно спрашиваем, только
 *   когда количество в ОСВ изменится.
 *
 * Список «ждут решения» не хранится отдельно, а считается из products: так он
 * не может разойтись с тем, что на самом деле обнулено и что пришло в ОСВ.
 */
import { OSV_UNITS_SQL } from "@/lib/osv-units";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { pushStocksForSkus } from "@/lib/stock-push";
import { markStocksDirty } from "@/lib/stock-queue";
import { readStockSyncState } from "@/lib/sync-pause";
import { eventStatement } from "@/lib/warehouse";

/** Блокировка «не найден», которая относится к позиции p. Требует алиас pa. */
export const PROBLEM_MATCHES_PRODUCT_SQL =
  "pa.state = 'blocked' AND pa.article = p.article AND (pa.size IS NULL OR pa.size = p.size OR p.size IS NULL)";

export type ZeroDecision = {
  sourceSku: string;
  article: string;
  size: string | null;
  reason: "not_found" | "manual";
  /** Количество в ОСВ, в единицах 1С: именно на него и отвечают. */
  osvQty: number;
  /** То же в единицах площадки (серьги — парами). */
  osvUnits: number;
  /** На какое количество в прошлый раз ответили «Нет». */
  declinedQty: number | null;
  zeroedAt: string | null;
  taskNumber: string | null;
  blockedBy: string | null;
  blockedAt: string | null;
  failedOrderCount: number | null;
};

export async function readPendingZeroDecisions(db: D1Database) {
  const rows = await db.prepare(
    `SELECT p.source_sku AS sourceSku,
            p.article AS article,
            p.size AS size,
            CASE WHEN pa.id IS NULL THEN 'manual' ELSE 'not_found' END AS reason,
            p.current_physical_qty AS osvQty,
            ${OSV_UNITS_SQL} AS osvUnits,
            p.zero_declined_qty AS declinedQty,
            p.manual_zero_at AS zeroedAt,
            pa.task_number AS taskNumber,
            pa.blocked_by AS blockedBy,
            pa.blocked_at AS blockedAt,
            pa.failed_order_count AS failedOrderCount
     FROM products p
     LEFT JOIN problem_articles pa ON pa.id = (
       SELECT pa.id FROM problem_articles pa
       WHERE ${PROBLEM_MATCHES_PRODUCT_SQL}
       ORDER BY pa.blocked_at DESC LIMIT 1
     )
     WHERE p.manual_zero = 1
       AND p.current_physical_qty > 0
       AND (p.zero_declined_qty IS NULL OR p.zero_declined_qty <> p.current_physical_qty)
     ORDER BY p.article, p.size
     LIMIT 500`,
  ).all<ZeroDecision>();
  return rows.results;
}

/**
 * После загрузки ОСВ: позиция, которой в ОСВ стало 0, «забывает» прошлый ответ.
 * Иначе 3 → 0 → 3 выглядело бы как «не изменилось», хотя товар уходил и пришёл.
 */
export async function resetDeclinedForEmptyOsv(db: D1Database) {
  await db.prepare(
    `UPDATE products SET zero_declined_qty = NULL
     WHERE zero_declined_qty IS NOT NULL AND current_physical_qty <= 0`,
  ).run();
}

export type DecisionInput = {
  sourceSku: string;
  confirm: boolean;
  /** Количество, которое человек видел на экране. Если ОСВ с тех пор сменилась — решение не применяем. */
  osvQty: number;
};

type ProductRow = { sourceSku: string; article: string; size: string | null; qty: number; manualZero: number };

const PUSH_CHUNK = 50;

export async function applyZeroDecisions(
  db: D1Database,
  runtime: AppRuntimeEnv,
  decisions: DecisionInput[],
  actorEmail: string,
) {
  const confirmed: string[] = [];
  const declined: string[] = [];
  const stale: string[] = [];

  for (const decision of decisions) {
    const product = await db.prepare(
      `SELECT source_sku AS sourceSku, article, size, current_physical_qty AS qty, manual_zero AS manualZero
       FROM products WHERE source_sku = ?`,
    ).bind(decision.sourceSku).first<ProductRow>();
    if (!product || !product.manualZero || Math.abs(Number(product.qty) - decision.osvQty) > 0.001) {
      stale.push(decision.sourceSku);
      continue;
    }

    const problem = await db.prepare(
      `SELECT pa.id, pa.task_number AS taskNumber FROM problem_articles pa, products p
       WHERE p.source_sku = ? AND ${PROBLEM_MATCHES_PRODUCT_SQL}
       ORDER BY pa.blocked_at DESC LIMIT 1`,
    ).bind(product.sourceSku).first<{ id: number; taskNumber: string | null }>();
    const qtyText = Number(product.qty).toLocaleString("ru-RU");

    if (!decision.confirm) {
      await db.batch([
        db.prepare("UPDATE products SET zero_declined_qty = current_physical_qty, updated_at = CURRENT_TIMESTAMP WHERE source_sku = ?")
          .bind(product.sourceSku),
        db.prepare(
          `INSERT INTO problem_article_log (article, size, action, actor_email, comment, task_number)
           VALUES (?, ?, 'osv_declined', ?, ?, ?)`,
        ).bind(product.article, product.size, actorEmail, `Остаток по ОСВ ${qtyText} не подтверждён — остаётся 0`, problem?.taskNumber ?? null),
      ]);
      declined.push(product.sourceSku);
      continue;
    }

    await db.batch([
      db.prepare(
        `UPDATE products SET manual_zero = 0, manual_zero_at = NULL, zero_declined_qty = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE source_sku = ?`,
      ).bind(product.sourceSku),
      db.prepare(
        `INSERT INTO problem_article_log (article, size, action, actor_email, comment, task_number)
         VALUES (?, ?, 'osv_confirmed', ?, ?, ?)`,
      ).bind(product.article, product.size, actorEmail, `Остаток по ОСВ ${qtyText} подтверждён — возвращён в продажу`, problem?.taskNumber ?? null),
    ]);
    confirmed.push(product.sourceSku);
    if (problem) await releaseProblemIfClear(db, problem.id, actorEmail, qtyText);
  }

  const pushed = await pushConfirmed(db, runtime, confirmed, actorEmail);
  return { confirmed, declined, stale, pushed };
}

/**
 * Блокировка «не найден» снимается, когда по артикулу не осталось обнулённых
 * позиций. Блокировка без размера накрывает все размеры артикула — пока хоть
 * один из них не подтверждён, она остаётся.
 */
async function releaseProblemIfClear(db: D1Database, problemId: number, actorEmail: string, qtyText: string) {
  const row = await db.prepare(
    `SELECT pa.article, pa.size, pa.task_id AS taskId, pa.task_number AS taskNumber,
            pa.failed_order_count AS failedOrderCount,
            (SELECT COUNT(*) FROM products p
              WHERE p.manual_zero = 1 AND p.article = pa.article
                AND (pa.size IS NULL OR p.size = pa.size OR p.size IS NULL)) AS zeroedLeft
     FROM problem_articles pa WHERE pa.id = ? AND pa.state = 'blocked'`,
  ).bind(problemId).first<{
    article: string;
    size: string | null;
    taskId: number | null;
    taskNumber: string | null;
    failedOrderCount: number;
    zeroedLeft: number;
  }>();
  if (!row || Number(row.zeroedLeft) > 0) return;

  const comment = `Остаток подтверждён при загрузке ОСВ: ${qtyText}`;
  await db.batch([
    db.prepare(
      `UPDATE problem_articles
       SET state = 'released', released_by = ?, released_at = CURRENT_TIMESTAMP, comment = ?
       WHERE id = ? AND state = 'blocked'`,
    ).bind(actorEmail, comment, problemId),
    eventStatement(db, {
      kind: "problem_released",
      taskId: row.taskId,
      taskNumber: row.taskNumber,
      article: row.article,
      size: row.size,
      actorEmail,
      payload: { comment, failedOrderCount: row.failedOrderCount, via: "osv_confirm" },
    }),
  ]);
}

/**
 * Подтверждённый остаток уходит на площадки сразу. Если выгрузка остановлена
 * или отправка не удалась, позиция ждёт в очереди доотправки.
 */
async function pushConfirmed(db: D1Database, runtime: AppRuntimeEnv, sourceSkus: string[], actorEmail: string) {
  if (sourceSkus.length === 0) return { sent: 0, error: null as string | null };
  await markStocksDirty(db, sourceSkus, "остаток подтверждён по ОСВ").catch(() => undefined);

  const state = await readStockSyncState(db);
  if (state.mode === "stopped") {
    return { sent: 0, error: "Выгрузка остатков остановлена — остаток уйдёт, когда её включат." };
  }

  let sent = 0;
  let error: string | null = null;
  for (let start = 0; start < sourceSkus.length; start += PUSH_CHUNK) {
    try {
      const result = await pushStocksForSkus({
        db,
        runtime,
        sourceSkus: sourceSkus.slice(start, start + PUSH_CHUNK),
        actorEmail,
        trigger: "osv_confirm",
        label: "Подтверждение остатка по ОСВ",
      });
      if ("error" in result) {
        error = result.error;
        break;
      }
      sent += result.wildberries.sent + result.ozon.sent + result.yandex.sent;
      error ??= result.failures[0] ?? null;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "Не удалось отправить остаток на площадки.";
      break;
    }
  }
  return { sent, error };
}
