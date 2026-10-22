/**
 * Что из регистра ШК уже есть на сайте — построчно «ШК<TAB>УИН».
 *
 * 1С (с версии обработки 1.1.0) спрашивает только диапазон кодов своей порции
 * сверки: `?from=<код>&to=<код>`, обе границы включительно. Новые ШК она
 * выгружает по своим отметкам и весь список не запрашивает. Без параметров
 * отдаётся весь регистр — так работала обработка 1.0.x.
 */
import { authorizeOnec, readKnownRegistry } from "@/lib/onec";
import { parseKnownRange } from "@/lib/onec-core.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizeOnec(request);
  if ("response" in auth) return auth.response;

  const parsed = parseKnownRange(new URL(request.url).searchParams);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  return new Response(await readKnownRegistry(auth.db, parsed.range), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
