/**
 * Проблемные товары: список, статусы разбора и снятие блокировки.
 *
 * Снятие — отдельное право («Снятие блокировки», уровень начальника склада) и
 * только с комментарием. Журнал блокировок отдаётся вместе со списком: строки
 * из него не удаляются и не правятся.
 */
import { authorizePermission } from "@/lib/permissions";
import { readProblemArticles, releaseArticle, setProblemStatus } from "@/lib/problem-articles";
import { getRuntimeEnv } from "@/lib/runtime-env";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.problems", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const stateParam = new URL(request.url).searchParams.get("state");
  const state = stateParam === "released" || stateParam === "all" ? stateParam : "blocked";
  const [items, log] = await Promise.all([
    readProblemArticles(db, state),
    db.prepare(
      `SELECT id, article, size, action, actor_email AS actorEmail, comment,
              task_number AS taskNumber, created_at AS createdAt
       FROM problem_article_log ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).all(),
  ]);

  return Response.json({
    state,
    items,
    log: log.results,
    canRelease: auth.permissions.includes("warehouse.problems.release"),
  });
}

export async function POST(request: Request) {
  const auth = await authorizePermission(["warehouse.problems", "warehouse.problems.release"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as {
    action?: unknown;
    id?: unknown;
    status?: unknown;
    comment?: unknown;
  } | null;
  const action = String(body?.action ?? "");
  const id = Number(body?.id);
  if (!Number.isFinite(id) || id <= 0) return Response.json({ error: "Не указана запись." }, { status: 400 });

  if (action === "status") {
    const allowed = ["searching", "requested", "cancelling", "arrived"] as const;
    const status = allowed.find((value) => value === body?.status);
    if (!status) return Response.json({ error: "Неизвестный статус." }, { status: 400 });
    const result = await setProblemStatus(runtime.DB, { id: Math.trunc(id), status, actorEmail: auth.user.email });
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true });
  }

  if (action === "release") {
    if (!auth.permissions.includes("warehouse.problems.release")) {
      return Response.json({ error: "Снять блокировку может начальник склада." }, { status: 403 });
    }
    const comment = typeof body?.comment === "string" ? body.comment : "";
    const result = await releaseArticle(runtime.DB, runtime, { id: Math.trunc(id), actorEmail: auth.user.email, comment });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true, restored: result.restored });
  }

  return Response.json({ error: "Неизвестное действие." }, { status: 400 });
}
