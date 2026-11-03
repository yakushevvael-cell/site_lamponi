import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { pushStocksForSkus } from "@/lib/stock-push";
import { clearDirtySkus, countDirtySkus, readDirtySkus } from "@/lib/stock-queue";
import {
  nextPendingStockRunAt,
  PENDING_STOCK_BATCH_LIMIT,
  PENDING_STOCK_INTERVAL_MINUTES,
  PENDING_STOCK_POLL_SECONDS,
  summarizePendingMarketplaces,
} from "@/lib/stock-pending-core.mjs";
import { bulkStockSyncScope, pilotFilterSql } from "@/lib/sync-pause";

/**
 * Доотправка остатков по изменившимся позициям.
 *
 * Раньше остаток уезжал на площадки только при часовой выгрузке: заказ,
 * сделанный на Ozon в 14:20, доходил до Wildberries в 15:10 — почти час
 * товара «не было», а продаваться он продолжал. Теперь пересчёт резервов
 * складывает изменившиеся артикулы в очередь (lib/stock-queue), а этот
 * маршрут сразу после загрузки заказов отправляет остаток только по ним.
 *
 * Весь ассортимент не трогается: уходят единицы позиций, лимиты API площадок
 * остаются свободными для полной часовой выгрузки.
 */

const DEFAULT_LIMIT = PENDING_STOCK_BATCH_LIMIT;
const MAX_LIMIT = PENDING_STOCK_BATCH_LIMIT;

type WarehouseSyncRow = {
  marketplaceId: "wildberries" | "ozon" | "yandex";
  syncStatus: "never" | "ok" | "error";
  syncError: string | null;
  lastStockSyncAt: string | null;
};

/** Сколько позиций ждёт доотправки — для индикатора на странице «Остатки». */
export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const checkedAt = new Date();
  const warehouses = await runtime.DB.prepare(
    `SELECT marketplace_id AS marketplaceId,
            sync_status AS syncStatus,
            sync_error AS syncError,
            last_stock_sync_at AS lastStockSyncAt
     FROM marketplace_warehouses
     WHERE remote_active = 1 AND publish_full_stock = 1
       AND marketplace_id IN ('wildberries', 'ozon', 'yandex')
     ORDER BY marketplace_id, name`,
  ).all<WarehouseSyncRow>();
  return Response.json({
    pending: await countDirtySkus(runtime.DB),
    checkedAt: checkedAt.toISOString(),
    nextRunAt: nextPendingStockRunAt(checkedAt.getTime()),
    intervalMinutes: PENDING_STOCK_INTERVAL_MINUTES,
    pollSeconds: PENDING_STOCK_POLL_SECONDS,
    batchLimit: PENDING_STOCK_BATCH_LIMIT,
    marketplaces: summarizePendingMarketplaces(warehouses.results),
  });
}

export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;
  // Доотправку ведёт таймер: в ручном режиме сервис не должен трогать площадки
  // сам, даже «дёшево» и по нескольким позициям.
  const scope = await bulkStockSyncScope(db);
  if (scope.blocked) return scope.blocked;

  const body = await request.json().catch(() => null) as { limit?: unknown } | null;
  const requested = Number(body?.limit);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested))) : DEFAULT_LIMIT;

  const sourceSkus = await readDirtySkus(db, limit, pilotFilterSql(scope.mode));
  if (sourceSkus.length === 0) {
    return Response.json({
      ok: true,
      selected: 0,
      pendingLeft: await countDirtySkus(db),
      skipped: "нет изменившихся позиций, доступных в текущем режиме",
    });
  }

  const result = await pushStocksForSkus({
    db,
    runtime,
    sourceSkus,
    actorEmail: auth.user.email,
    trigger: "orders_sync",
    label: "Доотправка после заказов",
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });

  // Позиции без активного сопоставления отправить некуда — держать их в
  // очереди вечно бессмысленно, они уйдут при полной выгрузке.
  if (result.unmapped.length > 0) await clearDirtySkus(db, result.unmapped).catch(() => undefined);
  // Остальные снимаем с очереди только при полном успехе: иначе следующий
  // запуск повторит отправку, а повтор безопасен — значения абсолютные.
  if (result.ok) await clearDirtySkus(db, sourceSkus).catch(() => undefined);

  return Response.json({
    ...result,
    pendingLeft: await countDirtySkus(db),
  }, { status: result.ok ? 200 : 207 });
}
