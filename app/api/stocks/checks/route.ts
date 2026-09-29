import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { runDueRemoteChecks } from "@/lib/stock-checks";

/**
 * Проверка площадок, назначенная через 10 минут после корректировки остатка.
 *
 * Запускает таймер lamponi-stock-checks (scripts/sync-task.mjs checks) каждые
 * 2 минуты. Площадкам ничего не отправляется — только чтение, поэтому
 * стоп-кран выгрузки здесь не действует.
 */
export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const result = await runDueRemoteChecks(runtime.DB, runtime);
  return Response.json({ ok: result.failures.length === 0, ...result });
}
