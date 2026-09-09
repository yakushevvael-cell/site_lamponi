import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { pushStocksForSkus } from "@/lib/stock-push";
import { clearDirtySkus } from "@/lib/stock-queue";
import { stockSyncBlocked } from "@/lib/sync-pause";

/**
 * Выборочная синхронизация: человек отметил галочками несколько позиций.
 *
 * Вся работа — в lib/stock-push: тот же код отправляет остатки и при
 * автоматической доотправке после загрузки заказов. Здесь только проверка
 * прав, ограничение размера выбора и перевод результата в ответ HTTP.
 */

const MAX_SELECTION = 50;

export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;
  const paused = await stockSyncBlocked(db);
  if (paused) return paused;

  const body = await request.json().catch(() => null) as { sourceSkus?: unknown } | null;
  const sourceSkus = Array.isArray(body?.sourceSkus)
    ? [...new Set((body.sourceSkus as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))]
    : [];
  if (sourceSkus.length === 0) return Response.json({ error: "Не выбрано ни одной позиции." }, { status: 400 });
  if (sourceSkus.length > MAX_SELECTION) {
    return Response.json({ error: `За один раз можно синхронизировать не больше ${MAX_SELECTION} позиций.` }, { status: 400 });
  }

  const result = await pushStocksForSkus({
    db,
    runtime,
    sourceSkus,
    actorEmail: auth.user.email,
    trigger: "manual",
    label: "Выборочная синхронизация",
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });

  // Отправленные вручную позиции больше не ждут автоматической доотправки.
  if (result.ok) await clearDirtySkus(db, sourceSkus).catch(() => undefined);

  return Response.json(result, { status: result.ok ? 200 : 207 });
}
