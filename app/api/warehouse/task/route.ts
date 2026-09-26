/**
 * Одно задание: состав и действия по нему.
 *
 * Действия собраны в один маршрут, потому что все они — переходы состояния
 * одного и того же задания, и каждый пишется в журнал событий одинаково.
 */
import { authorizePermission } from "@/lib/permissions";
import { blockArticle } from "@/lib/problem-articles";
import { getRuntimeEnv } from "@/lib/runtime-env";
import {
  assignTask,
  cancelTask,
  closeShipmentManually,
  closeTask,
  markAllPicked,
  markTaskPrinted,
  readTask,
  readTaskItems,
  releaseTask,
  reopenManualShipment,
  resolveTaskItem,
  returnTaskToPicking,
} from "@/lib/warehouse";

function taskIdFrom(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.tasks", "warehouse.pick"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const taskId = taskIdFrom(new URL(request.url).searchParams.get("id"));
  if (!taskId) return Response.json({ error: "Не указано задание." }, { status: 400 });

  const task = await readTask(runtime.DB, taskId);
  if (!task) return Response.json({ error: "Задание не найдено." }, { status: 404 });

  // Сборщику доступно своё задание и свободное — чужое он видеть не должен.
  const manages = auth.permissions.includes("warehouse.tasks");
  const own = task.assigneeEmail === auth.user.email;
  if (!manages && !own && task.assigneeEmail) {
    return Response.json({ error: "Это задание закреплено за другим сборщиком." }, { status: 403 });
  }

  return Response.json({ task, items: await readTaskItems(runtime.DB, taskId), manages, own });
}

export async function POST(request: Request) {
  const auth = await authorizePermission(["warehouse.tasks", "warehouse.pick"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as {
    id?: unknown;
    action?: unknown;
    itemId?: unknown;
    status?: unknown;
    assigneeEmail?: unknown;
    comment?: unknown;
  } | null;
  const taskId = taskIdFrom(body?.id);
  const action = String(body?.action ?? "");
  if (!taskId) return Response.json({ error: "Не указано задание." }, { status: 400 });

  const task = await readTask(db, taskId);
  if (!task) return Response.json({ error: "Задание не найдено." }, { status: 404 });

  const manages = auth.permissions.includes("warehouse.tasks");
  const own = task.assigneeEmail === auth.user.email;
  const mayWork = manages || own || !task.assigneeEmail;
  if (!mayWork) return Response.json({ error: "Это задание закреплено за другим сборщиком." }, { status: 403 });

  if (action === "take") {
    const updated = await assignTask(db, taskId, auth.user.email, auth.user.email);
    if (!updated) return Response.json({ error: "Задание уже взял другой сборщик." }, { status: 409 });
    return Response.json({ ok: true, task: updated });
  }

  if (action === "assign") {
    if (!manages) return Response.json({ error: "Выдавать задания может кладовщик." }, { status: 403 });
    const assignee = typeof body?.assigneeEmail === "string" ? body.assigneeEmail.trim().toLowerCase() : "";
    if (!assignee) return Response.json({ error: "Выберите сборщика." }, { status: 400 });
    const updated = await assignTask(db, taskId, assignee, auth.user.email);
    if (!updated) return Response.json({ error: "Задание уже закреплено за другим сборщиком." }, { status: 409 });
    return Response.json({ ok: true, task: updated });
  }

  if (action === "release") {
    if (!manages) return Response.json({ error: "Снять исполнителя может кладовщик." }, { status: 403 });
    const updated = await releaseTask(db, taskId, auth.user.email);
    if (!updated) return Response.json({ error: "Задание не выдано." }, { status: 409 });
    return Response.json({ ok: true, task: updated });
  }

  if (action === "printed") {
    await markTaskPrinted(db, taskId, auth.user.email);
    return Response.json({ ok: true, task: await readTask(db, taskId) });
  }

  if (action === "close") {
    const result = await closeTask(db, taskId, auth.user.email);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true, task: result.task });
  }

  // Строку отметили «собрано» по ошибке: задание возвращают сборщику, чтобы
  // переотметить её «не найден». Решает кладовщик — сборщик закрытое задание
  // сам не открывает.
  if (action === "return_to_picking") {
    if (!manages) return Response.json({ error: "Вернуть задание на сборку может кладовщик." }, { status: 403 });
    const result = await returnTaskToPicking(db, taskId, auth.user.email);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true, task: result.task });
  }

  if (action === "pick_all") {
    const result = await markAllPicked(db, taskId, auth.user.email);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true, marked: result.marked, task: result.task });
  }

  // Отгрузку закрыли руками в кабинете площадки: задание перестаёт числиться
  // неотгруженным, но отметка «закрыто вручную» остаётся при нём навсегда.
  if (action === "close_manual") {
    if (!manages) return Response.json({ error: "Закрыть отгрузку вручную может кладовщик." }, { status: 403 });
    const note = typeof body?.comment === "string" ? body.comment : null;
    const result = await closeShipmentManually(db, taskId, auth.user.email, note);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true, task: result.task });
  }

  // Ошибочно закрытую вручную отгрузку возвращают в работу: задание снова
  // в прежнем статусе, а закрытие и возврат остаются в журнале.
  if (action === "reopen_manual") {
    if (!manages) return Response.json({ error: "Вернуть отгрузку в работу может кладовщик." }, { status: 403 });
    const result = await reopenManualShipment(db, taskId, auth.user.email);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true, task: result.task });
  }

  if (action === "cancel") {
    if (!manages) return Response.json({ error: "Отменить задание может кладовщик." }, { status: 403 });
    const comment = typeof body?.comment === "string" ? body.comment.trim().slice(0, 500) : null;
    const result = await cancelTask(db, taskId, auth.user.email, comment);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true, task: result.task });
  }

  if (action === "resolve") {
    const itemId = taskIdFrom(body?.itemId);
    const status = body?.status === "picked" || body?.status === "not_found" ? body.status : null;
    if (!itemId || !status) return Response.json({ error: "Укажите строку и отметку." }, { status: 400 });

    const result = await resolveTaskItem(db, { taskId, itemId, status, actorEmail: auth.user.email });
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });

    // «Не найден» — это не просто отметка: остаток артикула уходит в ноль на
    // обеих площадках сразу, иначе его закажут снова через минуту.
    let problem = null;
    if (status === "not_found") {
      problem = await blockArticle(db, runtime, {
        article: result.item.article,
        size: result.item.size,
        productSku: result.item.productSku,
        taskId,
        taskNumber: task.number,
        marketplaceId: result.item.marketplaceId,
        externalOrderId: result.item.externalOrderId,
        shipmentDeadline: result.item.shipmentDeadline,
        actorEmail: auth.user.email,
      });
    }

    return Response.json({ ok: true, item: result.item, task: result.task, problem });
  }

  return Response.json({ error: "Неизвестное действие." }, { status: 400 });
}
