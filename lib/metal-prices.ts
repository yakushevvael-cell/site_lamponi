/**
 * Цены на золото и серебро для дашборда: хранение последнего удачного
 * значения и последней попытки. Сами цены приносит фоновая задача
 * scripts/fetch-metal-prices.mjs раз в 2 часа.
 */
import { METAL_BOUNDS } from "@/lib/metal-prices-core.mjs";

export type MetalQuote = {
  last: number;
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePercent: number | null;
  /** Время котировки на ProFinance, ЧЧ:ММ:СС по Москве. */
  time: string | null;
};

export type MetalPrices = {
  gold: MetalQuote | null;
  silver: MetalQuote | null;
  source: string | null;
  /** Когда сохранено последнее удачное значение (ISO). */
  fetchedAt: string | null;
  /** Последняя попытка — удачная или нет (ISO). */
  attemptedAt: string | null;
  /** Текст ошибки последней попытки, если она не удалась. */
  error: string | null;
};

const PRICES_KEY = "metal_prices";
const STATUS_KEY = "metal_prices_status";

async function read(db: D1Database, key: string) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function write(db: D1Database, key: string, value: unknown) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, JSON.stringify(value)).run();
}

export async function readMetalPrices(db: D1Database): Promise<MetalPrices> {
  const [prices, status] = await Promise.all([read(db, PRICES_KEY), read(db, STATUS_KEY)]);
  return {
    gold: (prices?.gold as MetalQuote | undefined) ?? null,
    silver: (prices?.silver as MetalQuote | undefined) ?? null,
    source: typeof prices?.source === "string" ? prices.source : null,
    fetchedAt: typeof prices?.fetchedAt === "string" ? prices.fetchedAt : null,
    attemptedAt: typeof status?.attemptedAt === "string" ? status.attemptedAt : null,
    error: typeof status?.error === "string" ? status.error : null,
  };
}

function toQuote(value: unknown, bounds: { min: number; max: number }): MetalQuote | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const num = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : null);
  const last = num(raw.last);
  if (last === null || last < bounds.min || last > bounds.max) return null;
  return {
    last,
    bid: num(raw.bid),
    ask: num(raw.ask),
    change: num(raw.change),
    changePercent: num(raw.changePercent),
    time: typeof raw.time === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(raw.time) ? raw.time : null,
  };
}

/**
 * Сохраняет результат фоновой задачи. Неудачная попытка прошлую цену не
 * трогает — только отмечает ошибку.
 */
export async function saveMetalPrices(db: D1Database, body: Record<string, unknown>) {
  const now = new Date().toISOString();
  const source = typeof body.source === "string" ? body.source.slice(0, 200) : null;

  if (body.ok === true) {
    const gold = toQuote(body.gold, METAL_BOUNDS.gold);
    const silver = toQuote(body.silver, METAL_BOUNDS.silver);
    if (!gold || !silver) {
      await write(db, STATUS_KEY, { attemptedAt: now, error: "Цены пришли в неверном виде или вне разумных границ." });
      return { ok: false as const, error: "Цены не прошли проверку." };
    }
    await write(db, PRICES_KEY, { gold, silver, source, fetchedAt: now });
    await write(db, STATUS_KEY, { attemptedAt: now, error: null });
    return { ok: true as const };
  }

  const error = typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 500) : "Цены не получены.";
  await write(db, STATUS_KEY, { attemptedAt: now, error });
  return { ok: true as const };
}
