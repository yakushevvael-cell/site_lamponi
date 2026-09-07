import { getMarketplaceCredentials } from "@/lib/credentials";
import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { getWildberriesWarehouses, WildberriesApiError } from "@/lib/wildberries";

const MARKETPLACE_ID = "wildberries";

async function recordFailure(db: D1Database, message: string) {
  await db.batch([
    db.prepare(
      `INSERT INTO marketplaces (id, name, enabled, connection_status)
       VALUES (?, ?, 0, 'error')
       ON CONFLICT(id) DO UPDATE SET connection_status = 'error'`,
    ).bind(MARKETPLACE_ID, "Wildberries"),
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
  const token = credentials.WB_API_TOKEN;
  // ТЗ, п. 5: кнопка и список складов остаются видимыми, показываем понятный текст.
  if (!token) return Response.json({ error: "Добавьте API-ключ для обновления списка складов." }, { status: 400 });

  try {
    await runtime.DB.prepare(
      `INSERT INTO marketplaces (id, name, enabled, connection_status)
       VALUES (?, ?, 0, 'awaiting_keys')
       ON CONFLICT(id) DO NOTHING`,
    ).bind(MARKETPLACE_ID, "Wildberries").run();

    const warehouses = await getWildberriesWarehouses(token);
    if (warehouses.length === 0) throw new WildberriesApiError(422, "Wildberries не вернул склады продавца.");
    const checkedAt = new Date().toISOString();
    const fbsWarehouses = warehouses.filter((warehouse) => !warehouse.isDeleting && warehouse.deliveryType === 1);

    const statements = [
      runtime.DB.prepare(
        `UPDATE marketplaces
         SET enabled = 1, connection_status = 'connected', last_sync_at = ?
         WHERE id = ?`,
      ).bind(checkedAt, MARKETPLACE_ID),
      ...warehouses.map((warehouse) => {
        const active = !warehouse.isDeleting && warehouse.deliveryType === 1;
        const status = warehouse.isDeleting ? "deleting" : warehouse.deliveryType === 1 ? "fbs" : `delivery_type_${warehouse.deliveryType ?? "unknown"}`;
        return runtime.DB!.prepare(
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
        ).bind(MARKETPLACE_ID, String(warehouse.id), warehouse.name, active ? 1 : 0, status, checkedAt);
      }),
      runtime.DB.prepare(
        `UPDATE marketplace_warehouses
         SET remote_active = 0, publish_full_stock = 0, remote_status = 'not_returned_by_api', last_checked_at = ?
         WHERE marketplace_id = ? AND external_id NOT IN (${warehouses.map(() => "?").join(",")})`,
      ).bind(checkedAt, MARKETPLACE_ID, ...warehouses.map((warehouse) => String(warehouse.id))),
      runtime.DB.prepare(
        `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
         VALUES (?, 'inbound', 'warehouses', 'success', ?, ?)`,
      ).bind(MARKETPLACE_ID, fbsWarehouses.length, "Соединение проверено, FBS-склады получены"),
    ];

    await runtime.DB.batch(statements);

    return Response.json({
      ok: true,
      checkedAt,
      warehouseCount: fbsWarehouses.length,
      warehouses: fbsWarehouses.map((warehouse) => ({
        id: String(warehouse.id),
        name: warehouse.name,
        isProcessing: Boolean(warehouse.isProcessing),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось проверить Wildberries.";
    try {
      await recordFailure(runtime.DB, message);
    } catch {
      // Ответ о сбое API важнее ошибки записи журнала.
    }

    const status = error instanceof WildberriesApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
