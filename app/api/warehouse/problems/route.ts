/**
 * Проблемные товары: список, статусы разбора и снятие блокировки.
 *
 * Снятие — отдельное право («Снятие блокировки», уровень начальника склада) и
 * только с комментарием. Журнал блокировок отдаётся вместе со списком: строки
 * из него не удаляются и не правятся.
 */
import { getMarketplaceCredentials } from "@/lib/credentials";
import { authorizePermission } from "@/lib/permissions";
import { readProblemArticles, releaseArticle, setProblemStatus } from "@/lib/problem-articles";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { logWarehouseEvent } from "@/lib/warehouse";
import { cancelWildberriesOrder } from "@/lib/wildberries";

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

  if (action === "cancel_wb") {
    // Wildberries: без УИН поставку не закрыть, поэтому сборочное задание
    // приходится отменять. Раньше это делали руками в кабинете.
    const row = await runtime.DB.prepare(
      `SELECT id, article, size, marketplace_id AS marketplaceId, external_order_id AS externalOrderId,
              task_number AS taskNumber, cancelled_on_marketplace_at AS cancelledAt
       FROM problem_articles WHERE id = ?`,
    ).bind(Math.trunc(id)).first<{
      id: number;
      article: string;
      size: string | null;
      marketplaceId: string | null;
      externalOrderId: string | null;
      taskNumber: string | null;
      cancelledAt: string | null;
    }>();
    if (!row) return Response.json({ error: "Запись не найдена." }, { status: 404 });
    if (row.marketplaceId !== "wildberries" || !row.externalOrderId) {
      return Response.json({ error: "Отмена через API есть только у Wildberries. Заказ Ozon не отменяем — изделие ищут на производстве." }, { status: 400 });
    }
    if (row.cancelledAt) return Response.json({ error: "Сборочное задание уже отменено." }, { status: 409 });

    const credentials = await getMarketplaceCredentials(runtime.DB, runtime, "wildberries");
    if (!credentials.WB_API_TOKEN) return Response.json({ error: "Ключ Wildberries не добавлен." }, { status: 400 });

    try {
      await cancelWildberriesOrder(credentials.WB_API_TOKEN, row.externalOrderId);
    } catch (error) {
      return Response.json({
        error: `Wildberries не отменил задание: ${error instanceof Error ? error.message : "неизвестная ошибка"}`,
      }, { status: 502 });
    }

    await runtime.DB.batch([
      runtime.DB.prepare(
        "UPDATE problem_articles SET cancelled_on_marketplace_at = CURRENT_TIMESTAMP, status = 'cancelling' WHERE id = ?",
      ).bind(row.id),
      // Заказ больше не ждёт сборки: помечаем отменённым, чтобы он ушёл из
      // отбора и не держал резерв остатка.
      runtime.DB.prepare(
        `UPDATE orders
         SET canceled_at = COALESCE(canceled_at, CURRENT_TIMESTAMP), seller_cancelled = 1,
             cancellation_source = 'seller', status = 'cancel/canceled', updated_at = CURRENT_TIMESTAMP
         WHERE marketplace_id = 'wildberries' AND external_order_id = ?`,
      ).bind(row.externalOrderId),
      runtime.DB.prepare(
        `INSERT INTO problem_article_log (article, size, action, actor_email, comment, task_number)
         VALUES (?, ?, 'wb_cancelled', ?, ?, ?)`,
      ).bind(row.article, row.size, auth.user.email, `Отменено сборочное задание WB ${row.externalOrderId}`, row.taskNumber),
    ]);

    await logWarehouseEvent(runtime.DB, {
      kind: "wb_order_cancelled",
      marketplaceId: "wildberries",
      externalOrderId: row.externalOrderId,
      article: row.article,
      size: row.size,
      actorEmail: auth.user.email,
    });

    return Response.json({ ok: true, cancelled: row.externalOrderId });
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
