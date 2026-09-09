import { getRuntimeEnv } from "@/lib/runtime-env";
import { stockSyncBlocked } from "@/lib/sync-pause";
import { buildSendableRow } from "@/lib/stock-math";
import { authorizeApi } from "@/lib/app-auth";
import { getMarketplaceCredentials } from "@/lib/credentials";
import {
import { OSV_UNITS_SQL } from "@/lib/osv-units";
  getOzonProductCatalog,
  getOzonStocksByWarehouse,
  getOzonUnfulfilledPostings,
  getOzonWarehouses,
  OzonApiError,
  type OzonPostingProduct,
  type OzonProduct,
  type OzonWarehouseStock,
  updateOzonStocks,
} from "@/lib/ozon";

const MARKETPLACE_ID = "ozon";
const CANARY_COUNT = 3;
const UPDATE_COOLDOWN_MS = 125_000;

type LocalProduct = {
  sourceSku: string;
  article: string;
  size: string | null;
  physicalQuantity: number;
};

type CanaryMapping = LocalProduct & {
  productId: number;
  offerId: string;
};

type TargetStock = {
  sourceSku: string;
  article: string;
  size: string | null;
  offerId: string;
  warehouseId: number;
  warehouseName: string;
  targetStock: number;
  expectedFree: number;
};

function normalize(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLocaleUpperCase("ru-RU")
    .replaceAll("Ё", "Е")
    .replace(/[^0-9A-ZА-Я]/g, "");
}

function sizeTokens(value: string | null) {
  if (!value) return [];
  const match = value.replace(",", ".").match(/\d+(?:\.\d+)?/);
  if (!match) return [normalize(value)].filter(Boolean);
  const rawDigits = match[0].replace(".", "");
  const numeric = Number(match[0]);
  const normalizedDigits = Number.isFinite(numeric)
    ? String(numeric).replace(".", "")
    : rawDigits;
  return [...new Set([rawDigits, normalizedDigits])].filter(Boolean);
}

function expectedOfferKeys(product: LocalProduct) {
  const article = normalize(product.article);
  if (!article) return [];
  if (product.size === null) return [article];
  return sizeTokens(product.size).map((size) => `${article}${size}`);
}

function moneyAmount(product: OzonPostingProduct) {
  const amount = product.price?.amount;
  const parsed = Number(amount ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isShippedStatus(status: string) {
  return new Set(["awaiting_deliver", "delivering", "driver_pickup", "delivered"]).has(status);
}

async function readCanaryStatus(db: D1Database) {
  const mode = await db.prepare("SELECT value FROM settings WHERE key = 'ozon_stock_mode'").first<{ value: string }>();
  const lastResult = await db.prepare("SELECT value FROM settings WHERE key = 'ozon_canary_last_result'").first<{ value: string }>();
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'ozon_canary_skus'").first<{ value: string }>();
  let sourceSkus: string[] = [];
  try {
    const parsed = saved?.value ? JSON.parse(saved.value) : [];
    if (Array.isArray(parsed)) sourceSkus = parsed.filter((value): value is string => typeof value === "string").slice(0, CANARY_COUNT);
  } catch {
    sourceSkus = [];
  }
  const placeholders = sourceSkus.map(() => "?").join(",");
  const results = sourceSkus.length === CANARY_COUNT ? (await db.prepare(
    `SELECT p.source_sku AS sourceSku,
            p.article,
            p.size,
            ${OSV_UNITS_SQL} AS physicalQuantity,
            sm.external_sku AS offerId,
            COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reservedQuantity,
            CASE WHEN p.manual_zero = 1 THEN 0 ELSE MAX(0, ${OSV_UNITS_SQL} - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) - p.safety_stock) END AS availableQuantity
     FROM sku_mappings sm
     JOIN products p ON p.source_sku = sm.product_sku
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     WHERE sm.marketplace_id = ? AND sm.active = 1 AND p.source_sku IN (${placeholders})
     GROUP BY p.source_sku, p.article, p.size, p.current_physical_qty, sm.external_sku, p.safety_stock, p.manual_zero
     ORDER BY p.article, p.size`,
  ).bind(MARKETPLACE_ID, ...sourceSkus).all()).results : [];

  let parsedResult: unknown = null;
  if (lastResult?.value) {
    try { parsedResult = JSON.parse(lastResult.value); } catch { parsedResult = null; }
  }
  return { mode: mode?.value ?? "off", items: results, lastResult: parsedResult };
}

async function readSavedMappings(db: D1Database) {
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'ozon_canary_skus'").first<{ value: string }>();
  if (!saved?.value) return [];
  try {
    const sourceSkus = JSON.parse(saved.value) as string[];
    if (!Array.isArray(sourceSkus) || sourceSkus.length !== CANARY_COUNT) return [];
    const placeholders = sourceSkus.map(() => "?").join(",");
    const { results } = await db.prepare(
      `SELECT p.source_sku AS sourceSku, p.article, p.size,
              p.current_physical_qty AS physicalQuantity,
              CAST(sm.external_sku AS TEXT) AS offerId,
              0 AS productId
       FROM products p
       JOIN sku_mappings sm ON sm.product_sku = p.source_sku
       WHERE sm.marketplace_id = ? AND sm.active = 1 AND p.source_sku IN (${placeholders})`,
    ).bind(MARKETPLACE_ID, ...sourceSkus).all<CanaryMapping>();
    return results.length === CANARY_COUNT ? results : [];
  } catch {
    return [];
  }
}

function findExactMatches(localProducts: LocalProduct[], catalog: OzonProduct[]) {
  const localByKey = new Map<string, LocalProduct[]>();
  for (const product of localProducts) {
    for (const key of expectedOfferKeys(product)) {
      const list = localByKey.get(key) ?? [];
      list.push(product);
      localByKey.set(key, list);
    }
  }

  const catalogByKey = new Map<string, OzonProduct[]>();
  for (const product of catalog.filter((item) => !item.archived)) {
    const key = normalize(product.offerId);
    const list = catalogByKey.get(key) ?? [];
    list.push(product);
    catalogByKey.set(key, list);
  }

  const matches: CanaryMapping[] = [];
  const usedSourceSkus = new Set<string>();
  for (const [key, localRows] of localByKey) {
    const remoteRows = catalogByKey.get(key) ?? [];
    if (localRows.length !== 1 || remoteRows.length !== 1) continue;
    const local = localRows[0];
    const remote = remoteRows[0];
    if (usedSourceSkus.has(local.sourceSku)) continue;
    usedSourceSkus.add(local.sourceSku);
    matches.push({ ...local, productId: remote.productId, offerId: remote.offerId });
  }
  return matches;
}

async function chooseCanaryMappings(
  db: D1Database,
  clientId: string,
  apiKey: string,
): Promise<{ mappings: CanaryMapping[]; remoteStocks: OzonWarehouseStock[] }> {
  const saved = await readSavedMappings(db);
  if (saved.length === CANARY_COUNT) {
    const remoteStocks = await getOzonStocksByWarehouse(clientId, apiKey, saved.map((item) => item.offerId));
    if (saved.every((item) => remoteStocks.some((stock) => stock.offerId === item.offerId))) {
      return { mappings: saved, remoteStocks };
    }
  }

  const [catalog, localRows] = await Promise.all([
    getOzonProductCatalog(clientId, apiKey),
    db.prepare(
      `SELECT source_sku AS sourceSku, article, size, current_physical_qty AS physicalQuantity
       FROM products
       WHERE article <> '' AND current_physical_qty BETWEEN 1 AND 50
       ORDER BY current_physical_qty ASC, article ASC, size ASC`,
    ).all<LocalProduct>(),
  ]);
  const exactMatches = findExactMatches(localRows.results, catalog).slice(0, 600);
  if (exactMatches.length < CANARY_COUNT) {
    throw new OzonApiError(422, "Не найдено три однозначных соответствия «артикул + размер» между ОСВ и артикулами Ozon. Остатки не изменялись.");
  }

  const remoteStocks: OzonWarehouseStock[] = [];
  for (let index = 0; index < exactMatches.length; index += 200) {
    remoteStocks.push(...await getOzonStocksByWarehouse(
      clientId,
      apiKey,
      exactMatches.slice(index, index + 200).map((item) => item.offerId),
    ));
    if (new Set(remoteStocks.map((stock) => stock.offerId)).size >= 12) break;
  }
  const offersWithWarehouses = new Set(remoteStocks.map((stock) => stock.offerId));
  const eligible = exactMatches.filter((item) => offersWithWarehouses.has(item.offerId));
  const selected = [
    ...eligible.filter((item) => item.size !== null).slice(0, 2),
    ...eligible.filter((item) => item.size === null).slice(0, 1),
  ];
  for (const item of eligible) {
    if (selected.length >= CANARY_COUNT) break;
    if (!selected.some((selectedItem) => selectedItem.sourceSku === item.sourceSku)) selected.push(item);
  }
  if (selected.length < CANARY_COUNT) {
    throw new OzonApiError(422, "Ozon не вернул складские позиции для трёх точных соответствий. Остатки не изменялись.");
  }

  await db.batch([
    ...selected.map((item) => db.prepare(
      `INSERT INTO sku_mappings (product_sku, marketplace_id, external_sku, active)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(marketplace_id, external_sku) DO UPDATE SET product_sku = excluded.product_sku, active = 1`,
    ).bind(item.sourceSku, MARKETPLACE_ID, item.offerId)),
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('ozon_canary_skus', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(JSON.stringify(selected.map((item) => item.sourceSku))),
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('ozon_stock_mode', 'canary', CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = 'canary', updated_at = CURRENT_TIMESTAMP`,
    ),
  ]);

  const selectedOffers = new Set(selected.map((item) => item.offerId));
  return { mappings: selected, remoteStocks: remoteStocks.filter((stock) => selectedOffers.has(stock.offerId)) };
}

async function syncOrdersAndReservations(
  db: D1Database,
  clientId: string,
  apiKey: string,
  canaryOfferIds: Set<string>,
) {
  const postings = await getOzonUnfulfilledPostings(clientId, apiKey);
  const receivedItems = postings.reduce(
    (total, posting) => total + (Array.isArray(posting.products) ? posting.products.length : 0),
    0,
  );
  const relevantPostings = postings.filter((posting) =>
    (Array.isArray(posting.products) ? posting.products : [])
      .some((product) => canaryOfferIds.has(product.offer_id)),
  );
  let mappedItems = 0;
  let newReservations = 0;

  for (const posting of relevantPostings) {
    const products = (Array.isArray(posting.products) ? posting.products : [])
      .filter((product) => canaryOfferIds.has(product.offer_id));
    const amount = products.reduce((sum, product) => sum + moneyAmount(product) * Math.max(1, Number(product.quantity ?? 1)), 0);
    const orderedAt = posting.in_process_at ?? posting.shipment_date ?? new Date().toISOString();
    const warehouseId = posting.delivery_method?.warehouse_id ?? posting.analytics_data?.warehouse_id;
    const shipped = isShippedStatus(posting.status);

    await db.prepare(
      `INSERT INTO orders
         (marketplace_id, external_order_id, status, amount, ordered_at, shipped_at, region, city, warehouse_external_id, updated_at)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET
         status = excluded.status,
         amount = excluded.amount,
         shipped_at = CASE WHEN excluded.shipped_at IS NOT NULL THEN COALESCE(orders.shipped_at, excluded.shipped_at) ELSE orders.shipped_at END,
         region = excluded.region,
         city = excluded.city,
         warehouse_external_id = excluded.warehouse_external_id,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(
      MARKETPLACE_ID,
      posting.posting_number,
      posting.status || "unknown",
      amount,
      orderedAt,
      shipped ? 1 : 0,
      posting.analytics_data?.region ?? null,
      posting.analytics_data?.city ?? null,
      warehouseId ? String(warehouseId) : null,
    ).run();

    const order = await db.prepare(
      "SELECT id FROM orders WHERE marketplace_id = ? AND external_order_id = ?",
    ).bind(MARKETPLACE_ID, posting.posting_number).first<{ id: number }>();
    if (!order) continue;

    for (const product of products) {
      const externalSku = product.offer_id || String(product.sku);
      const quantity = Math.max(1, Number(product.quantity ?? 1));
      const mapping = await db.prepare(
        `SELECT product_sku AS productSku FROM sku_mappings
         WHERE marketplace_id = ? AND external_sku = ? AND active = 1`,
      ).bind(MARKETPLACE_ID, product.offer_id).first<{ productSku: string }>();

      let item = await db.prepare(
        "SELECT id FROM order_items WHERE order_id = ? AND external_sku = ? LIMIT 1",
      ).bind(order.id, externalSku).first<{ id: number }>();
      if (!item) {
        item = await db.prepare(
          `INSERT INTO order_items (order_id, product_sku, external_sku, quantity, unit_price)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
        ).bind(order.id, mapping?.productSku ?? null, externalSku, quantity, moneyAmount(product)).first<{ id: number }>() ?? null;
      } else {
        await db.prepare(
          "UPDATE order_items SET product_sku = ?, quantity = ?, unit_price = ? WHERE id = ?",
        ).bind(mapping?.productSku ?? null, quantity, moneyAmount(product), item.id).run();
      }

      if (mapping && item) {
        mappedItems += 1;
        const result = await db.prepare(
          `INSERT INTO stock_reservations (order_item_id, product_sku, marketplace_id, quantity, status)
           VALUES (?, ?, ?, ?, 'active')
           ON CONFLICT(order_item_id) DO NOTHING`,
        ).bind(item.id, mapping.productSku, MARKETPLACE_ID, quantity).run();
        if ((result.meta.changes ?? 0) > 0) newReservations += 1;
      }
    }
  }

  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES (?, 'inbound', 'orders', 'success', ?, ?)`,
  ).bind(
    MARKETPLACE_ID,
    relevantPostings.length,
    `Получено заказов: ${postings.length}; тестовых заказов: ${relevantPostings.length}; позиций: ${receivedItems}; новых резервов: ${newReservations}`,
  ).run();

  return {
    received: postings.length,
    relevant: relevantPostings.length,
    receivedItems,
    mapped: mappedItems,
    newReservations,
  };
}

function stockKey(offerId: string, warehouseId: number) {
  return `${offerId}::${warehouseId}`;
}

async function readVerifiedStocks(clientId: string, apiKey: string, targets: TargetStock[]) {
  const offerIds = [...new Set(targets.map((target) => target.offerId))];
  let rows: OzonWarehouseStock[] = [];
  for (const waitMs of [1_200, 2_500, 4_000]) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    rows = await getOzonStocksByWarehouse(clientId, apiKey, offerIds);
    const byKey = new Map(rows.map((row) => [stockKey(row.offerId, row.warehouseId), row]));
    if (targets.every((target) => {
      const actual = byKey.get(stockKey(target.offerId, target.warehouseId));
      return actual && (actual.present === target.targetStock || actual.freeStock === target.expectedFree);
    })) break;
  }
  return rows;
}

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  return Response.json(await readCanaryStatus(runtime.DB));
}

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const paused = await stockSyncBlocked(runtime.DB);
  if (paused) return paused;
  const credentials = await getMarketplaceCredentials(runtime.DB, runtime, MARKETPLACE_ID);
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;
  if (!clientId || !apiKey) {
    return Response.json({ error: "Client-Id или API-ключ Ozon не добавлен." }, { status: 400 });
  }

  try {
    const lastResult = await runtime.DB.prepare(
      "SELECT value FROM settings WHERE key = 'ozon_canary_last_result'",
    ).first<{ value: string }>();
    if (lastResult?.value) {
      try {
        const parsed = JSON.parse(lastResult.value) as { testedAt?: string };
        const elapsed = parsed.testedAt ? Date.now() - new Date(parsed.testedAt).getTime() : UPDATE_COOLDOWN_MS;
        if (elapsed < UPDATE_COOLDOWN_MS) {
          return Response.json({
            error: "Ozon разрешает обновлять один товар на одном складе не чаще одного раза в 2 минуты.",
            retryAfterSeconds: Math.ceil((UPDATE_COOLDOWN_MS - elapsed) / 1000),
          }, { status: 429 });
        }
      } catch {
        // Поврежденная история не блокирует новый безопасный тест.
      }
    }

    const remoteWarehouses = await getOzonWarehouses(clientId, apiKey);
    if (remoteWarehouses.length === 0) throw new OzonApiError(422, "Ozon не вернул ни одного FBS/rFBS-склада. Остатки не изменялись.");
    await runtime.DB.batch([
      ...remoteWarehouses.map((warehouse) => runtime.DB!.prepare(
        `INSERT INTO marketplace_warehouses (marketplace_id, external_id, name, remote_active, publish_full_stock)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(marketplace_id, external_id) DO UPDATE SET
           name = excluded.name,
           remote_active = excluded.remote_active,
           publish_full_stock = CASE
             WHEN excluded.remote_active = 1 THEN marketplace_warehouses.publish_full_stock
             ELSE 0
           END`,
      ).bind(MARKETPLACE_ID, String(warehouse.id), warehouse.name, warehouse.active ? 1 : 0)),
      runtime.DB.prepare(
        `UPDATE marketplace_warehouses SET remote_active = 0, publish_full_stock = 0
         WHERE marketplace_id = ? AND external_id NOT IN (${remoteWarehouses.map(() => "?").join(",")})`,
      ).bind(MARKETPLACE_ID, ...remoteWarehouses.map((warehouse) => String(warehouse.id))),
    ]);
    const publishingRows = await runtime.DB.prepare(
      `SELECT external_id AS externalId
       FROM marketplace_warehouses
       WHERE marketplace_id = ? AND remote_active = 1 AND publish_full_stock = 1`,
    ).bind(MARKETPLACE_ID).all<{ externalId: string }>();
    const publishingIds = new Set(publishingRows.results.map((row) => row.externalId));
    const warehouses = remoteWarehouses.filter((warehouse) => warehouse.active && publishingIds.has(String(warehouse.id)));
    if (warehouses.length === 0) {
      throw new OzonApiError(422, "На вкладке «Склады» не включена выгрузка ни на один активный склад Ozon. Остатки не изменялись.");
    }

    const { mappings, remoteStocks } = await chooseCanaryMappings(
      runtime.DB,
      clientId,
      apiKey,
    );
    const orders = await syncOrdersAndReservations(
      runtime.DB,
      clientId,
      apiKey,
      new Set(mappings.map((mapping) => mapping.offerId)),
    );
    const sourceSkus = mappings.map((item) => item.sourceSku);
    const placeholders = sourceSkus.map(() => "?").join(",");
    const availableRows = await runtime.DB.prepare(
      `SELECT p.source_sku AS sourceSku,
              p.article,
              p.size,
              sm.external_sku AS offerId,
              ${OSV_UNITS_SQL} AS osvQty,
              COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reserveQty,
              p.safety_stock AS safetyStock,
              p.manual_zero AS manualZero
       FROM products p
       JOIN sku_mappings sm ON sm.product_sku = p.source_sku AND sm.marketplace_id = ? AND sm.active = 1
       LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
       WHERE p.source_sku IN (${placeholders})
       GROUP BY p.source_sku, p.article, p.size, sm.external_sku, p.current_physical_qty, p.safety_stock, p.manual_zero`,
    ).bind(MARKETPLACE_ID, ...sourceSkus).all<{
      sourceSku: string;
      article: string;
      size: string | null;
      offerId: string;
      osvQty: number;
      reserveQty: number;
      safetyStock: number;
      manualZero: number;
    }>();
    const localByOffer = new Map(availableRows.results.map((row) => [row.offerId, row]));
    const activeWarehouseIds = new Set(warehouses.map((warehouse) => warehouse.id));
    const targets: TargetStock[] = remoteStocks.flatMap((remote) => {
      const local = localByOffer.get(remote.offerId);
      if (!local || !activeWarehouseIds.has(remote.warehouseId)) return [];
      // Единая формула и обязательный гард 0 ≤ отправляемое ≤ ОСВ (ТЗ, п. 9).
      const row = buildSendableRow({
        marketplaceId: "ozon",
        warehouseId: remote.warehouseId,
        externalSku: local.offerId,
        productSku: local.sourceSku,
        article: local.article,
        size: local.size,
        osvQty: local.osvQty,
        reserveQty: local.reserveQty,
        safetyStock: local.safetyStock,
        manualZero: Boolean(local.manualZero),
        remoteReserved: remote.reserved,
      });
      return [{
        sourceSku: local.sourceSku,
        article: local.article,
        size: local.size,
        offerId: local.offerId,
        warehouseId: remote.warehouseId,
        warehouseName: remote.warehouseName,
        targetStock: row.sentQty,
        expectedFree: row.computedQty,
      }];
    });
    if (!mappings.every((mapping) => targets.some((target) => target.offerId === mapping.offerId))) {
      throw new OzonApiError(422, "Не для всех трёх тестовых SKU найден действующий склад Ozon. Остатки не изменялись.");
    }

    const updateFailures = await updateOzonStocks(
      clientId,
      apiKey,
      targets.map((target) => ({ offerId: target.offerId, warehouseId: target.warehouseId, stock: target.targetStock })),
    );
    const failedUpdateKeys = new Set(updateFailures.map((failure) => stockKey(failure.offerId, failure.warehouseId)));
    const verifiableTargets = targets.filter((target) => !failedUpdateKeys.has(stockKey(target.offerId, target.warehouseId)));
    const verifiedRows = verifiableTargets.length
      ? await readVerifiedStocks(clientId, apiKey, verifiableTargets)
      : [];
    const verifiedByKey = new Map(verifiedRows.map((row) => [stockKey(row.offerId, row.warehouseId), row]));
    const results = targets.map((target) => {
      const updateFailure = updateFailures.find((failure) => failure.offerId === target.offerId && failure.warehouseId === target.warehouseId);
      const actual = verifiedByKey.get(stockKey(target.offerId, target.warehouseId));
      const ok = !updateFailure && Boolean(actual && (actual.present === target.targetStock || actual.freeStock === target.expectedFree));
      return {
        ...target,
        ok,
        actualPresent: actual?.present ?? null,
        actualFree: actual?.freeStock ?? null,
        message: updateFailure?.message ?? (ok ? undefined : "Контрольное чтение Ozon пока не совпало"),
      };
    });
    const verifiedSkuCount = mappings.filter((mapping) => {
      const itemResults = results.filter((result) => result.offerId === mapping.offerId);
      return itemResults.length > 0 && itemResults.every((result) => result.ok);
    }).length;
    const failed = results.filter((result) => !result.ok);
    const testedAt = new Date().toISOString();
    const summary = {
      ok: verifiedSkuCount === CANARY_COUNT,
      testedAt,
      mode: "canary",
      skuCount: CANARY_COUNT,
      verifiedSkuCount,
      warehouseCount: new Set(results.map((result) => result.warehouseId)).size,
      pairCount: results.length,
      verifiedPairCount: results.length - failed.length,
      items: mappings.map((mapping) => {
        const itemResults = results.filter((result) => result.offerId === mapping.offerId);
        return {
          article: mapping.article,
          size: mapping.size,
          offerId: mapping.offerId,
          amount: itemResults[0]?.expectedFree ?? 0,
          warehouseCount: itemResults.length,
          verified: itemResults.length > 0 && itemResults.every((result) => result.ok),
        };
      }),
      orders,
      failures: failed.map((result) => ({ offerId: result.offerId, warehouse: result.warehouseName, message: result.message })),
    };

    const successfulWarehouseIds = new Set(results.filter((result) => result.ok).map((result) => String(result.warehouseId)));
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('ozon_canary_last_result', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      ).bind(JSON.stringify(summary)),
      runtime.DB.prepare(
        `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
         VALUES (?, 'outbound', 'stocks', ?, ?, ?)`,
      ).bind(
        MARKETPLACE_ID,
        summary.ok ? "success" : "error",
        results.length - failed.length,
        summary.ok ? "Тест трёх SKU Ozon подтверждён контрольным чтением" : `Не подтверждено пар товар-склад: ${failed.length}`,
      ),
      ...[...successfulWarehouseIds].map((warehouseId) => runtime.DB!.prepare(
        `UPDATE marketplace_warehouses SET last_stock_sync_at = CURRENT_TIMESTAMP
         WHERE marketplace_id = ? AND external_id = ?`,
      ).bind(MARKETPLACE_ID, warehouseId)),
    ]);

    return Response.json(summary, { status: summary.ok ? 200 : 207 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Тест Ozon не выполнен.";
    await runtime.DB.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'outbound', 'stocks', 'error', 0, ?)`,
    ).bind(MARKETPLACE_ID, message.slice(0, 500)).run().catch(() => undefined);
    const status = error instanceof OzonApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
