/** Поставки: готовность задания, оформление и догрузка документов. */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import {
  checkSupplyReadiness,
  collectOzonActDocuments,
  createSupplyForTask,
  readDropoffPoints,
  readSupplies,
  readTaskDropoffContext,
  readSupply,
  withDocuments,
} from "@/lib/supplies";

function idFrom(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.supply", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const url = new URL(request.url);
  const taskId = idFrom(url.searchParams.get("task"));

  const dropoff = taskId
    ? await readTaskDropoffContext(runtime.DB, taskId)
    : { wildberries: false, city: null, recommendedPointId: null };
  const points = await readDropoffPoints(runtime.DB, undefined, dropoff.city);

  return Response.json({
    supplies: await readSupplies(runtime.DB, taskId ? { taskId } : {}),
    blocker: taskId ? await checkSupplyReadiness(runtime.DB, taskId) : null,
    // Пока место сдачи не подобрано, список пуст: выбирать наугад из сотен
    // ПВЗ нельзя — поставку отвезут не туда.
    dropoffPoints: dropoff.wildberries && !dropoff.city
      ? points.filter((point) => (point as { marketplaceId?: string }).marketplaceId !== "wildberries")
      : points,
    dropoffCity: dropoff.city,
    recommendedPointId: dropoff.recommendedPointId,
    canManage: auth.permissions.includes("warehouse.supply"),
  });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.supply");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as {
    action?: unknown;
    taskId?: unknown;
    supplyId?: unknown;
    boxCount?: unknown;
    dropoffPointId?: unknown;
    departureDate?: unknown;
  } | null;
  const action = String(body?.action ?? "create");

  if (action === "refresh_documents") {
    const supplyId = idFrom(body?.supplyId);
    if (!supplyId) return Response.json({ error: "Не указана поставка." }, { status: 400 });
    const supply = await readSupply(runtime.DB, supplyId);
    if (!supply) return Response.json({ error: "Поставка не найдена." }, { status: 404 });
    if (supply.marketplaceId !== "ozon" || !supply.externalId) {
      return Response.json({ error: "Догрузка документов есть только у Ozon: акт готовится не мгновенно." }, { status: 400 });
    }
    const result = await collectOzonActDocuments(runtime.DB, runtime, supplyId, Number(supply.externalId), 2);
    const updated = await readSupply(runtime.DB, supplyId);
    return Response.json({ ok: true, status: result.status, supply: updated ? withDocuments(updated) : null });
  }

  const taskId = idFrom(body?.taskId);
  if (!taskId) return Response.json({ error: "Не указано задание." }, { status: 400 });
  const boxCountRaw = Number(body?.boxCount);
  const boxCount = Number.isFinite(boxCountRaw) && boxCountRaw > 0 ? Math.min(200, Math.trunc(boxCountRaw)) : 1;
  const departureDate = typeof body?.departureDate === "string" && body.departureDate.trim()
    ? body.departureDate.trim()
    : null;

  const result = await createSupplyForTask(runtime.DB, runtime, {
    taskId,
    boxCount,
    dropoffPointId: idFrom(body?.dropoffPointId),
    departureDate,
    actorEmail: auth.user.email,
  });

  if (!result.ok) return Response.json({ error: result.blocker.reason, details: result.blocker.details }, { status: 409 });
  return Response.json({ ok: true, supply: result.supply ? withDocuments(result.supply) : null });
}
