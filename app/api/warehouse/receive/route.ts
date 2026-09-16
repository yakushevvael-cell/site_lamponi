/**
 * Приём собранного задания на стол упаковки по скану листа подбора.
 *
 * Сканируют штрихкод с листа (T123). Задание, которое сборщик не закрыл на
 * экране, принимается только после подтверждения: иначе строки без отметки
 * молча стали бы «собрано».
 */
import { parseTaskBarcode } from "@/lib/barcode39.mjs";
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { receiveTaskForPacking } from "@/lib/warehouse";

export async function POST(request: Request) {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { code?: unknown; taskId?: unknown; confirm?: unknown } | null;
  const fromCode = parseTaskBarcode(typeof body?.code === "string" ? body.code : "");
  const direct = Number(body?.taskId);
  const taskId = fromCode ?? (Number.isSafeInteger(direct) && direct > 0 ? direct : null);
  if (!taskId) {
    return Response.json({ error: "Это не штрихкод листа подбора. Сканируйте код под номером задания (T и цифры)." }, { status: 400 });
  }

  const result = await receiveTaskForPacking(runtime.DB, taskId, auth.user.email, { closeIfOpen: body?.confirm === true });
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result);
}
