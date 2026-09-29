/** Проверка связи для 1С: ключ принят, сайт отвечает. */
import { authorizeOnec } from "@/lib/onec";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizeOnec(request);
  if ("response" in auth) return auth.response;
  return Response.json({ ok: true, site: new URL(request.url).host });
}
