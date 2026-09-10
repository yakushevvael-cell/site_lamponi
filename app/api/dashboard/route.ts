/**
 * Дашборд площадки: суммы заказов и выкупов по дням, по цене продавца.
 *
 * Данные берутся из суточных таблиц (lib/daily-finance.ts). Пока они не
 * заполнены, заказы показываются из таблицы orders — там только отправления
 * своего склада, поэтому суммы получаются меньше кабинета; об этом
 * предупреждает поле ordersSource.
 */
import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { marketplaceDay, readDailyFinance, readDailyOrders } from "@/lib/daily-finance";

const MARKETPLACE_NAMES: Record<string, string> = {
  ozon: "Ozon",
  wildberries: "Wildberries",
};

const MAX_RANGE_DAYS = 370;

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

function isDay(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function addDays(day: string, count: number) {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + count));
  return shifted.toISOString().slice(0, 10);
}

function dayToUtc(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

function daysBetween(from: string, to: string) {
  return Math.round((dayToUtc(to) - dayToUtc(from)) / 86_400_000) + 1;
}

export async function GET(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const url = new URL(request.url);
  const marketplaceId = url.searchParams.get("marketplace") === "wildberries" ? "wildberries" : "ozon";
  const today = marketplaceDay(new Date().toISOString());

  const requestedTo = url.searchParams.get("to");
  const requestedFrom = url.searchParams.get("from");
  let toDay = isDay(requestedTo) ? requestedTo : today;
  let fromDay = isDay(requestedFrom) ? requestedFrom : addDays(toDay, -29);
  if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
  if (daysBetween(fromDay, toDay) > MAX_RANGE_DAYS) fromDay = addDays(toDay, -(MAX_RANGE_DAYS - 1));
  const dayCount = daysBetween(fromDay, toDay);

  const byDate = new Map<string, ReturnType<typeof emptyDay>>();
  const dayOf = (date: string) => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created = emptyDay(date);
    byDate.set(date, created);
    return created;
  };

  const dailyOrders = await readDailyOrders(db, marketplaceId, fromDay, toDay);
  let ordersSource: "daily" | "fbs" = "daily";

  if (dailyOrders.length > 0) {
    for (const row of dailyOrders) {
      const day = dayOf(row.date);
      day.orderAmount += Number(row.orderedAmount) || 0;
      day.orderNetAmount += Number(row.orderedNetAmount) || 0;
      day.canceledAmount += Number(row.canceledAmount) || 0;
      day.orderCount += Number(row.orderedCount) || 0;
      day.orderUnits += Number(row.orderedUnits) || 0;
    }
  } else {
    // Запасной путь до первой загрузки суточных данных.
    ordersSource = "fbs";
    const sinceIso = `${addDays(fromDay, -1)}T00:00:00.000Z`;
    const untilIso = `${addDays(toDay, 2)}T00:00:00.000Z`;
    const rows = await db.prepare(
      `SELECT o.ordered_at AS orderedAt, o.amount, o.canceled_at AS canceledAt,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS units
       FROM orders o
       WHERE o.marketplace_id = ? AND o.ordered_at >= ? AND o.ordered_at < ?`,
    ).bind(marketplaceId, sinceIso, untilIso).all<{ orderedAt: string; amount: number; canceledAt: string | null; units: number }>();
    for (const order of rows.results) {
      const date = marketplaceDay(order.orderedAt);
      if (date < fromDay || date > toDay) continue;
      const day = dayOf(date);
      const amount = Number(order.amount) || 0;
      day.orderAmount += amount;
      day.orderCount += 1;
      day.orderUnits += Number(order.units) || 0;
      if (order.canceledAt) day.canceledAmount += amount;
      else day.orderNetAmount += amount;
    }
  }

  for (const finance of await readDailyFinance(db, marketplaceId, fromDay, toDay)) {
    const day = dayOf(finance.date);
    day.buyoutAmount += Number(finance.buyoutAmount) || 0;
    day.buyoutCount += Number(finance.buyoutCount) || 0;
    day.buyoutUnits += Number(finance.buyoutUnits) || 0;
    day.returnAmount += Number(finance.returnAmount) || 0;
  }

  // Пустые дни тоже нужны: без них график «склеивает» выходные с буднями.
  const series: Array<ReturnType<typeof emptyDay>> = [];
  for (let index = 0; index < dayCount; index += 1) {
    const date = addDays(fromDay, index);
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
    from: fromDay,
    to: toDay,
    days: dayCount,
    ordersSource,
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
