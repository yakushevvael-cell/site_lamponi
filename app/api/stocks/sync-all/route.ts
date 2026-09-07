import { authorizeApi } from "@/lib/app-auth";
import { getMarketplaceCredentials } from "@/lib/credentials";
import { getOzonStocksByWarehouse, updateOzonStocks } from "@/lib/ozon";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { retryAfterSecondsOf } from "@/lib/http-retry";
import { collectReserveDrift, rebuildReservations } from "@/lib/reservations";
import { finishSyncRun, logStockRows, startSyncRun, type LogRow } from "@/lib/stock-log";
import { buildSendableRow, isStockGuardError, type SendableRow } from "@/lib/stock-math";
import { updateWildberriesStocks } from "@/lib/wildberries";

const JOB_KEY = "stocks_full_sync_job";
const LAST_STARTED_KEY = "stocks_full_sync_last_started_at";
const LAST_RESULT_KEY = "stocks_full_sync_last_result";
const JOB_TTL_MS = 30 * 60 * 1000;
const RESTART_COOLDOWN_MS = 125_000;
const OZON_MAPPING_BATCH_SIZE = 100;
/** Доля нулей, выше которой запуск считается подозрительным и требует подтверждения. */
const MASS_ZERO_RATIO = 0.5;
const MASS_ZERO_MIN_ROWS = 20;

type MarketplaceId = "wildberries" | "ozon";
type Warehouse = { externalId: string; name: string };
type SyncFailure = { scope: string; message: string };

/** Основание расчёта по одной паре «локальный SKU → внешний SKU». */
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

type FullSyncJob = {
  jobId: string;
  ownerEmail: string;
  startedAt: string;
  /** Версия ОСВ на момент старта: после загрузки новой ОСВ задание становится недействительным. */
  osvUploadId: number | null;
  wildberries: {
    warehouses: Warehouse[];
    mappingCount: number;
    completedWarehouseIds: string[];
    sent: number;
    failures: SyncFailure[];
  };
  ozon: {
    warehouses: Warehouse[];
    mappingCount: number;
    processedMappings: number;
    sent: number;
    skippedMappings: number;
    /** Позиции, где резерв Ozon больше нашего: расхождение учётов. */
    reserveDrift?: number;
    done: boolean;
    failures: SyncFailure[];
  };
};

function messageFrom(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback).slice(0, 300);
}

async function readLatestOsvUploadId(db: D1Database) {
  const row = await db.prepare("SELECT id FROM osv_uploads ORDER BY id DESC LIMIT 1").first<{ id: number }>();
  return row?.id ?? null;
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

async function readMappingCount(db: D1Database, marketplaceId: MarketplaceId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM sku_mappings sm
     JOIN products p ON p.source_sku = sm.product_sku
     WHERE sm.marketplace_id = ? AND sm.active = 1`,
  ).bind(marketplaceId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/**
 * Отдаёт СЫРЫЕ величины (ОСВ, резерв, страховой запас), а не готовый остаток.
 * Всю арифметику делает lib/stock-math, чтобы у экрана и у выгрузки была одна формула.
 */
async function readStockBasis(
  db: D1Database,
  marketplaceId: MarketplaceId,
  limit?: number,
  offset = 0,
) {
  const pagination = typeof limit === "number" ? " LIMIT ? OFFSET ?" : "";
  const statement = db.prepare(
    `SELECT p.source_sku AS sourceSku,
            sm.external_sku AS externalSku,
            p.article AS article,
            p.size AS size,
            p.current_physical_qty AS osvQty,
            COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reserveQty,
            p.safety_stock AS safetyStock,
            p.manual_zero AS manualZero
     FROM products p
     JOIN sku_mappings sm ON sm.product_sku = p.source_sku AND sm.marketplace_id = ? AND sm.active = 1
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     GROUP BY p.source_sku, sm.external_sku, p.article, p.size,
              p.current_physical_qty, p.safety_stock, p.manual_zero
     ORDER BY sm.external_sku${pagination}`,
  );
  const rows = typeof limit === "number"
    ? await statement.bind(marketplaceId, limit, offset).all<StockBasisRow>()
    : await statement.bind(marketplaceId).all<StockBasisRow>();
  return rows.results;
}

async function readJob(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(JOB_KEY).first<{ value: string }>();
  if (!row?.value) return null;
  try {
    const job = JSON.parse(row.value) as FullSyncJob;
    return job?.jobId && job?.startedAt ? job : null;
  } catch {
    return null;
  }
}

async function saveJob(db: D1Database, job: FullSyncJob) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(JOB_KEY, JSON.stringify(job)).run();
}

/** Запрещает отправлять данные, посчитанные до загрузки новой ОСВ (ТЗ, п. 9). */
async function assertOsvUnchanged(db: D1Database, job: FullSyncJob) {
  const current = await readLatestOsvUploadId(db);
  if (current !== job.osvUploadId) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(JOB_KEY).run();
    await finishSyncRun(db, job.jobId, "cancelled", "Во время синхронизации загружена новая ОСВ.");
    return Response.json({
      error: "Загружена новая ОСВ. Синхронизация остановлена — запустите её заново, чтобы не отправить устаревшие остатки.",
    }, { status: 409 });
  }
  return null;
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

/**
 * Защита от массового обнуления.
 *
 * Пустая или наполовину загруженная таблица товаров даёт корректный с точки
 * зрения формулы, но катастрофический результат: на площадки уходят нули по
 * товарам, которые физически лежат на складе. Считаем долю нулей заранее и
 * без явного подтверждения администратора такой запуск не начинаем.
 */
async function readZeroRatio(db: D1Database) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(CASE WHEN computed <= 0 THEN 1 END) AS zeros
     FROM (
       SELECT CASE WHEN p.manual_zero = 1 THEN 0 ELSE
                MAX(0, CAST(p.current_physical_qty
                  - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0)
                  - p.safety_stock AS INTEGER))
              END AS computed
       FROM products p
       JOIN sku_mappings sm ON sm.product_sku = p.source_sku AND sm.active = 1
       LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
       GROUP BY p.source_sku, sm.marketplace_id, sm.external_sku,
                p.current_physical_qty, p.safety_stock, p.manual_zero
     )`,
  ).first<{ total: number; zeros: number }>();
  const total = Number(row?.total ?? 0);
  const zeros = Number(row?.zeros ?? 0);
  return { total, zeros, ratio: total > 0 ? zeros / total : 0 };
}

async function startJob(db: D1Database, ownerEmail: string, confirmMassZero = false) {
  const now = Date.now();
  const existing = await readJob(db);
  const existingStartedAt = existing ? Date.parse(existing.startedAt) : Number.NaN;
  if (existing && Number.isFinite(existingStartedAt) && now - existingStartedAt < JOB_TTL_MS) {
    return Response.json({ error: "Синхронизация уже выполняется. Дождитесь её завершения." }, { status: 409 });
  }

  const lastStarted = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(LAST_STARTED_KEY).first<{ value: string }>();
  const lastStartedAt = lastStarted?.value ? Date.parse(lastStarted.value) : Number.NaN;
  if (Number.isFinite(lastStartedAt) && now - lastStartedAt < RESTART_COOLDOWN_MS) {
    return Response.json({
      error: "Повторную синхронизацию можно запустить через две минуты.",
      retryAfterSeconds: Math.ceil((RESTART_COOLDOWN_MS - (now - lastStartedAt)) / 1000),
    }, { status: 429 });
  }

  // Резерв пересчитывается перед стартом: синхронизация всегда идёт от свежих
  // данных, а не от того, что осталось от прошлой загрузки заказов.
  await rebuildReservations(db).catch(() => undefined);

  const [wbWarehouses, ozonWarehouses, wbMappingCount, ozonMappingCount, osvUploadId] = await Promise.all([
    readWarehouses(db, "wildberries"),
    readWarehouses(db, "ozon"),
    readMappingCount(db, "wildberries"),
    readMappingCount(db, "ozon"),
    readLatestOsvUploadId(db),
  ]);
  if (wbWarehouses.length === 0 && ozonWarehouses.length === 0) {
    return Response.json({ error: "Нет складов с включённой выгрузкой остатков. Включите нужный склад на вкладке «Склады»." }, { status: 400 });
  }
  if (osvUploadId === null) {
    return Response.json({ error: "ОСВ ещё не загружена. Остатки отправлять не с чего." }, { status: 400 });
  }

  const zeroStats = await readZeroRatio(db);
  if (!confirmMassZero && zeroStats.total >= MASS_ZERO_MIN_ROWS && zeroStats.ratio >= MASS_ZERO_RATIO) {
    return Response.json({
      error: `Расчёт даёт ноль по ${zeroStats.zeros} из ${zeroStats.total} сопоставленных позиций. Похоже на неполные данные: проверьте последнюю ОСВ и загрузку заказов. Если обнуление действительно нужно, подтвердите запуск.`,
      needsMassZeroConfirmation: true,
      zeroCount: zeroStats.zeros,
      totalCount: zeroStats.total,
    }, { status: 409 });
  }

  const startedAt = new Date(now).toISOString();
  const jobId = crypto.randomUUID();
  const job: FullSyncJob = {
    jobId,
    ownerEmail,
    startedAt,
    osvUploadId,
    wildberries: {
      warehouses: wbWarehouses,
      mappingCount: wbMappingCount,
      completedWarehouseIds: [],
      sent: 0,
      failures: wbWarehouses.length > 0 && wbMappingCount === 0
        ? [{ scope: "mappings", message: "Нет активных сопоставлений товаров Wildberries." }]
        : [],
    },
    ozon: {
      warehouses: ozonWarehouses,
      mappingCount: ozonMappingCount,
      processedMappings: 0,
      sent: 0,
      skippedMappings: 0,
      done: ozonWarehouses.length === 0 || ozonMappingCount === 0,
      failures: ozonWarehouses.length > 0 && ozonMappingCount === 0
        ? [{ scope: "mappings", message: "Нет активных сопоставлений товаров Ozon." }]
        : [],
    },
  };

  await startSyncRun(db, { runId: jobId, trigger: "manual", actorEmail: ownerEmail, osvUploadId });
  await db.batch([
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(JOB_KEY, JSON.stringify(job)),
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(LAST_STARTED_KEY, startedAt),
  ]);

  return Response.json({
    jobId: job.jobId,
    osvUploadId,
    wildberries: { warehouses: wbWarehouses, mappingCount: wbMappingCount },
    ozon: { warehouses: ozonWarehouses, mappingCount: ozonMappingCount, batchSize: OZON_MAPPING_BATCH_SIZE },
  });
}

async function syncWildberriesWarehouse(
  db: D1Database,
  runtime: ReturnType<typeof getRuntimeEnv>,
  job: FullSyncJob,
  warehouseId: string,
) {
  const warehouse = job.wildberries.warehouses.find((item) => item.externalId === warehouseId);
  if (!warehouse) return Response.json({ error: "Склад Wildberries не входит в текущую синхронизацию." }, { status: 400 });
  if (job.wildberries.completedWarehouseIds.includes(warehouseId)) {
    return Response.json({ ok: true, alreadyProcessed: true, sent: job.wildberries.mappingCount });
  }
  const previousFailure = job.wildberries.failures.find((failure) => failure.scope === warehouseId);
  if (previousFailure) return Response.json({ ok: false, alreadyProcessed: true, sent: 0, error: previousFailure.message }, { status: 207 });

  const stale = await assertOsvUnchanged(db, job);
  if (stale) return stale;

  let rows: SendableRow[] = [];
  try {
    const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
    if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");

    const basis = await readStockBasis(db, "wildberries");
    // Гард срабатывает здесь: если хоть одна строка не проходит проверку,
    // на маркетплейс не уходит НИ ОДНОГО запроса (ТЗ, п. 9).
    rows = basis.map((item) => buildSendableRow({
      marketplaceId: "wildberries",
      warehouseId,
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
    if (stocks.length === 0) throw new Error("Не найдено корректных сопоставлений товаров Wildberries.");
    if (stocks.length !== rows.length) throw new Error(`Некорректных сопоставлений Wildberries: ${rows.length - stocks.length}. Остатки не отправлялись.`);

    await updateWildberriesStocks(credentials.WB_API_TOKEN, warehouseId, stocks);

    job.wildberries.completedWarehouseIds.push(warehouseId);
    job.wildberries.sent += stocks.length;
    await logStockRows(db, job.jobId, job.ownerEmail, rows.map((row): LogRow => ({ ...row, apiStatus: "success" })));
    await markWarehouseSync(db, "wildberries", warehouseId, true);
    await saveJob(db, job);
    return Response.json({ ok: true, sent: stocks.length, warehouse: warehouse.name });
  } catch (error) {
    const guard = isStockGuardError(error);
    const message = messageFrom(error, `Не удалось обновить склад ${warehouse.name}.`);
    const retryAfterSeconds = retryAfterSecondsOf(error);
    if (retryAfterSeconds !== null) {
      // Площадка попросила подождать. Это не сбой склада: шаг нужно повторить,
      // а не записывать его в ошибки задания.
      return Response.json({ ok: false, retry: true, retryAfterSeconds, warehouse: warehouse.name, error: message }, { status: 429 });
    }
    job.wildberries.failures.push({ scope: warehouseId, message });
    await logStockRows(db, job.jobId, job.ownerEmail, [{
      ...(guard ? (error as { row: Partial<SendableRow> }).row : { warehouseId }),
      marketplaceId: "wildberries",
      apiStatus: guard ? "blocked" : "error",
      apiMessage: message,
    } as LogRow]);
    await markWarehouseSync(db, "wildberries", warehouseId, false, message);
    await saveJob(db, job);
    return Response.json({ ok: false, sent: 0, warehouse: warehouse.name, error: message, guard }, { status: guard ? 422 : 207 });
  }
}

async function syncOzonBatch(
  db: D1Database,
  runtime: ReturnType<typeof getRuntimeEnv>,
  job: FullSyncJob,
  requestedOffset: number,
) {
  if (requestedOffset < job.ozon.processedMappings) {
    return Response.json({ ok: true, alreadyProcessed: true, nextOffset: job.ozon.processedMappings, done: job.ozon.done, sent: 0 });
  }
  if (requestedOffset !== job.ozon.processedMappings) {
    return Response.json({ error: "Пакеты Ozon нужно обрабатывать по порядку.", nextOffset: job.ozon.processedMappings }, { status: 409 });
  }
  if (job.ozon.done) return Response.json({ ok: job.ozon.failures.length === 0, nextOffset: job.ozon.processedMappings, done: true, sent: 0 });

  const stale = await assertOsvUnchanged(db, job);
  if (stale) return stale;

  const basis = await readStockBasis(db, "ozon", OZON_MAPPING_BATCH_SIZE, requestedOffset);
  if (basis.length === 0) {
    job.ozon.done = true;
    if (requestedOffset < job.ozon.mappingCount) {
      job.ozon.failures.push({ scope: "incomplete", message: "Список сопоставлений Ozon изменился во время синхронизации." });
    }
    await saveJob(db, job);
    return Response.json({ ok: job.ozon.failures.length === 0, nextOffset: requestedOffset, done: true, sent: 0 }, { status: job.ozon.failures.length > 0 ? 207 : 200 });
  }

  const nextOffset = requestedOffset + basis.length;
  try {
    const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
    if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Client-Id или API-ключ Ozon не добавлен.");

    const basisByOffer = new Map(basis.map((item) => [item.externalSku, item]));
    const enabledWarehouseIds = new Set(job.ozon.warehouses.map((warehouse) => warehouse.externalId));
    const remoteStocks = await getOzonStocksByWarehouse(
      credentials.OZON_CLIENT_ID,
      credentials.OZON_API_KEY,
      basis.map((item) => item.externalSku),
    );

    // Строим целевые пары «товар–склад» по включённым складам.
    // Если Ozon ещё не показывает товар на включённом складе, всё равно
    // отправляем на него значение: иначе только что включённый склад
    // никогда не получил бы остаток (ТЗ, п. 6 и критерий приёмки 6).
    const seen = new Set<string>();
    const rows: SendableRow[] = [];
    const bootstrapKeys = new Set<string>();
    for (const remote of remoteStocks) {
      const warehouseId = String(remote.warehouseId);
      if (!enabledWarehouseIds.has(warehouseId)) continue;
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
    for (const warehouseId of enabledWarehouseIds) {
      for (const item of basis) {
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

    // Сверка: резерв Ozon заметно больше нашего означает, что заказы подтянуты
    // не полностью. На отправляемое число это уже не влияет (его ограничивает
    // гард), но это ранний сигнал о расхождении учётов.
    const remoteReservedByKey = new Map(
      remoteStocks.map((remote) => [`${remote.offerId}::${String(remote.warehouseId)}`, Number(remote.reserved) || 0]),
    );
    const drift = collectReserveDrift(rows, remoteReservedByKey);

    const failures = rows.length > 0
      ? await updateOzonStocks(
        credentials.OZON_CLIENT_ID,
        credentials.OZON_API_KEY,
        rows.map((row) => ({ offerId: row.externalSku, warehouseId: Number(row.warehouseId), stock: row.sentQty })),
      )
      : [];
    const failedKeys = new Map(failures.map((failure) => [`${failure.offerId}::${failure.warehouseId}`, failure.message]));

    // Ошибка на паре, которой Ozon и так не показывал, — это не сбой выгрузки,
    // а «товар пока не заведён на этом складе». Такие строки идут в журнал как skipped.
    const realFailures = failures.filter((failure) => !bootstrapKeys.has(`${failure.offerId}::${failure.warehouseId}`));
    const skipped = failures.length - realFailures.length;

    await logStockRows(db, job.jobId, job.ownerEmail, rows.map((row): LogRow => {
      const key = `${row.externalSku}::${Number(row.warehouseId)}`;
      const failure = failedKeys.get(key);
      if (!failure) return { ...row, apiStatus: "success", apiMessage: null };
      return { ...row, apiStatus: bootstrapKeys.has(key) ? "skipped" : "error", apiMessage: failure };
    }));

    job.ozon.processedMappings = nextOffset;
    job.ozon.sent += Math.max(0, rows.length - failures.length);
    job.ozon.skippedMappings += skipped;
    job.ozon.done = nextOffset >= job.ozon.mappingCount || basis.length < OZON_MAPPING_BATCH_SIZE;
    if (drift.length > 0) {
      job.ozon.reserveDrift = (job.ozon.reserveDrift ?? 0) + drift.length;
    }
    if (realFailures.length > 0) {
      job.ozon.failures.push({
        scope: `${requestedOffset}-${nextOffset}`,
        message: `Ozon не обновил ${realFailures.length} пар товар–склад: ${realFailures[0]?.message ?? "неизвестная ошибка"}`.slice(0, 300),
      });
    }

    await saveJob(db, job);
    if (job.ozon.done) {
      const ok = job.ozon.failures.length === 0;
      for (const warehouse of job.ozon.warehouses) {
        await markWarehouseSync(db, "ozon", warehouse.externalId, ok, job.ozon.failures[0]?.message ?? null);
      }
    }

    return Response.json({
      ok: realFailures.length === 0,
      nextOffset,
      done: job.ozon.done,
      sent: Math.max(0, rows.length - failures.length),
      failed: realFailures.length,
      skipped,
      reserveDrift: drift.length,
      error: realFailures[0]?.message,
    }, { status: realFailures.length > 0 ? 207 : 200 });
  } catch (error) {
    const guard = isStockGuardError(error);
    const message = messageFrom(error, `Не удалось обработать товары Ozon ${requestedOffset + 1}–${nextOffset}.`);
    const retryAfterSeconds = retryAfterSecondsOf(error);
    if (retryAfterSeconds !== null) {
      // Пакет не сдвигаем: тот же offset будет повторён после паузы.
      return Response.json({ ok: false, retry: true, retryAfterSeconds, nextOffset: requestedOffset, done: false, sent: 0, error: message }, { status: 429 });
    }
    job.ozon.processedMappings = nextOffset;
    job.ozon.done = true;
    job.ozon.failures.push({ scope: `${requestedOffset}-${nextOffset}`, message });
    await logStockRows(db, job.jobId, job.ownerEmail, [{
      ...(guard ? (error as { row: Partial<SendableRow> }).row : {}),
      marketplaceId: "ozon",
      apiStatus: guard ? "blocked" : "error",
      apiMessage: message,
    } as LogRow]);
    for (const warehouse of job.ozon.warehouses) {
      await markWarehouseSync(db, "ozon", warehouse.externalId, false, message);
    }
    await saveJob(db, job);
    return Response.json({ ok: false, nextOffset: job.ozon.mappingCount, done: true, sent: 0, error: message, guard }, { status: guard ? 422 : 207 });
  }
}

async function finishJob(db: D1Database, job: FullSyncJob) {
  const wbPending = job.wildberries.warehouses.filter((warehouse) => (
    !job.wildberries.completedWarehouseIds.includes(warehouse.externalId)
    && !job.wildberries.failures.some((failure) => failure.scope === warehouse.externalId)
  ));
  if (wbPending.length > 0) {
    job.wildberries.failures.push({ scope: "incomplete", message: `Не обработано складов Wildberries: ${wbPending.length}.` });
  }
  if (job.ozon.warehouses.length > 0 && job.ozon.mappingCount > 0 && !job.ozon.done) {
    job.ozon.failures.push({ scope: "incomplete", message: "Синхронизация товаров Ozon не завершена." });
  }

  const wbActive = job.wildberries.warehouses.length > 0;
  const ozonActive = job.ozon.warehouses.length > 0;
  const wbOk = !wbActive || (
    job.wildberries.mappingCount > 0
    && job.wildberries.failures.length === 0
    && job.wildberries.completedWarehouseIds.length === job.wildberries.warehouses.length
  );
  const ozonOk = !ozonActive || (
    job.ozon.mappingCount > 0
    && job.ozon.done
    && job.ozon.processedMappings >= job.ozon.mappingCount
    && job.ozon.failures.length === 0
  );
  const ok = wbOk && ozonOk;
  const finishedAt = new Date().toISOString();
  const summary = {
    ok,
    startedAt: job.startedAt,
    finishedAt,
    osvUploadId: job.osvUploadId,
    wildberries: {
      mappingCount: job.wildberries.mappingCount,
      warehouseCount: job.wildberries.warehouses.length,
      completedWarehouseCount: job.wildberries.completedWarehouseIds.length,
      sent: job.wildberries.sent,
      failures: job.wildberries.failures,
    },
    ozon: {
      mappingCount: job.ozon.mappingCount,
      warehouseCount: job.ozon.warehouses.length,
      processedMappings: job.ozon.processedMappings,
      sent: job.ozon.sent,
      skippedMappings: job.ozon.skippedMappings,
      reserveDrift: job.ozon.reserveDrift ?? 0,
      failures: job.ozon.failures,
    },
  };
  const statements = [
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(LAST_RESULT_KEY, JSON.stringify(summary)),
    db.prepare("DELETE FROM settings WHERE key = ?").bind(JOB_KEY),
  ];
  if (wbActive) {
    statements.push(db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES ('wildberries', 'outbound', 'stocks', ?, ?, ?)`,
    ).bind(
      wbOk ? "success" : "error",
      job.wildberries.sent,
      wbOk
        ? `Полная синхронизация: ${job.wildberries.mappingCount} товаров × ${job.wildberries.warehouses.length} складов.`
        : `Полная синхронизация завершена частично. Ошибок: ${job.wildberries.failures.length}.`,
    ));
    if (wbOk) statements.push(db.prepare("UPDATE marketplaces SET last_sync_at = CURRENT_TIMESTAMP WHERE id = 'wildberries'"));
  }
  if (ozonActive) {
    statements.push(db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES ('ozon', 'outbound', 'stocks', ?, ?, ?)`,
    ).bind(
      ozonOk ? "success" : "error",
      job.ozon.sent,
      ozonOk
        ? `Полная синхронизация: обработано ${job.ozon.processedMappings} товаров, отправлено ${job.ozon.sent} пар товар–склад.`
        : `Полная синхронизация завершена частично. Ошибок: ${job.ozon.failures.length}.`,
    ));
    if (ozonOk) statements.push(db.prepare("UPDATE marketplaces SET last_sync_at = CURRENT_TIMESTAMP WHERE id = 'ozon'"));
  }
  await db.batch(statements);
  await finishSyncRun(
    db,
    job.jobId,
    ok ? "success" : "partial",
    ok ? null : [...job.wildberries.failures, ...job.ozon.failures][0]?.message ?? "Синхронизация завершена частично.",
  );
  return Response.json(summary, { status: ok ? 200 : 207 });
}

/**
 * Состояние задания синхронизации.
 *
 * Нужен для автоподхвата: цикл ведёт браузер, поэтому закрытая вкладка
 * оставляет задание незавершённым. Открыв любую страницу, администратор
 * видит незакрытый запуск и может его продолжить или отменить.
 */
export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const job = await readJob(runtime.DB);
  const lastResultRow = await runtime.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(LAST_RESULT_KEY)
    .first<{ value: string }>();
  let lastResult: unknown = null;
  if (lastResultRow?.value) {
    try { lastResult = JSON.parse(lastResultRow.value); } catch { lastResult = null; }
  }

  const startedAt = job ? Date.parse(job.startedAt) : Number.NaN;
  const stale = Number.isFinite(startedAt) && Date.now() - startedAt >= JOB_TTL_MS;
  return Response.json({
    running: Boolean(job) && !stale,
    jobId: job?.jobId ?? null,
    startedAt: job?.startedAt ?? null,
    ownedByMe: job?.ownerEmail === auth.user.email,
    stale,
    lastResult,
  });
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as {
    action?: unknown;
    confirmMassZero?: unknown;
    jobId?: unknown;
    warehouseId?: unknown;
    offset?: unknown;
  } | null;
  if (body?.action === "start") return startJob(runtime.DB, auth.user.email, body?.confirmMassZero === true);

  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const job = await readJob(runtime.DB);
  if (!job || !jobId || job.jobId !== jobId || job.ownerEmail !== auth.user.email) {
    return Response.json({ error: "Сессия синхронизации не найдена или уже завершена." }, { status: 409 });
  }

  if (body?.action === "wildberries") {
    const warehouseId = typeof body.warehouseId === "string" ? body.warehouseId : "";
    return syncWildberriesWarehouse(runtime.DB, runtime, job, warehouseId);
  }
  if (body?.action === "ozon") {
    const offset = Number(body.offset);
    if (!Number.isInteger(offset) || offset < 0) return Response.json({ error: "Некорректный номер пакета Ozon." }, { status: 400 });
    return syncOzonBatch(runtime.DB, runtime, job, offset);
  }
  if (body?.action === "finish") return finishJob(runtime.DB, job);
  if (body?.action === "cancel") {
    await runtime.DB.prepare("DELETE FROM settings WHERE key = ?").bind(JOB_KEY).run();
    await finishSyncRun(runtime.DB, job.jobId, "cancelled", "Синхронизация прервана пользователем.");
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Некорректное действие синхронизации." }, { status: 400 });
}
