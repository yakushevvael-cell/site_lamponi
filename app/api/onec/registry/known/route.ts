/**
 * Что из регистра ШК уже есть на сайте — построчно «ШК<TAB>УИН».
 *
 * По этому списку 1С отправляет только новые ШК и те, у которых сменился УИН:
 * даты добавления ни в справочнике, ни в регистре 1С нет.
 */
import { authorizeOnec, readKnownRegistry } from "@/lib/onec";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizeOnec(request);
  if ("response" in auth) return auth.response;
  return new Response(await readKnownRegistry(auth.db), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
