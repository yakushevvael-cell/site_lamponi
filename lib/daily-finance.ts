/**
 * Суточные показатели площадок для дашборда: заказы и выкупы.
 *
 * Почему это не считается из таблицы orders:
 *  — orders держит резервы и поэтому собирается только из отправлений своего
 *    склада (FBS). В кабинете площадки продавец видит и заказы со склада
 *    площадки, поэтому суммы там больше, и сравнение не сходится;
 *  — дату выкупа список отправлений не отдаёт вовсе: у Ozon её знает только
 *    финансовый отчёт, у Wildberries — отчёт «Продажи».
 *
 * Поэтому дашборд считает по своим суточным таблицам. Каждая синхронизация
 * пересчитывает период целиком и перезаписывает дни — поздние возвраты и
 * отмены не оставляют устаревших сумм.
 *
 * Арифметика — в lib/daily-finance-core.mjs, чтобы её проверяли тесты.
 */
import { getMarketplaceCredentials } from "@/lib/credentials";
import {
  getOzonAccrualTypes,
  getOzonFboPostings,
  getOzonPostingAccruals,
  getOzonPostings,
  ozonProductPrice,
  type OzonAccrual,
  type OzonAccrualType,
  type OzonPostingProduct,
} from "@/lib/ozon";
import {
  getWildberriesSales,
  getWildberriesStatOrders,
  type WildberriesSale,
  type WildberriesStatOrder,
} from "@/lib/wildberries";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import {
  aggregateOzonAccruals as aggregateOzonAccrualsCore,
  aggregateOzonOrderPostings as aggregateOzonOrderPostingsCore,
  aggregateWildberriesSales as aggregateWildberriesSalesCore,
  aggregateWildberriesStatOrders as aggregateWildberriesStatOrdersCore,
  classifyOzonAccrualTypes as classifyOzonAccrualTypesCore,
  marketplaceDay as marketplaceDayCore,
} from "./daily-finance-core.mjs";

export type DailyFinanceRow = {
  date: string;
  buyoutAmount: number;
  buyoutCount: number;
  buyoutUnits: number;
  returnAmount: number;
  returnCount: number;
};

export type DailyOrdersRow = {
  date: string;
  orderedAmount: number;
  orderedNetAmount: number;
  canceledAmount: number;
  orderedCount: number;
  orderedUnits: number;
};

type NormalizedPosting = {
  postingNumber: string;
  orderedAt: string;
  amount: number;
  units: number;
  canceled: boolean;
};

export function marketplaceDay(value: string): string {
  return marketplaceDayCore(value) as string;
}

export function aggregateOzonAccruals(
  accruals: OzonAccrual[],
  classification: { sale: number[]; refund: number[] },
): DailyFinanceRow[] {
  return aggregateOzonAccrualsCore(accruals, classification) as DailyFinanceRow[];
}

export function classifyOzonAccrualTypes(types: OzonAccrualType[]): { sale: number[]; refund: number[] } {
  return classifyOzonAccrualTypesCore(types) as { sale: number[]; refund: number[] };
}

export function aggregateWildberriesSales(sales: WildberriesSale[]): DailyFinanceRow[] {
  return aggregateWildberriesSalesCore(sales) as DailyFinanceRow[];
}

export function aggregateWildberriesStatOrders(orders: WildberriesStatOrder[]): DailyOrdersRow[] {
  return aggregateWildberriesStatOrdersCore(orders) as DailyOrdersRow[];
}

export function aggregateOzonOrderPostings(postings: NormalizedPosting[]): DailyOrdersRow[] {
  return aggregateOzonOrderPostingsCore(postings) as DailyOrdersRow[];
}

async function runBatch(db: D1Database, statements: D1PreparedStatement[]) {
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }
}

async function replaceFinanceDays(db: D1Database, marketplaceId: string, from: string, to: string, rows: DailyFinanceRow[]) {
  await runBatch(db, [
    db.prepare("DELETE FROM marketplace_daily_finance WHERE marketplace_id = ? AND date >= ? AND date <= ?")
      .bind(marketplaceId, from, to),
    ...rows.filter((row) => row.date >= from && row.date <= to).map((row) => db.prepare(
      `INSERT INTO marketplace_daily_finance
         (marketplace_id, date, buyout_amount, buyout_count, buyout_units, return_amount, return_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    ).bind(marketplaceId, row.date, row.buyoutAmount, row.buyoutCount, row.buyoutUnits, row.returnAmount, row.returnCount)),
  ]);
}

async function replaceOrderDays(db: D1Database, marketplaceId: string, from: string, to: string, rows: DailyOrdersRow[]) {
  await runBatch(db, [
    db.prepare("DELETE FROM marketplace_daily_orders WHERE marketplace_id = ? AND date >= ? AND date <= ?")
      .bind(marketplaceId, from, to),
    ...rows.filter((row) => row.date >= from && row.date <= to).map((row) => db.prepare(
      `INSERT INTO marketplace_daily_orders
         (marketplace_id, date, ordered_amount, ordered_net_amount, canceled_amount, ordered_count, ordered_units, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    ).bind(marketplaceId, row.date, row.orderedAmount, row.orderedNetAmount, row.canceledAmount, row.orderedCount, row.orderedUnits)),
  ]);
}

async function logSync(db: D1Database, marketplaceId: string, message: string, count: number) {
  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES (?, 'inbound', 'finance', 'success', ?, ?)`,
  ).bind(marketplaceId, count, message.slice(0, 500)).run();
}

export type FinanceSyncResult = {
  marketplace: string;
  skipped: boolean;
  reason?: string;
  orderDays?: number;
  buyoutDays?: number;
  note?: string;
};

const DELIVERED_OZON_STATUSES = new Set(["delivered"]);
const CANCELED_OZON_STATUSES = new Set(["cancelled", "canceled"]);

type OzonPostingLike = {
  posting_number: string;
  status?: string;
  in_process_at?: string;
  created_at?: string;
  shipment_date?: string;
  products?: OzonPostingProduct[];
};

function normalizeOzonPosting(posting: OzonPostingLike): NormalizedPosting & { delivered: boolean } {
  const products = Array.isArray(posting.products) ? posting.products : [];
  let amount = 0;
  let units = 0;
  for (const product of products) {
    const quantity = Math.max(1, Number(product.quantity ?? 1));
    amount += ozonProductPrice(product) * quantity;
    units += quantity;
  }
  const status = posting.status || "unknown";
  return {
    postingNumber: posting.posting_number,
    orderedAt: posting.in_process_at ?? posting.created_at ?? posting.shipment_date ?? new Date().toISOString(),
    amount,
    units,
    canceled: CANCELED_OZON_STATUSES.has(status),
    delivered: DELIVERED_OZON_STATUSES.has(status),
  };
}

export async function syncOzonDaily(db: D1Database, runtime: AppRuntimeEnv, days: number): Promise<FinanceSyncResult> {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) {
    return { marketplace: "ozon", skipped: true, reason: "ключи Ozon не добавлены" };
  }
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromDay = marketplaceDay(from.toISOString());
  const toDay = marketplaceDay(to.toISOString());

  const fbs = await getOzonPostings(clientId, apiKey, days);
  const fbo = await getOzonFboPostings(clientId, apiKey, days);
  const normalized: Array<NormalizedPosting & { delivered: boolean }> =
    [...fbs, ...fbo].map((posting) => normalizeOzonPosting(posting as OzonPostingLike));
  const orderRows = aggregateOzonOrderPostings(normalized);
  await replaceOrderDays(db, "ozon", fromDay, toDay, orderRows);

  // Выкупы: дату вручения знают только начисления, поэтому спрашиваем их
  // по доставленным отправлениям.
  let note = "";
  let buyoutRows: DailyFinanceRow[] = [];
  let types: OzonAccrualType[] = [];
  try {
    types = await getOzonAccrualTypes(clientId, apiKey);
  } catch (error) {
    note = `справочник начислений недоступен: ${error instanceof Error ? error.message : "ошибка"}`;
  }
  const classification = classifyOzonAccrualTypes(types);
  const delivered = normalized.filter((posting) => posting.delivered).map((posting) => posting.postingNumber);
  const accruals = await getOzonPostingAccruals(clientId, apiKey, delivered);
  buyoutRows = aggregateOzonAccruals(accruals, classification);
  await replaceFinanceDays(db, "ozon", fromDay, toDay, buyoutRows);

  await logSync(
    db,
    "ozon",
    `За ${days} дн.: FBS ${fbs.length}, FBO ${fbo.length}, доставлено ${delivered.length}, начислений ${accruals.length}, ` +
    `типы продаж ${classification.sale.length}, возвратов ${classification.refund.length}. ${note}`,
    normalized.length,
  );
  return { marketplace: "ozon", skipped: false, orderDays: orderRows.length, buyoutDays: buyoutRows.length, note: note || undefined };
}

export async function syncWildberriesDaily(db: D1Database, runtime: AppRuntimeEnv, days: number): Promise<FinanceSyncResult> {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) {
    return { marketplace: "wildberries", skipped: true, reason: "ключ Wildberries не добавлен" };
  }
  const token = credentials.WB_API_TOKEN;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromDay = marketplaceDay(from.toISOString());
  const toDay = marketplaceDay(to.toISOString());
  const dateFrom = from.toISOString().slice(0, 19);

  const statOrders = await getWildberriesStatOrders(token, dateFrom);
  const orderRows = aggregateWildberriesStatOrders(statOrders);
  await replaceOrderDays(db, "wildberries", fromDay, toDay, orderRows);

  const sales = await getWildberriesSales(token, dateFrom);
  const buyoutRows = aggregateWildberriesSales(sales);
  await replaceFinanceDays(db, "wildberries", fromDay, toDay, buyoutRows);

  await logSync(
    db,
    "wildberries",
    `За ${days} дн.: строк заказов ${statOrders.length}, строк продаж ${sales.length}`,
    statOrders.length + sales.length,
  );
  return { marketplace: "wildberries", skipped: false, orderDays: orderRows.length, buyoutDays: buyoutRows.length };
}

export async function readDailyFinance(db: D1Database, marketplaceId: string, from: string, to: string) {
  const result = await db.prepare(
    `SELECT date, buyout_amount AS buyoutAmount, buyout_count AS buyoutCount,
            buyout_units AS buyoutUnits, return_amount AS returnAmount, return_count AS returnCount
     FROM marketplace_daily_finance
     WHERE marketplace_id = ? AND date >= ? AND date <= ?
     ORDER BY date`,
  ).bind(marketplaceId, from, to).all<DailyFinanceRow>();
  return result.results;
}

export async function readDailyOrders(db: D1Database, marketplaceId: string, from: string, to: string) {
  const result = await db.prepare(
    `SELECT date, ordered_amount AS orderedAmount, ordered_net_amount AS orderedNetAmount,
            canceled_amount AS canceledAmount, ordered_count AS orderedCount, ordered_units AS orderedUnits
     FROM marketplace_daily_orders
     WHERE marketplace_id = ? AND date >= ? AND date <= ?
     ORDER BY date`,
  ).bind(marketplaceId, from, to).all<DailyOrdersRow>();
  return result.results;
}
