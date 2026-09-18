/**
 * Приём собранного задания на стол упаковки по скану листа подбора.
 *
 * Сканируют штрихкод с листа — 12 цифр, свои у каждого задания. Задание,
 * которое сборщик не закрыл на экране, принимается только после
 * подтверждения: иначе строки без отметки молча стали бы «собрано».
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { findTaskByPickSheet, receiveTaskForPacking } from "@/lib/warehouse";

export async function POST(request: Request) {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  // Задание открывается только по коду с листа: ручной выбор задания убран,
  // поэтому и здесь номер задания напрямую больше не принимается.
  const body = await request.json().catch(() => null) as { code?: unknown; confirm?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const task = await findTaskByPickSheet(runtime.DB, code);
  if (!task) {
    return Response.json(
      { error: "Это не штрихкод листа подбора. Сканируйте код с листа — 12 цифр под номером задания." },
      { status: 400 },
    );
  }
  const taskId = task.id;

  const result = await receiveTaskForPacking(runtime.DB, taskId, auth.user.email, { closeIfOpen: body?.confirm === true });
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result);
}
