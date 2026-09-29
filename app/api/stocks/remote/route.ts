import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { OSV_UNITS_SQL } from "@/lib/osv-units";
import {
  readRemoteMappings,
  readRemoteStocks,
  remoteKey,
  REMOTE_MARKETPLACES,
  type RemoteMarketplaceId,
  type RemoteWarehouseStock,
} from "@/lib/remote-stocks";
import { getRuntimeEnv } from "@/lib/runtime-env";

/**
 * Что на самом деле лежит на площадке.
 *
 * До этого маршрута страница «Остатки» показывала только свою сторону: ОСВ,
 * резерв, расчёт. Чему равен остаток в кабинете WB или Ozon прямо сейчас —
 * узнать было неоткуда, и расхождение всплывало уже после отправки. Особенно
 * больно, когда часть остатков выставлена вручную: понять, что именно
 * перезапишет синхронизация, было нельзя.
 *
 * Маршрут ничего не отправляет — только читает. Поэтому его не блокирует
 * стоп-кран выгрузки: смотреть на площадку под паузой как раз и нужно.
 *
 * Само чтение — в lib/remote-stocks: тем же кодом пользуется проверка
 * площадок через 10 минут после корректировки.
 */

const MAX_SELECTION = 50;

type BasisRow = {
  sourceSku: string;
  article: string | null;
  size: string | null;
  availableQuantity: number;
};

export type { RemoteWarehouseStock };

export type RemoteStockRow = {
  sourceSku: string;
  article: string | null;
  size: string | null;
  availableQuantity: number;
  marketplaces: Array<{
    marketplaceId: RemoteMarketplaceId;
    externalSku: string;
    warehouses: RemoteWarehouseStock[];
  }>;
};

export async function POST(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  if (!hasManagerAccess(auth.user)) return Response.json({ error: "Требуется полный доступ." }, { status: 403 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as { sourceSkus?: unknown } | null;
  const sourceSkus = Array.isArray(body?.sourceSkus)
    ? [...new Set((body.sourceSkus as unknown[])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()))]
    : [];
  if (sourceSkus.length === 0) return Response.json({ error: "Не выбрано ни одной позиции." }, { status: 400 });
  if (sourceSkus.length > MAX_SELECTION) {
    return Response.json({ error: `За один раз можно проверить не больше ${MAX_SELECTION} позиций.` }, { status: 400 });
  }

  const placeholders = sourceSkus.map(() => "?").join(", ");
  // Резерв и сопоставления читаются двумя запросами: если соединить их в один,
  // строки перемножатся и SUM по резерву удвоится.
  const basis = await db.prepare(
    `SELECT p.source_sku AS sourceSku,
            p.article AS article,
            p.size AS size,
            CASE WHEN p.manual_zero = 1 THEN 0 ELSE MAX(0, CAST(${OSV_UNITS_SQL}
              - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0)
              - p.safety_stock AS INTEGER)) END AS availableQuantity
     FROM products p
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     WHERE p.source_sku IN (${placeholders})
     GROUP BY p.source_sku, p.article, p.size, p.current_physical_qty, p.units_per_item, p.safety_stock, p.manual_zero
     ORDER BY p.article, p.size`,
  ).bind(...sourceSkus).all<BasisRow>();

  const mappings = await readRemoteMappings(db, sourceSkus);
  const remote = await readRemoteStocks(db, runtime, mappings);

  const rows: RemoteStockRow[] = basis.results.map((item) => ({
    sourceSku: item.sourceSku,
    article: item.article,
    size: item.size,
    availableQuantity: Number(item.availableQuantity) || 0,
    marketplaces: REMOTE_MARKETPLACES.flatMap((marketplaceId) => {
      const mapping = mappings.find((row) => row.sourceSku === item.sourceSku && row.marketplaceId === marketplaceId);
      if (!mapping) return [];
      return [{
        marketplaceId,
        externalSku: mapping.externalSku,
        warehouses: remote.stocks.get(remoteKey(marketplaceId, mapping.externalSku)) ?? [],
      }];
    }),
  }));
  const failures = remote.failures;

  return Response.json({
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    selected: sourceSkus.length,
    unmapped: rows.filter((row) => row.marketplaces.length === 0).map((row) => row.sourceSku),
    rows,
    failures,
  }, { status: failures.length > 0 ? 207 : 200 });
}
