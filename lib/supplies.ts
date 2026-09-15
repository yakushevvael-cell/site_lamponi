/**
 * Оформление поставки (ТЗ, п. 6).
 *
 * Создаётся после того, как всё собрано и отсканировано. Один склад = одна
 * поставка. Пока в задании есть неразобранные проблемные товары, оформление
 * недоступно: поставку с отсутствующим изделием потом не закрыть.
 *
 * Wildberries: создать поставку → добавить сборочные задания → короба →
 * передать в доставку → QR поставки и стикеры коробов.
 * Ozon: акт приёма-передачи по методу доставки; готовится не мгновенно,
 * статус опрашивается, поэтому документы докладываются кнопкой «Обновить».
 */
import { getMarketplaceCredentials } from "@/lib/credentials";
import {
  checkOzonActStatus,
  createOzonAct,
  getOzonActFile,
  ozonPostingDeliveryMethod,
} from "@/lib/ozon";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import {
  addOrderToWildberriesSupply,
  addWildberriesSupplyBoxes,
  createWildberriesSupply,
  deleteWildberriesSupply,
  deliverWildberriesSupply,
  getWildberriesBoxStickers,
  getWildberriesOffices,
  getWildberriesSupplyBarcode,
} from "@/lib/wildberries";
import { logWarehouseEvent, readTask } from "@/lib/warehouse";

export type SupplyDocument = {
  kind: "supply_qr" | "box_sticker" | "act" | "act_barcode";
  label: string;
  storageKey: string;
  contentType: string;
};

export type SupplyRow = {
  id: number;
  marketplaceId: "ozon" | "wildberries";
  taskId: number | null;
  externalId: string | null;
  name: string | null;
  status: "open" | "created" | "closed" | "error";
  boxCount: number;
  postingCount: number;
  dropoffPointId: number | null;
  dropoffName: string | null;
  documentsJson: string;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
};

const SUPPLY_COLUMNS = `
  id, marketplace_id AS marketplaceId, task_id AS taskId, external_id AS externalId, name, status,
  box_count AS boxCount, posting_count AS postingCount, dropoff_point_id AS dropoffPointId,
  dropoff_name AS dropoffName, documents_json AS documentsJson, error, created_by AS createdBy,
  created_at AS createdAt, closed_at AS closedAt
`;

function parseDocuments(row: Pick<SupplyRow, "documentsJson">): SupplyDocument[] {
  try {
    const parsed = JSON.parse(row.documentsJson || "[]");
    return Array.isArray(parsed) ? parsed as SupplyDocument[] : [];
  } catch {
    return [];
  }
}

export function withDocuments(row: SupplyRow) {
  return { ...row, documents: parseDocuments(row) };
}

async function storeDocument(
  runtime: AppRuntimeEnv,
  supplyId: number,
  kind: SupplyDocument["kind"],
  index: number,
  base64: string,
  contentType: string,
) {
  if (!runtime.BUCKET) throw new Error("Хранилище файлов недоступно.");
  const extension = contentType === "application/pdf" ? "pdf" : contentType === "image/svg+xml" ? "svg" : "png";
  const key = `supplies/${supplyId}/${kind}-${index}.${extension}`;
  await runtime.BUCKET.put(key, Uint8Array.from(Buffer.from(base64, "base64")), { httpMetadata: { contentType } });
  return key;
}

async function saveDocuments(db: D1Database, supplyId: number, documents: SupplyDocument[]) {
  await db.prepare("UPDATE supplies SET documents_json = ? WHERE id = ?")
    .bind(JSON.stringify(documents), supplyId).run();
}

/** Точки сдачи: справочник обновляется из API площадки. */
export async function refreshDropoffPoints(db: D1Database, runtime: AppRuntimeEnv) {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  let added = 0;
  if (credentials.WB_API_TOKEN) {
    const offices = await getWildberriesOffices(credentials.WB_API_TOKEN);
    for (const office of offices) {
      const result = await db.prepare(
        `INSERT INTO dropoff_points (marketplace_id, external_id, name, address, active)
         VALUES ('wildberries', ?, ?, ?, 1)
         ON CONFLICT(marketplace_id, external_id) DO UPDATE SET name = excluded.name, address = excluded.address, active = 1`,
      ).bind(String(office.id), office.name || `Склад ${office.id}`, office.address ?? office.city ?? null).run();
      added += Number(result.meta.changes ?? 0);
    }
  }
  return { added };
}

export async function readDropoffPoints(db: D1Database, marketplaceId?: string) {
  const rows = marketplaceId
    ? await db.prepare(
      `SELECT id, marketplace_id AS marketplaceId, external_id AS externalId, name, address,
              last_used_at AS lastUsedAt
       FROM dropoff_points WHERE active = 1 AND marketplace_id = ?
       ORDER BY CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END, last_used_at DESC, name`,
    ).bind(marketplaceId).all()
    : await db.prepare(
      `SELECT id, marketplace_id AS marketplaceId, external_id AS externalId, name, address,
              last_used_at AS lastUsedAt
       FROM dropoff_points WHERE active = 1
       ORDER BY CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END, last_used_at DESC, name`,
    ).all();
  return rows.results;
}

export type SupplyBlocker = { reason: string; details: string[] };

/**
 * Можно ли оформлять поставку по заданию.
 * Кнопка появляется, когда всё отсканировано и проблемные разобраны.
 */
export async function checkSupplyReadiness(db: D1Database, taskId: number): Promise<SupplyBlocker | null> {
  const task = await readTask(db, taskId);
  if (!task) return { reason: "Задание не найдено.", details: [] };
  if (task.status === "cancelled") return { reason: "Задание отменено.", details: [] };
  if (task.status === "shipped") return { reason: "По заданию уже оформлена поставка.", details: [] };

  const rows = await db.prepare(
    `SELECT ti.article, ti.size, ti.status, ti.scanned_at AS scannedAt, ti.external_order_id AS externalOrderId
     FROM pick_task_items ti WHERE ti.task_id = ?`,
  ).bind(taskId).all<{ article: string; size: string | null; status: string; scannedAt: string | null; externalOrderId: string }>();

  const notFound = rows.results.filter((row) => row.status === "not_found");
  if (notFound.length > 0) {
    // ТЗ, п. 6: пока проблемные не разобраны, оформление недоступно.
    const open = await db.prepare(
      `SELECT article, size FROM problem_articles WHERE state = 'blocked' AND task_id = ?`,
    ).bind(taskId).all<{ article: string; size: string | null }>();
    if (open.results.length > 0) {
      return {
        reason: "Есть неразобранные проблемные товары — сначала закройте их.",
        details: open.results.map((row) => `${row.article}${row.size ? ` / ${row.size}` : ""}`),
      };
    }
  }

  const pending = rows.results.filter((row) => row.status !== "not_found" && !row.scannedAt);
  if (pending.length > 0) {
    return {
      reason: "Не всё отсканировано на столе упаковки.",
      details: pending.slice(0, 10).map((row) => `${row.article}${row.size ? ` / ${row.size}` : ""} · ${row.externalOrderId}`),
    };
  }

  return null;
}

/**
 * Открытая поставка Wildberries под задание.
 *
 * WB отдаёт стикер сборочного задания только после того, как задание попало в
 * поставку: у задания в статусе new этикетки не существует. Поэтому поставка
 * заводится не в конце дня, а при первой подготовке этикетки, и задания
 * добавляются в неё по мере упаковки. «Оформить поставку» эту же поставку
 * закрывает — второй не создаёт.
 *
 * Открытая поставка у задания одна: запрет стоит в базе (partial unique
 * index), потому что этикетки может готовить не один стол.
 */
export async function ensureWildberriesSupply(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { taskId: number; taskNumber: string; actorEmail: string },
): Promise<{ supplyId: number; externalId: string }> {
  const openSupply = async () => db.prepare(
    `SELECT id, external_id AS externalId FROM supplies
     WHERE task_id = ? AND marketplace_id = 'wildberries' AND status = 'open' AND external_id IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  ).bind(input.taskId).first<{ id: number; externalId: string }>();

  const existing = await openSupply();
  if (existing?.externalId) return { supplyId: Number(existing.id), externalId: existing.externalId };

  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
  const token = credentials.WB_API_TOKEN;
  const externalId = await createWildberriesSupply(token, input.taskNumber);

  try {
    const insert = await db.prepare(
      `INSERT INTO supplies (marketplace_id, task_id, external_id, name, status, posting_count, created_by)
       VALUES ('wildberries', ?, ?, ?, 'open', 0, ?)`,
    ).bind(input.taskId, externalId, input.taskNumber, input.actorEmail).run();
    const supplyId = Number(insert.meta.last_row_id ?? 0);
    await db.prepare("UPDATE pick_tasks SET supply_id = ? WHERE id = ?").bind(supplyId, input.taskId).run();
    await logWarehouseEvent(db, {
      kind: "supply_opened",
      taskId: input.taskId,
      taskNumber: input.taskNumber,
      marketplaceId: "wildberries",
      actorEmail: input.actorEmail,
      payload: { supplyId, externalId },
    });
    return { supplyId, externalId };
  } catch (error) {
    // Соседний стол успел открыть поставку первым. Свою пустую убираем, чтобы
    // она не мешалась в кабинете WB, и работаем с той, что уже открыта.
    const other = await openSupply();
    if (other?.externalId) {
      await deleteWildberriesSupply(token, externalId).catch(() => undefined);
      return { supplyId: Number(other.id), externalId: other.externalId };
    }
    throw error;
  }
}

export type CreateSupplyInput = {
  taskId: number;
  boxCount: number;
  dropoffPointId?: number | null;
  departureDate?: string | null;
  actorEmail: string;
};

/**
 * Оформляет поставку по заданию.
 *
 * Ошибка площадки не теряется: поставка остаётся в статусе error с текстом,
 * и её видно на экране — иначе склад думает, что документы уже есть.
 */
export async function createSupplyForTask(db: D1Database, runtime: AppRuntimeEnv, input: CreateSupplyInput) {
  const blocker = await checkSupplyReadiness(db, input.taskId);
  if (blocker) return { ok: false as const, blocker };

  const task = await readTask(db, input.taskId);
  if (!task) return { ok: false as const, blocker: { reason: "Задание не найдено.", details: [] } };

  const postings = await db.prepare(
    `SELECT DISTINCT external_order_id AS externalOrderId
     FROM pick_task_items WHERE task_id = ? AND status <> 'not_found' ORDER BY external_order_id`,
  ).bind(input.taskId).all<{ externalOrderId: string }>();
  if (postings.results.length === 0) {
    return { ok: false as const, blocker: { reason: "В задании нет отправлений.", details: [] } };
  }

  const dropoff = input.dropoffPointId
    ? await db.prepare("SELECT id, name, external_id AS externalId FROM dropoff_points WHERE id = ?")
      .bind(input.dropoffPointId).first<{ id: number; name: string; externalId: string }>()
    : null;

  const boxCount = Math.max(1, Math.trunc(input.boxCount || 1));

  // Wildberries: поставка уже открыта на упаковке — без неё не было бы
  // стикеров. Её и закрываем; вторая поставка разорвала бы состав пополам.
  const openWb = task.marketplaceId === "wildberries"
    ? await db.prepare(
      `SELECT id, external_id AS externalId FROM supplies
       WHERE task_id = ? AND marketplace_id = 'wildberries' AND status = 'open'
       ORDER BY id DESC LIMIT 1`,
    ).bind(input.taskId).first<{ id: number; externalId: string | null }>()
    : null;

  let supplyId: number;
  if (openWb) {
    supplyId = Number(openWb.id);
    await db.prepare(
      `UPDATE supplies SET box_count = ?, posting_count = ?, dropoff_point_id = ?, dropoff_name = ?, error = NULL
       WHERE id = ?`,
    ).bind(boxCount, postings.results.length, dropoff?.id ?? null, dropoff?.name ?? null, supplyId).run();
  } else {
    const insert = await db.prepare(
      `INSERT INTO supplies (marketplace_id, task_id, name, status, box_count, posting_count, dropoff_point_id, dropoff_name, created_by)
       VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)`,
    ).bind(
      task.marketplaceId,
      input.taskId,
      `${task.number}`,
      boxCount,
      postings.results.length,
      dropoff?.id ?? null,
      dropoff?.name ?? null,
      input.actorEmail,
    ).run();
    supplyId = Number(insert.meta.last_row_id ?? 0);
  }
  if (!supplyId) return { ok: false as const, blocker: { reason: "Не удалось создать поставку.", details: [] } };

  try {
    if (task.marketplaceId === "wildberries") {
      await createWildberriesSupplyFlow(db, runtime, {
        supplyId,
        taskNumber: task.number,
        externalId: openWb?.externalId ?? null,
        orderIds: postings.results.map((row) => row.externalOrderId),
        boxCount,
      });
    } else {
      await createOzonSupplyFlow(db, runtime, {
        supplyId,
        firstPosting: postings.results[0].externalOrderId,
        boxCount: Math.max(1, Math.trunc(input.boxCount || 1)),
        departureDate: input.departureDate ?? null,
      });
    }

    await db.batch([
      db.prepare("UPDATE pick_tasks SET status = 'shipped', shipped_at = CURRENT_TIMESTAMP, supply_id = ? WHERE id = ?")
        .bind(supplyId, input.taskId),
      db.prepare("UPDATE supplies SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(supplyId),
      ...(dropoff ? [db.prepare("UPDATE dropoff_points SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(dropoff.id)] : []),
    ]);

    await logWarehouseEvent(db, {
      kind: "supply_created",
      taskId: input.taskId,
      taskNumber: task.number,
      marketplaceId: task.marketplaceId,
      actorEmail: input.actorEmail,
      payload: { supplyId, boxes: input.boxCount, postings: postings.results.length, dropoff: dropoff?.name ?? null },
    });

    return { ok: true as const, supply: await readSupply(db, supplyId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Площадка отклонила оформление поставки.";
    // Открытая поставка Wildberries остаётся открытой: в ней уже лежат
    // задания, и закрывать её надо повторной попыткой, а не новой поставкой.
    await db.prepare(
      `UPDATE supplies SET status = CASE WHEN ? = 1 THEN 'open' ELSE 'error' END, error = ? WHERE id = ?`,
    ).bind(openWb ? 1 : 0, message.slice(0, 500), supplyId).run();
    await logWarehouseEvent(db, {
      kind: "supply_failed",
      taskId: input.taskId,
      taskNumber: task.number,
      marketplaceId: task.marketplaceId,
      actorEmail: input.actorEmail,
      payload: { supplyId, error: message },
    });
    return { ok: true as const, supply: await readSupply(db, supplyId) };
  }
}

async function createWildberriesSupplyFlow(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { supplyId: number; taskNumber: string; externalId?: string | null; orderIds: string[]; boxCount: number },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
  const token = credentials.WB_API_TOKEN;

  // Поставка уже открыта на упаковке — тогда работаем с ней.
  const externalId = input.externalId ?? await createWildberriesSupply(token, input.taskNumber);
  if (!input.externalId) {
    await db.prepare("UPDATE supplies SET external_id = ? WHERE id = ?").bind(externalId, input.supplyId).run();
  }

  for (const orderId of input.orderIds) {
    // Большинство заданий попало в поставку ещё на упаковке: повторное
    // добавление — не ошибка, и останавливать из-за него отгрузку нельзя.
    await addOrderToWildberriesSupply(token, externalId, orderId).catch(() => undefined);
  }

  const documents: SupplyDocument[] = [];

  // Короба заводим до закрытия поставки: после «передать в доставку» состав не меняется.
  let boxIds: string[] = [];
  try {
    boxIds = await addWildberriesSupplyBoxes(token, externalId, input.boxCount);
  } catch (error) {
    documents.push({
      kind: "box_sticker",
      label: `Короба не заведены: ${error instanceof Error ? error.message : "ошибка WB"}`,
      storageKey: "",
      contentType: "text/plain",
    });
  }

  await deliverWildberriesSupply(token, externalId);

  const barcode = await getWildberriesSupplyBarcode(token, externalId);
  documents.push({
    kind: "supply_qr",
    label: `QR поставки ${externalId}`,
    storageKey: await storeDocument(runtime, input.supplyId, "supply_qr", 1, barcode, "image/png"),
    contentType: "image/png",
  });

  if (boxIds.length > 0) {
    try {
      const stickers = await getWildberriesBoxStickers(token, externalId, boxIds);
      for (const [index, sticker] of stickers.entries()) {
        const file = sticker.file ?? sticker.barcode ?? "";
        if (!file) continue;
        documents.push({
          kind: "box_sticker",
          label: `Короб ${index + 1} из ${stickers.length}`,
          storageKey: await storeDocument(runtime, input.supplyId, "box_sticker", index + 1, file, "image/png"),
          contentType: "image/png",
        });
      }
    } catch (error) {
      documents.push({
        kind: "box_sticker",
        label: `Стикеры коробов не получены: ${error instanceof Error ? error.message : "ошибка WB"}`,
        storageKey: "",
        contentType: "text/plain",
      });
    }
  }

  await saveDocuments(db, input.supplyId, documents.filter((document) => document.storageKey || document.contentType === "text/plain"));
}

async function createOzonSupplyFlow(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { supplyId: number; firstPosting: string; boxCount: number; departureDate: string | null },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Ключи Ozon не добавлены.");
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;

  const method = await ozonPostingDeliveryMethod(clientId, apiKey, input.firstPosting);
  if (!method.id) throw new Error("Ozon не сообщил метод доставки по отправлению — акт создать не из чего.");

  const actId = await createOzonAct(clientId, apiKey, {
    deliveryMethodId: method.id,
    departureDate: input.departureDate,
    containersCount: input.boxCount,
  });
  await db.prepare("UPDATE supplies SET external_id = ?, dropoff_name = COALESCE(dropoff_name, ?) WHERE id = ?")
    .bind(String(actId), method.name || method.warehouseName || null, input.supplyId).run();

  // Акт готовится не мгновенно: ждём немного, дальше документы докладываются кнопкой.
  await collectOzonActDocuments(db, runtime, input.supplyId, actId, 4);
}

/** Догружает документы Ozon: акт и штрихкод отгрузки, когда они готовы. */
export async function collectOzonActDocuments(
  db: D1Database,
  runtime: AppRuntimeEnv,
  supplyId: number,
  actId: number,
  rounds = 1,
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) throw new Error("Ключи Ozon не добавлены.");
  const clientId = credentials.OZON_CLIENT_ID;
  const apiKey = credentials.OZON_API_KEY;

  const supply = await readSupply(db, supplyId);
  const documents = supply ? parseDocuments(supply) : [];
  const have = new Set(documents.map((document) => document.kind));

  let status = "";
  for (let round = 0; round < Math.max(1, rounds); round += 1) {
    status = await checkOzonActStatus(clientId, apiKey, actId).catch(() => "");
    if (status === "ready" || status === "READY" || status === "formed") break;
    if (round < rounds - 1) await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  for (const kind of ["act", "barcode"] as const) {
    const documentKind: SupplyDocument["kind"] = kind === "act" ? "act" : "act_barcode";
    if (have.has(documentKind)) continue;
    const file = await getOzonActFile(clientId, apiKey, actId, kind);
    if (!file.ok) continue;
    documents.push({
      kind: documentKind,
      label: kind === "act" ? `Акт приёма-передачи ${actId}` : `Штрихкод отгрузки ${actId}`,
      storageKey: await storeDocument(
        runtime,
        supplyId,
        documentKind,
        1,
        Buffer.from(file.bytes).toString("base64"),
        file.contentType,
      ),
      contentType: file.contentType,
    });
  }

  await saveDocuments(db, supplyId, documents);
  return { status, documents };
}

export async function readSupply(db: D1Database, supplyId: number) {
  return db.prepare(`SELECT ${SUPPLY_COLUMNS} FROM supplies WHERE id = ?`).bind(supplyId).first<SupplyRow>();
}

export async function readSupplies(db: D1Database, filter: { taskId?: number; limit?: number } = {}) {
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  const rows = filter.taskId
    ? await db.prepare(`SELECT ${SUPPLY_COLUMNS} FROM supplies WHERE task_id = ? ORDER BY id DESC LIMIT ${limit}`)
      .bind(filter.taskId).all<SupplyRow>()
    : await db.prepare(`SELECT ${SUPPLY_COLUMNS} FROM supplies ORDER BY id DESC LIMIT ${limit}`).all<SupplyRow>();
  return rows.results.map(withDocuments);
}
