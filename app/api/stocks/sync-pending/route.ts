import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { pushStocksForSkus } from "@/lib/stock-push";
import { clearDirtySkus, countDirtySkus, readDirtySkus } from "@/lib/stock-queue";
import { stockSyncBlocked } from "@/lib/sync-pause";

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

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 300;

/** Сколько позиций ждёт доотправки — для индикатора на странице «Остатки». */
export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json({ pending: await countDirtySkus(runtime.DB) });
}

export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;
  const paused = await stockSyncBlocked(db);
  if (paused) return paused;

  const body = await request.json().catch(() => null) as { limit?: unknown } | null;
  const requested = Number(body?.limit);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested))) : DEFAULT_LIMIT;

  const sourceSkus = await readDirtySkus(db, limit);
  if (sourceSkus.length === 0) {
    return Response.json({ ok: true, selected: 0, pendingLeft: 0, skipped: "нет изменившихся позиций" });
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
