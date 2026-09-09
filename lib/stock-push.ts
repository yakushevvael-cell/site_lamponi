import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { getMarketplaceCredentials } from "@/lib/credentials";
import { getOzonStocksByWarehouse, updateOzonStocks } from "@/lib/ozon";
import { collectReserveDrift, rebuildReservations } from "@/lib/reservations";
import { finishSyncRun, logStockRows, newRunId, startSyncRun, type LogRow, type SyncTrigger } from "@/lib/stock-log";
import { buildSendableRow, isStockGuardError, type SendableRow } from "@/lib/stock-math";
import { updateWildberriesStocks } from "@/lib/wildberries";
import { OSV_UNITS_SQL } from "@/lib/osv-units";

/**
 * Отправка остатков по списку позиций.
 *
 * Один и тот же код используют два сценария:
 *  - ручная кнопка «Синхронизировать выбранные» (человек отметил несколько SKU);
 *  - автоматическая доотправка после загрузки заказов (список берётся из очереди
 *    изменившихся позиций, lib/stock-queue).
 *
 * Полная синхронизация (app/api/stocks/sync-all) осталась отдельной: тысячи
 * товаров не помещаются в один запрос и идут заданием в несколько шагов. Здесь
 * список заведомо короткий, поэтому всё делается за один заход.
 *
 * Формула, гард от некорректных значений и запись в журнал — общие:
 * lib/stock-math и lib/stock-log, отдельной арифметики здесь нет.
 */

type MarketplaceId = "wildberries" | "ozon";
type Warehouse = { externalId: string; name: string };

type StockBasisRow = {
  sourceSku: string;
  externalSku: string;
  article: string | null;
  size: string | null;
  osvQty: number;
  reserveQty: number;
  safetyStock: number;
  manualZero: number;
};

/** Строка отчёта: что посчитали и что произошло при отправке. */
export type ResultRow = {
  marketplaceId: MarketplaceId;
  warehouseId: string;
  warehouseName: string;
  sourceSku: string;
  externalSku: string;
  article: string | null;
  size: string | null;
  osvQty: number;
  reserveQty: number;
  computedQty: number;
  sentQty: number;
  status: "success" | "error" | "skipped" | "blocked";
  message: string | null;
};

function messageFrom(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback).slice(0, 300);
}

async function readWarehouses(db: D1Database, marketplaceId: MarketplaceId) {
  const rows = await db.prepare(
    `SELECT external_id AS externalId, name
     FROM marketplace_warehouses
     WHERE marketplace_id = ? AND remote_active = 1 AND publish_full_stock = 1
     ORDER BY name`,
  ).bind(marketplaceId).all<Warehouse>();
  return rows.results;
}

/** Сырые величины по выбранным товарам: расчёт делает lib/stock-math. */
async function readSelectedBasis(db: D1Database, marketplaceId: MarketplaceId, sourceSkus: string[]) {
  const placeholders = sourceSkus.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT p.source_sku AS sourceSku,
            sm.external_sku AS externalSku,
            p.article AS article,
            p.size AS size,
            ${OSV_UNITS_SQL} AS osvQty,
            COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reserveQty,
            p.safety_stock AS safetyStock,
            p.manual_zero AS manualZero
     FROM products p
     JOIN sku_mappings sm ON sm.product_sku = p.source_sku AND sm.marketplace_id = ? AND sm.active = 1
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     WHERE p.source_sku IN (${placeholders})
     GROUP BY p.source_sku, sm.external_sku, p.article, p.size,
              p.current_physical_qty, p.safety_stock, p.manual_zero
     ORDER BY sm.external_sku`,
  ).bind(marketplaceId, ...sourceSkus).all<StockBasisRow>();
  return rows.results;
}

async function markWarehouseSync(
  db: D1Database,
  marketplaceId: MarketplaceId,
  warehouseId: string,
  ok: boolean,
  error?: string | null,
) {
  await db.prepare(
    `UPDATE marketplace_warehouses
     SET sync_status = ?, sync_error = ?,
         last_stock_sync_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_stock_sync_at END
     WHERE marketplace_id = ? AND external_id = ?`,
  ).bind(ok ? "ok" : "error", ok ? null : (error ?? "").slice(0, 500), ok ? 1 : 0, marketplaceId, warehouseId).run();
}

export type PushStocksOptions = {
  db: D1Database;
  runtime: AppRuntimeEnv;
  sourceSkus: string[];
  actorEmail: string;
  trigger: SyncTrigger;
  /** Подпись сценария в журнале событий: «Выборочная синхронизация», «Доотправка после заказов». */
  label: string;
};

export type PushStocksResult = {
  ok: boolean;
  runId: string;
  selected: number;
  unmapped: string[];
  wildberries: { warehouseCount: number; mappingCount: number; sent: number };
  ozon: { warehouseCount: number; mappingCount: number; sent: number; reserveDrift: number };
  failures: string[];
  rows: ResultRow[];
};

/** Если отправлять не с чего или некуда, возвращает { error } — вызывающий решает, что с этим делать. */
export async function pushStocksForSkus(options: PushStocksOptions): Promise<PushStocksResult | { error: string }> {
  const { db, runtime, sourceSkus, actorEmail, trigger, label } = options;
  const osvRow = await db.prepare("SELECT id FROM osv_uploads ORDER BY id DESC LIMIT 1").first<{ id: number }>();
  const osvUploadId = osvRow?.id ?? null;
  if (osvUploadId === null) {
    return { error: "ОСВ ещё не загружена. Остатки отправлять не с чего." };
  }

  // Резерв пересчитывается перед отправкой: остаток считается от свежих заказов,
  // а не от того, что осталось от прошлой загрузки.
  await rebuildReservations(db).catch(() => undefined);

  const [wbWarehouses, ozonWarehouses] = await Promise.all([
    readWarehouses(db, "wildberries"),
    readWarehouses(db, "ozon"),
  ]);
  if (wbWarehouses.length === 0 && ozonWarehouses.length === 0) {
    return { error: "Нет складов с включённой выгрузкой остатков. Включите нужный склад на вкладке «Склады»." };
  }

  const runId = newRunId();
  await startSyncRun(db, { runId, trigger, actorEmail, osvUploadId });

  const resultRows: ResultRow[] = [];
  const logRows: LogRow[] = [];
  const failures: string[] = [];
  let wbSent = 0;
  let ozonSent = 0;
  let reserveDrift = 0;

  const wbBasis = wbWarehouses.length > 0 ? await readSelectedBasis(db, "wildberries", sourceSkus) : [];
  const ozonBasis = ozonWarehouses.length > 0 ? await readSelectedBasis(db, "ozon", sourceSkus) : [];
  const mappedSkus = new Set([...wbBasis, ...ozonBasis].map((item) => item.sourceSku));
  const unmapped = sourceSkus.filter((sku) => !mappedSkus.has(sku));

  // --- Wildberries: остатки отправляются по каждому включённому складу отдельно.
  for (const warehouse of wbWarehouses) {
    if (wbBasis.length === 0) {
      failures.push("Для выбранных позиций нет активных сопоставлений Wildberries.");
      break;
    }
    let rows: SendableRow[] = [];
    try {
      const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
      if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");

      // Гард в buildSendableRow: если хоть одна строка некорректна,
      // на площадку не уходит ни одного запроса.
      rows = wbBasis.map((item) => buildSendableRow({
        marketplaceId: "wildberries",
        warehouseId: warehouse.externalId,
        externalSku: item.externalSku,
        productSku: item.sourceSku,
        article: item.article,
        size: item.size,
        osvQty: item.osvQty,
        reserveQty: item.reserveQty,
        safetyStock: item.safetyStock,
        manualZero: Boolean(item.manualZero),
      }));

      const stocks = rows
        .map((row) => ({ chrtId: Number(row.externalSku), amount: row.sentQty }))
        .filter((stock) => Number.isSafeInteger(stock.chrtId) && stock.chrtId > 0);
      if (stocks.length !== rows.length) {
        throw new Error(`Некорректных сопоставлений Wildberries: ${rows.length - stocks.length}. Остатки не отправлялись.`);
      }

      await updateWildberriesStocks(credentials.WB_API_TOKEN, warehouse.externalId, stocks);
      wbSent += stocks.length;
      await markWarehouseSync(db, "wildberries", warehouse.externalId, true);
      for (const row of rows) {
        logRows.push({ ...row, apiStatus: "success" });
        resultRows.push({
          marketplaceId: "wildberries",
          warehouseId: warehouse.externalId,
          warehouseName: warehouse.name,
          sourceSku: row.productSku ?? "",
          externalSku: row.externalSku,
          article: row.article,
          size: row.size,
          osvQty: row.osvQty,
          reserveQty: row.reserveQty,
          computedQty: row.computedQty,
          sentQty: row.sentQty,
          status: "success",
          message: null,
        });
      }
    } catch (error) {
      const guard = isStockGuardError(error);
      const message = messageFrom(error, `Не удалось обновить склад ${warehouse.name}.`);
      failures.push(`Wildberries, ${warehouse.name}: ${message}`);
      await markWarehouseSync(db, "wildberries", warehouse.externalId, false, message);
      logRows.push({
        ...(guard ? (error as { row: Partial<SendableRow> }).row : { warehouseId: warehouse.externalId }),
        marketplaceId: "wildberries",
        apiStatus: guard ? "blocked" : "error",
        apiMessage: message,
      } as LogRow);
      for (const item of wbBasis) {
        resultRows.push({
          marketplaceId: "wildberries",
          warehouseId: warehouse.externalId,
          warehouseName: warehouse.name,
          sourceSku: item.sourceSku,
          externalSku: item.externalSku,
          article: item.article,
          size: item.size,
          osvQty: item.osvQty,
          reserveQty: item.reserveQty,
          computedQty: 0,
          sentQty: 0,
          status: guard ? "blocked" : "error",
          message,
        });
      }
    }
  }

  // --- Ozon: значения отправляются парами «товар–склад» одним запросом.
  if (ozonWarehouses.length > 0) {
    if (ozonBasis.length === 0) {
      failures.push("Для выбранных позиций нет активных сопоставлений Ozon.");
    } else {
      try {
        const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
        if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Client-Id или API-ключ Ozon не добавлен.");

        const basisByOffer = new Map(ozonBasis.map((item) => [item.externalSku, item]));
        const enabledWarehouses = new Map(ozonWarehouses.map((warehouse) => [warehouse.externalId, warehouse]));
        const remoteStocks = await getOzonStocksByWarehouse(
          credentials.OZON_CLIENT_ID,
          credentials.OZON_API_KEY,
          ozonBasis.map((item) => item.externalSku),
        );

        // Товар, которого Ozon пока не показывает на включённом складе, всё
        // равно получает значение: иначе только что включённый склад никогда
        // не получил бы остаток. Ошибку по такой паре считаем «пропущено».
        const seen = new Set<string>();
        const rows: SendableRow[] = [];
        const bootstrapKeys = new Set<string>();
        for (const remote of remoteStocks) {
          const warehouseId = String(remote.warehouseId);
          if (!enabledWarehouses.has(warehouseId)) continue;
          const item = basisByOffer.get(remote.offerId);
          if (!item) continue;
          seen.add(`${remote.offerId}::${warehouseId}`);
          rows.push(buildSendableRow({
            marketplaceId: "ozon",
            warehouseId,
            externalSku: item.externalSku,
            productSku: item.sourceSku,
            article: item.article,
            size: item.size,
            osvQty: item.osvQty,
            reserveQty: item.reserveQty,
            safetyStock: item.safetyStock,
            manualZero: Boolean(item.manualZero),
            remoteReserved: remote.reserved,
          }));
        }
        for (const warehouseId of enabledWarehouses.keys()) {
          for (const item of ozonBasis) {
            if (seen.has(`${item.externalSku}::${warehouseId}`)) continue;
            bootstrapKeys.add(`${item.externalSku}::${Number(warehouseId)}`);
            rows.push(buildSendableRow({
              marketplaceId: "ozon",
              warehouseId,
              externalSku: item.externalSku,
              productSku: item.sourceSku,
              article: item.article,
              size: item.size,
              osvQty: item.osvQty,
              reserveQty: item.reserveQty,
              safetyStock: item.safetyStock,
              manualZero: Boolean(item.manualZero),
              remoteReserved: 0,
            }));
          }
        }

        const remoteReservedByKey = new Map(
          remoteStocks.map((remote) => [`${remote.offerId}::${String(remote.warehouseId)}`, Number(remote.reserved) || 0]),
        );
        reserveDrift = collectReserveDrift(rows, remoteReservedByKey).length;

        const apiFailures = rows.length > 0
          ? await updateOzonStocks(
            credentials.OZON_CLIENT_ID,
            credentials.OZON_API_KEY,
            rows.map((row) => ({ offerId: row.externalSku, warehouseId: Number(row.warehouseId), stock: row.sentQty })),
          )
          : [];
        const failedKeys = new Map(apiFailures.map((failure) => [`${failure.offerId}::${failure.warehouseId}`, failure.message]));
        const realFailures = apiFailures.filter((failure) => !bootstrapKeys.has(`${failure.offerId}::${failure.warehouseId}`));

        for (const row of rows) {
          const key = `${row.externalSku}::${Number(row.warehouseId)}`;
          const failure = failedKeys.get(key);
          const status: ResultRow["status"] = !failure ? "success" : bootstrapKeys.has(key) ? "skipped" : "error";
          logRows.push({ ...row, apiStatus: status, apiMessage: failure ?? null });
          resultRows.push({
            marketplaceId: "ozon",
            warehouseId: String(row.warehouseId),
            warehouseName: enabledWarehouses.get(String(row.warehouseId))?.name ?? String(row.warehouseId),
            sourceSku: row.productSku ?? "",
            externalSku: row.externalSku,
            article: row.article,
            size: row.size,
            osvQty: row.osvQty,
            reserveQty: row.reserveQty,
            computedQty: row.computedQty,
            sentQty: row.sentQty,
            status,
            message: failure ?? null,
          });
        }
        ozonSent += Math.max(0, rows.length - apiFailures.length);
        if (realFailures.length > 0) {
          failures.push(`Ozon не обновил ${realFailures.length} пар товар–склад: ${realFailures[0]?.message ?? "неизвестная ошибка"}`);
        }
        for (const warehouse of ozonWarehouses) {
          await markWarehouseSync(db, "ozon", warehouse.externalId, realFailures.length === 0, realFailures[0]?.message ?? null);
        }
      } catch (error) {
        const guard = isStockGuardError(error);
        const message = messageFrom(error, "Не удалось обновить остатки Ozon.");
        failures.push(`Ozon: ${message}`);
        logRows.push({
          ...(guard ? (error as { row: Partial<SendableRow> }).row : {}),
          marketplaceId: "ozon",
          apiStatus: guard ? "blocked" : "error",
          apiMessage: message,
        } as LogRow);
        for (const warehouse of ozonWarehouses) {
          await markWarehouseSync(db, "ozon", warehouse.externalId, false, message);
        }
      }
    }
  }

  if (logRows.length > 0) await logStockRows(db, runId, actorEmail, logRows);

  const ok = failures.length === 0;
  const statements: D1PreparedStatement[] = [];
  if (wbWarehouses.length > 0) {
    statements.push(db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES ('wildberries', 'outbound', 'stocks', ?, ?, ?)`,
    ).bind(wbSent > 0 ? "success" : "error", wbSent, `${label}: позиций ${sourceSkus.length}, отправлено ${wbSent}.`));
  }
  if (ozonWarehouses.length > 0) {
    statements.push(db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES ('ozon', 'outbound', 'stocks', ?, ?, ?)`,
    ).bind(ozonSent > 0 ? "success" : "error", ozonSent, `${label}: позиций ${sourceSkus.length}, отправлено ${ozonSent} пар товар–склад.`));
  }
  if (statements.length > 0) await db.batch(statements);

  await finishSyncRun(db, runId, ok ? "success" : "partial", ok ? null : failures[0] ?? null);

  return {
    ok,
    runId,
    selected: sourceSkus.length,
    unmapped,
    wildberries: { warehouseCount: wbWarehouses.length, mappingCount: wbBasis.length, sent: wbSent },
    ozon: { warehouseCount: ozonWarehouses.length, mappingCount: ozonBasis.length, sent: ozonSent, reserveDrift },
    failures,
    rows: resultRows,
  };
}
