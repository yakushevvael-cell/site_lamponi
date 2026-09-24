/**
 * Склейка позиций, которые отличаются только написанием размера.
 *
 * До того как ОСВ стала приводить размер к одному виду (canonicalOsvSize),
 * «17» и «17,0» одного артикула сохранялись двумя позициями. Остаток делился
 * между ними, Wildberries сопоставлялся с одной, Ozon — с другой, и на каждую
 * площадку уходила только часть остатка. Новая ОСВ таких пар уже не создаёт,
 * а эта функция один раз сводит накопленные: всё, что ссылалось на старую
 * позицию, переезжает на позицию с каноническим размером.
 *
 * Идемпотентна: когда склеивать нечего, ничего не пишет.
 */
import { canonicalOsvSize, variantKey } from "./osv-parse-core.mjs";

/** Таблицы, где позиция упоминается просто ссылкой — её достаточно переписать. */
const PLAIN_REFERENCES = ["sku_mappings", "order_items", "stock_reservations", "stock_sync_log", "pick_task_items"];

/**
 * @param {{ prepare: Function, batch: Function }} db адаптер с интерфейсом D1
 * @returns {Promise<Array<{ target: string, merged: string[] }>>}
 */
export async function mergeSizeSpellings(db) {
  const rows = (await db.prepare(
    `SELECT source_sku AS sourceSku, article, size,
            current_physical_qty AS qty, units_per_item AS unitsPerItem,
            latest_upload_id AS latestUploadId, safety_stock AS safetyStock,
            manual_zero AS manualZero, manual_zero_at AS manualZeroAt
     FROM products
     WHERE size IS NOT NULL`,
  ).all()).results;

  /** @type {Map<string, typeof rows>} */
  const groups = new Map();
  for (const row of rows) {
    // Позиции заводит только ОСВ, и ключ у них всегда «артикул::размер».
    // Всё, что устроено иначе, не наше — не трогаем.
    if (row.sourceSku !== variantKey(row.article, row.size)) continue;
    const target = variantKey(row.article, canonicalOsvSize(row.size));
    const group = groups.get(target) ?? [];
    group.push(row);
    groups.set(target, group);
  }

  const report = [];
  for (const [target, group] of groups) {
    const sources = group.filter((row) => row.sourceSku !== target).map((row) => row.sourceSku);
    if (sources.length === 0) continue;
    const { article, size } = group[0];
    const canonical = canonicalOsvSize(size);

    const statements = [
      db.prepare(
        `INSERT INTO products (source_sku, article, size, current_physical_qty, units_per_item,
                               latest_upload_id, safety_stock, manual_zero, manual_zero_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(source_sku) DO UPDATE SET
           size = excluded.size,
           current_physical_qty = excluded.current_physical_qty,
           units_per_item = excluded.units_per_item,
           latest_upload_id = excluded.latest_upload_id,
           safety_stock = excluded.safety_stock,
           manual_zero = excluded.manual_zero,
           manual_zero_at = excluded.manual_zero_at,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(
        target,
        article,
        canonical,
        // Позиции, пропавшие из последней ОСВ, уже обнулены, так что сумма —
        // это ровно остаток по размеру, в каком бы написании он ни пришёл.
        group.reduce((sum, row) => sum + Number(row.qty), 0),
        Math.max(...group.map((row) => Number(row.unitsPerItem) || 1)),
        Math.max(...group.map((row) => Number(row.latestUploadId) || 0)) || null,
        // Защитный остаток и ручное обнуление — это ограничения; при склейке
        // выигрывает более строгое.
        Math.max(...group.map((row) => Number(row.safetyStock) || 0)),
        group.some((row) => Boolean(row.manualZero)) ? 1 : 0,
        group.map((row) => row.manualZeroAt).filter(Boolean).sort().at(-1) ?? null,
      ),
    ];

    for (const source of sources) {
      // Снимок одной ОСВ по двум написаниям — один снимок с суммой.
      statements.push(
        db.prepare(
          `UPDATE stock_snapshots
           SET physical_qty = physical_qty + (
             SELECT other.physical_qty FROM stock_snapshots other
             WHERE other.upload_id = stock_snapshots.upload_id AND other.product_sku = ?)
           WHERE product_sku = ?
             AND upload_id IN (SELECT upload_id FROM stock_snapshots WHERE product_sku = ?)`,
        ).bind(source, target, source),
        db.prepare(
          `DELETE FROM stock_snapshots
           WHERE product_sku = ?
             AND upload_id IN (SELECT upload_id FROM stock_snapshots WHERE product_sku = ?)`,
        ).bind(source, target),
        db.prepare("UPDATE stock_snapshots SET product_sku = ? WHERE product_sku = ?").bind(target, source),
        ...PLAIN_REFERENCES.map((table) =>
          db.prepare(`UPDATE ${table} SET product_sku = ? WHERE product_sku = ?`).bind(target, source)),
        db.prepare("UPDATE problem_articles SET product_sku = ?, size = ? WHERE product_sku = ?").bind(target, canonical, source),
        db.prepare("DELETE FROM stock_dirty_skus WHERE product_sku = ?").bind(source),
        db.prepare("DELETE FROM products WHERE source_sku = ?").bind(source),
      );
    }

    // Остаток по размеру изменился — площадкам нужно отправить новый.
    statements.push(
      db.prepare(
        `INSERT INTO stock_dirty_skus (product_sku, reason, marked_at)
         VALUES (?, 'size_merge', CURRENT_TIMESTAMP)
         ON CONFLICT(product_sku) DO UPDATE SET reason = excluded.reason, marked_at = excluded.marked_at`,
      ).bind(target),
    );

    await db.batch(statements);
    report.push({ target, merged: sources });
  }
  return report;
}
