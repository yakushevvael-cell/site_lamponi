/** Справочник точек сдачи: список и обновление из API площадки. */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readDropoffPoints, refreshDropoffPoints, resolveWildberriesDropoff } from "@/lib/supplies";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.supply", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const marketplace = new URL(request.url).searchParams.get("marketplace") ?? undefined;
  return Response.json({ points: await readDropoffPoints(runtime.DB, marketplace ?? undefined) });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.supply");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { city?: unknown; cargoType?: unknown; taskId?: unknown } | null;

  // Задание WB: город и пункт берутся из склада сдачи, привязанного к складу
  // продавца в кабинете WB, а не из имени склада в задании.
  const taskIdRaw = Number(body?.taskId);
  const cityOverride = typeof body?.city === "string" ? body.city.trim() : "";
  if (Number.isFinite(taskIdRaw) && taskIdRaw > 0 && !cityOverride) {
    try {
      const result = await resolveWildberriesDropoff(runtime.DB, runtime, { taskId: Math.trunc(taskIdRaw) });
      return Response.json({ ok: true, ...result, points: await readDropoffPoints(runtime.DB, undefined, result.city) });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : "Не удалось подобрать пункт отгрузки.",
      }, { status: 502 });
    }
  }

  // Город вручную — запасной путь, если привязка склада в WB не заполнена.
  const city = cityOverride;
  if (!city) {
    return Response.json({ error: "Не указан город отгрузки." }, { status: 400 });
  }
  const cargoTypeRaw = Number(body?.cargoType);
  const cargoType = Number.isFinite(cargoTypeRaw) && cargoTypeRaw > 0 ? Math.trunc(cargoTypeRaw) : 1;

  try {
    const result = await refreshDropoffPoints(runtime.DB, runtime, { city, cargoType });
    return Response.json({ ok: true, ...result, points: await readDropoffPoints(runtime.DB, undefined, city) });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Не удалось обновить точки сдачи.",
    }, { status: 502 });
  }
}
