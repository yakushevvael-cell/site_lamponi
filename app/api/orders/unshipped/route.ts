import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readUnshippedAt } from "@/lib/unshipped";
import { formatMoscow, moscowInputToTime, timeToMoscowInput, toCsv } from "@/lib/unshipped-core.mjs";

/**
 * Заказы, не отгруженные на момент: ?at=ГГГГ-ММ-ДДTЧЧ:ММ по Москве.
 * &format=csv — файл для Excel, иначе JSON.
 */
export async function GET(request: Request) {
  const auth = await authorizePermission("money.view");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const url = new URL(request.url);
  const at = url.searchParams.get("at") ?? "";
  const cutoff = moscowInputToTime(at);
  if (cutoff === null) {
    return Response.json({ error: "Укажите время по Москве в виде ГГГГ-ММ-ДДTЧЧ:ММ, например 2026-10-05T14:00." }, { status: 400 });
  }

  const orders = await readUnshippedAt(runtime.DB, cutoff);
  const label = timeToMoscowInput(cutoff);

  if (url.searchParams.get("format") === "csv") {
    const csv = toCsv(
      ["Площадка", "Номер заказа", "Оформлен (МСК)", "Дедлайн отгрузки (МСК)", "Ждал, ч", "Товары", "Штук", "Сумма", "Статус сейчас", "Передан (МСК)", "Отменён (МСК)"],
      orders.map((order) => [
        order.marketplace,
        order.externalOrderId,
        formatMoscow(order.orderedAt),
        formatMoscow(order.shipmentDeadline),
        order.waitedHours,
        order.items,
        order.units,
        String(order.amount).replace(".", ","),
        order.status,
        formatMoscow(order.handedOverAt),
        formatMoscow(order.canceledAt),
      ]),
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="unshipped_${label.replace(/[-:]/g, "").replace("T", "_")}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json({ at: label, count: orders.length, orders });
}
