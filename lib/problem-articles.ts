/**
 * Проблемные товары: в учёте есть, физически нет.
 *
 * ТЗ, п. 4. Отметка «не найден» уводит остаток артикула в ноль на обеих
 * площадках сразу. Блокировка — это именно нулевой остаток плюс игнорирование
 * артикула при загрузке ОСВ (признак manual_zero у товара уже так и работает),
 * а не резерв и не запрет отгрузки того, что уже заказано.
 *
 * Снятие — только вручную и только с комментарием: скана при размещении в
 * ячейку нет, а рост количества в ОСВ ненадёжный сигнал, поэтому автоснятия
 * здесь нет сознательно.
 */
import { markStocksDirty } from "@/lib/stock-queue";
import { pushStocksForSkus } from "@/lib/stock-push";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { eventStatement, logWarehouseEvent } from "@/lib/warehouse";

export type ProblemArticle = {
  id: number;
  article: string;
  size: string | null;
  productSku: string | null;
  state: "blocked" | "released";
  status: "searching" | "requested" | "cancelling" | "arrived";
  failedOrderCount: number;
  taskId: number | null;
  taskNumber: string | null;
  marketplaceId: string | null;
  externalOrderId: string | null;
  shipmentDeadline: string | null;
  blockedBy: string | null;
  blockedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  comment: string | null;
};

const PROBLEM_COLUMNS = `
  id, article, size, product_sku AS productSku, state, status,
  osv_qty_at_block AS osvQtyAtBlock, failed_order_count AS failedOrderCount,
  task_id AS taskId, task_number AS taskNumber, marketplace_id AS marketplaceId,
  external_order_id AS externalOrderId, shipment_deadline AS shipmentDeadline,
  blocked_by AS blockedBy, blocked_at AS blockedAt, released_by AS releasedBy,
  released_at AS releasedAt, comment
`;

/** Позиции 1С, соответствующие артикулу. Размер может быть не указан — тогда все. */
async function readProductSkus(db: D1Database, article: string, size: string | null) {
  const rows = size
    ? await db.prepare(
      "SELECT source_sku AS sourceSku, current_physical_qty AS qty FROM products WHERE article = ? AND (size = ? OR size IS NULL)",
    ).bind(article, size).all<{ sourceSku: string; qty: number }>()
    : await db.prepare(
      "SELECT source_sku AS sourceSku, current_physical_qty AS qty FROM products WHERE article = ?",
    ).bind(article).all<{ sourceSku: string; qty: number }>();
  return rows.results;
}

export type BlockInput = {
  article: string;
  size?: string | null;
  productSku?: string | null;
  taskId?: number | null;
  taskNumber?: string | null;
  marketplaceId?: string | null;
  externalOrderId?: string | null;
  shipmentDeadline?: string | null;
  actorEmail: string;
  comment?: string | null;
};

/**
 * Блокирует артикул и уводит его остаток в ноль.
 *
 * Отправка нулей на площадки делается сразу, но её неудача не отменяет
 * блокировку: позиция остаётся в очереди доотправки (stock_dirty_skus) и
 * уедет следующей синхронизацией. Иначе сбой сети оставил бы товар в продаже.
 */
export async function blockArticle(db: D1Database, runtime: AppRuntimeEnv, input: BlockInput) {
  const article = input.article.trim();
  if (!article) return { ok: false as const, error: "Не указан артикул." };
  const size = input.size?.trim() ? input.size.trim() : null;

  const products = input.productSku
    ? await db.prepare(
      "SELECT source_sku AS sourceSku, current_physical_qty AS qty FROM products WHERE source_sku = ?",
    ).bind(input.productSku).all<{ sourceSku: string; qty: number }>().then((rows) => rows.results)
    : await readProductSkus(db, article, size);
  const sourceSkus = products.map((row) => row.sourceSku);
  const osvQty = products.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);

  const existing = await db.prepare(
    `SELECT ${PROBLEM_COLUMNS} FROM problem_articles
     WHERE state = 'blocked' AND article = ? AND COALESCE(size, '') = COALESCE(?, '')`,
  ).bind(article, size).first<ProblemArticle>();

  if (existing) {
    // Тот же артикул не нашёлся второй раз — это не новая блокировка, а ещё
    // один сорванный заказ. История повторов и есть сигнал системной ошибки.
    await db.batch([
      db.prepare(
        `UPDATE problem_articles
         SET failed_order_count = failed_order_count + 1,
             task_id = COALESCE(?, task_id),
             task_number = COALESCE(?, task_number),
             marketplace_id = COALESCE(?, marketplace_id),
             external_order_id = COALESCE(?, external_order_id),
             shipment_deadline = COALESCE(?, shipment_deadline)
         WHERE id = ?`,
      ).bind(
        input.taskId ?? null,
        input.taskNumber ?? null,
        input.marketplaceId ?? null,
        input.externalOrderId ?? null,
        input.shipmentDeadline ?? null,
        existing.id,
      ),
      db.prepare(
        `INSERT INTO problem_article_log (article, size, action, actor_email, comment, task_number)
         VALUES (?, ?, 'repeat', ?, ?, ?)`,
      ).bind(article, size, input.actorEmail, input.comment ?? null, input.taskNumber ?? null),
      eventStatement(db, {
        kind: "problem_repeat",
        taskId: input.taskId ?? null,
        taskNumber: input.taskNumber ?? null,
        marketplaceId: input.marketplaceId ?? null,
        externalOrderId: input.externalOrderId ?? null,
        article,
        size,
        actorEmail: input.actorEmail,
        payload: { failedOrderCount: existing.failedOrderCount + 1 },
      }),
    ]);
  } else {
    await db.batch([
      db.prepare(
        `INSERT INTO problem_articles
           (article, size, product_sku, state, status, osv_qty_at_block, failed_order_count,
            task_id, task_number, marketplace_id, external_order_id, shipment_deadline, blocked_by, comment)
         VALUES (?, ?, ?, 'blocked', 'searching', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        article,
        size,
        sourceSkus[0] ?? null,
        osvQty,
        input.taskId ?? null,
        input.taskNumber ?? null,
        input.marketplaceId ?? null,
        input.externalOrderId ?? null,
        input.shipmentDeadline ?? null,
        input.actorEmail,
        input.comment ?? null,
      ),
      db.prepare(
        `INSERT INTO problem_article_log (article, size, action, actor_email, comment, task_number)
         VALUES (?, ?, 'blocked', ?, ?, ?)`,
      ).bind(article, size, input.actorEmail, input.comment ?? null, input.taskNumber ?? null),
      eventStatement(db, {
        kind: "problem_blocked",
        taskId: input.taskId ?? null,
        taskNumber: input.taskNumber ?? null,
        marketplaceId: input.marketplaceId ?? null,
        externalOrderId: input.externalOrderId ?? null,
        article,
        size,
        actorEmail: input.actorEmail,
        payload: { osvQty, skus: sourceSkus },
      }),
    ]);
  }

  const zeroed = await applyManualZero(db, sourceSkus, true);
  const pushed = await pushZeros(db, runtime, sourceSkus, input.actorEmail);

  return {
    ok: true as const,
    article,
    size,
    repeated: Boolean(existing),
    skus: sourceSkus,
    zeroed,
    pushed,
    // Артикул без сопоставления с 1С нельзя обнулить — об этом надо сказать вслух.
    warning: sourceSkus.length === 0 ? "Артикул не найден в остатках 1С — остаток обнулить не удалось, проверьте вручную." : null,
  };
}

export type ReleaseInput = {
  id: number;
  actorEmail: string;
  comment: string;
};

/** Снятие блокировки. Комментарий обязателен — иначе разбор потом не прочитать. */
export async function releaseArticle(db: D1Database, runtime: AppRuntimeEnv, input: ReleaseInput) {
  const comment = input.comment.trim();
  if (comment.length < 3) return { ok: false as const, error: "Напишите, что выяснилось: комментарий обязателен." };

  const row = await db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problem_articles WHERE id = ?`)
    .bind(input.id).first<ProblemArticle>();
  if (!row) return { ok: false as const, error: "Запись не найдена." };
  if (row.state !== "blocked") return { ok: false as const, error: "Блокировка уже снята." };

  const products = await readProductSkus(db, row.article, row.size);
  const sourceSkus = products.map((item) => item.sourceSku);

  await db.batch([
    db.prepare(
      `UPDATE problem_articles
       SET state = 'released', released_by = ?, released_at = CURRENT_TIMESTAMP, comment = ?
       WHERE id = ?`,
    ).bind(input.actorEmail, comment, input.id),
    db.prepare(
      `INSERT INTO problem_article_log (article, size, action, actor_email, comment, task_number)
       VALUES (?, ?, 'released', ?, ?, ?)`,
    ).bind(row.article, row.size, input.actorEmail, comment, row.taskNumber),
    eventStatement(db, {
      kind: "problem_released",
      taskId: row.taskId,
      taskNumber: row.taskNumber,
      article: row.article,
      size: row.size,
      actorEmail: input.actorEmail,
      payload: { comment, failedOrderCount: row.failedOrderCount },
    }),
  ]);

  const restored = await applyManualZero(db, sourceSkus, false);
  // Положительный остаток сам не уедет: он посчитается от свежей ОСВ при
  // следующей выгрузке, поэтому позиции просто ставятся в очередь.
  if (sourceSkus.length > 0) await markStocksDirty(db, sourceSkus, "снята блокировка проблемного товара").catch(() => undefined);

  return { ok: true as const, restored, skus: sourceSkus };
}

async function applyManualZero(db: D1Database, sourceSkus: string[], zero: boolean) {
  if (sourceSkus.length === 0) return 0;
  let changed = 0;
  for (let start = 0; start < sourceSkus.length; start += 100) {
    const chunk = sourceSkus.slice(start, start + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db.prepare(
      zero
        ? `UPDATE products SET manual_zero = 1, manual_zero_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE source_sku IN (${placeholders})`
        : `UPDATE products SET manual_zero = 0, manual_zero_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE source_sku IN (${placeholders})`,
    ).bind(...chunk).run();
    changed += Number(result.meta.changes ?? 0);
  }
  return changed;
}

async function pushZeros(db: D1Database, runtime: AppRuntimeEnv, sourceSkus: string[], actorEmail: string) {
  if (sourceSkus.length === 0) return { sent: 0, error: null as string | null };
  await markStocksDirty(db, sourceSkus, "проблемный товар: остаток обнулён").catch(() => undefined);
  try {
    const result = await pushStocksForSkus({
      db,
      runtime,
      sourceSkus,
      actorEmail,
      trigger: "manual_zero",
      label: "Блокировка проблемного товара",
    });
    if ("error" in result) return { sent: 0, error: result.error };
    return { sent: result.wildberries.sent + result.ozon.sent, error: result.failures[0] ?? null };
  } catch (error) {
    return { sent: 0, error: error instanceof Error ? error.message : "Не удалось отправить нули на площадки." };
  }
}

export async function readProblemArticles(db: D1Database, state: "blocked" | "released" | "all" = "blocked") {
  const where = state === "all" ? "" : "WHERE state = ?";
  const statement = db.prepare(
    `SELECT ${PROBLEM_COLUMNS} FROM problem_articles ${where} ORDER BY blocked_at DESC LIMIT 500`,
  );
  const rows = state === "all" ? await statement.all<ProblemArticle>() : await statement.bind(state).all<ProblemArticle>();
  return rows.results;
}

export async function countBlockedArticles(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM problem_articles WHERE state = 'blocked'")
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** Смена статуса разбора: ищем / запрошено на производстве / отменяем. */
export async function setProblemStatus(
  db: D1Database,
  input: { id: number; status: ProblemArticle["status"]; actorEmail: string },
) {
  const result = await db.prepare(
    "UPDATE problem_articles SET status = ? WHERE id = ? AND state = 'blocked'",
  ).bind(input.status, input.id).run();
  if (!result.meta.changes) return { ok: false as const, error: "Запись не найдена или блокировка снята." };
  await logWarehouseEvent(db, {
    kind: "problem_status_changed",
    actorEmail: input.actorEmail,
    payload: { id: input.id, status: input.status },
  });
  return { ok: true as const };
}
