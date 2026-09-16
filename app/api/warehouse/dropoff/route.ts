/** Пункты отгрузки: список по городам отгрузки, загрузка города из WB, подсказка из кабинета. */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import {
  readDropoffPoints,
  readShippingCities,
  refreshDropoffPoints,
  removeShippingCity,
  resolveWildberriesDropoff,
} from "@/lib/supplies";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.supply", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const marketplace = new URL(request.url).searchParams.get("marketplace") ?? undefined;
  const cities = await readShippingCities(runtime.DB);
  return Response.json({ cities, points: await readDropoffPoints(runtime.DB, marketplace ?? undefined, cities) });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.supply");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as {
    action?: unknown; city?: unknown; cargoType?: unknown; taskId?: unknown;
  } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  const city = typeof body?.city === "string" ? body.city.trim().slice(0, 80) : "";

  const listing = async () => {
    const cities = await readShippingCities(db);
    return { cities, points: await readDropoffPoints(db, undefined, cities) };
  };

  try {
    // Убрать город из списка: его пункты перестают показываться в выборе.
    if (action === "remove_city") {
      if (!city) return Response.json({ error: "Не указан город." }, { status: 400 });
      await removeShippingCity(db, city);
      return Response.json({ ok: true, ...(await listing()) });
    }

    // Подсказка: склад сдачи, привязанный к складу продавца в кабинете WB.
    if (action === "suggest") {
      const taskId = Number(body?.taskId);
      if (!Number.isFinite(taskId) || taskId <= 0) {
        return Response.json({ error: "Выберите задание Wildberries." }, { status: 400 });
      }
      const result = await resolveWildberriesDropoff(db, runtime, { taskId: Math.trunc(taskId) });
      return Response.json({ ok: true, ...result, ...(await listing()) });
    }

    // Загрузить (или обновить) пункты города и добавить его в список.
    if (!city) return Response.json({ error: "Укажите город отгрузки, например «Кострома»." }, { status: 400 });
    const cargoTypeRaw = Number(body?.cargoType);
    const cargoType = [1, 2, 3].includes(cargoTypeRaw) ? cargoTypeRaw : 1;
    const result = await refreshDropoffPoints(db, runtime, { city, cargoType });
    return Response.json({ ok: true, found: result.found, city: result.city, ...(await listing()) });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Не удалось обновить пункты отгрузки.",
    }, { status: 502 });
  }
}
