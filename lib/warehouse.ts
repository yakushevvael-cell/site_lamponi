/**
 * Задания на сборку: отбор заказов, формирование, выдача, закрытие.
 *
 * Чистые правила (нумерация, партии, маршрут по ячейкам) лежат в
 * lib/warehouse-core.mjs и покрыты тестами. Здесь — работа с базой.
 *
 * Главное ограничение заложено в базу, а не в код: уникальный индекс
 * pick_task_item_posting_unique не даёт одному товару одного отправления
 * попасть в два задания. Два кладовщика, нажавшие кнопку одновременно, не
 * выдадут сборщикам один и тот же товар.
 */
import {
  attachCells,
  buildTaskNumber,
  cellSortOrder,
  countCells,
  groupByPosting,
  normalizeBatchSize,
  placementKey,
  sortByRoute,
  sortByWaiting,
  splitIntoBatches,
  taskDay,
} from "@/lib/warehouse-core.mjs";

export type MarketplaceId = "ozon" | "wildberries";
export type PickTaskStatus = "created" | "issued" | "picked" | "shipped" | "cancelled";
export type PickItemStatus = "pending" | "picked" | "not_found";

export const OZON_BATCH_SIZE_KEY = "warehouse_ozon_batch_size";
export const WB_BATCH_SIZE_KEY = "warehouse_wb_batch_size";

/** Статусы Ozon, при которых отправление ждёт сборки. */
const OZON_PICK_STATUSES = ["awaiting_packaging"];

export type CandidateRow = {
  marketplaceId: MarketplaceId;
  externalOrderId: string;
  warehouseExternalId: string | null;
  orderedAt: string | null;
  shipmentDeadline: string | null;
  externalSku: string;
  productSku: string | null;
  article: string;
  size: string | null;
  quantity: number;
};

type PostingGroup = {
  key: string;
  marketplaceId: MarketplaceId;
  externalOrderId: string;
  warehouseExternalId: string | null;
  orderedAt: string | null;
  shipmentDeadline: string | null;
  items: CandidateRow[];
};

export type PickTask = {
  id: number;
  number: string;
  marketplaceId: MarketplaceId;
  warehouseExternalId: string | null;
  warehouseName: string | null;
  status: PickTaskStatus;
  assigneeEmail: string | null;
  orderCount: number;
  itemCount: number;
  unitCount: number;
  pickedCount: number;
  notFoundCount: number;
  cellCount: number;
  createdBy: string | null;
  createdAt: string;
  issuedAt: string | null;
  pickedAt: string | null;
  shippedAt: string | null;
  cancelledAt: string | null;
  printedAt: string | null;
  comment: string | null;
};

export type PickTaskItem = {
  id: number;
  taskId: number;
  marketplaceId: MarketplaceId;
  externalOrderId: string;
  externalSku: string;
  productSku: string | null;
  article: string;
  size: string | null;
  quantity: number;
  cellCode: string | null;
  cellSort: number | null;
  status: PickItemStatus;
  orderedAt: string | null;
  shipmentDeadline: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
};

/** Событие процесса. Из этих записей потом считается весь хронометраж. */
export type WarehouseEvent = {
  kind: string;
  taskId?: number | null;
  taskNumber?: string | null;
  marketplaceId?: string | null;
  externalOrderId?: string | null;
  article?: string | null;
  size?: string | null;
  quantity?: number | null;
  actorEmail?: string | null;
  payload?: Record<string, unknown>;
};

export function eventStatement(db: D1Database, event: WarehouseEvent) {
  return db.prepare(
    `INSERT INTO warehouse_events
       (kind, task_id, task_number, marketplace_id, external_order_id, article, size, quantity, actor_email, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.kind,
    event.taskId ?? null,
    event.taskNumber ?? null,
    event.marketplaceId ?? null,
    event.externalOrderId ?? null,
    event.article ?? null,
    event.size ?? null,
    event.quantity ?? null,
    event.actorEmail ?? null,
    JSON.stringify(event.payload ?? {}),
  );
}

/** Журнал событий не должен ронять действие: пишем, но не падаем из-за записи. */
export async function logWarehouseEvent(db: D1Database, event: WarehouseEvent) {
  await eventStatement(db, event).run().catch(() => undefined);
}

async function readSetting(db: D1Database, key: string) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function readBatchSizes(db: D1Database) {
  const [ozon, wb] = await Promise.all([readSetting(db, OZON_BATCH_SIZE_KEY), readSetting(db, WB_BATCH_SIZE_KEY)]);
  const wbParsed = Number(wb);
  return {
    ozon: normalizeBatchSize(ozon ?? 30, 30),
    // Ноль — «не делить»: у WB задание делится по региональным складам, и
    // дробить его на партии нужно не всегда.
    wildberries: Number.isFinite(wbParsed) && wbParsed > 0 ? normalizeBatchSize(wbParsed, 0) : 0,
  };
}

export async function writeBatchSizes(
  db: D1Database,
  values: { ozon?: unknown; wildberries?: unknown },
  actorEmail: string,
) {
  const statements: D1PreparedStatement[] = [];
  const save = (key: string, value: number) => statements.push(db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, String(value)));

  if (values.ozon !== undefined) save(OZON_BATCH_SIZE_KEY, normalizeBatchSize(values.ozon, 30));
  if (values.wildberries !== undefined) {
    const parsed = Number(values.wildberries);
    save(WB_BATCH_SIZE_KEY, Number.isFinite(parsed) && parsed > 0 ? normalizeBatchSize(parsed, 0) : 0);
  }
  if (statements.length === 0) return readBatchSizes(db);
  statements.push(eventStatement(db, { kind: "settings_changed", actorEmail, payload: { batchSizes: values } }));
  await db.batch(statements);
  return readBatchSizes(db);
}

/**
 * Заказы, ждущие сборки.
 *
 * Отсеиваются: отменённые, уже попавшие в задание и артикулы, числящиеся
 * проблемными (ТЗ, п. 3: проверка при формировании, а не при сборке).
 */
const CANDIDATE_SQL = `
  SELECT o.marketplace_id AS marketplaceId,
         o.external_order_id AS externalOrderId,
         o.warehouse_external_id AS warehouseExternalId,
         o.ordered_at AS orderedAt,
         o.shipment_deadline AS shipmentDeadline,
         oi.external_sku AS externalSku,
         oi.product_sku AS productSku,
         COALESCE(NULLIF(oi.seller_article, ''), NULLIF(p.article, ''), oi.external_sku) AS article,
         COALESCE(oi.size, p.size) AS size,
         oi.quantity AS quantity
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN products p ON p.source_sku = oi.product_sku
  WHERE o.canceled_at IS NULL
    AND (
      (o.marketplace_id = 'ozon' AND o.status IN (${OZON_PICK_STATUSES.map((status) => `'${status}'`).join(", ")}))
      OR (o.marketplace_id = 'wildberries' AND o.status LIKE 'new/%')
    )
    AND NOT EXISTS (
      SELECT 1 FROM pick_task_items ti
      WHERE ti.marketplace_id = o.marketplace_id
        AND ti.external_order_id = o.external_order_id
        AND ti.external_sku = oi.external_sku
    )
    AND NOT EXISTS (
      SELECT 1 FROM problem_articles pa
      WHERE pa.state = 'blocked'
        AND pa.article = COALESCE(NULLIF(oi.seller_article, ''), NULLIF(p.article, ''), oi.external_sku)
        AND (pa.size IS NULL OR pa.size = COALESCE(oi.size, p.size))
    )
`;

export async function readCandidateRows(
  db: D1Database,
  filter: { marketplaceId?: MarketplaceId; warehouseExternalId?: string | null } = {},
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.marketplaceId) {
    conditions.push("AND o.marketplace_id = ?");
    values.push(filter.marketplaceId);
  }
  if (filter.warehouseExternalId) {
    conditions.push("AND o.warehouse_external_id = ?");
    values.push(filter.warehouseExternalId);
  }
  const query = `${CANDIDATE_SQL} ${conditions.join(" ")} ORDER BY o.ordered_at ASC`;
  const rows = await db.prepare(query).bind(...values).all<CandidateRow>();
  return rows.results;
}

/** Сводка по ожидающим заказам: сколько и по каким складам. Для главного экрана. */
export async function readWaitingSummary(db: D1Database) {
  const rows = await readCandidateRows(db);
  const names = await readWarehouseNames(db);
  const groups = new Map<string, {
    marketplaceId: MarketplaceId;
    warehouseExternalId: string | null;
    warehouseName: string;
    postingCount: number;
    itemCount: number;
    unitCount: number;
    oldestOrderedAt: string | null;
    withoutCell: number;
  }>();
  const postings = groupByPosting(rows) as PostingGroup[];
  const placements = await readPlacements(db);
  // Ключ строится тем же placementKey, что и при сборке задания: иначе
  // «без ячейки» на главной и в задании посчитались бы по-разному.
  const cellIndex = new Map<string, unknown>(placements.map((placement) => [placementKey(placement.article, placement.size) as string, placement]));

  for (const posting of postings) {
    const key = `${posting.marketplaceId}::${posting.warehouseExternalId ?? ""}`;
    const group = groups.get(key) ?? {
      marketplaceId: posting.marketplaceId,
      warehouseExternalId: posting.warehouseExternalId,
      warehouseName: names.get(key) ?? (posting.marketplaceId === "ozon" ? "Ozon" : "Склад не указан"),
      postingCount: 0,
      itemCount: 0,
      unitCount: 0,
      oldestOrderedAt: null,
      withoutCell: 0,
    };
    group.postingCount += 1;
    group.itemCount += posting.items.length;
    group.unitCount += posting.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
    if (posting.orderedAt && (!group.oldestOrderedAt || posting.orderedAt < group.oldestOrderedAt)) {
      group.oldestOrderedAt = posting.orderedAt;
    }
    for (const item of posting.items) {
      const exact = cellIndex.get(placementKey(item.article, item.size) as string)
        ?? cellIndex.get(placementKey(item.article, null) as string);
      if (!exact) group.withoutCell += 1;
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    if (left.marketplaceId !== right.marketplaceId) return left.marketplaceId.localeCompare(right.marketplaceId);
    return right.postingCount - left.postingCount;
  });
}

export async function readPlacements(db: D1Database) {
  const rows = await db.prepare(
    `SELECT cp.article AS article, cp.size AS size, c.code AS cellCode, c.sort_order AS sortOrder
     FROM cell_placements cp
     JOIN warehouse_cells c ON c.id = cp.cell_id
     WHERE c.active = 1`,
  ).all<{ article: string; size: string | null; cellCode: string; sortOrder: number }>();
  return rows.results;
}

/** Названия складов площадок: ключ «площадка::внешний id». */
export async function readWarehouseNames(db: D1Database, marketplaceId?: MarketplaceId) {
  const rows = marketplaceId
    ? await db.prepare(
      "SELECT marketplace_id AS marketplaceId, external_id AS externalId, name FROM marketplace_warehouses WHERE marketplace_id = ?",
    ).bind(marketplaceId).all<{ marketplaceId: string; externalId: string; name: string }>()
    : await db.prepare(
      "SELECT marketplace_id AS marketplaceId, external_id AS externalId, name FROM marketplace_warehouses",
    ).all<{ marketplaceId: string; externalId: string; name: string }>();
  return new Map(rows.results.map((row) => [`${row.marketplaceId}::${row.externalId}`, row.name]));
}

export type CreateTasksOptions = {
  marketplaceId: MarketplaceId;
  /** Только один региональный склад WB. Пусто — все склады сразу. */
  warehouseExternalId?: string | null;
  /** Сколько партий создать. Пусто — все, что набралось (кнопка «из остатка»). */
  maxBatches?: number | null;
  actorEmail: string;
};

export type CreatedTask = { id: number; number: string; itemCount: number; warehouseName: string | null };

/**
 * Формирует задания.
 *
 * WB — по одному заданию на каждый региональный склад: сортировка идёт уже на
 * сборке, и смешивать склады нельзя. Ozon — партиями по размеру из настроек,
 * остаток уходит как есть.
 */
export async function createPickTasks(db: D1Database, options: CreateTasksOptions) {
  const rows = await readCandidateRows(db, {
    marketplaceId: options.marketplaceId,
    warehouseExternalId: options.warehouseExternalId ?? undefined,
  });
  if (rows.length === 0) return { created: [] as CreatedTask[], skipped: "Ожидающих заказов нет." };

  const [placements, names, batchSizes] = await Promise.all([
    readPlacements(db),
    readWarehouseNames(db, options.marketplaceId),
    readBatchSizes(db),
  ]);

  const postings = sortByWaiting(groupByPosting(rows) as PostingGroup[]) as PostingGroup[];
  const day = taskDay(new Date());
  const takenRows = await db.prepare("SELECT number FROM pick_tasks WHERE number LIKE ?").bind(`${day}%`).all<{ number: string }>();
  const taken = new Set(takenRows.results.map((row) => row.number));

  const batchSize = options.marketplaceId === "ozon" ? batchSizes.ozon : batchSizes.wildberries;

  // Группы будущих заданий: для WB — по складам, для Ozon — одна очередь.
  const groups: Array<{ warehouseExternalId: string | null; postings: PostingGroup[] }> = [];
  if (options.marketplaceId === "wildberries") {
    const byWarehouse = new Map<string, PostingGroup[]>();
    for (const posting of postings) {
      const key = posting.warehouseExternalId ?? "";
      byWarehouse.set(key, [...(byWarehouse.get(key) ?? []), posting]);
    }
    for (const [key, list] of byWarehouse) {
      groups.push({ warehouseExternalId: key || null, postings: list });
    }
  } else {
    groups.push({ warehouseExternalId: null, postings });
  }

  const created: CreatedTask[] = [];
  let ozonSequence = [...taken].filter((number) => number.startsWith(`${day}-OZ-`)).length;
  let batchesLeft = options.maxBatches && options.maxBatches > 0 ? options.maxBatches : Number.POSITIVE_INFINITY;

  for (const group of groups) {
    const warehouseName = group.warehouseExternalId
      ? names.get(`${options.marketplaceId}::${group.warehouseExternalId}`) ?? `Склад ${group.warehouseExternalId}`
      : options.marketplaceId === "ozon" ? "Ozon" : "Склад не указан";

    const batches = batchSize > 0 ? splitIntoBatches(group.postings, batchSize) : [group.postings];
    for (const batch of batches as PostingGroup[][]) {
      if (batchesLeft <= 0) break;
      if (batch.length === 0) continue;
      if (options.marketplaceId === "ozon") ozonSequence += 1;
      const number = buildTaskNumber({
        day,
        marketplaceId: options.marketplaceId,
        warehouseName,
        sequence: ozonSequence,
        taken: [...taken],
      });
      taken.add(number);

      const task = await insertTask(db, {
        number,
        marketplaceId: options.marketplaceId,
        warehouseExternalId: group.warehouseExternalId,
        warehouseName,
        actorEmail: options.actorEmail,
        postings: batch,
        placements,
      });
      if (task) {
        created.push(task);
        batchesLeft -= 1;
      } else {
        taken.delete(number);
      }
    }
  }

  return { created, skipped: created.length === 0 ? "Все ожидающие заказы уже в заданиях." : null };
}

async function insertTask(
  db: D1Database,
  input: {
    number: string;
    marketplaceId: MarketplaceId;
    warehouseExternalId: string | null;
    warehouseName: string | null;
    actorEmail: string;
    postings: PostingGroup[];
    placements: Array<{ article: string; size: string | null; cellCode: string; sortOrder: number }>;
  },
): Promise<CreatedTask | null> {
  const flat = input.postings.flatMap((posting) => posting.items.map((item) => ({
    ...item,
    orderedAt: posting.orderedAt,
    shipmentDeadline: posting.shipmentDeadline,
  })));
  const routed = sortByRoute(attachCells(flat, input.placements)) as Array<CandidateRow & { cellCode: string | null; cellSort: number | null }>;
  if (routed.length === 0) return null;

  const insert = await db.prepare(
    `INSERT INTO pick_tasks (number, marketplace_id, warehouse_external_id, warehouse_name, status, created_by)
     VALUES (?, ?, ?, ?, 'created', ?)`,
  ).bind(input.number, input.marketplaceId, input.warehouseExternalId, input.warehouseName, input.actorEmail).run();
  const taskId = Number(insert.meta.last_row_id ?? 0);
  if (!taskId) return null;

  // ON CONFLICT DO NOTHING: если тот же товар успел уйти в другое задание,
  // строка просто не добавится, а задание пересчитает свои счётчики по факту.
  const statements = routed.map((item) => db.prepare(
    `INSERT INTO pick_task_items
       (task_id, marketplace_id, external_order_id, external_sku, product_sku, article, size, quantity,
        cell_code, cell_sort, status, ordered_at, shipment_deadline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(marketplace_id, external_order_id, external_sku) DO NOTHING`,
  ).bind(
    taskId,
    item.marketplaceId,
    item.externalOrderId,
    item.externalSku,
    item.productSku,
    item.article,
    item.size,
    Number(item.quantity ?? 1),
    item.cellCode,
    item.cellSort,
    item.orderedAt,
    item.shipmentDeadline,
  ));
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }

  const counters = await refreshTaskCounters(db, taskId);
  if (!counters || counters.itemCount === 0) {
    await db.prepare("DELETE FROM pick_tasks WHERE id = ?").bind(taskId).run();
    return null;
  }

  await logWarehouseEvent(db, {
    kind: "task_created",
    taskId,
    taskNumber: input.number,
    marketplaceId: input.marketplaceId,
    actorEmail: input.actorEmail,
    payload: {
      warehouse: input.warehouseName,
      orders: counters.orderCount,
      items: counters.itemCount,
      units: counters.unitCount,
      cells: counters.cellCount,
      withoutCell: counters.withoutCell,
    },
  });

  return { id: taskId, number: input.number, itemCount: counters.itemCount, warehouseName: input.warehouseName };
}

/** Пересчитывает счётчики задания по его строкам. */
export async function refreshTaskCounters(db: D1Database, taskId: number) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS itemCount,
            COUNT(DISTINCT external_order_id) AS orderCount,
            COALESCE(SUM(quantity), 0) AS unitCount,
            COUNT(DISTINCT CASE WHEN cell_code IS NOT NULL THEN cell_code END) AS cellCount,
            SUM(CASE WHEN cell_code IS NULL THEN 1 ELSE 0 END) AS withoutCell,
            SUM(CASE WHEN status = 'picked' THEN 1 ELSE 0 END) AS pickedCount,
            SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS notFoundCount
     FROM pick_task_items WHERE task_id = ?`,
  ).bind(taskId).first<{
    itemCount: number;
    orderCount: number;
    unitCount: number;
    cellCount: number;
    withoutCell: number;
    pickedCount: number;
    notFoundCount: number;
  }>();
  if (!row) return null;
  await db.prepare(
    `UPDATE pick_tasks
     SET order_count = ?, item_count = ?, unit_count = ?, cell_count = ?, picked_count = ?, not_found_count = ?
     WHERE id = ?`,
  ).bind(
    Number(row.orderCount ?? 0),
    Number(row.itemCount ?? 0),
    Number(row.unitCount ?? 0),
    Number(row.cellCount ?? 0),
    Number(row.pickedCount ?? 0),
    Number(row.notFoundCount ?? 0),
    taskId,
  ).run();
  return {
    itemCount: Number(row.itemCount ?? 0),
    orderCount: Number(row.orderCount ?? 0),
    unitCount: Number(row.unitCount ?? 0),
    cellCount: Number(row.cellCount ?? 0),
    withoutCell: Number(row.withoutCell ?? 0),
    pickedCount: Number(row.pickedCount ?? 0),
    notFoundCount: Number(row.notFoundCount ?? 0),
  };
}

const TASK_COLUMNS = `
  id, number, marketplace_id AS marketplaceId, warehouse_external_id AS warehouseExternalId,
  warehouse_name AS warehouseName, status, assignee_email AS assigneeEmail,
  order_count AS orderCount, item_count AS itemCount, unit_count AS unitCount,
  picked_count AS pickedCount, not_found_count AS notFoundCount, cell_count AS cellCount,
  created_by AS createdBy, created_at AS createdAt, issued_at AS issuedAt, picked_at AS pickedAt,
  shipped_at AS shippedAt, cancelled_at AS cancelledAt, printed_at AS printedAt, comment
`;

export async function readTaskList(
  db: D1Database,
  filter: { statuses?: PickTaskStatus[]; assigneeEmail?: string; limit?: number } = {},
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.statuses && filter.statuses.length > 0) {
    conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    values.push(...filter.statuses);
  }
  if (filter.assigneeEmail) {
    conditions.push("assignee_email = ?");
    values.push(filter.assigneeEmail);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  const rows = await db.prepare(
    `SELECT ${TASK_COLUMNS} FROM pick_tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
  ).bind(...values).all<PickTask>();
  return rows.results;
}

export async function readTask(db: D1Database, taskId: number) {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM pick_tasks WHERE id = ?`).bind(taskId).first<PickTask>();
}

export async function readTaskItems(db: D1Database, taskId: number) {
  const rows = await db.prepare(
    `SELECT id, task_id AS taskId, marketplace_id AS marketplaceId, external_order_id AS externalOrderId,
            external_sku AS externalSku, product_sku AS productSku, article, size, quantity,
            cell_code AS cellCode, cell_sort AS cellSort, status, ordered_at AS orderedAt,
            shipment_deadline AS shipmentDeadline, resolved_by AS resolvedBy, resolved_at AS resolvedAt
     FROM pick_task_items
     WHERE task_id = ?
     ORDER BY CASE WHEN cell_code IS NULL THEN 1 ELSE 0 END, cell_sort, cell_code, article, size`,
  ).bind(taskId).all<PickTaskItem>();
  return rows.results;
}

/**
 * Закрепляет задание за сборщиком.
 *
 * Условие в самом UPDATE: задание достаётся тому, чей запрос пришёл первым.
 * Повторная выдача исключена — второму сборщику вернётся отказ.
 */
export async function assignTask(db: D1Database, taskId: number, assigneeEmail: string, actorEmail: string) {
  const result = await db.prepare(
    `UPDATE pick_tasks
     SET assignee_email = ?, status = 'issued', issued_at = COALESCE(issued_at, CURRENT_TIMESTAMP)
     WHERE id = ? AND status IN ('created', 'issued') AND (assignee_email IS NULL OR assignee_email = ?)`,
  ).bind(assigneeEmail, taskId, assigneeEmail).run();
  if (!result.meta.changes) return null;
  const task = await readTask(db, taskId);
  await logWarehouseEvent(db, {
    kind: "task_issued",
    taskId,
    taskNumber: task?.number ?? null,
    marketplaceId: task?.marketplaceId ?? null,
    actorEmail,
    payload: { assignee: assigneeEmail, items: task?.itemCount ?? 0 },
  });
  return task;
}

/** Снимает исполнителя: задание возвращается в очередь невыданным. */
export async function releaseTask(db: D1Database, taskId: number, actorEmail: string) {
  const result = await db.prepare(
    `UPDATE pick_tasks SET assignee_email = NULL, status = 'created', issued_at = NULL
     WHERE id = ? AND status = 'issued'`,
  ).bind(taskId).run();
  if (!result.meta.changes) return null;
  const task = await readTask(db, taskId);
  await logWarehouseEvent(db, { kind: "task_released", taskId, taskNumber: task?.number ?? null, actorEmail });
  return task;
}

export async function markTaskPrinted(db: D1Database, taskId: number, actorEmail: string) {
  await db.prepare("UPDATE pick_tasks SET printed_at = COALESCE(printed_at, CURRENT_TIMESTAMP) WHERE id = ?")
    .bind(taskId).run();
  await logWarehouseEvent(db, { kind: "task_printed", taskId, actorEmail });
}

export type ResolveResult =
  | { ok: true; item: PickTaskItem; task: PickTask | null }
  | { ok: false; error: string };

/** Отметка по строке задания: собрано либо не найдено. */
export async function resolveTaskItem(
  db: D1Database,
  input: { taskId: number; itemId: number; status: Exclude<PickItemStatus, "pending">; actorEmail: string },
): Promise<ResolveResult> {
  const item = await db.prepare(
    `SELECT id, task_id AS taskId, marketplace_id AS marketplaceId, external_order_id AS externalOrderId,
            external_sku AS externalSku, product_sku AS productSku, article, size, quantity,
            cell_code AS cellCode, cell_sort AS cellSort, status, ordered_at AS orderedAt,
            shipment_deadline AS shipmentDeadline, resolved_by AS resolvedBy, resolved_at AS resolvedAt
     FROM pick_task_items WHERE id = ? AND task_id = ?`,
  ).bind(input.itemId, input.taskId).first<PickTaskItem>();
  if (!item) return { ok: false, error: "Строка задания не найдена." };

  const task = await readTask(db, input.taskId);
  if (!task) return { ok: false, error: "Задание не найдено." };
  if (task.status === "cancelled") return { ok: false, error: "Задание отменено." };
  if (task.status === "shipped") return { ok: false, error: "По заданию уже оформлена поставка." };

  await db.prepare(
    "UPDATE pick_task_items SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(input.status, input.actorEmail, input.itemId).run();
  await refreshTaskCounters(db, input.taskId);

  await logWarehouseEvent(db, {
    kind: input.status === "picked" ? "item_picked" : "item_not_found",
    taskId: input.taskId,
    taskNumber: task.number,
    marketplaceId: item.marketplaceId,
    externalOrderId: item.externalOrderId,
    article: item.article,
    size: item.size,
    quantity: item.quantity,
    actorEmail: input.actorEmail,
    payload: { cell: item.cellCode, previousStatus: item.status },
  });

  return {
    ok: true,
    item: { ...item, status: input.status, resolvedBy: input.actorEmail },
    task: await readTask(db, input.taskId),
  };
}

/**
 * Закрытие задания сборщиком — одна кнопка «Собрано».
 * Строки без отметки считаются собранными: отдельно отмечают только то, чего
 * не нашлось.
 */
export async function closeTask(db: D1Database, taskId: number, actorEmail: string) {
  const task = await readTask(db, taskId);
  if (!task) return { ok: false as const, error: "Задание не найдено." };
  if (task.status === "cancelled") return { ok: false as const, error: "Задание отменено." };
  if (task.status === "picked" || task.status === "shipped") return { ok: false as const, error: "Задание уже закрыто." };

  await db.prepare(
    `UPDATE pick_task_items
     SET status = 'picked', resolved_by = COALESCE(resolved_by, ?), resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
     WHERE task_id = ? AND status = 'pending'`,
  ).bind(actorEmail, taskId).run();
  await db.prepare(
    `UPDATE pick_tasks SET status = 'picked', picked_at = CURRENT_TIMESTAMP,
       assignee_email = COALESCE(assignee_email, ?), issued_at = COALESCE(issued_at, CURRENT_TIMESTAMP)
     WHERE id = ?`,
  ).bind(actorEmail, taskId).run();
  const counters = await refreshTaskCounters(db, taskId);

  await logWarehouseEvent(db, {
    kind: "task_closed",
    taskId,
    taskNumber: task.number,
    marketplaceId: task.marketplaceId,
    actorEmail,
    payload: {
      picked: counters?.pickedCount ?? 0,
      notFound: counters?.notFoundCount ?? 0,
      items: counters?.itemCount ?? 0,
      issuedAt: task.issuedAt,
    },
  });
  return { ok: true as const, task: await readTask(db, taskId) };
}

/**
 * Отмена задания: строки освобождаются и вернутся в следующий отбор.
 * Нужна, когда задание сформировали ошибочно — иначе товар заперт в нём
 * уникальным индексом.
 */
export async function cancelTask(db: D1Database, taskId: number, actorEmail: string, comment?: string | null) {
  const task = await readTask(db, taskId);
  if (!task) return { ok: false as const, error: "Задание не найдено." };
  if (task.status === "shipped") return { ok: false as const, error: "По заданию уже оформлена поставка." };

  await db.batch([
    db.prepare("DELETE FROM pick_task_items WHERE task_id = ?").bind(taskId),
    db.prepare(
      `UPDATE pick_tasks SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, comment = ?,
         order_count = 0, item_count = 0, unit_count = 0, picked_count = 0, not_found_count = 0, cell_count = 0
       WHERE id = ?`,
    ).bind(comment ?? task.comment ?? null, taskId),
    eventStatement(db, {
      kind: "task_cancelled",
      taskId,
      taskNumber: task.number,
      marketplaceId: task.marketplaceId,
      actorEmail,
      payload: { comment: comment ?? null, items: task.itemCount },
    }),
  ]);
  return { ok: true as const, task: await readTask(db, taskId) };
}

/** Ячейки справочника вместе с количеством закреплённых артикулов. */
export async function readCells(db: D1Database) {
  const rows = await db.prepare(
    `SELECT c.id, c.code, c.zone, c.sort_order AS sortOrder, c.active,
            COUNT(cp.id) AS placementCount
     FROM warehouse_cells c
     LEFT JOIN cell_placements cp ON cp.cell_id = c.id
     GROUP BY c.id
     ORDER BY c.sort_order, c.code`,
  ).all<{ id: number; code: string; zone: string | null; sortOrder: number; active: number; placementCount: number }>();
  return rows.results;
}

/**
 * Импорт раскладки: создаёт недостающие ячейки и переписывает привязки.
 * Порядок ячейки считается из её кода, чтобы маршрут сборщика шёл по складу,
 * а не по алфавиту.
 */
export async function importPlacements(
  db: D1Database,
  rows: Array<{ article: string; size: string | null; cell: string }>,
  actorEmail: string,
) {
  const codes = [...new Set(rows.map((row) => row.cell.trim()).filter(Boolean))];
  if (codes.length === 0) return { cellsCreated: 0, placements: 0 };

  const existing = await db.prepare("SELECT id, code FROM warehouse_cells").all<{ id: number; code: string }>();
  const cellIdByCode = new Map(existing.results.map((row) => [row.code.toUpperCase(), row.id]));

  const newCodes = codes.filter((code) => !cellIdByCode.has(code.toUpperCase()));
  if (newCodes.length > 0) {
    const statements = newCodes.map((code) => db.prepare(
      `INSERT INTO warehouse_cells (code, sort_order, active, created_by) VALUES (?, ?, 1, ?)
       ON CONFLICT(code) DO NOTHING`,
    ).bind(code, cellSortOrder(code), actorEmail));
    for (let start = 0; start < statements.length; start += 100) {
      await db.batch(statements.slice(start, start + 100));
    }
    const refreshed = await db.prepare("SELECT id, code FROM warehouse_cells").all<{ id: number; code: string }>();
    cellIdByCode.clear();
    for (const row of refreshed.results) cellIdByCode.set(row.code.toUpperCase(), row.id);
  }

  const placementStatements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const cellId = cellIdByCode.get(row.cell.trim().toUpperCase());
    if (!cellId) continue;
    placementStatements.push(db.prepare(
      `INSERT INTO cell_placements (article, size, cell_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(article, COALESCE(size, '')) DO UPDATE SET
         cell_id = excluded.cell_id, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    ).bind(row.article, row.size, cellId, actorEmail));
  }
  for (let start = 0; start < placementStatements.length; start += 100) {
    await db.batch(placementStatements.slice(start, start + 100));
  }

  await logWarehouseEvent(db, {
    kind: "placements_imported",
    actorEmail,
    payload: { cellsCreated: newCodes.length, placements: placementStatements.length },
  });

  return { cellsCreated: newCodes.length, placements: placementStatements.length };
}
