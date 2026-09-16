/** Цены на золото и серебро: чтение для дашборда и приём от фоновой задачи. */
import { authorizeApi } from "@/lib/app-auth";
import { readMetalPrices, saveMetalPrices } from "@/lib/metal-prices";
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";

export async function GET() {
  const auth = await authorizePermission("money.view");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json(await readMetalPrices(runtime.DB));
}

export async function POST(request: Request) {
  // Пишет только фоновая задача со служебным токеном (или администратор).
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Пустой запрос." }, { status: 400 });
  const result = await saveMetalPrices(runtime.DB, body);
  if (!result.ok) return Response.json({ error: result.error }, { status: 422 });
  return Response.json({ ok: true });
}
