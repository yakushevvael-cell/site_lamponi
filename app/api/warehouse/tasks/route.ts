/**
 * Задания на сборку: список и формирование.
 *
 * Сборщик видит только свободные задания и свои: список для него урезается на
 * сервере, а не в интерфейсе.
 */
import { authorizePermission } from "@/lib/permissions";
import { countBlockedArticles } from "@/lib/problem-articles";
import { getRuntimeEnv } from "@/lib/runtime-env";
import {
  createPickTasks,
  readBatchSizes,
  readTaskList,
  readWaitingSummary,
  type MarketplaceId,
} from "@/lib/warehouse";

export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.tasks", "warehouse.pick"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const url = new URL(request.url);
  const manages = auth.permissions.includes("warehouse.tasks");
  const scope = url.searchParams.get("scope") === "mine" || !manages ? "mine" : "all";

  if (scope === "mine") {
    const [mine, free] = await Promise.all([
      readTaskList(db, { assigneeEmail: auth.user.email, statuses: ["issued", "picked"], limit: 50 }),
      readTaskList(db, { statuses: ["created"], limit: 50 }),
    ]);
    return Response.json({
      scope,
      manages,
      tasks: mine,
      // Свободные задания сборщик берёт сам — это и есть «выдача» на терминале.
      freeTasks: free.filter((task) => !task.assigneeEmail),
      permissions: auth.permissions,
    });
  }

  const [tasks, waiting, batchSizes, blockedCount] = await Promise.all([
    readTaskList(db, { limit: 120 }),
    readWaitingSummary(db),
    readBatchSizes(db),
    countBlockedArticles(db),
  ]);
  return Response.json({ scope, manages, tasks, waiting, batchSizes, blockedCount, permissions: auth.permissions });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.tasks");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as {
    marketplaceId?: unknown;
    warehouseExternalId?: unknown;
    maxBatches?: unknown;
  } | null;
  const marketplaceId = body?.marketplaceId === "ozon" || body?.marketplaceId === "wildberries"
    ? body.marketplaceId as MarketplaceId
    : null;
  if (!marketplaceId) return Response.json({ error: "Укажите площадку: ozon или wildberries." }, { status: 400 });

  const warehouseExternalId = typeof body?.warehouseExternalId === "string" && body.warehouseExternalId.trim()
    ? body.warehouseExternalId.trim()
    : null;
  const maxBatchesRaw = Number(body?.maxBatches);
  const maxBatches = Number.isFinite(maxBatchesRaw) && maxBatchesRaw > 0 ? Math.trunc(maxBatchesRaw) : null;

  const result = await createPickTasks(runtime.DB, {
    marketplaceId,
    warehouseExternalId,
    maxBatches,
    actorEmail: auth.user.email,
  });
  return Response.json({
    ok: result.created.length > 0,
    created: result.created,
    skipped: result.skipped,
  });
}
