import { authorizeApi, hasManagerAccess } from "@/lib/app-auth";
import { getMarketplaceCredentials } from "@/lib/credentials";
import { getOzonStocksByWarehouse } from "@/lib/ozon";
import { OSV_UNITS_SQL } from "@/lib/osv-units";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { getWildberriesStocks } from "@/lib/wildberries";

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
 * Спрашиваем все активные склады, а не только те, где включена выгрузка:
 * смысл в том и есть, чтобы увидеть склад до его включения.
 */

const MAX_SELECTION = 50;

type BasisRow = {
  sourceSku: string;
  article: string | null;
  size: string | null;
  availableQuantity: number;
};

type MappingRow = { sourceSku: string; marketplaceId: string; externalSku: string };
type WarehouseRow = { externalId: string; name: string; publishFullStock: number };

export type RemoteWarehouseStock = {
  warehouseId: string;
  warehouseName: string;
  publishing: boolean;
  amount: number;
  reserved: number | null;
};

export type RemoteStockRow = {
  sourceSku: string;
  article: string | null;
  size: string | null;
  availableQuantity: number;
  marketplaces: Array<{
    marketplaceId: "wildberries" | "ozon";
    externalSku: string;
    warehouses: RemoteWarehouseStock[];
  }>;
};

async function readWarehouses(db: D1Database, marketplaceId: string) {
  const rows = await db.prepare(
    `SELECT external_id AS externalId, name, publish_full_stock AS publishFullStock
     FROM marketplace_warehouses
     WHERE marketplace_id = ? AND remote_active = 1
     ORDER BY name`,
  ).bind(marketplaceId).all<WarehouseRow>();
  return rows.results;
}

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

  const mappings = await db.prepare(
    `SELECT product_sku AS sourceSku, marketplace_id AS marketplaceId, external_sku AS externalSku
     FROM sku_mappings
     WHERE active = 1 AND marketplace_id IN ('wildberries', 'ozon') AND product_sku IN (${placeholders})`,
  ).bind(...sourceSkus).all<MappingRow>();

  const wbMappings = mappings.results.filter((row) => row.marketplaceId === "wildberries");
  const ozonMappings = mappings.results.filter((row) => row.marketplaceId === "ozon");
  const failures: string[] = [];

  /** Фактические остатки: ключ «внешний SKU» → строки по складам. */
  const wbRemote = new Map<string, RemoteWarehouseStock[]>();
  const ozonRemote = new Map<string, RemoteWarehouseStock[]>();

  if (wbMappings.length > 0) {
    try {
      const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
      if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
      const warehouses = await readWarehouses(db, "wildberries");
      if (warehouses.length === 0) throw new Error("Активных складов Wildberries нет. Обновите список складов.");
      const chrtIds = wbMappings
        .map((row) => Number(row.externalSku))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      for (const warehouse of warehouses) {
        try {
          const stocks = await getWildberriesStocks(credentials.WB_API_TOKEN, warehouse.externalId, chrtIds);
          for (const stock of stocks) {
            const key = String(stock.chrtId);
            const list = wbRemote.get(key) ?? [];
            list.push({
              warehouseId: warehouse.externalId,
              warehouseName: warehouse.name,
              publishing: Boolean(warehouse.publishFullStock),
              amount: Number(stock.amount) || 0,
              // WB отдаёт только итоговое количество, резерв в этом ответе не приходит.
              reserved: null,
            });
            wbRemote.set(key, list);
          }
        } catch (error) {
          failures.push(`Wildberries, ${warehouse.name}: ${error instanceof Error ? error.message : "склад не ответил"}`);
        }
      }
    } catch (error) {
      failures.push(`Wildberries: ${error instanceof Error ? error.message : "не удалось прочитать остатки"}`);
    }
  }

  if (ozonMappings.length > 0) {
    try {
      const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
      if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Client-Id или API-ключ Ozon не добавлен.");
      const publishingByWarehouse = new Map(
        (await readWarehouses(db, "ozon")).map((warehouse) => [warehouse.externalId, Boolean(warehouse.publishFullStock)]),
      );
      const stocks = await getOzonStocksByWarehouse(
        credentials.OZON_CLIENT_ID,
        credentials.OZON_API_KEY,
        ozonMappings.map((row) => row.externalSku),
      );
      for (const stock of stocks) {
        const list = ozonRemote.get(stock.offerId) ?? [];
        list.push({
          warehouseId: String(stock.warehouseId),
          warehouseName: stock.warehouseName,
          publishing: publishingByWarehouse.get(String(stock.warehouseId)) ?? false,
          amount: Number(stock.present) || 0,
          reserved: Number(stock.reserved) || 0,
        });
        ozonRemote.set(stock.offerId, list);
      }
    } catch (error) {
      failures.push(`Ozon: ${error instanceof Error ? error.message : "не удалось прочитать остатки"}`);
    }
  }

  const wbBySku = new Map(wbMappings.map((row) => [row.sourceSku, row.externalSku]));
  const ozonBySku = new Map(ozonMappings.map((row) => [row.sourceSku, row.externalSku]));

  const rows: RemoteStockRow[] = basis.results.map((item) => {
    const marketplaces: RemoteStockRow["marketplaces"] = [];
    const wbSku = wbBySku.get(item.sourceSku);
    if (wbSku) {
      marketplaces.push({ marketplaceId: "wildberries", externalSku: wbSku, warehouses: wbRemote.get(wbSku) ?? [] });
    }
    const ozonSku = ozonBySku.get(item.sourceSku);
    if (ozonSku) {
      marketplaces.push({ marketplaceId: "ozon", externalSku: ozonSku, warehouses: ozonRemote.get(ozonSku) ?? [] });
    }
    return {
      sourceSku: item.sourceSku,
      article: item.article,
      size: item.size,
      availableQuantity: Number(item.availableQuantity) || 0,
      marketplaces,
    };
  });

  return Response.json({
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    selected: sourceSkus.length,
    unmapped: rows.filter((row) => row.marketplaces.length === 0).map((row) => row.sourceSku),
    rows,
    failures,
  }, { status: failures.length > 0 ? 207 : 200 });
}
