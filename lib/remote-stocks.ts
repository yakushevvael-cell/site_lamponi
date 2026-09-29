import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { getMarketplaceCredentials } from "@/lib/credentials";
import { getOzonStocksByWarehouse } from "@/lib/ozon";
import { getWildberriesStocks } from "@/lib/wildberries";
import { getYandexOfferStocks } from "@/lib/yandex";

/**
 * Чтение фактических остатков с площадок — только чтение, ничего не шлёт.
 *
 * Им пользуются два места: кнопка «Что на площадке» на странице «Остатки» и
 * фоновая проверка через 10 минут после корректировки (lib/stock-checks).
 * Раньше чтение жило прямо в маршруте кнопки; вторая копия со временем
 * разошлась бы с первой.
 *
 * Спрашиваются все активные склады, а не только те, где включена выгрузка:
 * смысл в том и есть, чтобы видеть склад и до его включения.
 */

export type RemoteMarketplaceId = "wildberries" | "ozon" | "yandex";

export const REMOTE_MARKETPLACES: RemoteMarketplaceId[] = ["wildberries", "ozon", "yandex"];

export type RemoteMapping = { sourceSku: string; marketplaceId: RemoteMarketplaceId; externalSku: string };

export type LocalWarehouse = { externalId: string; name: string; publishFullStock: number };

export type RemoteWarehouseStock = {
  warehouseId: string;
  warehouseName: string;
  publishing: boolean;
  amount: number;
  reserved: number | null;
};

export type RemoteReadResult = {
  /** Активные склады площадки по нашему списку «Склады площадок». */
  warehouses: Record<RemoteMarketplaceId, LocalWarehouse[]>;
  /** Ключ `площадка::внешний SKU` → что лежит по складам. */
  stocks: Map<string, RemoteWarehouseStock[]>;
  /** Ключ `площадка::склад` или `площадка::*` (вся площадка) → почему не прочитано. */
  errors: Map<string, string>;
  failures: string[];
};

export function remoteKey(marketplaceId: string, externalSku: string) {
  return `${marketplaceId}::${externalSku}`;
}

function messageOf(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback).slice(0, 300);
}

async function readWarehouses(db: D1Database, marketplaceId: RemoteMarketplaceId) {
  const rows = await db.prepare(
    `SELECT external_id AS externalId, name, publish_full_stock AS publishFullStock
     FROM marketplace_warehouses
     WHERE marketplace_id = ? AND remote_active = 1
     ORDER BY name`,
  ).bind(marketplaceId).all<LocalWarehouse>();
  return rows.results;
}

/** Активные сопоставления позиций со всеми площадками. */
export async function readRemoteMappings(db: D1Database, sourceSkus: string[]) {
  if (sourceSkus.length === 0) return [];
  const placeholders = sourceSkus.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT product_sku AS sourceSku, marketplace_id AS marketplaceId, external_sku AS externalSku
     FROM sku_mappings
     WHERE active = 1 AND marketplace_id IN ('wildberries', 'ozon', 'yandex') AND product_sku IN (${placeholders})`,
  ).bind(...sourceSkus).all<RemoteMapping>();
  return rows.results;
}

function push(target: Map<string, RemoteWarehouseStock[]>, key: string, value: RemoteWarehouseStock) {
  const list = target.get(key) ?? [];
  list.push(value);
  target.set(key, list);
}

export async function readRemoteStocks(
  db: D1Database,
  runtime: AppRuntimeEnv,
  mappings: RemoteMapping[],
): Promise<RemoteReadResult> {
  const result: RemoteReadResult = {
    warehouses: { wildberries: [], ozon: [], yandex: [] },
    stocks: new Map(),
    errors: new Map(),
    failures: [],
  };
  const byMarketplace = (id: RemoteMarketplaceId) => mappings.filter((row) => row.marketplaceId === id);

  const wbMappings = byMarketplace("wildberries");
  if (wbMappings.length > 0) {
    try {
      result.warehouses.wildberries = await readWarehouses(db, "wildberries");
      const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
      if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
      if (result.warehouses.wildberries.length === 0) throw new Error("Активных складов Wildberries нет. Обновите список складов.");
      const chrtIds = wbMappings
        .map((row) => Number(row.externalSku))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      // WB отвечает по одному складу за запрос: сбой одного склада не должен
      // прятать остальные.
      for (const warehouse of result.warehouses.wildberries) {
        try {
          const stocks = await getWildberriesStocks(credentials.WB_API_TOKEN, warehouse.externalId, chrtIds);
          for (const stock of stocks) {
            push(result.stocks, remoteKey("wildberries", String(stock.chrtId)), {
              warehouseId: warehouse.externalId,
              warehouseName: warehouse.name,
              publishing: Boolean(warehouse.publishFullStock),
              amount: Number(stock.amount) || 0,
              // WB отдаёт только итоговое количество, резерв в этом ответе не приходит.
              reserved: null,
            });
          }
        } catch (error) {
          const message = messageOf(error, "склад не ответил");
          result.errors.set(`wildberries::${warehouse.externalId}`, message);
          result.failures.push(`Wildberries, ${warehouse.name}: ${message}`);
        }
      }
    } catch (error) {
      const message = messageOf(error, "не удалось прочитать остатки");
      result.errors.set("wildberries::*", message);
      result.failures.push(`Wildberries: ${message}`);
    }
  }

  const ozonMappings = byMarketplace("ozon");
  if (ozonMappings.length > 0) {
    try {
      result.warehouses.ozon = await readWarehouses(db, "ozon");
      const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
      if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Client-Id или API-ключ Ozon не добавлен.");
      const publishing = new Map(result.warehouses.ozon.map((warehouse) => [warehouse.externalId, Boolean(warehouse.publishFullStock)]));
      const stocks = await getOzonStocksByWarehouse(
        credentials.OZON_CLIENT_ID,
        credentials.OZON_API_KEY,
        ozonMappings.map((row) => row.externalSku),
      );
      for (const stock of stocks) {
        push(result.stocks, remoteKey("ozon", stock.offerId), {
          warehouseId: String(stock.warehouseId),
          warehouseName: stock.warehouseName,
          publishing: publishing.get(String(stock.warehouseId)) ?? false,
          amount: Number(stock.present) || 0,
          reserved: Number(stock.reserved) || 0,
        });
      }
    } catch (error) {
      const message = messageOf(error, "не удалось прочитать остатки");
      result.errors.set("ozon::*", message);
      result.failures.push(`Ozon: ${message}`);
    }
  }

  const yandexMappings = byMarketplace("yandex");
  if (yandexMappings.length > 0) {
    try {
      result.warehouses.yandex = await readWarehouses(db, "yandex");
      const credentials = await getMarketplaceCredentials(db, runtime, "yandex");
      const campaignId = String(credentials.YANDEX_CAMPAIGN_ID ?? "").trim();
      if (!credentials.YANDEX_API_KEY || !campaignId) throw new Error("Api-Key или номер магазина Яндекс Маркета не добавлен.");
      const stocks = await getYandexOfferStocks(credentials.YANDEX_API_KEY, campaignId, yandexMappings.map((row) => row.externalSku));
      // На DBS склад у нас один — магазин (его номер — campaignId). Маркет
      // может вернуть свой номер склада: всё относим к складу-магазину.
      const local = result.warehouses.yandex.find((warehouse) => warehouse.externalId === campaignId)
        ?? result.warehouses.yandex[0]
        ?? { externalId: campaignId, name: "Яндекс Маркет", publishFullStock: 0 };
      const summed = new Map<string, RemoteWarehouseStock>();
      for (const stock of stocks) {
        const known = result.warehouses.yandex.find((warehouse) => warehouse.externalId === stock.warehouseId) ?? local;
        const key = `${stock.offerId}::${known.externalId}`;
        const current = summed.get(key);
        if (current) {
          current.amount += stock.amount;
          current.reserved = current.reserved === null && stock.reserved === null ? null : (current.reserved ?? 0) + (stock.reserved ?? 0);
          continue;
        }
        const entry: RemoteWarehouseStock = {
          warehouseId: known.externalId,
          warehouseName: known.name,
          publishing: Boolean(known.publishFullStock),
          amount: stock.amount,
          reserved: stock.reserved,
        };
        summed.set(key, entry);
        push(result.stocks, remoteKey("yandex", stock.offerId), entry);
      }
    } catch (error) {
      const message = messageOf(error, "не удалось прочитать остатки");
      result.errors.set("yandex::*", message);
      result.failures.push(`Яндекс Маркет: ${message}`);
    }
  }

  return result;
}
