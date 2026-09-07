import { getMarketplaceCredentials } from "@/lib/credentials";
import { authorizeApi } from "@/lib/app-auth";
import { getOzonWarehouses, OzonApiError } from "@/lib/ozon";
import { getRuntimeEnv } from "@/lib/runtime-env";

const MARKETPLACE_ID = "ozon";

async function recordFailure(db: D1Database, message: string) {
  await db.batch([
    db.prepare(
      `INSERT INTO marketplaces (id, name, enabled, connection_status)
       VALUES (?, ?, 0, 'error')
       ON CONFLICT(id) DO UPDATE SET connection_status = 'error'`,
    ).bind(MARKETPLACE_ID, "Ozon"),
    db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'inbound', 'warehouses', 'error', 0, ?)`,
    ).bind(MARKETPLACE_ID, message.slice(0, 500)),
  ]);
}

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const credentials = await getMarketplaceCredentials(runtime.DB, runtime, MARKETPLACE_ID);
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;
  if (!clientId || !apiKey) {
    // ТЗ, п. 5: кнопка и список складов остаются видимыми, показываем понятный текст.
    return Response.json({ error: "Добавьте API-ключ для обновления списка складов." }, { status: 400 });
  }

  try {
    const warehouses = await getOzonWarehouses(clientId, apiKey);
    if (warehouses.length === 0) throw new OzonApiError(422, "Ozon не вернул ни одного FBS/rFBS-склада.");
    const activeWarehouses = warehouses.filter((warehouse) => warehouse.active);
    const checkedAt = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO marketplaces (id, name, enabled, connection_status, last_sync_at)
         VALUES (?, ?, 1, 'connected', ?)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, connection_status = 'connected', last_sync_at = excluded.last_sync_at`,
      ).bind(MARKETPLACE_ID, "Ozon", checkedAt),
      ...warehouses.map((warehouse) => runtime.DB!.prepare(
        `INSERT INTO marketplace_warehouses
           (marketplace_id, external_id, name, remote_active, remote_status, publish_full_stock, last_checked_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(marketplace_id, external_id) DO UPDATE SET
           name = excluded.name,
           remote_active = excluded.remote_active,
           remote_status = excluded.remote_status,
           last_checked_at = excluded.last_checked_at,
           -- Ранее выбранные настройки действующих складов сохраняются;
           -- склад, ставший архивным, автоматически теряет право на выгрузку (ТЗ, п. 5).
           publish_full_stock = CASE
             WHEN excluded.remote_active = 1 THEN marketplace_warehouses.publish_full_stock
             ELSE 0
           END`,
      ).bind(MARKETPLACE_ID, String(warehouse.id), warehouse.name, warehouse.active ? 1 : 0, warehouse.status || null, checkedAt)),
      runtime.DB.prepare(
        `UPDATE marketplace_warehouses
         SET remote_active = 0, publish_full_stock = 0, remote_status = 'not_returned_by_api', last_checked_at = ?
         WHERE marketplace_id = ? AND external_id NOT IN (${warehouses.map(() => "?").join(",")})`,
      ).bind(checkedAt, MARKETPLACE_ID, ...warehouses.map((warehouse) => String(warehouse.id))),
      runtime.DB.prepare(
        `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
         VALUES (?, 'inbound', 'warehouses', 'success', ?, ?)`,
      ).bind(MARKETPLACE_ID, activeWarehouses.length, `Получено складов: ${warehouses.length}, активных: ${activeWarehouses.length}`),
    ]);

    return Response.json({
      ok: true,
      checkedAt,
      warehouseCount: warehouses.length,
      activeWarehouseCount: activeWarehouses.length,
      warehouses: warehouses.map((warehouse) => ({
        id: String(warehouse.id),
        name: warehouse.name,
        type: warehouse.isRfbs ? "rFBS" : "FBS",
        status: warehouse.status,
        active: warehouse.active,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось проверить Ozon.";
    await recordFailure(runtime.DB, message).catch(() => undefined);
    const status = error instanceof OzonApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
