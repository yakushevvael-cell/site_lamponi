/**
 * Файл этикетки для печати.
 *
 * Отдаётся прямо в браузер: окно печати открывается по этому адресу, и
 * ничего не проходит через JavaScript — так печать не зависит от того,
 * успела ли страница что-то отрисовать.
 */
import { markLabelPrinted, readLabel } from "@/lib/labels";
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB || !runtime.BUCKET) return new Response("Хранилище недоступно.", { status: 500 });

  const url = new URL(request.url);
  const marketplaceId = url.searchParams.get("marketplace") === "wildberries" ? "wildberries" : "ozon";
  const posting = (url.searchParams.get("posting") ?? "").trim();
  if (!posting) return new Response("Не указано отправление.", { status: 400 });

  const label = await readLabel(runtime.DB, marketplaceId, posting);
  if (!label || label.status !== "ready" || !label.storageKey) {
    return new Response("Этикетка ещё не готова.", { status: 409 });
  }

  const file = await runtime.BUCKET.get(label.storageKey);
  if (!file) return new Response("Файл этикетки не найден на сервере.", { status: 404 });

  if (url.searchParams.get("count") !== "0") await markLabelPrinted(runtime.DB, label.id);

  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": label.contentType ?? "application/pdf",
      "Content-Disposition": `inline; filename="label-${posting}.${label.contentType === "image/png" ? "png" : "pdf"}"`,
      "Cache-Control": "no-store",
    },
  });
}
