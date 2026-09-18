/**
 * Задание по штрихкоду листа подбора.
 *
 * Стол упаковки и поставки начинают работу со скана листа: задание больше
 * нельзя выбрать из списка руками, иначе легко открыть чужое и перепутать
 * партию. Здесь скан превращается в задание — и только здесь.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { findTaskByPickSheet } from "@/lib/warehouse";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.supply", "warehouse.tasks", "warehouse.pick"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const code = (new URL(request.url).searchParams.get("code") ?? "").trim();
  if (!code) return Response.json({ error: "Сканируйте штрихкод листа подбора." }, { status: 400 });

  const task = await findTaskByPickSheet(runtime.DB, code);
  if (!task) {
    return Response.json(
      { error: "Такого листа подбора нет. Проверьте, что отсканирован штрихкод с листа, а не этикетка." },
      { status: 404 },
    );
  }
  if (task.status === "cancelled") return Response.json({ error: `Задание ${task.number} отменено.` }, { status: 409 });

  return Response.json({ task });
}
