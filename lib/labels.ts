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
  buildLabelLines,
  buildShipPackages,
  neededUinCount,
  normalizeLabelPostings,
  readExemplarProgress,
} from "@/lib/ozon-exemplars.mjs";
import { stampLabelLines } from "@/lib/label-stamp.mjs";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import { ensureWildberriesSupply } from "@/lib/supplies";
import { articleKey, normalizeSizeValue } from "@/lib/upd-parse-core.mjs";
import {
  addOrdersToWildberriesSupply,
  getWildberriesStickers,
  setWildberriesUin,
} from "@/lib/wildberries";
import { logWarehouseEvent } from "@/lib/warehouse";
import {
  getYandexOrder,
  getYandexOrderLabels,
  setYandexOrderBoxes,
  updateYandexOrderStatus,
} from "@/lib/yandex";
import { buildYandexBoxes, parseYandexStatus, yandexStatusKey } from "@/lib/yandex-core.mjs";

export type LabelRow = {
  id: number;
  marketplaceId: "ozon" | "wildberries" | "yandex";
  externalOrderId: string;
  taskId: number | null;
  article: string | null;
  size: string | null;
  uin: string | null;
  status: "pending" | "ready" | "error";
  contentType: string | null;
  storageKey: string | null;
  error: string | null;
  exemplarStatus: string | null;
  note: string | null;
  shipPostings: string | null;
  attempts: number;
  preparedAt: string | null;
  printedAt: string | null;
  printCount: number;
};

const LABEL_COLUMNS = `
  id, marketplace_id AS marketplaceId, external_order_id AS externalOrderId, task_id AS taskId,
  article, size, uin, status, content_type AS contentType, storage_key AS storageKey,
  error, exemplar_status AS exemplarStatus, note, ship_postings AS shipPostings,
  attempts, prepared_at AS preparedAt, printed_at AS printedAt, print_count AS printCount
`;

/** Номера отправлений после сборки хранятся строкой через запятую. */
function splitPostings(value: string | null | undefined) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

type TaskItemRow = {
  id: number;
  taskId: number;
  marketplaceId: "ozon" | "wildberries" | "yandex";
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
    exemplarStatus?: string | null;
    note?: string | null;
    shipPostings?: string[] | null;
  },
) {
  await db.prepare(
    `INSERT INTO shipment_labels
       (marketplace_id, external_order_id, task_id, article, size, uin, status, content_type, storage_key, error,
        exemplar_status, note, ship_postings, attempts, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END)
     ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET
       task_id = COALESCE(excluded.task_id, shipment_labels.task_id),
       article = COALESCE(excluded.article, shipment_labels.article),
       size = COALESCE(excluded.size, shipment_labels.size),
       uin = COALESCE(excluded.uin, shipment_labels.uin),
       status = excluded.status,
       content_type = COALESCE(excluded.content_type, shipment_labels.content_type),
       storage_key = COALESCE(excluded.storage_key, shipment_labels.storage_key),
       error = excluded.error,
       exemplar_status = COALESCE(excluded.exemplar_status, shipment_labels.exemplar_status),
       note = excluded.note,
       -- Номера сборки не перетираются пустым значением: собрать отправление
       -- второй раз нельзя, и потеря номеров означала бы этикетку в никуда.
       ship_postings = COALESCE(excluded.ship_postings, shipment_labels.ship_postings),
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
    input.exemplarStatus ?? null,
    input.note ?? null,
    input.shipPostings && input.shipPostings.length > 0 ? input.shipPostings.join(",") : null,
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
  /** Отправлений, ожидающих сканов: собрано ещё не всё. */
  waiting: number;
  /** Отправлений, по которым УИН уже у Ozon и идёт проверка. */
  validating: number;
  ready: number;
  total: number;
  messages: string[];
};

/**
 * Сколько отправлений за один заход доводим до площадки.
 *
 * Опрос статуса проверки УИН стоит один дешёвый запрос, поэтому он не тратит
 * лимит: иначе в большом задании отправления, ждущие проверки, забирали бы
 * все места и до новых очередь не доходила бы никогда.
 */
const STATUS_POLLS_PER_PASS = 40;

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
    return { prepared: 0, failed: 0, skipped: 0, waiting: 0, validating: 0, ready: 0, total: 0, messages };
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
  let validating = 0;
  let ready = 0;
  let statusPolls = 0;

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

    // Отправление, по которому УИН уже у Ozon, стоит один дешёвый запрос
    // статуса — лимит захода оно не занимает.
    const polling = marketplaceId === "ozon" && label?.status === "pending" && Boolean(label.note);
    if (polling) {
      if (statusPolls >= STATUS_POLLS_PER_PASS) {
        skipped += 1;
        continue;
      }
      statusPolls += 1;
    } else if (prepared + failed >= limit) {
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

    // Закрепление УИН вынесено из общего хвоста: по Ozon оно происходит сразу
    // после передачи УИН площадке, не дожидаясь сборки. Иначе следующий заход
    // снова возьмёт свободный УИН из УПД — уже другой — и проверка в Ozon
    // начнётся заново. Ровно из-за этого отправления зависали навсегда.
    const persistUins = async (pairs: Array<{ itemId: number | null; uin: string }>) => {
      for (const pair of pairs) {
        await markUinUsed(db, {
          uin: pair.uin,
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          actorEmail: input.actorEmail,
        });
        if (pair.itemId === null) continue;
        await db.prepare("UPDATE pick_task_items SET uin = COALESCE(uin, ?) WHERE id = ?")
          .bind(pair.uin, pair.itemId).run();
      }
    };

    try {
      if (marketplaceId === "ozon") {
        const step = await prepareOzonLabel(db, runtime, {
          postingNumber: first.externalOrderId,
          products: taken.map((entry) => ({
            externalSku: entry.item.externalSku,
            article: entry.item.article,
            size: entry.item.size,
            uin: entry.uin,
          })),
          shipPostings: splitPostings(label?.shipPostings),
        });

        // Отправление из одного изделия могло уже получить УИН в Ozon на
        // прошлом заходе — тогда за изделием закрепляется именно он. У
        // отсканированного изделия УИН свой, и подменять его нельзя: это
        // скрыло бы пересорт.
        const adopt = group.length === 1 && step.uins.length === 1 && !group[0].uin;
        await persistUins(adopt
          ? [{ itemId: group[0].id, uin: step.uins[0] }]
          : [
            ...taken.map((entry) => ({ itemId: entry.item.id, uin: entry.uin })),
            ...step.uins.filter((uin) => !taken.some((entry) => entry.uin === uin))
              .map((uin) => ({ itemId: null, uin })),
          ]);
        if (adopt) for (const entry of taken) if (entry.fresh) claimed.delete(entry.uin);

        if (step.kind === "waiting") {
          await upsertLabel(db, {
            marketplaceId,
            externalOrderId: first.externalOrderId,
            taskId: input.taskId,
            article: articles,
            size: multi ? null : first.size,
            uin: step.uins[0] ?? taken[0]?.uin ?? null,
            status: "pending",
            error: null,
            exemplarStatus: step.exemplarStatus || null,
            note: step.note,
            shipPostings: step.shipPostings ?? null,
          });
          validating += 1;
          continue;
        }

        await upsertLabel(db, {
          marketplaceId,
          externalOrderId: first.externalOrderId,
          taskId: input.taskId,
          article: articles,
          size: multi ? null : first.size,
          uin: step.uins[0] ?? taken[0]?.uin ?? null,
          status: "ready",
          contentType: "application/pdf",
          storageKey: step.storageKey,
          error: null,
          note: null,
          shipPostings: step.shipPostings,
        });
        prepared += 1;
        continue;
      }

      if (marketplaceId === "yandex") {
        const { storageKey, warning } = await prepareYandexLabel(db, runtime, {
          orderId: first.externalOrderId,
          products: taken.map((entry) => ({
            externalSku: entry.item.externalSku,
            quantity: entry.item.quantity,
            uin: entry.uin,
          })),
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
          contentType: "application/pdf",
          storageKey,
          error: warning ?? null,
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

      await persistUins(taken.map((entry) => ({ itemId: entry.item.id, uin: entry.uin })));
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
        note: null,
      });
      failed += 1;
    }
  }

  if (prepared > 0 || failed > 0) {
    await logWarehouseEvent(db, {
      kind: "labels_prepared",
      taskId: input.taskId,
      actorEmail: input.actorEmail,
      payload: { prepared, failed, ready, waiting, validating, total: postings.size },
    });
  }

  return { prepared, failed, skipped, waiting, validating, ready, total: postings.size, messages };
}

/**
 * Шаг подготовки отправления Ozon.
 *
 * `waiting` — не ошибка: УИН у площадки на проверке, и следующий заход
 * продолжит с того же места. Настоящие отказы по-прежнему бросаются
 * исключением и оседают в строке этикетки красным.
 */
type OzonStep =
  | { kind: "waiting"; exemplarStatus: string; note: string; uins: string[]; shipPostings?: string[] }
  | { kind: "ready"; storageKey: string; uins: string[]; shipPostings: string[] };

/**
 * Один шаг цепочки Ozon: экземпляры → проверка → сборка → этикетка.
 *
 * Функция никогда не ждёт площадку в цикле. Проверка УИН идёт через «Честный
 * ЗНАК» и занимает минуты — столько держать HTTP-запрос стола нельзя, а
 * прежние 9 секунд ожидания почти всегда заканчивались ложной ошибкой. Вместо
 * ожидания возвращается `waiting`, и состояние остаётся в строке этикетки:
 * следующий заход спросит статус ещё раз, ничего не передавая заново.
 */
async function prepareOzonLabel(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: {
    postingNumber: string;
    products: Array<{ externalSku: string; article: string; size: string | null; uin: string }>;
    shipPostings: string[];
  },
): Promise<OzonStep> {
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
    assigned: Array<{ productId: number; offerId: string; uin: string; reused: boolean }>;
  };
  if (build.problems.length > 0) throw new Error(build.problems.join(" "));
  // УИН, которые сейчас стоят на экземплярах в Ozon. Именно их закрепляет за
  // изделиями вызывающая сторона — иначе следующий заход возьмёт из УПД другой.
  const uins = build.assigned.map((entry) => entry.uin);

  const finish = async (postings: string[]): Promise<OzonStep> => {
    const label = await ozonPackageLabel(clientId, apiKey, postings);
    // «Этикетка ещё не готова» — не отказ: отправление уже собрано. Номера
    // сборки возвращаются вместе с ожиданием, иначе следующий заход начал бы
    // цепочку с экземпляров — по собранному отправлению это заведомо ошибка.
    if (!label.ok) {
      if (label.notReady) {
        return { kind: "waiting", exemplarStatus: "", note: label.message, uins, shipPostings: postings };
      }
      throw new Error(label.message);
    }

    // Впечатываем «артикул / размер» в нижнюю белую полосу этикетки. Строки идут
    // в том же порядке, что и упаковки при сборке, поэтому каждая попадает на свою
    // страницу PDF. Сбой впечатывания не должен ронять уже готовую этикетку —
    // тогда сохраняем исходный PDF от Ozon, как было раньше.
    let pdf: Uint8Array = label.pdf;
    try {
      const lines = buildLabelLines(created, input.products, input.products.length > 1) as Array<{ article: string; size: string | null }>;
      pdf = (await stampLabelLines(label.pdf, lines)) as Uint8Array;
    } catch (error) {
      console.warn(`Не удалось впечатать артикул на этикетку ${input.postingNumber}:`, error);
    }
    const storageKey = await storeLabelFile(runtime, "ozon", input.postingNumber, pdf, "pdf");
    return { kind: "ready", storageKey, uins, shipPostings: postings };
  };

  // Отправление уже собрано на прошлом заходе: номера известны, остаётся файл.
  if (input.shipPostings.length > 0) return finish(input.shipPostings);

  if (build.mustSet) {
    try {
      await ozonExemplarSet(clientId, apiKey, build.payload);
    } catch (error) {
      // Отправление могли собрать руками в кабинете Ozon: экземпляры там уже
      // приняты, и менять их поздно — остаётся забрать этикетку.
      const status = await ozonPostingStatus(clientId, apiKey, input.postingNumber).catch(() => "");
      if (!(OZON_SHIPPED_STATUSES as string[]).includes(status)) throw error;
      return finish([input.postingNumber]);
    }
    return {
      kind: "waiting",
      exemplarStatus: "",
      note: "УИН переданы, Ozon начал проверку.",
      uins,
    };
  }

  const progress = readExemplarProgress(
    await ozonExemplarStatus(clientId, apiKey, input.postingNumber),
  ) as { decision: "ship" | "wait" | "resend" | "fail"; status: string; message: string };

  if (progress.decision === "fail") throw new Error(progress.message);
  if (progress.decision === "resend") {
    await ozonExemplarSet(clientId, apiKey, build.payload);
    return { kind: "waiting", exemplarStatus: progress.status, note: progress.message, uins };
  }
  if (progress.decision === "wait") {
    return { kind: "waiting", exemplarStatus: progress.status, note: progress.message, uins };
  }

  let labelPostings: string[] = [input.postingNumber];
  try {
    // Многотоварное отправление уезжает отдельными упаковками: Ozon делит его
    // на отправления по одному изделию, и на каждое приходит своя этикетка.
    const shipped = await ozonShipPosting(
      clientId,
      apiKey,
      input.postingNumber,
      buildShipPackages(
        created,
        Number(input.products[0]?.externalSku),
        input.products.length > 1,
      ) as Array<{ products: Array<{ product_id: number; quantity: number }> }>,
    );
    labelPostings = normalizeLabelPostings(shipped.result, input.postingNumber) as string[];
  } catch (error) {
    // Повторная подготовка после сбоя связи: отправление могло уже уехать в сборку.
    const status = await ozonPostingStatus(clientId, apiKey, input.postingNumber).catch(() => "");
    if (!(OZON_SHIPPED_STATUSES as string[]).includes(status)) {
      throw new Error(error instanceof Error ? error.message : "Сборка отправления не прошла.");
    }
  }

  return finish(labelPostings);
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
 * Ярлык Яндекс Маркета на заказ DBS.
 *
 * Порядок задан площадкой: состав грузовых мест → «готов к отгрузке» → ярлык.
 * Без переданного состава Маркет ярлык не отдаёт, а УИН изделия попадает в
 * заказ именно здесь, в instances грузового места.
 *
 * В доставку заказ на этом шаге не переводится: курьер Яндекс Доставки ещё не
 * вызван, а статус DELIVERY без трек-номера означал бы, что посылка уже едет.
 */
async function prepareYandexLabel(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { orderId: string; products: Array<{ externalSku: string; quantity: number; uin: string }> },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "yandex");
  const apiKey = credentials.YANDEX_API_KEY;
  const campaignId = credentials.YANDEX_CAMPAIGN_ID;
  if (!apiKey || !campaignId) throw new Error("Ключи Яндекс Маркета не добавлены.");

  const order = await getYandexOrder(apiKey, campaignId, input.orderId);
  if (!order) throw new Error(`Яндекс Маркет не нашёл заказ ${input.orderId}.`);

  // Состав передаётся по идентификаторам строк заказа Маркета, а не по нашим:
  // сопоставляем их с артикулами задания по offerId.
  const remoteByOffer = new Map<string, Array<{ id: number; count: number }>>();
  for (const item of order.items ?? []) {
    const offerId = String(item.offerId ?? "");
    if (!offerId) continue;
    const rows = remoteByOffer.get(offerId) ?? [];
    rows.push({ id: Number(item.id), count: Math.max(1, Number(item.count ?? 1)) });
    remoteByOffer.set(offerId, rows);
  }

  const boxItems: Array<{ id: number; count: number; uin: string | null }> = [];
  const warnings: string[] = [];
  for (const product of input.products) {
    const remote = (remoteByOffer.get(product.externalSku) ?? []).shift();
    if (!remote) {
      throw new Error(`В заказе ${input.orderId} нет артикула ${product.externalSku}. Обновите заказы.`);
    }
    // Один УИН — одно изделие. Когда в строке несколько штук, маркировку
    // придётся проставить в кабинете руками: угадывать остальные УИН нельзя.
    const single = remote.count === 1;
    if (!single) {
      warnings.push(`Заказ ${input.orderId}: в строке ${product.externalSku} ${remote.count} шт., УИН передан не был.`);
    }
    boxItems.push({ id: remote.id, count: remote.count, uin: single ? product.uin : null });
  }

  await setYandexOrderBoxes(apiKey, campaignId, input.orderId, buildYandexBoxes(boxItems));

  const current = parseYandexStatus(yandexStatusKey(order.status, order.substatus));
  if (current.status === "PROCESSING" && current.substatus !== "READY_TO_SHIP") {
    await updateYandexOrderStatus(apiKey, campaignId, input.orderId, "PROCESSING", "READY_TO_SHIP");
  }

  const pdf = await getYandexOrderLabels(apiKey, campaignId, input.orderId, "A7");
  const storageKey = await storeLabelFile(runtime, "yandex", input.orderId, pdf, "pdf");
  return { storageKey, warning: warnings.length > 0 ? warnings.join(" ") : null };
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
  | { status: "size_confirm"; uin: string; item: ScanItem; orderSize: string; updSize: string | null }
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

  // Артикул сравнивается в коде, а не в SQL: SQLite не знает регистра кириллицы,
  // и «с-3064зр» из карточки WB не равно «С-3064зр» из 1С. Поэтому из базы
  // берутся строки заданий за последний месяц, а отбор идёт по ключу артикула.
  const candidates = await db.prepare(
    `SELECT ti.id AS itemId, ti.task_id AS taskId, ti.marketplace_id AS marketplaceId,
            ti.external_order_id AS externalOrderId, ti.article, ti.size, ti.cell_code AS cellCode,
            ti.scanned_at AS scannedAt, ti.uin AS itemUin, t.number AS taskNumber, t.status AS taskStatus
     FROM pick_task_items ti
     JOIN pick_tasks t ON t.id = ti.task_id
     WHERE ti.status <> 'not_found' AND t.status <> 'cancelled'
       AND (ti.uin = ? OR t.created_at >= datetime('now', '-45 day'))
     ORDER BY CASE WHEN ti.uin = ? THEN 0 ELSE 1 END, ti.task_id DESC, ti.id`,
  ).bind(uin, uin).all<ScanItem & { itemUin: string | null; taskNumber: string | null; taskStatus: string }>();

  const articleOnly = articleKey(known.article, null) as string;
  const withSize = articleKey(known.article, known.size) as string;
  const sameArticle = candidates.results.filter(
    (row) => row.itemUin === uin || (articleKey(row.article, null) as string) === articleOnly,
  );

  // Размер из УПД — подсказка, а не фильтр: у колец он либо не приходит вовсе
  // («б/р», «16-20», «16,0 +»), либо записан иначе, чем в заказе. Точное
  // совпадение выигрывает, но если его нет, строку не прячем — размер
  // подтверждает человек.
  const exactSize = sameArticle.filter((row) => (articleKey(row.article, row.size) as string) === withSize);
  const rows = exactSize.length > 0 ? exactSize : sameArticle;

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
  const sizeMatches = normalizeSizeValue(orderSize) === normalizeSizeValue(updSize);

  // Размер на Wildberries («16-20», «18,0 +», «б/р») в УПД либо не приходит
  // вовсе, либо записан иначе. Решение — за человеком: подтвердил, значит
  // изделие то самое.
  if (target.marketplaceId === "wildberries" && orderSize && !sizeMatches && input.confirmSize !== true) {
    return { status: "size_confirm", uin, item: target, orderSize, updSize: updSize || null };
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
    // Пояснение про идущую проверку УИН — такая же полезная подсказка, как и
    // ошибка: кладовщик должен понимать, ждать ему или звать старшего.
    return { status: "label_not_ready", uin, item: target, error: label?.error ?? label?.note ?? null };
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

/**
 * Отправления, по которым УИН переданы и идёт проверка в Ozon.
 *
 * Это не ошибка, поэтому на столе они показываются отдельно от красного
 * списка: кладовщику важно видеть, что работа идёт и делать ничего не надо.
 */
export async function readLabelWaiting(db: D1Database, taskId: number) {
  const rows = await db.prepare(
    `SELECT ${LABEL_COLUMNS} FROM shipment_labels
     WHERE task_id = ? AND status = 'pending' AND note IS NOT NULL ORDER BY id LIMIT 50`,
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
