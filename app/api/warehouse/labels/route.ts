/** Этикетки задания: состояние подготовки и запуск фоновой подготовки. */
import { prepareLabelsForTask, readLabelErrors, readScanSummary } from "@/lib/labels";
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readTask } from "@/lib/warehouse";

function taskIdFrom(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const taskId = taskIdFrom(new URL(request.url).searchParams.get("task"));
  if (!taskId) return Response.json({ error: "Не указано задание." }, { status: 400 });
  const task = await readTask(runtime.DB, taskId);
  if (!task) return Response.json({ error: "Задание не найдено." }, { status: 404 });

  return Response.json({
    task,
    summary: await readScanSummary(runtime.DB, taskId),
    errors: await readLabelErrors(runtime.DB, taskId),
  });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.scan");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { taskId?: unknown; limit?: unknown } | null;
  const taskId = taskIdFrom(body?.taskId);
  if (!taskId) return Response.json({ error: "Не указано задание." }, { status: 400 });
  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : undefined;

  const task = await readTask(runtime.DB, taskId);
  if (!task) return Response.json({ error: "Задание не найдено." }, { status: 404 });
  if (task.status === "cancelled") return Response.json({ error: "Задание отменено." }, { status: 409 });

  const result = await prepareLabelsForTask(runtime.DB, runtime, {
    taskId,
    limit,
    actorEmail: auth.user.email,
  });

  return Response.json({
    ok: true,
    ...result,
    summary: await readScanSummary(runtime.DB, taskId),
    errors: await readLabelErrors(runtime.DB, taskId),
  });
}
