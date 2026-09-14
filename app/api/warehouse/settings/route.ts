/** Размер партии — настройка интерфейса, а не константа в коде (ТЗ, п. 3). */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readBatchSizes, writeBatchSizes } from "@/lib/warehouse";

export async function GET() {
  const auth = await authorizePermission(["warehouse.tasks", "warehouse.cells"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json({ batchSizes: await readBatchSizes(runtime.DB) });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.tasks");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { ozon?: unknown; wildberries?: unknown } | null;
  if (!body || (body.ozon === undefined && body.wildberries === undefined)) {
    return Response.json({ error: "Нечего менять." }, { status: 400 });
  }
  const batchSizes = await writeBatchSizes(runtime.DB, body, auth.user.email);
  return Response.json({ ok: true, batchSizes });
}
