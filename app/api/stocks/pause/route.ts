import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readStockSyncPause, setStockSyncPause } from "@/lib/sync-pause";

/** Текущее состояние выключателя — читать может любой вошедший. */
export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json(await readStockSyncPause(runtime.DB));
}

/** Включение и снятие паузы. */
export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { paused?: unknown; reason?: unknown } | null;
  if (typeof body?.paused !== "boolean") return Response.json({ error: "Укажите, включить паузу или снять." }, { status: 400 });
  const reason = typeof body?.reason === "string" ? body.reason : null;

  const state = await setStockSyncPause(runtime.DB, body.paused, auth.user.email, reason);
  return Response.json({ ok: true, ...state });
}
