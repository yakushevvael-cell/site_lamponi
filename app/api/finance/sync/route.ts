import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { syncOzonFinance, syncWildberriesFinance, type FinanceSyncResult } from "@/lib/daily-finance";

/** Как часто финансовые данные обновляются без явной просьбы. */
const THROTTLE_MS = 30 * 60 * 1000;
const ALLOWED_MARKETPLACES = new Set(["ozon", "wildberries"]);

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  let days = 30;
  let force = false;
  let only: string | null = null;
  try {
    const body = await request.json() as { days?: number; force?: boolean; marketplace?: string };
    const requested = Number(body.days);
    if (Number.isFinite(requested)) days = Math.min(180, Math.max(7, Math.round(requested)));
    force = body.force === true;
    if (typeof body.marketplace === "string" && ALLOWED_MARKETPLACES.has(body.marketplace)) only = body.marketplace;
  } catch {
    // Значения по умолчанию: 30 дней, обе площадки.
  }

  const settingKey = `finance_sync_at_${only ?? "all"}`;
  if (!force) {
    const last = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(settingKey).first<{ value: string }>();
    const lastMs = last?.value ? new Date(last.value).getTime() : 0;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < THROTTLE_MS) {
      return Response.json({ ok: true, days, cached: true, results: [], errors: [] });
    }
  }

  const tasks: Array<[string, () => Promise<FinanceSyncResult>]> = [];
  if (!only || only === "ozon") tasks.push(["ozon", () => syncOzonFinance(db, runtime, days)]);
  if (!only || only === "wildberries") tasks.push(["wildberries", () => syncWildberriesFinance(db, runtime, days)]);

  const results: FinanceSyncResult[] = [];
  const errors: Array<{ marketplace: string; message: string }> = [];
  for (const [marketplace, run] of tasks) {
    try {
      results.push(await run());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось получить финансовые данные";
      errors.push({ marketplace, message });
      await db.prepare(
        `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
         VALUES (?, 'inbound', 'finance', 'error', 0, ?)`,
      ).bind(marketplace, message.slice(0, 500)).run().catch(() => undefined);
    }
  }

  if (results.some((result) => !result.skipped)) {
    await db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(settingKey, new Date().toISOString()).run();
  }

  return Response.json({ ok: errors.length === 0, days, results, errors }, { status: errors.length ? 207 : 200 });
}
