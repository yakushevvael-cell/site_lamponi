/** Ответ 1С по одному заданию: создан или обновлён документ, либо почему нет. */
import { authorizeOnec, saveTaskAck } from "@/lib/onec";
import { parseTaskAck } from "@/lib/onec-core.mjs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authorizeOnec(request);
  if ("response" in auth) return auth.response;

  const ack = parseTaskAck(await request.json().catch(() => null));
  if (!ack) return Response.json({ error: "Ожидается ответ по заданию с полем id." }, { status: 400 });
  if (!(await saveTaskAck(auth.db, ack))) {
    return Response.json({ error: `Задания ${ack.id} на сайте нет.` }, { status: 404 });
  }
  return Response.json({ ok: true });
}
