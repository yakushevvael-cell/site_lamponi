/**
 * Очередь позиций, ждущих доотправки остатка на площадки.
 *
 * Зачем: полная выгрузка идёт раз в час, и заказ, сделанный сразу после неё,
 * почти час не отражался на других площадках — можно было продать то, чего
 * физически уже нет. Теперь пересчёт резервов складывает сюда артикулы, у
 * которых остаток изменился, а фоновая задача сразу после загрузки заказов
 * отправляет остаток только по ним. Весь ассортимент при этом не трогается,
 * лимиты API площадок не расходуются впустую.
 *
 * Очередь намеренно устроена «по артикулу, без деталей»: что именно поменялось,
 * знать не нужно — отправляется всегда абсолютное значение, посчитанное заново.
 */

const MARK_BATCH = 100;

/** Ставит позиции в очередь на доотправку. Повторная пометка просто обновляет время. */
export async function markStocksDirty(db: D1Database, sourceSkus: Iterable<string>, reason: string) {
  const unique = [...new Set([...sourceSkus].filter((sku) => typeof sku === "string" && sku.length > 0))];
  if (unique.length === 0) return 0;
  const statements = unique.map((sku) => db.prepare(
    `INSERT INTO stock_dirty_skus (product_sku, reason, marked_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(product_sku) DO UPDATE SET reason = excluded.reason, marked_at = CURRENT_TIMESTAMP`,
  ).bind(sku, reason.slice(0, 200)));
  try {
    for (let start = 0; start < statements.length; start += MARK_BATCH) {
      await db.batch(statements.slice(start, start + MARK_BATCH));
    }
  } catch {
    // Очередь — ускоритель, а не единственный путь: её сбой не должен ронять
    // пересчёт резервов. Позиция уедет при ближайшей часовой выгрузке.
    return 0;
  }
  return unique.length;
}

/** Сколько позиций ждёт доотправки. */
export async function countDirtySkus(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM stock_dirty_skus").first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** Берёт из очереди самые давние позиции: они ждут дольше всех. */
export async function readDirtySkus(db: D1Database, limit: number) {
  const rows = await db.prepare(
    `SELECT product_sku AS productSku
     FROM stock_dirty_skus
     ORDER BY marked_at, product_sku
     LIMIT ?`,
  ).bind(Math.max(1, Math.min(1000, Math.trunc(limit)))).all<{ productSku: string }>();
  return rows.results.map((row) => row.productSku);
}

/** Убирает разобранные позиции. Вызывается только после успешной отправки. */
export async function clearDirtySkus(db: D1Database, sourceSkus: string[]) {
  if (sourceSkus.length === 0) return;
  const statements = sourceSkus.map((sku) => db.prepare("DELETE FROM stock_dirty_skus WHERE product_sku = ?").bind(sku));
  for (let start = 0; start < statements.length; start += MARK_BATCH) {
    await db.batch(statements.slice(start, start + MARK_BATCH));
  }
}

/** Полная очистка: после полной выгрузки на площадках и так актуальные числа. */
export async function clearAllDirtySkus(db: D1Database) {
  await db.prepare("DELETE FROM stock_dirty_skus").run().catch(() => undefined);
}
