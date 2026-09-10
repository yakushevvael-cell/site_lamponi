/**
 * Дашборд площадки: суммы заказов и выкупов по дням, по цене продавца.
 *
 * Заказы берутся из таблицы `orders` (цена продавца в момент заказа), выкупы —
 * из агрегата `marketplace_daily_finance`, который собирается из финансовых
 * данных площадок. Складывать их в одном запросе нельзя: у заказа и выкупа
 * разные даты, и день выкупа известен только площадке.
 */
import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { marketplaceDay, readDailyFinance } from "@/lib/daily-finance";

const MARKETPLACE_NAMES: Record<string, string> = {
  ozon: "Ozon",
  wildberries: "Wildberries",
};

type OrderRow = {
  orderedAt: string;
  amount: number;
  canceledAt: string | null;
  units: number;
};

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** CURRENT_TIMESTAMP пишет время в UTC без пояса — браузер иначе сдвинет его на часовой пояс. */
function asIsoUtc(value: string | null) {
  if (!value) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return `${value.replace(" ", "T")}Z`;
}

function emptyDay(date: string) {
  return {
    date,
    orderAmount: 0,
    orderNetAmount: 0,
    orderCount: 0,
    orderUnits: 0,
    canceledAmount: 0,
    buyoutAmount: 0,
    buyoutCount: 0,
    buyoutUnits: 0,
    returnAmount: 0,
  };
}

export async function GET(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const url = new URL(request.url);
  const marketplaceId = url.searchParams.get("marketplace") === "wildberries" ? "wildberries" : "ozon";
  const requestedDays = Number(url.searchParams.get("days") ?? 30);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;

  const sinceMs = Date.now() - (days - 1) * 86_400_000;
  const sinceDate = marketplaceDay(new Date(sinceMs).toISOString());
  // Заказ мог быть создан вечером по Москве, но храним мы UTC — берём с запасом в сутки.
  const sinceIso = new Date(sinceMs - 86_400_000).toISOString();

  const orderRows = await db.prepare(
    `SELECT o.ordered_at AS orderedAt, o.amount, o.canceled_at AS canceledAt,
            (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS units
     FROM orders o
     WHERE o.marketplace_id = ? AND o.ordered_at >= ?`,
  ).bind(marketplaceId, sinceIso).all<OrderRow>();

  const byDate = new Map<string, ReturnType<typeof emptyDay>>();
  const dayOf = (date: string) => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created = emptyDay(date);
    byDate.set(date, created);
    return created;
  };

  for (const order of orderRows.results) {
    const date = marketplaceDay(order.orderedAt);
    if (date < sinceDate) continue;
    const row = dayOf(date);
    const amount = Number(order.amount) || 0;
    const units = Number(order.units) || 0;
    row.orderAmount += amount;
    row.orderCount += 1;
    row.orderUnits += units;
    if (order.canceledAt) row.canceledAmount += amount;
    else row.orderNetAmount += amount;
  }

  for (const finance of await readDailyFinance(db, marketplaceId, sinceDate)) {
    const row = dayOf(finance.date);
    row.buyoutAmount += Number(finance.buyoutAmount) || 0;
    row.buyoutCount += Number(finance.buyoutCount) || 0;
    row.buyoutUnits += Number(finance.buyoutUnits) || 0;
    row.returnAmount += Number(finance.returnAmount) || 0;
  }

  // Пустые дни тоже нужны: без них график «склеивает» выходные с буднями.
  const series: Array<ReturnType<typeof emptyDay>> = [];
  for (let index = 0; index < days; index += 1) {
    const date = marketplaceDay(new Date(sinceMs + index * 86_400_000).toISOString());
    const row = byDate.get(date) ?? emptyDay(date);
    series.push({
      ...row,
      orderAmount: round(row.orderAmount),
      orderNetAmount: round(row.orderNetAmount),
      canceledAmount: round(row.canceledAmount),
      buyoutAmount: round(row.buyoutAmount),
      returnAmount: round(row.returnAmount),
      orderUnits: round(row.orderUnits, 3),
      buyoutUnits: round(row.buyoutUnits, 3),
    });
  }

  const sum = (pick: (row: (typeof series)[number]) => number) => series.reduce((total, row) => total + pick(row), 0);
  const orderAmount = sum((row) => row.orderAmount);
  const orderNetAmount = sum((row) => row.orderNetAmount);
  const orderCount = sum((row) => row.orderCount);
  const orderUnits = sum((row) => row.orderUnits);
  const buyoutAmount = sum((row) => row.buyoutAmount);
  const buyoutCount = sum((row) => row.buyoutCount);
  const buyoutUnits = sum((row) => row.buyoutUnits);
  const returnAmount = sum((row) => row.returnAmount);

  const lastSyncRows = await db.prepare(
    `SELECT kind, MAX(created_at) AS lastAt
     FROM sync_events
     WHERE marketplace_id = ? AND status = 'success' AND kind IN ('orders', 'finance')
     GROUP BY kind`,
  ).bind(marketplaceId).all<{ kind: string; lastAt: string | null }>();
  const lastSync = Object.fromEntries(lastSyncRows.results.map((row) => [row.kind, row.lastAt]));

  return Response.json({
    marketplace: marketplaceId,
    marketplaceName: MARKETPLACE_NAMES[marketplaceId],
    days,
    series,
    totals: {
      orderAmount: round(orderAmount),
      orderNetAmount: round(orderNetAmount),
      canceledAmount: round(orderAmount - orderNetAmount),
      orderCount,
      orderUnits: round(orderUnits, 3),
      buyoutAmount: round(buyoutAmount),
      buyoutCount,
      buyoutUnits: round(buyoutUnits, 3),
      returnAmount: round(returnAmount),
      // Средние цены — по цене продавца, за единицу товара.
      averageOrderPrice: orderUnits > 0 ? round(orderAmount / orderUnits) : null,
      averageOrderPricePerOrder: orderCount > 0 ? round(orderAmount / orderCount) : null,
      averageBuyoutPrice: buyoutUnits > 0 ? round(buyoutAmount / buyoutUnits) : null,
      averageBuyoutPricePerOrder: buyoutCount > 0 ? round(buyoutAmount / buyoutCount) : null,
    },
    financeReady: buyoutCount > 0 || buyoutAmount > 0,
    lastSync: {
      orders: asIsoUtc(lastSync.orders ?? null),
      finance: asIsoUtc(lastSync.finance ?? null),
    },
  });
}
