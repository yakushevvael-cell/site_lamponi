import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readStockSyncState, setStockSyncMode, type StockSyncMode } from "@/lib/sync-pause";

/** Текущий режим выгрузки — читать может любой вошедший. */
export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json(await readStockSyncState(runtime.DB));
}

/**
 * Смена режима.
 *
 * Принимает `mode` («auto», «manual», «stopped»). Старое поле `paused`
 * продолжает работать: на него рассчитаны прежние версии интерфейса.
 */
export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { mode?: unknown; paused?: unknown; reason?: unknown } | null;
  const mode: StockSyncMode | null = body?.mode === "auto" || body?.mode === "manual" || body?.mode === "stopped"
    ? body.mode
    : typeof body?.paused === "boolean"
      ? (body.paused ? "stopped" : "auto")
      : null;
  if (!mode) return Response.json({ error: "Укажите режим выгрузки: auto, manual или stopped." }, { status: 400 });
  const reason = typeof body?.reason === "string" ? body.reason : null;

  const state = await setStockSyncMode(runtime.DB, mode, auth.user.email, reason);
  return Response.json({ ok: true, ...state });
}
