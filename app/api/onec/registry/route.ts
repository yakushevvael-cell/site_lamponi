/** Пачка регистра из 1С: «ШК бирки -> УИН, артикул, размер». Повторная отправка ничего не ломает. */
import { authorizeOnec, saveRegistry } from "@/lib/onec";
import { parseRegistryItem, type RegistryItem } from "@/lib/onec-core.mjs";

export const dynamic = "force-dynamic";

/** 1С шлёт по 1000; запас — на случай, если размер пачки в обработке увеличат. */
const MAX_ITEMS = 5000;

export async function POST(request: Request) {
  const auth = await authorizeOnec(request);
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null) as { full?: unknown; items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) {
    return Response.json({ error: "Ожидается {\"items\": [...]}." }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS) {
    return Response.json({ error: `Не больше ${MAX_ITEMS} строк за запрос.` }, { status: 413 });
  }

  // Последняя строка с тем же ШК побеждает — как если бы они пришли по очереди.
  const byBarcode = new Map<string, RegistryItem>();
  for (const raw of body.items) {
    const item = parseRegistryItem(raw);
    if (item) byBarcode.set(item.barcode, item);
  }
  const items = [...byBarcode.values()];
  if (body.items.length > 0) await saveRegistry(auth.db, items, body.items.length, body.full === true);

  return Response.json({ ok: true, saved: items.length, skipped: body.items.length - items.length });
}
