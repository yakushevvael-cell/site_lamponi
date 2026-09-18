/**
 * Стол сканирования: один скан УИН — один ответ.
 *
 * Решение, что показать на экране, принимает сервер: повторный скан, чужое
 * задание и неизвестный УИН — это не оформление, а контроль пересорта, и
 * он не должен зависеть от состояния страницы.
 *
 * Скан по отправлению с несколькими товарами — тоже нормальный исход: он
 * отмечает изделие и называет ячейку комплектации, но этикетку не печатает.
 */
import { readPostingBoard, readScanSummary, resolveScan } from "@/lib/labels";
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { findTaskByPickSheet, logWarehouseEvent } from "@/lib/warehouse";

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.scan");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as {
    uin?: unknown;
    code?: unknown;
    confirmSize?: unknown;
  } | null;
  const raw = typeof body?.uin === "string" ? body.uin : "";
  // Сканер иногда добавляет пробелы и перевод строки, а иногда префикс.
  const uin = raw.replace(/\s+/g, "").replace(/^УИН[:№#-]?/i, "");
  if (!uin) return Response.json({ error: "Пустой скан." }, { status: 400 });

  // Задание берётся из кода листа подбора, который отсканировали на столе.
  // Номер задания сам по себе больше не пропуск: без листа упаковки нет.
  const code = typeof body?.code === "string" ? body.code : "";
  const task = await findTaskByPickSheet(runtime.DB, code);
  if (!task) {
    return Response.json({ error: "Сначала отсканируйте штрихкод листа подбора." }, { status: 400 });
  }
  if (task.status === "cancelled") return Response.json({ error: "Задание отменено." }, { status: 409 });
  const taskId = task.id;

  const outcome = await resolveScan(runtime.DB, {
    uin,
    taskId,
    actorEmail: auth.user.email,
    // Подтверждение размера присылает кладовщик вторым запросом: до него
    // ничего не записывается, поэтому «отклонить» ничего не ломает.
    confirmSize: body?.confirmSize === true,
  });

  if (outcome.status !== "ok" && outcome.status !== "grouped") {
    await logWarehouseEvent(runtime.DB, {
      kind: `scan_${outcome.status}`,
      taskId,
      taskNumber: task.number,
      actorEmail: auth.user.email,
      payload: { uin },
    });
  }

  return Response.json({
    ok: outcome.status === "ok" || outcome.status === "grouped",
    outcome,
    summary: await readScanSummary(runtime.DB, taskId),
    board: await readPostingBoard(runtime.DB, taskId),
  });
}
