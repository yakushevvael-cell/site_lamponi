/**
 * Ключ обмена с 1С и состояние обмена — для страницы «Подключения».
 *
 * Управляет только владелец. Ключ возвращается один раз, в ответе на выпуск:
 * в базе лежит лишь его хеш, показать его повторно невозможно.
 */
import { authorizeApi } from "@/lib/app-auth";
import { issueKey, readOnecStatus, revokeKeys } from "@/lib/onec";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json(await readOnecStatus(runtime.DB));
}

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const token = await issueKey(runtime.DB, auth.user.email);
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  await revokeKeys(runtime.DB, auth.user.email);
  return Response.json({ ok: true });
}
