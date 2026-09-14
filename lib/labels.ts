/**
 * Этикетки и стол сканирования (ТЗ, п. 5).
 *
 * Этикетки готовятся фоном заранее, до того как товар дойдёт до стола: на
 * столе остаётся скан и печать, без обращений к API площадки. Файлы лежат на
 * диске рядом с ОСВ, в базе — только ключ.
 *
 * Скан УИН убирать нельзя: это не ввод данных, а поиск нужной этикетки среди
 * сотен. Поэтому здесь же живут проверки, которые ловят пересорт: повторный
 * скан, чужое задание, неизвестный УИН.
 */
import { getMarketplaceCredentials } from "@/lib/credentials";
import {
  ozonExemplarCreateOrGet,
  ozonExemplarSet,
  ozonExemplarStatus,
  ozonPackageLabel,
  ozonPostingStatus,
  ozonShipPosting,
} from "@/lib/ozon";
import {
  OZON_SHIPPED_STATUSES,
  buildExemplarSetPayload,
  buildShipProducts,
  countExemplars,
  exemplarStatusErrors,
  normalizeLabelPostings,
} from "@/lib/ozon-exemplars.mjs";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { articleKey } from "@/lib/upd-parse-core.mjs";
import { getWildberriesStickers, setWildberriesSgtin } from "@/lib/wildberries";
import { logWarehouseEvent } from "@/lib/warehouse";

export type LabelRow = {
  id: number;
  marketplaceId: "ozon" | "wildberries";
  externalOrderId: string;
  taskId: number | null;
  article: string | null;
  size: string | null;
  uin: string | null;
  status: "pending" | "ready" | "error";
  contentType: string | null;
  storageKey: string | null;
  error: string | null;
  attempts: number;
  preparedAt: string | null;
  printedAt: string | null;
  printCount: number;
};

const LABEL_COLUMNS = `
  id, marketplace_id AS marketplaceId, external_order_id AS externalOrderId, task_id AS taskId,
  article, size, uin, status, content_type AS contentType, storage_key AS storageKey,
  error, attempts, prepared_at AS preparedAt, printed_at AS printedAt, print_count AS printCount
`;

/** Сколько раз спрашиваем Ozon о проверке УИН, прежде чем отложить отправление. */
const EXEMPLAR_STATUS_ROUNDS = 6;
const EXEMPLAR_STATUS_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TaskItemRow = {
  id: number;
  taskId: number;
  marketplaceId: "ozon" | "wildberries";
  externalOrderId: string;
  externalSku: string;
  article: string;
  size: string | null;
  quantity: number;
  uin: string | null;
  scannedAt: string | null;
};

async function readTaskItemsForLabels(db: D1Database, taskId: number) {
  const rows = await db.prepare(
    `SELECT id, task_id AS taskId, marketplace_id AS marketplaceId, external_order_id AS externalOrderId,
            external_sku AS externalSku, article, size, quantity, uin, scanned_at AS scannedAt
     FROM pick_task_items
     WHERE task_id = ? AND status <> 'not_found'
     ORDER BY id`,
  ).bind(taskId).all<TaskItemRow>();
  return rows.results;
}

/** Свободные УИН по ключу «артикул + размер». Сопоставление в коде: SQLite не умеет UPPER для кириллицы. */
async function readFreeUins(db: D1Database) {
  const rows = await db.prepare(
    "SELECT uin, article, size FROM uin_items WHERE used_external_order_id IS NULL ORDER BY created_at, uin",
  ).all<{ uin: string; article: string; size: string | null }>();
  const byKey = new Map<string, string[]>();
  for (const row of rows.results) {
    for (const key of [articleKey(row.article, row.size) as string, articleKey(row.article, null) as string]) {
      const list = byKey.get(key) ?? [];
      list.push(row.uin);
      byKey.set(key, list);
    }
  }
  return byKey;
}

/** УИН под строку задания: сначала точная пара с размером, потом по артикулу. */
function takeUin(byKey: Map<string, string[]>, article: string, size: string | null, used: Set<string>) {
  const keys = [articleKey(article, size) as string, articleKey(article, null) as string];
  for (const key of keys) {
    const list = byKey.get(key) ?? [];
    for (const uin of list) {
      if (!used.has(uin)) return uin;
    }
  }
  return null;
}

async function upsertLabel(
  db: D1Database,
  input: {
    marketplaceId: string;
    externalOrderId: string;
    taskId: number | null;
    article: string | null;
    size: string | null;
    uin: string | null;
    status: "pending" | "ready" | "error";
    contentType?: string | null;
    storageKey?: string | null;
    error?: string | null;
  },
) {
  await db.prepare(
    `INSERT INTO shipment_labels
       (marketplace_id, external_order_id, task_id, article, size, uin, status, content_type, storage_key, error,
        attempts, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END)
     ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET
       task_id = COALESCE(excluded.task_id, shipment_labels.task_id),
       article = COALESCE(excluded.article, shipment_labels.article),
       size = COALESCE(excluded.size, shipment_labels.size),
       uin = COALESCE(excluded.uin, shipment_labels.uin),
       status = excluded.status,
       content_type = COALESCE(excluded.content_type, shipment_labels.content_type),
       storage_key = COALESCE(excluded.storage_key, shipment_labels.storage_key),
       error = excluded.error,
       attempts = shipment_labels.attempts + 1,
       prepared_at = CASE WHEN excluded.status = 'ready' THEN CURRENT_TIMESTAMP ELSE shipment_labels.prepared_at END`,
  ).bind(
    input.marketplaceId,
    input.externalOrderId,
    input.taskId,
    input.article,
    input.size,
    input.uin,
    input.status,
    input.contentType ?? null,
    input.storageKey ?? null,
    input.error ?? null,
    input.status,
  ).run();
}

/** Закрепляет УИН за отправлением, чтобы он не ушёл на второе изделие. */
async function markUinUsed(
  db: D1Database,
  input: { uin: string; marketplaceId: string; externalOrderId: string; taskId: number | null; actorEmail: string },
) {
  const result = await db.prepare(
    `UPDATE uin_items
     SET used_marketplace_id = ?, used_external_order_id = ?, used_task_id = ?, used_at = CURRENT_TIMESTAMP, used_by = ?
     WHERE uin = ? AND used_external_order_id IS NULL`,
  ).bind(input.marketplaceId, input.externalOrderId, input.taskId, input.actorEmail, input.uin).run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function storeLabelFile(
  runtime: AppRuntimeEnv,
  marketplaceId: string,
  externalOrderId: string,
  bytes: Uint8Array,
  extension: string,
) {
  const key = `labels/${marketplaceId}/${externalOrderId.replace(/[^0-9A-Za-z_-]/g, "_")}.${extension}`;
  if (!runtime.BUCKET) throw new Error("Хранилище файлов недоступно.");
  await runtime.BUCKET.put(key, bytes, { httpMetadata: { contentType: extension === "pdf" ? "application/pdf" : "image/png" } });
  return key;
}

export type PrepareResult = {
  prepared: number;
  failed: number;
  skipped: number;
  ready: number;
  total: number;
  messages: string[];
};

/**
 * Готовит этикетки по заданию.
 *
 * Ozon: экземпляры → УИН → проверка → сборка → PDF. Wildberries: УИН по
 * заданию и стикер картинкой. Одна неудача не останавливает остальные —
 * ошибка запоминается в строке этикетки и видна на столе.
 */
export async function prepareLabelsForTask(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { taskId: number; limit?: number; actorEmail: string },
): Promise<PrepareResult> {
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const items = await readTaskItemsForLabels(db, input.taskId);
  const messages: string[] = [];
  if (items.length === 0) return { prepared: 0, failed: 0, skipped: 0, ready: 0, total: 0, messages };

  const existing = await db.prepare(
    `SELECT ${LABEL_COLUMNS} FROM shipment_labels WHERE task_id = ?`,
  ).bind(input.taskId).all<LabelRow>();
  const byPosting = new Map(existing.results.map((row) => [`${row.marketplaceId}::${row.externalOrderId}`, row]));

  const freeUins = await readFreeUins(db);
  const claimed = new Set<string>();

  // Отправление — единица подготовки: этикетка выдаётся на отправление, а не на строку.
  const postings = new Map<string, TaskItemRow[]>();
  for (const item of items) {
    const key = `${item.marketplaceId}::${item.externalOrderId}`;
    postings.set(key, [...(postings.get(key) ?? []), item]);
  }

  let prepared = 0;
  let failed = 0;
  let skipped = 0;
  let ready = 0;

  for (const [key, group] of postings) {
    const label = byPosting.get(key);
    if (label?.status === "ready") {
      ready += 1;
      continue;
    }
    if (prepared + failed >= limit) {
      skipped += 1;
      continue;
    }

    const first = group[0];
    const marketplaceId = first.marketplaceId;
    const uin = first.uin ?? takeUin(freeUins, first.article, first.size, claimed);

    if (!uin) {
      await upsertLabel(db, {
        marketplaceId,
        externalOrderId: first.externalOrderId,
        taskId: input.taskId,
        article: first.article,
        size: first.size,
        uin: null,
        status: "error",
        error: `Нет свободного УИН для артикула ${first.article}${first.size ? ` / ${first.size}` : ""}. Загрузите УПД.`,
      });
      failed += 1;
      continue;
    }
    claimed.add(uin);

    try {
      if (marketplaceId === "ozon") {
        const storageKey = await prepareOzonLabel(db, runtime, {
          postingNumber: first.externalOrderId,
          externalSku: first.externalSku,
          uin,
        });
        await upsertLabel(db, {
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          article: first.article,
          size: first.size,
          uin,
          status: "ready",
          contentType: "application/pdf",
          storageKey,
          error: null,
        });
      } else {
        const { storageKey, warning } = await prepareWildberriesLabel(db, runtime, {
          orderId: first.externalOrderId,
          uin,
        });
        if (warning) messages.push(warning);
        await upsertLabel(db, {
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          article: first.article,
          size: first.size,
          uin,
          status: "ready",
          contentType: "image/png",
          storageKey,
          error: warning ?? null,
        });
      }

      await markUinUsed(db, {
        uin,
        marketplaceId,
        externalOrderId: first.externalOrderId,
        taskId: input.taskId,
        actorEmail: input.actorEmail,
      });
      await db.prepare("UPDATE pick_task_items SET uin = COALESCE(uin, ?) WHERE task_id = ? AND external_order_id = ?")
        .bind(uin, input.taskId, first.externalOrderId).run();
      prepared += 1;
    } catch (error) {
      claimed.delete(uin);
      const message = error instanceof Error ? error.message : "Не удалось подготовить этикетку.";
      await upsertLabel(db, {
        marketplaceId,
        externalOrderId: first.externalOrderId,
        taskId: input.taskId,
        article: first.article,
        size: first.size,
        uin,
        status: "error",
        error: message.slice(0, 500),
      });
      failed += 1;
    }
  }

  if (prepared > 0 || failed > 0) {
    await logWarehouseEvent(db, {
      kind: "labels_prepared",
      taskId: input.taskId,
      actorEmail: input.actorEmail,
      payload: { prepared, failed, ready, total: postings.size },
    });
  }

  return { prepared, failed, skipped, ready, total: postings.size, messages };
}

async function prepareOzonLabel(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { postingNumber: string; externalSku: string; uin: string },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Ключи Ozon не добавлены.");
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;

  const created = await ozonExemplarCreateOrGet(clientId, apiKey, input.postingNumber);
  const total = countExemplars(created) as number;
  if (total > 1) {
    throw new Error(`В отправлении ${total} изделий — соберите его вручную в кабинете Ozon.`);
  }

  const build = buildExemplarSetPayload(input.postingNumber, created, input.uin) as {
    mustSet: boolean;
    payload: Record<string, unknown>;
    problems: string[];
  };
  if (build.problems.length > 0) throw new Error(build.problems.join(" "));

  if (build.mustSet) {
    await ozonExemplarSet(clientId, apiKey, build.payload);
    let lastStatus = "";
    let approved = false;
    for (let round = 0; round < EXEMPLAR_STATUS_ROUNDS; round += 1) {
      const status = await ozonExemplarStatus(clientId, apiKey, input.postingNumber);
      lastStatus = String(status.status ?? "");
      if (lastStatus === "ship_available") {
        approved = true;
        break;
      }
      if (lastStatus === "ship_not_available") {
        throw new Error(`Ozon отклонил УИН: ${exemplarStatusErrors(status)}`);
      }
      await sleep(EXEMPLAR_STATUS_DELAY_MS);
    }
    if (!approved) throw new Error(`Ozon всё ещё проверяет УИН (статус ${lastStatus || "пустой"}). Повторите подготовку.`);
  }

  let labelPostings: string[] = [input.postingNumber];
  try {
    const shipped = await ozonShipPosting(
      clientId,
      apiKey,
      input.postingNumber,
      buildShipProducts(created, Number(input.externalSku)) as Array<{ product_id: number; quantity: number }>,
    );
    labelPostings = normalizeLabelPostings(shipped.result, input.postingNumber) as string[];
  } catch (error) {
    // Повторная подготовка после сбоя связи: отправление могло уже уехать в сборку.
    const status = await ozonPostingStatus(clientId, apiKey, input.postingNumber).catch(() => "");
    if (!(OZON_SHIPPED_STATUSES as string[]).includes(status)) {
      throw new Error(error instanceof Error ? error.message : "Сборка отправления не прошла.");
    }
  }

  const label = await ozonPackageLabel(clientId, apiKey, labelPostings);
  if (!label.ok) throw new Error(label.message);
  return storeLabelFile(runtime, "ozon", input.postingNumber, label.pdf, "pdf");
}

async function prepareWildberriesLabel(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { orderId: string; uin: string },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
  const token = credentials.WB_API_TOKEN;

  let warning: string | null = null;
  try {
    await setWildberriesSgtin(token, input.orderId, [input.uin]);
  } catch (error) {
    // УИН мог быть передан раньше, а бывает, что категория его не требует.
    warning = `Wildberries не принял УИН по заданию ${input.orderId}: ${error instanceof Error ? error.message : "неизвестная ошибка"}`;
  }

  const stickers = await getWildberriesStickers(token, [input.orderId]);
  const sticker = stickers.find((row) => String(row.orderId) === String(input.orderId)) ?? stickers[0];
  if (!sticker?.file) throw new Error("Wildberries не отдал стикер по этому заданию.");
  const bytes = Uint8Array.from(Buffer.from(sticker.file, "base64"));
  const storageKey = await storeLabelFile(runtime, "wildberries", input.orderId, bytes, "png");
  return { storageKey, warning };
}

export type ScanOutcome =
  | { status: "ok"; item: ScanItem; label: { marketplaceId: string; externalOrderId: string; contentType: string } }
  | { status: "uin_unknown"; uin: string }
  | { status: "foreign_task"; uin: string; article: string; taskNumber: string | null }
  | { status: "repeat"; uin: string; item: ScanItem }
  | { status: "not_in_task"; uin: string; article: string; size: string | null }
  | { status: "label_not_ready"; uin: string; item: ScanItem; error: string | null };

export type ScanItem = {
  itemId: number;
  taskId: number;
  marketplaceId: string;
  externalOrderId: string;
  article: string;
  size: string | null;
  cellCode: string | null;
  scannedAt: string | null;
};

/**
 * Скан УИН на столе.
 *
 * Возвращает, что показать на экране. Печать этикетки — отдельный запрос
 * файла: так на столе не бывает состояния «этикетка ушла на принтер, а в
 * системе отметки нет».
 */
export async function resolveScan(
  db: D1Database,
  input: { uin: string; taskId: number; actorEmail: string },
): Promise<ScanOutcome> {
  const uin = input.uin.trim();
  const known = await db.prepare("SELECT uin, article, size FROM uin_items WHERE uin = ?")
    .bind(uin).first<{ uin: string; article: string; size: string | null }>();
  if (!known) return { status: "uin_unknown", uin };

  const candidates = await db.prepare(
    `SELECT ti.id AS itemId, ti.task_id AS taskId, ti.marketplace_id AS marketplaceId,
            ti.external_order_id AS externalOrderId, ti.article, ti.size, ti.cell_code AS cellCode,
            ti.scanned_at AS scannedAt, t.number AS taskNumber, t.status AS taskStatus
     FROM pick_task_items ti
     JOIN pick_tasks t ON t.id = ti.task_id
     WHERE ti.status <> 'not_found' AND t.status <> 'cancelled'
       AND (ti.uin = ? OR ti.article = ?)
     ORDER BY CASE WHEN ti.uin = ? THEN 0 ELSE 1 END, ti.task_id DESC, ti.id`,
  ).bind(uin, known.article, uin).all<ScanItem & { taskNumber: string | null; taskStatus: string }>();

  const rows = candidates.results.filter((row) => {
    if (!known.size || !row.size) return true;
    return articleKey(row.article, row.size) === articleKey(known.article, known.size);
  });

  const inTask = rows.filter((row) => row.taskId === input.taskId);
  if (inTask.length === 0) {
    const foreign = rows[0];
    if (foreign) {
      return { status: "foreign_task", uin, article: known.article, taskNumber: foreign.taskNumber };
    }
    return { status: "not_in_task", uin, article: known.article, size: known.size };
  }

  const already = inTask.find((row) => row.scannedAt);
  const target = inTask.find((row) => !row.scannedAt);
  if (!target) {
    return { status: "repeat", uin, item: already ?? inTask[0] };
  }

  const label = await db.prepare(
    `SELECT ${LABEL_COLUMNS} FROM shipment_labels WHERE marketplace_id = ? AND external_order_id = ?`,
  ).bind(target.marketplaceId, target.externalOrderId).first<LabelRow>();

  if (!label || label.status !== "ready" || !label.storageKey) {
    return { status: "label_not_ready", uin, item: target, error: label?.error ?? null };
  }

  await db.batch([
    db.prepare(
      `UPDATE pick_task_items SET scanned_at = CURRENT_TIMESTAMP, scanned_by = ?, uin = COALESCE(uin, ?)
       WHERE id = ? AND scanned_at IS NULL`,
    ).bind(input.actorEmail, uin, target.itemId),
    db.prepare(
      `UPDATE uin_items
       SET used_marketplace_id = ?, used_external_order_id = ?, used_task_id = ?,
           used_at = COALESCE(used_at, CURRENT_TIMESTAMP), used_by = COALESCE(used_by, ?)
       WHERE uin = ?`,
    ).bind(target.marketplaceId, target.externalOrderId, target.taskId, input.actorEmail, uin),
  ]);

  await logWarehouseEvent(db, {
    kind: "item_scanned",
    taskId: target.taskId,
    marketplaceId: target.marketplaceId,
    externalOrderId: target.externalOrderId,
    article: target.article,
    size: target.size,
    actorEmail: input.actorEmail,
    payload: { uin },
  });

  return {
    status: "ok",
    item: target,
    label: {
      marketplaceId: label.marketplaceId,
      externalOrderId: label.externalOrderId,
      contentType: label.contentType ?? "application/pdf",
    },
  };
}

/** Сводка по столу: сколько отсканировано, сколько этикеток готово, что в очереди на упаковке. */
export async function readScanSummary(db: D1Database, taskId: number) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS items,
            SUM(CASE WHEN scanned_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned,
            COUNT(DISTINCT external_order_id) AS postings
     FROM pick_task_items WHERE task_id = ? AND status <> 'not_found'`,
  ).bind(taskId).first<{ items: number; scanned: number; postings: number }>();
  const labels = await db.prepare(
    `SELECT status, COUNT(*) AS count FROM shipment_labels WHERE task_id = ? GROUP BY status`,
  ).bind(taskId).all<{ status: string; count: number }>();
  const byStatus = new Map(labels.results.map((entry) => [entry.status, Number(entry.count)]));
  return {
    items: Number(row?.items ?? 0),
    scanned: Number(row?.scanned ?? 0),
    postings: Number(row?.postings ?? 0),
    labelsReady: byStatus.get("ready") ?? 0,
    labelsError: byStatus.get("error") ?? 0,
    labelsPending: byStatus.get("pending") ?? 0,
  };
}

export async function readLabelErrors(db: D1Database, taskId: number) {
  const rows = await db.prepare(
    `SELECT ${LABEL_COLUMNS} FROM shipment_labels WHERE task_id = ? AND status = 'error' ORDER BY id LIMIT 50`,
  ).bind(taskId).all<LabelRow>();
  return rows.results;
}

export async function readLabel(db: D1Database, marketplaceId: string, externalOrderId: string) {
  return db.prepare(`SELECT ${LABEL_COLUMNS} FROM shipment_labels WHERE marketplace_id = ? AND external_order_id = ?`)
    .bind(marketplaceId, externalOrderId).first<LabelRow>();
}

export async function markLabelPrinted(db: D1Database, labelId: number) {
  await db.prepare(
    "UPDATE shipment_labels SET printed_at = COALESCE(printed_at, CURRENT_TIMESTAMP), print_count = print_count + 1 WHERE id = ?",
  ).bind(labelId).run();
}
