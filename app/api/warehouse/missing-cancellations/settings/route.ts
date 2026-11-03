import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readMissingCancelSettings } from "@/lib/missing-cancellations";
import { CANCEL_SETTINGS_KEY, renderMissingMessage } from "@/lib/missing-cancel-core.mjs";
import { logWarehouseEvent } from "@/lib/warehouse";

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const db = getRuntimeEnv().DB;
  if (!db) return Response.json({error:"База данных недоступна."},{status:500});
  return Response.json(await readMissingCancelSettings(db));
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const db = getRuntimeEnv().DB;
  if (!db) return Response.json({error:"База данных недоступна."},{status:500});
  const input = await request.json().catch(() => null);
  if (typeof input?.text !== "string" || typeof input?.promo !== "string") return Response.json({error:"Укажите текст и промокод."},{status:400});
  const settings = {text:input.text.trim(),promo:input.promo.trim()};
  try { renderMissingMessage(settings,{article:"АРТИКУЛ",quantity:1,posting:"НОМЕР-ОТПРАВЛЕНИЯ"}); }
  catch (error) { return Response.json({error:error instanceof Error ? error.message : "Некорректный текст."},{status:400}); }
  await db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(CANCEL_SETTINGS_KEY,JSON.stringify(settings)).run();
  await logWarehouseEvent(db,{kind:"missing_cancel_settings",actorEmail:auth.user.email,payload:settings});
  return Response.json({ok:true,...settings});
}
