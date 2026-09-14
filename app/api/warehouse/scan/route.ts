/**
 * Стол сканирования: один скан УИН — один ответ.
 *
 * Решение, что показать на экране, принимает сервер: повторный скан, чужое
 * задание и неизвестный УИН — это не оформление, а контроль пересорта, и
 * он не должен зависеть от состояния страницы.
 */
import { resolveScan, readScanSummary } from "@/lib/labels";
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { logWarehouseEvent, readTask } from "@/lib/warehouse";

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.scan");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { uin?: unknown; taskId?: unknown } | null;
  const raw = typeof body?.uin === "string" ? body.uin : "";
  // Сканер иногда добавляет пробелы и перевод строки, а иногда префикс.
  const uin = raw.replace(/\s+/g, "").replace(/^УИН[:№#-]?/i, "");
  const taskIdRaw = Number(body?.taskId);
  const taskId = Number.isFinite(taskIdRaw) && taskIdRaw > 0 ? Math.trunc(taskIdRaw) : null;

  if (!uin) return Response.json({ error: "Пустой скан." }, { status: 400 });
  if (!taskId) return Response.json({ error: "Выберите задание, по которому идёт упаковка." }, { status: 400 });

  const task = await readTask(runtime.DB, taskId);
  if (!task) return Response.json({ error: "Задание не найдено." }, { status: 404 });
  if (task.status === "cancelled") return Response.json({ error: "Задание отменено." }, { status: 409 });

  const outcome = await resolveScan(runtime.DB, { uin, taskId, actorEmail: auth.user.email });

  if (outcome.status !== "ok") {
    await logWarehouseEvent(runtime.DB, {
      kind: `scan_${outcome.status}`,
      taskId,
      taskNumber: task.number,
      actorEmail: auth.user.email,
      payload: { uin },
    });
  }

  return Response.json({
    ok: outcome.status === "ok",
    outcome,
    summary: await readScanSummary(runtime.DB, taskId),
  });
}
