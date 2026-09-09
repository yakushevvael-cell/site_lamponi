import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { normalizeUnitsPerItem } from "@/lib/osv-units";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { markStocksDirty } from "@/lib/stock-queue";

/**
 * Кратность позиции: сколько единиц ОСВ составляют один товар на площадке.
 *
 * Серьги в 1С учитываются штуками, а продаются парой — для них коэффициент 2.
 * Проставлять его по одному товару бессмысленно: артикулов тысячи. Поэтому
 * маршрут умеет два режима — по списку отмеченных позиций и сразу по всем,
 * что нашлись по строке поиска (например, все артикулы, начинающиеся на «С»).
 *
 * Изменение кратности меняет доступный остаток, поэтому затронутые позиции
 * сразу ставятся в очередь доотправки — площадки получат новые числа при
 * ближайшей синхронизации, а не через час.
 */

const WRITE_BATCH = 100;
const MAX_TARGETS = 5000;

type Body = { unitsPerItem?: unknown; sourceSkus?: unknown; query?: unknown; scope?: unknown };

export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as Body | null;
  const unitsPerItem = normalizeUnitsPerItem(body?.unitsPerItem);
  if (unitsPerItem === null) {
    return Response.json({ error: "Кратность должна быть целым числом от 1 до 100." }, { status: 400 });
  }

  const scope = body?.scope === "search" ? "search" : "selected";
  let targets: string[] = [];

  if (scope === "selected") {
    targets = Array.isArray(body?.sourceSkus)
      ? [...new Set((body.sourceSkus as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))]
      : [];
    if (targets.length === 0) return Response.json({ error: "Не выбрано ни одной позиции." }, { status: 400 });
  } else {
    // Тот же фильтр, что и в списке остатков, — человек видит ровно то, что меняет.
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    const rows = await db.prepare(
      `SELECT source_sku AS sourceSku
       FROM products p
       WHERE p.article <> ''
         AND (? = '' OR p.article LIKE '%' || ? || '%' OR COALESCE(p.size, '') LIKE '%' || ? || '%')
       ORDER BY p.article, p.size
       LIMIT ?`,
    ).bind(query, query, query, MAX_TARGETS).all<{ sourceSku: string }>();
    targets = rows.results.map((row) => row.sourceSku);
    if (targets.length === 0) return Response.json({ error: "По этому поиску позиций не нашлось." }, { status: 400 });
  }

  if (targets.length > MAX_TARGETS) {
    return Response.json({ error: `За один раз можно изменить не больше ${MAX_TARGETS} позиций.` }, { status: 400 });
  }

  const statements = targets.map((sku) => db.prepare(
    "UPDATE products SET units_per_item = ?, updated_at = CURRENT_TIMESTAMP WHERE source_sku = ?",
  ).bind(unitsPerItem, sku));
  for (let start = 0; start < statements.length; start += WRITE_BATCH) {
    await db.batch(statements.slice(start, start + WRITE_BATCH));
  }

  await markStocksDirty(db, targets, `изменена кратность позиции: ${unitsPerItem}`);
  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES (NULL, 'outbound', 'stocks', 'success', ?, ?)`,
  ).bind(targets.length, `Кратность ${unitsPerItem} установлена для ${targets.length} позиций (${auth.user.email})`).run().catch(() => undefined);

  return Response.json({ ok: true, updated: targets.length, unitsPerItem });
}
