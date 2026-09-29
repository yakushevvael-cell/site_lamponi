/**
 * Задания на сборку для черновиков «Расход ГП» в 1С.
 *
 * Отдаются новые и изменившиеся с последнего ответа 1С — не больше 50 за раз.
 * Формат описан в «Пояснении» к обработке 1С, раздел «API сайта».
 */
import { authorizeOnec, readPendingTasks } from "@/lib/onec";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizeOnec(request);
  if ("response" in auth) return auth.response;
  return Response.json({ tasks: await readPendingTasks(auth.db) });
}
