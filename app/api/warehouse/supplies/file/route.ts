/** Документ поставки: QR, стикер короба или акт. Отдаётся прямо в браузер для печати. */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readSupply, withDocuments } from "@/lib/supplies";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.supply", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB || !runtime.BUCKET) return new Response("Хранилище недоступно.", { status: 500 });

  const url = new URL(request.url);
  const supplyId = Number(url.searchParams.get("supply"));
  const index = Number(url.searchParams.get("document"));
  if (!Number.isFinite(supplyId) || !Number.isFinite(index)) return new Response("Не указан документ.", { status: 400 });

  const supply = await readSupply(runtime.DB, Math.trunc(supplyId));
  if (!supply) return new Response("Поставка не найдена.", { status: 404 });
  const document = withDocuments(supply).documents[Math.trunc(index)];
  if (!document?.storageKey) return new Response("Документ ещё не готов.", { status: 409 });

  const file = await runtime.BUCKET.get(document.storageKey);
  if (!file) return new Response("Файл не найден на сервере.", { status: 404 });

  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": document.contentType,
      "Content-Disposition": `inline; filename="${document.kind}-${supply.id}.${document.contentType === "application/pdf" ? "pdf" : "png"}"`,
      "Cache-Control": "no-store",
    },
  });
}
