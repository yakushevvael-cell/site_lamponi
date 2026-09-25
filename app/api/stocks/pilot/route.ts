import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { markStocksDirty } from "@/lib/stock-queue";

/**
 * Пилотный список: позиции, которым разрешена автоматическая выгрузка.
 *
 * Отдавать автоматике сразу весь каталог рискованно — ошибку видно уже на
 * площадке. Здесь человек набирает несколько артикулов, включает пилотный
 * режим и смотрит, как сервис ведёт их сам: считает остаток, реагирует на
 * заказы, доносит числа до кабинета. Убедился — расширяет список или
 * переключается на автоматический режим.
 *
 * Маршрут ничего не отправляет на площадки, поэтому режим выгрузки его не
 * ограничивает: набирать список нужно как раз до включения пилота.
 */

const MAX_SELECTION = 200;

export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as { action?: unknown; sourceSkus?: unknown } | null;
  const action = body?.action;
  if (action !== "add" && action !== "remove" && action !== "clear") {
    return Response.json({ error: "Неизвестное действие. Ожидается add, remove или clear." }, { status: 400 });
  }

  if (action === "clear") {
    await db.prepare("UPDATE products SET pilot = 0, updated_at = CURRENT_TIMESTAMP WHERE pilot = 1").run();
    return Response.json({ ok: true, action, pilotCount: 0 });
  }

  const sourceSkus = Array.isArray(body?.sourceSkus)
    ? [...new Set((body.sourceSkus as unknown[])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()))]
    : [];
  if (sourceSkus.length === 0) return Response.json({ error: "Не выбрано ни одной позиции." }, { status: 400 });
  if (sourceSkus.length > MAX_SELECTION) {
    return Response.json({ error: `За один раз можно изменить не больше ${MAX_SELECTION} позиций.` }, { status: 400 });
  }

  const placeholders = sourceSkus.map(() => "?").join(", ");
  const existing = await db.prepare(
    `SELECT source_sku AS sourceSku FROM products WHERE source_sku IN (${placeholders})`,
  ).bind(...sourceSkus).all<{ sourceSku: string }>();
  if (existing.results.length !== sourceSkus.length) {
    return Response.json({ error: "Часть выбранных позиций не найдена." }, { status: 400 });
  }

  await db.prepare(
    `UPDATE products SET pilot = ?, updated_at = CURRENT_TIMESTAMP WHERE source_sku IN (${placeholders})`,
  ).bind(action === "add" ? 1 : 0, ...sourceSkus).run();

  // Добавленная в пилот позиция должна уехать при ближайшей доотправке, а не
  // ждать часовой выгрузки: иначе человек включит пилот и полчаса не поймёт,
  // работает ли он вообще.
  if (action === "add") await markStocksDirty(db, sourceSkus, "позиция добавлена в пилот").catch(() => undefined);

  const total = await db.prepare("SELECT COUNT(*) AS count FROM products WHERE pilot = 1").first<{ count: number }>();
  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES (NULL, 'outbound', 'stocks', 'success', ?, ?)`,
  ).bind(
    sourceSkus.length,
    `${action === "add" ? "Добавлено в пилот" : "Убрано из пилота"}: ${sourceSkus.length} позиций (${auth.user.email})`,
  ).run().catch(() => undefined);

  return Response.json({ ok: true, action, changed: sourceSkus.length, pilotCount: Number(total?.count ?? 0) });
}
