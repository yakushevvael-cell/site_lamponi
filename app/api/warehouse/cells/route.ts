/**
 * Справочник ячеек и раскладка «артикул → ячейка».
 *
 * После переноса из Google-таблицы раскладка ведётся здесь, а в таблице
 * убирается: два источника правды о том, где лежит товар, — это пересорт.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { cellSortOrder } from "@/lib/warehouse-core.mjs";
import { logWarehouseEvent, readCells } from "@/lib/warehouse";

const MAX_PLACEMENTS_PAGE = 300;

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.cells", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const url = new URL(request.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_PLACEMENTS_PAGE, Math.max(10, Math.trunc(limitRaw))) : 100;

  const cells = await readCells(db);
  const like = `%${search.toUpperCase()}%`;
  const placementsQuery = `SELECT cp.id, cp.article, cp.size, c.code AS cellCode, c.sort_order AS sortOrder,
            cp.updated_by AS updatedBy, cp.updated_at AS updatedAt
     FROM cell_placements cp
     JOIN warehouse_cells c ON c.id = cp.cell_id
     ${search ? "WHERE UPPER(cp.article) LIKE ? OR UPPER(c.code) LIKE ?" : ""}
     ORDER BY c.sort_order, c.code, cp.article
     LIMIT ${limit}`;
  const placements = search
    ? await db.prepare(placementsQuery).bind(like, like).all()
    : await db.prepare(placementsQuery).all();
  const total = await db.prepare("SELECT COUNT(*) AS count FROM cell_placements").first<{ count: number }>();

  return Response.json({
    cells,
    placements: placements.results,
    total: Number(total?.count ?? 0),
    canManage: auth.permissions.includes("warehouse.cells"),
  });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.cells");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as {
    action?: unknown;
    id?: unknown;
    code?: unknown;
    zone?: unknown;
    sortOrder?: unknown;
    active?: unknown;
    article?: unknown;
    size?: unknown;
    cell?: unknown;
  } | null;
  const action = String(body?.action ?? "");
  const text = (value: unknown, limit = 100) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

  if (action === "upsert_cell") {
    const code = text(body?.code, 40).toUpperCase();
    if (!code) return Response.json({ error: "Укажите код ячейки." }, { status: 400 });
    const zone = text(body?.zone, 40) || null;
    const sortOrderRaw = Number(body?.sortOrder);
    // Порядок по умолчанию считается из кода: маршрут идёт по складу, а не по алфавиту.
    const sortOrder = Number.isFinite(sortOrderRaw) && sortOrderRaw > 0 ? Math.trunc(sortOrderRaw) : cellSortOrder(code);
    const active = body?.active === false ? 0 : 1;
    await db.prepare(
      `INSERT INTO warehouse_cells (code, zone, sort_order, active, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET zone = excluded.zone, sort_order = excluded.sort_order, active = excluded.active`,
    ).bind(code, zone, sortOrder, active, auth.user.email).run();
    await logWarehouseEvent(db, { kind: "cell_saved", actorEmail: auth.user.email, payload: { code, zone, sortOrder, active: Boolean(active) } });
    return Response.json({ ok: true, cells: await readCells(db) });
  }

  if (action === "delete_cell") {
    const id = Number(body?.id);
    if (!Number.isFinite(id)) return Response.json({ error: "Не указана ячейка." }, { status: 400 });
    const cell = await db.prepare("SELECT code FROM warehouse_cells WHERE id = ?").bind(id).first<{ code: string }>();
    if (!cell) return Response.json({ error: "Ячейка не найдена." }, { status: 404 });
    // Удаление ячейки уносит и привязки к ней: артикулы останутся без адреса,
    // поэтому в ответе честно говорим, сколько их было.
    const affected = await db.prepare("SELECT COUNT(*) AS count FROM cell_placements WHERE cell_id = ?").bind(id).first<{ count: number }>();
    await db.prepare("DELETE FROM warehouse_cells WHERE id = ?").bind(id).run();
    await logWarehouseEvent(db, { kind: "cell_deleted", actorEmail: auth.user.email, payload: { code: cell.code, placements: Number(affected?.count ?? 0) } });
    return Response.json({ ok: true, removedPlacements: Number(affected?.count ?? 0), cells: await readCells(db) });
  }

  if (action === "set_placement") {
    const article = text(body?.article, 80);
    const size = text(body?.size, 40) || null;
    const code = text(body?.cell, 40).toUpperCase();
    if (!article || !code) return Response.json({ error: "Укажите артикул и ячейку." }, { status: 400 });
    let cell = await db.prepare("SELECT id FROM warehouse_cells WHERE UPPER(code) = ?").bind(code).first<{ id: number }>();
    if (!cell) {
      await db.prepare(
        "INSERT INTO warehouse_cells (code, sort_order, active, created_by) VALUES (?, ?, 1, ?) ON CONFLICT(code) DO NOTHING",
      ).bind(code, cellSortOrder(code), auth.user.email).run();
      cell = await db.prepare("SELECT id FROM warehouse_cells WHERE UPPER(code) = ?").bind(code).first<{ id: number }>();
    }
    if (!cell) return Response.json({ error: "Не удалось создать ячейку." }, { status: 500 });
    await db.prepare(
      `INSERT INTO cell_placements (article, size, cell_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(article, COALESCE(size, '')) DO UPDATE SET
         cell_id = excluded.cell_id, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    ).bind(article, size, cell.id, auth.user.email).run();
    await logWarehouseEvent(db, { kind: "placement_saved", article, size, actorEmail: auth.user.email, payload: { cell: code } });
    return Response.json({ ok: true });
  }

  if (action === "delete_placement") {
    const id = Number(body?.id);
    if (!Number.isFinite(id)) return Response.json({ error: "Не указана строка раскладки." }, { status: 400 });
    const row = await db.prepare("SELECT article, size FROM cell_placements WHERE id = ?").bind(id).first<{ article: string; size: string | null }>();
    await db.prepare("DELETE FROM cell_placements WHERE id = ?").bind(id).run();
    if (row) {
      await logWarehouseEvent(db, { kind: "placement_deleted", article: row.article, size: row.size, actorEmail: auth.user.email });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Неизвестное действие." }, { status: 400 });
}
