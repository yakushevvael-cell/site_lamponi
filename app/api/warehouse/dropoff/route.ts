/** Справочник точек сдачи: список и обновление из API площадки. */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readDropoffPoints, refreshDropoffPoints } from "@/lib/supplies";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.supply", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const marketplace = new URL(request.url).searchParams.get("marketplace") ?? undefined;
  return Response.json({ points: await readDropoffPoints(runtime.DB, marketplace ?? undefined) });
}

export async function POST() {
  const auth = await authorizePermission("warehouse.supply");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  try {
    const result = await refreshDropoffPoints(runtime.DB, runtime);
    return Response.json({ ok: true, ...result, points: await readDropoffPoints(runtime.DB) });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Не удалось обновить точки сдачи.",
    }, { status: 502 });
  }
}
