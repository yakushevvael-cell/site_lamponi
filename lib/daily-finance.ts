/**
 * Выкупы и возвраты по дням — из финансовых данных площадок.
 *
 * Заказы мы и так знаем: они лежат в таблице `orders` с датой заказа и ценой
 * продавца. А вот «на какую сумму выкупили в этот день» из списка отправлений
 * не считается: ни Ozon, ни Wildberries не отдают там дату вручения покупателю.
 * Поэтому выкупы берутся из финансовых данных:
 *
 *   Ozon        — /v3/finance/transaction/list, поле accruals_for_sale
 *                 (стоимость товаров по цене продавца);
 *   Wildberries — отчёт «Продажи», поле priceWithDisc (цена со скидкой продавца).
 *
 * Хранится агрегат по дням. Каждая синхронизация пересчитывает весь период
 * заново и перезаписывает дни целиком — так поздние правки на стороне площадки
 * (возвраты, сторно) не оставляют в базе устаревших сумм.
 *
 * Сама арифметика — в lib/daily-finance-core.mjs, чтобы её проверяли тесты.
 */
import { getMarketplaceCredentials } from "@/lib/credentials";
import { getOzonFinanceOperations, type OzonFinanceOperation } from "@/lib/ozon";
import { getWildberriesSales, type WildberriesSale } from "@/lib/wildberries";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import {
  aggregateOzonOperations as aggregateOzonCore,
  aggregateWildberriesSales as aggregateWildberriesCore,
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

export function marketplaceDay(value: string): string {
  return marketplaceDayCore(value) as string;
}

export function aggregateOzonOperations(operations: OzonFinanceOperation[]): DailyFinanceRow[] {
  return aggregateOzonCore(operations) as DailyFinanceRow[];
}

export function aggregateWildberriesSales(sales: WildberriesSale[]): DailyFinanceRow[] {
  return aggregateWildberriesCore(sales) as DailyFinanceRow[];
}

async function replaceDays(
  db: D1Database,
  marketplaceId: string,
  fromDate: string,
  toDate: string,
  rows: DailyFinanceRow[],
) {
  const statements = [
    db.prepare("DELETE FROM marketplace_daily_finance WHERE marketplace_id = ? AND date >= ? AND date <= ?")
      .bind(marketplaceId, fromDate, toDate),
    ...rows
      .filter((row) => row.date >= fromDate && row.date <= toDate)
      .map((row) => db.prepare(
        `INSERT INTO marketplace_daily_finance
           (marketplace_id, date, buyout_amount, buyout_count, buyout_units, return_amount, return_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).bind(marketplaceId, row.date, row.buyoutAmount, row.buyoutCount, row.buyoutUnits, row.returnAmount, row.returnCount)),
  ];
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }
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
  days?: number;
  operations?: number;
};

export async function syncOzonFinance(db: D1Database, runtime: AppRuntimeEnv, days: number): Promise<FinanceSyncResult> {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) {
    return { marketplace: "ozon", skipped: true, reason: "ключи Ozon не добавлены" };
  }
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const operations = await getOzonFinanceOperations(
    credentials.OZON_CLIENT_ID,
    credentials.OZON_API_KEY,
    from.toISOString(),
    to.toISOString(),
  );
  const rows = aggregateOzonOperations(operations);
  await replaceDays(db, "ozon", marketplaceDay(from.toISOString()), marketplaceDay(to.toISOString()), rows);
  await logSync(db, "ozon", `Финансовые операции за ${days} дн.: ${operations.length}`, operations.length);
  return { marketplace: "ozon", skipped: false, days: rows.length, operations: operations.length };
}

export async function syncWildberriesFinance(db: D1Database, runtime: AppRuntimeEnv, days: number): Promise<FinanceSyncResult> {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) {
    return { marketplace: "wildberries", skipped: true, reason: "ключ Wildberries не добавлен" };
  }
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const sales = await getWildberriesSales(credentials.WB_API_TOKEN, from.toISOString().slice(0, 19));
  const rows = aggregateWildberriesSales(sales);
  await replaceDays(db, "wildberries", marketplaceDay(from.toISOString()), marketplaceDay(to.toISOString()), rows);
  await logSync(db, "wildberries", `Строк отчёта о продажах за ${days} дн.: ${sales.length}`, sales.length);
  return { marketplace: "wildberries", skipped: false, days: rows.length, operations: sales.length };
}

export async function readDailyFinance(db: D1Database, marketplaceId: string, sinceDate: string) {
  const result = await db.prepare(
    `SELECT date, buyout_amount AS buyoutAmount, buyout_count AS buyoutCount,
            buyout_units AS buyoutUnits, return_amount AS returnAmount, return_count AS returnCount
     FROM marketplace_daily_finance
     WHERE marketplace_id = ? AND date >= ?
     ORDER BY date`,
  ).bind(marketplaceId, sinceDate).all<DailyFinanceRow>();
  return result.results;
}
