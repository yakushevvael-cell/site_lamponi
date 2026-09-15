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
 *
 * Отправление с несколькими товарами идёт другим путём. Этикетка одна на
 * отправление, а Ozon принимает сборку только целиком, поэтому по первому
 * скану печатать нечего: изделия откладываются в ячейку комплектации — своя
 * ячейка на каждое отправление, — и этикетка готовится и печатается, когда
 * отсканировано всё отправление.
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
  exemplarStatusErrors,
  neededUinCount,
  normalizeLabelPostings,
} from "@/lib/ozon-exemplars.mjs";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { ensureWildberriesSupply } from "@/lib/supplies";
import { articleKey } from "@/lib/upd-parse-core.mjs";
import {
  addOrdersToWildberriesSupply,
  getWildberriesStickers,
  setWildberriesUin,
} from "@/lib/wildberries";
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
  waiting: number;
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
 *
 * Отправление из одного изделия готовится заранее, до стола: УИН берётся
 * свободный из УПД. Отправление из нескольких — только когда отсканировано
 * целиком: собрать его в Ozon можно одним запросом, а УИН нужен на каждое
 * изделие, и брать их «на глаз» из УПД нельзя.
 */
export async function prepareLabelsForTask(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { taskId: number; limit?: number; actorEmail: string },
): Promise<PrepareResult> {
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const items = await readTaskItemsForLabels(db, input.taskId);
  const messages: string[] = [];
  if (items.length === 0) {
    return { prepared: 0, failed: 0, skipped: 0, waiting: 0, ready: 0, total: 0, messages };
  }

  const existing = await db.prepare(
    `SELECT ${LABEL_COLUMNS} FROM shipment_labels WHERE task_id = ?`,
  ).bind(input.taskId).all<LabelRow>();
  const byPosting = new Map(existing.results.map((row) => [`${row.marketplaceId}::${row.externalOrderId}`, row]));

  const freeUins = await readFreeUins(db);
  const claimed = new Set<string>();
  // Номер задания нужен как имя поставки Wildberries.
  const taskRow = await db.prepare("SELECT number FROM pick_tasks WHERE id = ?")
    .bind(input.taskId).first<{ number: string }>();
  const taskNumber = taskRow?.number ?? String(input.taskId);

  // Отправление — единица подготовки: этикетка выдаётся на отправление, а не на строку.
  const postings = new Map<string, TaskItemRow[]>();
  for (const item of items) {
    const key = `${item.marketplaceId}::${item.externalOrderId}`;
    postings.set(key, [...(postings.get(key) ?? []), item]);
  }

  let prepared = 0;
  let failed = 0;
  let skipped = 0;
  let waiting = 0;
  let ready = 0;

  for (const [key, group] of postings) {
    const label = byPosting.get(key);
    if (label?.status === "ready") {
      ready += 1;
      continue;
    }

    const first = group[0];
    const marketplaceId = first.marketplaceId;
    const multi = group.length > 1;
    const articles = [...new Set(group.map((row) => row.article))].join(", ").slice(0, 200);

    // Пока отправление не отсканировано целиком, готовить нечего: передать
    // Ozon половину УИН и собрать отправление — значит разделить посылку.
    if (multi && group.some((row) => !row.scannedAt || !row.uin)) {
      waiting += 1;
      continue;
    }

    if (prepared + failed >= limit) {
      skipped += 1;
      continue;
    }

    // У отсканированного изделия УИН уже свой. Для одиночного отправления,
    // которое готовится заранее, берём свободный УИН из УПД.
    const taken: Array<{ item: TaskItemRow; uin: string; fresh: boolean }> = [];
    let shortage: string | null = null;
    for (const row of group) {
      const own = row.uin;
      const uin = own ?? takeUin(freeUins, row.article, row.size, claimed);
      if (!uin) {
        shortage = `Нет свободного УИН для артикула ${row.article}${row.size ? ` / ${row.size}` : ""}. Загрузите УПД.`;
        break;
      }
      claimed.add(uin);
      taken.push({ item: row, uin, fresh: !own });
    }

    if (shortage) {
      for (const entry of taken) if (entry.fresh) claimed.delete(entry.uin);
      await upsertLabel(db, {
        marketplaceId,
        externalOrderId: first.externalOrderId,
        taskId: input.taskId,
        article: articles,
        size: multi ? null : first.size,
        uin: null,
        status: "error",
        error: shortage,
      });
      failed += 1;
      continue;
    }

    try {
      if (marketplaceId === "ozon") {
        const storageKey = await prepareOzonLabel(db, runtime, {
          postingNumber: first.externalOrderId,
          products: taken.map((entry) => ({
            externalSku: entry.item.externalSku,
            article: entry.item.article,
            uin: entry.uin,
          })),
        });
        await upsertLabel(db, {
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          article: articles,
          size: multi ? null : first.size,
          uin: taken[0]?.uin ?? null,
          status: "ready",
          contentType: "application/pdf",
          storageKey,
          error: null,
        });
      } else {
        const { storageKey, warning } = await prepareWildberriesLabel(db, runtime, {
          orderId: first.externalOrderId,
          uins: taken.map((entry) => entry.uin),
          taskId: input.taskId,
          taskNumber,
          actorEmail: input.actorEmail,
        });
        if (warning) messages.push(warning);
        await upsertLabel(db, {
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          article: articles,
          size: multi ? null : first.size,
          uin: taken[0]?.uin ?? null,
          status: "ready",
          contentType: "image/png",
          storageKey,
          error: warning ?? null,
        });
      }

      for (const entry of taken) {
        await markUinUsed(db, {
          uin: entry.uin,
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          actorEmail: input.actorEmail,
        });
        await db.prepare("UPDATE pick_task_items SET uin = COALESCE(uin, ?) WHERE id = ?")
          .bind(entry.uin, entry.item.id).run();
      }
      prepared += 1;
    } catch (error) {
      for (const entry of taken) if (entry.fresh) claimed.delete(entry.uin);
      const message = error instanceof Error ? error.message : "Не удалось подготовить этикетку.";
      await upsertLabel(db, {
        marketplaceId,
        externalOrderId: first.externalOrderId,
        taskId: input.taskId,
        article: articles,
        size: multi ? null : first.size,
        uin: taken[0]?.uin ?? null,
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
      payload: { prepared, failed, ready, waiting, total: postings.size },
    });
  }

  return { prepared, failed, skipped, waiting, ready, total: postings.size, messages };
}

async function prepareOzonLabel(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { postingNumber: string; products: Array<{ externalSku: string; article: string; uin: string }> },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Ключи Ozon не добавлены.");
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;

  const created = await ozonExemplarCreateOrGet(clientId, apiKey, input.postingNumber);

  // Сколько изделий ждёт Ozon — спрашиваем до передачи УИН: собрать половину
  // отправления значит разделить посылку, а этого уже не отменить.
  const needed = neededUinCount(created) as number;
  if (needed > input.products.length) {
    throw new Error(
      `В отправлении ${needed} изделий, а отсканировано ${input.products.length}. Соберите отправление целиком.`,
    );
  }

  // Раскладка УИН по товарам: Ozon называет товар то product_id, то offer_id,
  // поэтому кладём УИН под оба ключа, а общий запас остаётся на случай, когда
  // ни один не совпал.
  const byProduct: Record<string, string[]> = {};
  const pool: string[] = [];
  for (const product of input.products) {
    for (const key of [String(product.externalSku ?? "").trim(), String(product.article ?? "").trim()]) {
      if (!key) continue;
      byProduct[key] = [...(byProduct[key] ?? []), product.uin];
    }
    pool.push(product.uin);
  }

  const build = buildExemplarSetPayload(input.postingNumber, created, { byProduct, pool }) as {
    mustSet: boolean;
    payload: Record<string, unknown>;
    problems: string[];
    marks: number;
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
      buildShipProducts(created, Number(input.products[0]?.externalSku)) as Array<{ product_id: number; quantity: number }>,
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
  input: { orderId: string; uins: string[]; taskId: number; taskNumber: string; actorEmail: string },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
  const token = credentials.WB_API_TOKEN;

  // Порядок здесь не наш выбор, а требование WB:
  //   поставка → задание в поставке (статус confirm) → УИН → стикер.
  // У задания в статусе new стикера не существует, а УИН не принимается.
  const supply = await ensureWildberriesSupply(db, runtime, {
    taskId: input.taskId,
    taskNumber: input.taskNumber,
    actorEmail: input.actorEmail,
  });

  let addError: string | null = null;
  try {
    await addOrdersToWildberriesSupply(token, supply.externalId, [input.orderId]);
  } catch (error) {
    // Задание уже в этой поставке — обычное дело при повторной подготовке.
    // Настоящую причину покажет запрос стикера, поэтому ошибку запоминаем.
    addError = error instanceof Error ? error.message : "не удалось добавить задание в поставку";
  }

  let warning: string | null = null;
  const uin = input.uins.find((value) => value.trim().length === 16) ?? input.uins[0] ?? "";
  if (!uin) {
    warning = `Нет УИН для задания ${input.orderId}: без него Wildberries не примет поставку.`;
  } else if (uin.trim().length !== 16) {
    warning = `УИН ${uin} не 16 символов — Wildberries такой не примет. Проверьте УПД.`;
  } else {
    try {
      await setWildberriesUin(token, input.orderId, uin.trim());
    } catch (error) {
      // УИН мог быть закреплён раньше: повторная передача не нужна.
      warning = `Wildberries не принял УИН по заданию ${input.orderId}: ${error instanceof Error ? error.message : "неизвестная ошибка"}`;
    }
  }

  const stickers = await getWildberriesStickers(token, [input.orderId]);
  const sticker = stickers.find((row) => String(row.orderId) === String(input.orderId)) ?? stickers[0];
  if (!sticker?.file) {
    throw new Error(
      `Wildberries не отдал стикер по заданию ${input.orderId} (поставка ${supply.externalId}).`
      + (addError ? ` Задание не добавилось в поставку: ${addError}` : " Повторите подготовку этикеток через минуту."),
    );
  }
  const bytes = Uint8Array.from(Buffer.from(sticker.file, "base64"));
  const storageKey = await storeLabelFile(runtime, "wildberries", input.orderId, bytes, "png");
  return { storageKey, warning };
}

/**
 * Ячейка комплектации под отправление.
 *
 * Номер выдаётся по порядку и закрепляется за отправлением до конца задания:
 * кладовщик кладёт изделия одного отправления в одну ячейку, а не запоминает,
 * куда положил предыдущее. Оба запрета — одна ячейка на отправление и
 * неповторяющийся номер — стоят в базе: столов может быть несколько.
 */
export async function ensurePostingSlot(
  db: D1Database,
  input: { taskId: number; marketplaceId: string; externalOrderId: string; itemsTotal: number; actorEmail: string },
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await db.prepare(
      `SELECT slot FROM posting_slots
       WHERE task_id = ? AND marketplace_id = ? AND external_order_id = ?`,
    ).bind(input.taskId, input.marketplaceId, input.externalOrderId).first<{ slot: number }>();
    if (existing) return Number(existing.slot);

    try {
      await db.prepare(
        `INSERT INTO posting_slots (task_id, marketplace_id, external_order_id, slot, items_total, created_by)
         SELECT ?, ?, ?, COALESCE(MAX(slot), 0) + 1, ?, ?
         FROM posting_slots
         WHERE task_id = ?`,
      ).bind(
        input.taskId,
        input.marketplaceId,
        input.externalOrderId,
        input.itemsTotal,
        input.actorEmail,
        input.taskId,
      ).run();
    } catch {
      // Соседний стол занял этот номер: читаем заново и берём следующий.
    }
  }
  return null;
}

export type PostingBoardItem = {
  itemId: number;
  article: string;
  size: string | null;
  uin: string | null;
  scannedAt: string | null;
  cellCode: string | null;
};

export type PostingBoardRow = {
  marketplaceId: string;
  externalOrderId: string;
  slot: number | null;
  total: number;
  scanned: number;
  labelStatus: string | null;
  labelError: string | null;
  printedAt: string | null;
  printCount: number;
  items: PostingBoardItem[];
};

/**
 * Отправления с несколькими товарами по заданию.
 *
 * Это и есть окно, которое кладовщик видит на столе: номер отправления,
 * ячейка комплектации, список артикулов и отметки сканов. Печать запускается
 * по нажатию на номер отправления — когда отсканировано всё.
 */
export async function readPostingBoard(db: D1Database, taskId: number): Promise<PostingBoardRow[]> {
  const rows = await db.prepare(
    `SELECT ti.id AS itemId, ti.marketplace_id AS marketplaceId, ti.external_order_id AS externalOrderId,
            ti.article, ti.size, ti.uin, ti.scanned_at AS scannedAt, ti.cell_code AS cellCode,
            ps.slot AS slot,
            l.status AS labelStatus, l.error AS labelError,
            l.printed_at AS printedAt, l.print_count AS printCount
     FROM pick_task_items ti
     LEFT JOIN posting_slots ps ON ps.task_id = ti.task_id
       AND ps.marketplace_id = ti.marketplace_id AND ps.external_order_id = ti.external_order_id
     LEFT JOIN shipment_labels l ON l.marketplace_id = ti.marketplace_id
       AND l.external_order_id = ti.external_order_id
     WHERE ti.task_id = ? AND ti.status <> 'not_found'
     ORDER BY ti.external_order_id, ti.article, ti.id`,
  ).bind(taskId).all<{
    itemId: number; marketplaceId: string; externalOrderId: string; article: string; size: string | null;
    uin: string | null; scannedAt: string | null; cellCode: string | null; slot: number | null;
    labelStatus: string | null; labelError: string | null; printedAt: string | null; printCount: number | null;
  }>();

  const byPosting = new Map<string, PostingBoardRow>();
  for (const row of rows.results) {
    const key = `${row.marketplaceId}::${row.externalOrderId}`;
    const entry = byPosting.get(key) ?? {
      marketplaceId: row.marketplaceId,
      externalOrderId: row.externalOrderId,
      slot: row.slot === null ? null : Number(row.slot),
      total: 0,
      scanned: 0,
      labelStatus: row.labelStatus,
      labelError: row.labelError,
      printedAt: row.printedAt,
      printCount: Number(row.printCount ?? 0),
      items: [],
    };
    entry.total += 1;
    if (row.scannedAt) entry.scanned += 1;
    entry.items.push({
      itemId: row.itemId,
      article: row.article,
      size: row.size,
      uin: row.uin,
      scannedAt: row.scannedAt,
      cellCode: row.cellCode,
    });
    byPosting.set(key, entry);
  }

  // В окно попадают только отправления с несколькими товарами: одиночные
  // печатаются сразу по скану, и список их только загромождает.
  return [...byPosting.values()]
    .filter((entry) => entry.total > 1)
    .sort((left, right) => (left.slot ?? 9999) - (right.slot ?? 9999));
}

export type ScanOutcome =
  | { status: "ok"; item: ScanItem; label: { marketplaceId: string; externalOrderId: string; contentType: string } }
  | { status: "grouped"; uin: string; item: ScanItem; slot: number | null; scanned: number; total: number; complete: boolean }
  | { status: "size_confirm"; uin: string; item: ScanItem; orderSize: string }
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

/** Отметка скана. Размер подтверждается тем же запросом: одно действие — одна запись. */
function scanStatements(
  db: D1Database,
  input: {
    itemId: number;
    uin: string;
    actorEmail: string;
    confirmSize: boolean;
    orderSize: string | null;
    marketplaceId: string;
    externalOrderId: string;
    taskId: number;
  },
) {
  const confirm = input.confirmSize ? 1 : 0;
  return [
    db.prepare(
      `UPDATE pick_task_items
       SET scanned_at = CURRENT_TIMESTAMP, scanned_by = ?, uin = COALESCE(uin, ?),
           size_confirmed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE size_confirmed_at END,
           size_confirmed_by = CASE WHEN ? = 1 THEN ? ELSE size_confirmed_by END,
           size_confirmed_value = CASE WHEN ? = 1 THEN ? ELSE size_confirmed_value END
       WHERE id = ? AND scanned_at IS NULL`,
    ).bind(
      input.actorEmail,
      input.uin,
      confirm,
      confirm,
      input.actorEmail,
      confirm,
      input.orderSize,
      input.itemId,
    ),
    db.prepare(
      `UPDATE uin_items
       SET used_marketplace_id = ?, used_external_order_id = ?, used_task_id = ?,
           used_at = COALESCE(used_at, CURRENT_TIMESTAMP), used_by = COALESCE(used_by, ?)
       WHERE uin = ?`,
    ).bind(input.marketplaceId, input.externalOrderId, input.taskId, input.actorEmail, input.uin),
  ];
}

/**
 * Скан УИН на столе.
 *
 * Возвращает, что показать на экране. Печать этикетки — отдельный запрос
 * файла: так на столе не бывает состояния «этикетка ушла на принтер, а в
 * системе отметки нет».
 *
 * Два случая, когда скан не заканчивается печатью:
 *  — в отправлении несколько изделий: печатать нечего, пока не собрано всё
 *    отправление, изделие уходит в ячейку комплектации;
 *  — на Wildberries у заказа есть размер, а в УПД его нет: расхождение
 *    подтверждает человек, и до подтверждения ничего не записывается.
 */
export async function resolveScan(
  db: D1Database,
  input: { uin: string; taskId: number; actorEmail: string; confirmSize?: boolean },
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

  const orderSize = String(target.size ?? "").trim();
  const updSize = String(known.size ?? "").trim();

  // Размер на Wildberries («16-20», «18,0+», «б/р») в УПД не приходит вовсе.
  // Решение — за человеком: подтвердил, значит изделие то самое.
  if (target.marketplaceId === "wildberries" && orderSize && !updSize && input.confirmSize !== true) {
    return { status: "size_confirm", uin, item: target, orderSize };
  }

  const postingItems = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN scanned_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned
     FROM pick_task_items
     WHERE task_id = ? AND marketplace_id = ? AND external_order_id = ? AND status <> 'not_found'`,
  ).bind(input.taskId, target.marketplaceId, target.externalOrderId).first<{ total: number; scanned: number }>();
  const total = Number(postingItems?.total ?? 1);
  const scannedBefore = Number(postingItems?.scanned ?? 0);

  const writes = scanStatements(db, {
    itemId: target.itemId,
    uin,
    actorEmail: input.actorEmail,
    confirmSize: input.confirmSize === true,
    orderSize: orderSize || null,
    marketplaceId: target.marketplaceId,
    externalOrderId: target.externalOrderId,
    taskId: target.taskId,
  });

  // Отправление из нескольких изделий: отмечаем скан, но этикетку не выдаём.
  if (total > 1) {
    const slot = await ensurePostingSlot(db, {
      taskId: input.taskId,
      marketplaceId: target.marketplaceId,
      externalOrderId: target.externalOrderId,
      itemsTotal: total,
      actorEmail: input.actorEmail,
    });

    await db.batch(writes);

    const scanned = Math.min(total, scannedBefore + 1);
    await logWarehouseEvent(db, {
      kind: "item_scanned",
      taskId: target.taskId,
      marketplaceId: target.marketplaceId,
      externalOrderId: target.externalOrderId,
      article: target.article,
      size: target.size,
      actorEmail: input.actorEmail,
      payload: { uin, slot, grouped: true, scanned, total, sizeConfirmed: input.confirmSize === true },
    });

    return { status: "grouped", uin, item: target, slot, scanned, total, complete: scanned >= total };
  }

  const label = await db.prepare(
    `SELECT ${LABEL_COLUMNS} FROM shipment_labels WHERE marketplace_id = ? AND external_order_id = ?`,
  ).bind(target.marketplaceId, target.externalOrderId).first<LabelRow>();

  if (!label || label.status !== "ready" || !label.storageKey) {
    return { status: "label_not_ready", uin, item: target, error: label?.error ?? null };
  }

  await db.batch(writes);

  await logWarehouseEvent(db, {
    kind: "item_scanned",
    taskId: target.taskId,
    marketplaceId: target.marketplaceId,
    externalOrderId: target.externalOrderId,
    article: target.article,
    size: target.size,
    actorEmail: input.actorEmail,
    payload: { uin, sizeConfirmed: input.confirmSize === true },
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

/**
 * Сводка по столу.
 *
 * Отдельно считается, сколько отправлений уже можно готовить: отправление из
 * нескольких изделий готовится только после того, как отсканировано целиком,
 * и без этого счётчика экран бесконечно дёргал бы подготовку.
 */
export async function readScanSummary(db: D1Database, taskId: number) {
  const row = await db.prepare(
    `WITH posting AS (
       SELECT marketplace_id AS mp, external_order_id AS posting,
              COUNT(*) AS total,
              SUM(CASE WHEN scanned_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned
       FROM pick_task_items
       WHERE task_id = ? AND status <> 'not_found'
       GROUP BY marketplace_id, external_order_id
     )
     SELECT SUM(total) AS items,
            SUM(scanned) AS scanned,
            COUNT(*) AS postings,
            SUM(CASE WHEN total > 1 THEN 1 ELSE 0 END) AS multiPostings,
            SUM(CASE WHEN total > 1 AND scanned >= total THEN 1 ELSE 0 END) AS multiComplete,
            SUM(CASE WHEN total = 1 OR scanned >= total THEN 1 ELSE 0 END) AS preparable
     FROM posting`,
  ).bind(taskId).first<{
    items: number; scanned: number; postings: number;
    multiPostings: number; multiComplete: number; preparable: number;
  }>();
  const labels = await db.prepare(
    `SELECT status, COUNT(*) AS count FROM shipment_labels WHERE task_id = ? GROUP BY status`,
  ).bind(taskId).all<{ status: string; count: number }>();
  const byStatus = new Map(labels.results.map((entry) => [entry.status, Number(entry.count)]));
  return {
    items: Number(row?.items ?? 0),
    scanned: Number(row?.scanned ?? 0),
    postings: Number(row?.postings ?? 0),
    multiPostings: Number(row?.multiPostings ?? 0),
    multiComplete: Number(row?.multiComplete ?? 0),
    preparable: Number(row?.preparable ?? 0),
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
