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
import { deliveryConfigured, getMarketplaceCredentials } from "@/lib/credentials";
import {
  checkOzonActStatus,
  createOzonAct,
  getOzonActFile,
  ozonPostingDeliveryMethod,
} from "@/lib/ozon";
import type { AppRuntimeEnv } from "@/lib/runtime-env";
import {
  addOrdersToWildberriesSupply,
  addWildberriesSupplyBoxes,
  createWildberriesSupply,
  deleteWildberriesSupply,
  deliverWildberriesSupply,
  getWildberriesBoxStickers,
  getWildberriesOffices,
  getWildberriesShippingPoints,
  getWildberriesSupplyBarcode,
  getWildberriesSupplyBoxIds,
  getWildberriesWarehouses,
  setWildberriesShippingMethod,
  type WildberriesShippingPoint,
} from "@/lib/wildberries";
import { logWarehouseEvent, readTask } from "@/lib/warehouse";
import { moscowDate, normalizeCity, pickShippingPoint, sameCity } from "@/lib/shipping-point-core.mjs";
import {
  getYandexOrder,
  setYandexOrderTrack,
  updateYandexOrderStatus,
  type YandexOrderAddress,
} from "@/lib/yandex";
import {
  confirmDeliveryOffer,
  createDeliveryOffers,
  createDeliveryRequest,
  generateDeliveryLabels,
  getDeliveryHandoverAct,
} from "@/lib/yandex-delivery";
import { buildDeliveryRequest, yandexHandoverSteps, yandexStatusKey } from "@/lib/yandex-core.mjs";

export type SupplyDocument = {
  kind: "supply_qr" | "box_sticker" | "act" | "act_barcode";
  label: string;
  storageKey: string;
  contentType: string;
};

export type SupplyRow = {
  id: number;
  marketplaceId: "ozon" | "wildberries" | "yandex";
  taskId: number | null;
  externalId: string | null;
  name: string | null;
  status: "open" | "created" | "closed" | "error";
  boxCount: number;
  postingCount: number;
  dropoffPointId: number | null;
  dropoffName: string | null;
  shippingType: string | null;
  shippingDate: string | null;
  documentsJson: string;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  /** Поставку оформили руками в кабинете площадки, а не через сайт. */
  closedManually: number;
  closedBy: string | null;
};

const SUPPLY_COLUMNS = `
  id, marketplace_id AS marketplaceId, task_id AS taskId, external_id AS externalId, name, status,
  box_count AS boxCount, posting_count AS postingCount, dropoff_point_id AS dropoffPointId,
  dropoff_name AS dropoffName, shipping_type AS shippingType, shipping_date AS shippingDate,
  documents_json AS documentsJson, error, created_by AS createdBy,
  created_at AS createdAt, closed_at AS closedAt,
  closed_manually AS closedManually, closed_by AS closedBy
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
/**
 * Обновление справочника пунктов отгрузки по городу.
 *
 * Город — это место, куда склад реально везёт коробки (Кострома, Ярославль),
 * а не регион склада в задании: задание «САМАРА» тоже сдаётся в Ярославле.
 * Идентификатор пункта (shippingPointId) нужен, чтобы закрыть поставку, —
 * старые «офисы» WB для этого не годятся. Город запоминается в списке
 * городов отгрузки.
 */
export async function refreshDropoffPoints(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { city: string; cargoType?: number },
) {
  const city = input.city.trim();
  if (!city) throw new Error("Укажите город отгрузки — WB отдаёт пункты только по городу.");
  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");

  const points = await getWildberriesShippingPoints(credentials.WB_API_TOKEN, city, input.cargoType ?? 1);
  const added = await saveShippingPoints(db, points, city);
  if (points.length === 0) {
    throw new Error(`Wildberries не нашёл пунктов отгрузки в городе «${city}». Проверьте написание: «Кострома», «Ярославль».`);
  }
  // Пункт, который WB убрал из справочника, больше не предлагаем.
  const fresh = new Set(points.map((point) => String(point.id)));
  const known = await db.prepare(
    `SELECT id, external_id AS externalId, city FROM dropoff_points
     WHERE marketplace_id = 'wildberries' AND active = 1 AND office_type IS NOT NULL`,
  ).all<{ id: number; externalId: string; city: string | null }>();
  for (const row of known.results) {
    if (sameCity(row.city, city) && !fresh.has(String(row.externalId))) {
      await db.prepare("UPDATE dropoff_points SET active = 0 WHERE id = ?").bind(row.id).run();
    }
  }
  const cities = await addShippingCity(db, city);
  return { added, found: points.length, city, cities };
}

async function saveShippingPoints(db: D1Database, points: WildberriesShippingPoint[], city: string) {
  let added = 0;
  for (const point of points) {
    if (!point?.id) continue;
    const result = await db.prepare(
      `INSERT INTO dropoff_points (marketplace_id, external_id, name, address, city, office_type, cargo_types, active)
       VALUES ('wildberries', ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(marketplace_id, external_id) DO UPDATE SET
         name = excluded.name, address = excluded.address, city = excluded.city,
         office_type = excluded.office_type, cargo_types = excluded.cargo_types, active = 1`,
    ).bind(
      String(point.id),
      point.name || `Пункт ${point.id}`,
      point.address ?? null,
      point.city ?? city,
      point.officeType ?? null,
      JSON.stringify(point.cargoTypes ?? []),
      // Порядок биндов: external_id, name, address, city, office_type, cargo_types
    ).run();
    added += Number(result.meta.changes ?? 0);
  }
  return added;
}

const SHIPPING_CITIES_KEY = "wb_shipping_cities";
/** Куда склад возит коробки WB: ПВЗ в Костроме или сортировочный центр в Ярославле. */
const DEFAULT_SHIPPING_CITIES = ["Кострома", "Ярославль"];
const dropoffPointKey = (warehouseExternalId: string) => `wb_dropoff_point:${warehouseExternalId}`;

async function saveSetting(db: D1Database, key: string, value: string) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, value).run();
}

async function readSetting(db: D1Database, key: string) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Города отгрузки, пункты которых показываются в списке выбора. */
export async function readShippingCities(db: D1Database): Promise<string[]> {
  const raw = await readSetting(db, SHIPPING_CITIES_KEY);
  if (raw === null) return [...DEFAULT_SHIPPING_CITIES];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  } catch {
    return [...DEFAULT_SHIPPING_CITIES];
  }
}

async function addShippingCity(db: D1Database, city: string) {
  const cities = await readShippingCities(db);
  const next = cities.some((item) => sameCity(item, city)) ? cities : [...cities, city.trim()];
  await saveSetting(db, SHIPPING_CITIES_KEY, JSON.stringify(next));
  return next;
}

export async function removeShippingCity(db: D1Database, city: string) {
  const cities = await readShippingCities(db);
  const next = cities.filter((item) => !sameCity(item, city));
  await saveSetting(db, SHIPPING_CITIES_KEY, JSON.stringify(next));
  return next;
}

/**
 * Города из списка, по которым справочник пунктов ещё пуст, догружаются из
 * WB сами — чтобы в первый раз не пришлось искать кнопку.
 */
export async function ensureShippingCityPoints(db: D1Database, runtime: AppRuntimeEnv) {
  const cities = await readShippingCities(db);
  if (cities.length === 0) return [];
  const rows = await db.prepare(
    `SELECT city FROM dropoff_points WHERE marketplace_id = 'wildberries' AND active = 1 AND office_type IS NOT NULL`,
  ).all<{ city: string | null }>();
  const problems: string[] = [];
  for (const city of cities) {
    if (rows.results.some((row) => sameCity(row.city, city))) continue;
    try {
      await refreshDropoffPoints(db, runtime, { city });
    } catch (error) {
      problems.push(`${city}: ${error instanceof Error ? error.message : "пункты не загрузились"}`);
    }
  }
  return problems;
}

/** Город для запроса к WB: «Ярославль», а не «г. Ярославль» и не «ярославль». */
function cityForRequest(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (raw && !/[,.]/.test(raw) && !/^г\s/i.test(raw)) return raw;
  // Из адреса «Ярославская обл, г. Ярославль. ул. Громова, д. 9».
  const fromAddress = raw.match(/(?:^|[\s,])г\.?\s*([А-ЯЁ][А-ЯЁа-яё-]+)/u);
  if (fromAddress) return fromAddress[1];
  const normalized = normalizeCity(raw);
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "";
}

export type DropoffResolution = {
  city: string;
  officeName: string | null;
  officeAddress: string | null;
  found: number;
  recommendedPointId: number | null;
  confident: boolean;
  distance: number | null;
};

/**
 * Пункт отгрузки под задание Wildberries.
 *
 * Название склада в задании («Самара») — это имя склада продавца в кабинете,
 * а не место сдачи: везут поставку туда, какой склад WB к нему привязан
 * (officeId). Поэтому город и пункт берутся из привязки склада, а не из имени
 * задания. Иначе список заполняется сотнями ПВЗ чужого города, а выбранный
 * из старого справочника «офис» WB отклоняет как IncorrectRequestBody.
 */
export async function resolveWildberriesDropoff(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { taskId: number },
): Promise<DropoffResolution> {
  const task = await readTask(db, input.taskId);
  if (!task) throw new Error("Задание не найдено.");
  if (task.marketplaceId !== "wildberries") throw new Error("Пункт отгрузки подбирается только для заданий Wildberries.");
  if (!task.warehouseExternalId) throw new Error("В задании не указан склад Wildberries.");

  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
  const token = credentials.WB_API_TOKEN;

  const warehouses = await getWildberriesWarehouses(token);
  const warehouse = warehouses.find((row) => String(row.id) === String(task.warehouseExternalId));
  if (!warehouse) {
    throw new Error(`Склад «${task.warehouseName ?? task.warehouseExternalId}» не найден в кабинете Wildberries.`);
  }
  if (!warehouse.officeId) {
    throw new Error(`У склада «${warehouse.name}» в кабинете WB не выбран склад WB для сдачи поставок.`);
  }

  const offices = await getWildberriesOffices(token);
  const office = offices.find((row) => Number(row.id) === Number(warehouse.officeId)) ?? null;
  const city = cityForRequest(office?.city || office?.address || "");
  if (!office || !city) {
    throw new Error(`Wildberries не сообщил адрес склада сдачи (ID ${warehouse.officeId}) для склада «${warehouse.name}».`);
  }

  const cargoType = [1, 2, 3].includes(Number(warehouse.cargoType)) ? Number(warehouse.cargoType) : 1;
  const points = await getWildberriesShippingPoints(token, city, cargoType);
  await saveShippingPoints(db, points, city);

  const local = points.filter((point) => !point.city || sameCity(point.city, city));
  const pick = pickShippingPoint(office, local.length > 0 ? local : points);
  let recommendedPointId: number | null = null;
  if (pick) {
    const row = await db.prepare(
      "SELECT id FROM dropoff_points WHERE marketplace_id = 'wildberries' AND external_id = ?",
    ).bind(String(pick.id)).first<{ id: number }>();
    recommendedPointId = row ? Number(row.id) : null;
  }

  // Подсказку человек запросил сам — город склада сдачи добавляем в список,
  // но пункт не закрепляем: решает тот, кто везёт коробки.
  await addShippingCity(db, city);

  return {
    city,
    officeName: office.name ?? null,
    officeAddress: office.address ?? null,
    found: points.length,
    recommendedPointId,
    confident: Boolean(pick?.confident),
    distance: pick?.distance === null || pick?.distance === undefined ? null : Math.round(pick.distance),
  };
}

/**
 * Пункт по умолчанию для задания: тот, с которым закрывали поставку этого
 * склада в прошлый раз, иначе последний использованный вообще. Наугад пункт
 * не подставляется.
 */
export async function readTaskDropoffContext(db: D1Database, taskId: number | null) {
  const task = taskId ? await readTask(db, taskId) : null;
  const wildberries = task?.marketplaceId === "wildberries";
  let recommendedPointId: number | null = null;
  if (wildberries && task?.warehouseExternalId) {
    const saved = Number(await readSetting(db, dropoffPointKey(task.warehouseExternalId)));
    if (Number.isFinite(saved) && saved > 0) recommendedPointId = saved;
  }
  if (wildberries && !recommendedPointId) {
    const last = await db.prepare(
      `SELECT id FROM dropoff_points
       WHERE marketplace_id = 'wildberries' AND active = 1 AND office_type IS NOT NULL AND last_used_at IS NOT NULL
       ORDER BY last_used_at DESC LIMIT 1`,
    ).first<{ id: number }>();
    recommendedPointId = last ? Number(last.id) : null;
  }
  return { wildberries, recommendedPointId };
}

const TYPE_ORDER: Record<string, number> = { sc: 0, sw: 1, pp: 2 };

/**
 * Пункты отгрузки для выбора.
 *
 * Записи из старого справочника «офисов» WB (office_type пустой) не
 * показываются: WB не принимает их ID как пункт отгрузки. Город сужает список
 * до места сдачи — иначе в нём сотни ПВЗ со всех городов, где их искали.
 */
export async function readDropoffPoints(db: D1Database, marketplaceId?: string, cities?: string[] | null) {
  type Row = { marketplaceId?: string; officeType?: string | null; city?: string | null; address?: string | null; name?: string };
  const all = (await readDropoffPointRows(db, marketplaceId)) as Row[];
  const current = all.filter((point) => point.marketplaceId !== "wildberries" || Boolean(point.officeType));
  if (!cities) return current;
  const cityIndex = (point: Row) => cities.findIndex((city) => sameCity(point.city, city));
  // Порядок: города как в списке, внутри — сортировочный центр и склад WB,
  // затем ПВЗ по адресу.
  return current
    .filter((point) => point.marketplaceId !== "wildberries" || cityIndex(point) >= 0)
    .map((point) => ({ point, city: cityIndex(point) }))
    .sort((left, right) => left.city - right.city
      || (TYPE_ORDER[left.point.officeType ?? ""] ?? 3) - (TYPE_ORDER[right.point.officeType ?? ""] ?? 3)
      || String(left.point.address ?? left.point.name ?? "").localeCompare(String(right.point.address ?? right.point.name ?? ""), "ru"))
    .map((entry) => entry.point);
}

async function readDropoffPointRows(db: D1Database, marketplaceId?: string) {
  const rows = marketplaceId
    ? await db.prepare(
      `SELECT id, marketplace_id AS marketplaceId, external_id AS externalId, name, address,
              city, office_type AS officeType, last_used_at AS lastUsedAt
       FROM dropoff_points WHERE active = 1 AND marketplace_id = ?
       ORDER BY CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END, last_used_at DESC,
                CASE WHEN office_type = 'pp' THEN 1 ELSE 0 END, name, address`,
    ).bind(marketplaceId).all()
    : await db.prepare(
      `SELECT id, marketplace_id AS marketplaceId, external_id AS externalId, name, address,
              city, office_type AS officeType, last_used_at AS lastUsedAt
       FROM dropoff_points WHERE active = 1
       ORDER BY CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END, last_used_at DESC,
                CASE WHEN office_type = 'pp' THEN 1 ELSE 0 END, name, address`,
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
    // Разобранным считается и товар, чей заказ отменён на площадке: в
    // поставку он не попадёт, а блокировка артикула при этом остаётся —
    // снимать её ради поставки значит вернуть в продажу то, чего нет.
    const cancelled = await db.prepare(
      `SELECT DISTINCT o.external_order_id AS externalOrderId
       FROM pick_task_items ti
       JOIN orders o ON o.marketplace_id = ti.marketplace_id AND o.external_order_id = ti.external_order_id
       WHERE ti.task_id = ? AND ti.status = 'not_found' AND o.canceled_at IS NOT NULL`,
    ).bind(taskId).all<{ externalOrderId: string }>();
    const cancelledOrders = new Set(cancelled.results.map((row) => row.externalOrderId));
    const waiting = notFound.filter((row) => !cancelledOrders.has(row.externalOrderId));

    const open = waiting.length > 0
      ? await db.prepare(
        `SELECT article, size FROM problem_articles WHERE state = 'blocked' AND task_id = ?`,
      ).bind(taskId).all<{ article: string; size: string | null }>()
      : { results: [] as Array<{ article: string; size: string | null }> };
    const blocked = waiting.filter((row) => open.results.some(
      (problem) => problem.article === row.article && (problem.size ?? "") === (row.size ?? ""),
    ));
    if (blocked.length > 0) {
      return {
        reason: "Есть неразобранные проблемные товары — отмените их заказы на «Проблемных товарах» или снимите блокировку.",
        details: blocked.map((row) => `${row.article}${row.size ? ` / ${row.size}` : ""} · заказ ${row.externalOrderId}`),
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
    ? await db.prepare(
      "SELECT id, name, external_id AS externalId, office_type AS officeType FROM dropoff_points WHERE id = ?",
    ).bind(input.dropoffPointId).first<{ id: number; name: string; externalId: string; officeType: string | null }>()
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
        shippingPointId: dropoff ? Number(dropoff.externalId) : null,
        shippingPointType: dropoff?.officeType ?? null,
        shippingPointName: dropoff?.name ?? null,
        shippingDate: input.departureDate ?? null,
      });
    } else if (task.marketplaceId === "yandex") {
      await createYandexSupplyFlow(db, runtime, {
        supplyId,
        taskId: input.taskId,
        orderIds: postings.results.map((row) => row.externalOrderId),
        actorEmail: input.actorEmail,
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
    // Пункт, с которым WB закрыл поставку, — проверенный: в следующий раз
    // для этого склада он подставится сам.
    if (task.marketplaceId === "wildberries" && dropoff?.officeType && task.warehouseExternalId) {
      await saveSetting(db, dropoffPointKey(task.warehouseExternalId), String(dropoff.id));
    }

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
  input: {
    supplyId: number;
    taskNumber: string;
    externalId?: string | null;
    orderIds: string[];
    boxCount: number;
    shippingPointId: number | null;
    shippingPointType: string | null;
    shippingPointName?: string | null;
    shippingDate: string | null;
  },
) {
  // Проверяем пункт до любых запросов к WB: ошибка должна говорить, что
  // делать, а не «IncorrectRequestBody».
  if (!input.shippingPointId) {
    throw new Error("Выберите пункт отгрузки: без него Wildberries не закроет поставку.");
  }
  if (!input.shippingPointType) {
    throw new Error(
      `Пункт «${input.shippingPointName ?? input.shippingPointId}» из старого справочника складов WB — `
      + "Wildberries не принимает его как пункт отгрузки. Нажмите «Подобрать пункт отгрузки», выберите пункт и оформите поставку ещё раз.",
    );
  }
  if (!Number.isSafeInteger(input.shippingPointId) || input.shippingPointId <= 0) {
    throw new Error(`Некорректный ID пункта отгрузки: ${input.shippingPointId}. Обновите список пунктов.`);
  }

  const credentials = await getMarketplaceCredentials(db, runtime, "wildberries");
  if (!credentials.WB_API_TOKEN) throw new Error("Ключ Wildberries не добавлен.");
  const token = credentials.WB_API_TOKEN;

  // Поставка уже открыта на упаковке — тогда работаем с ней.
  const externalId = input.externalId ?? await createWildberriesSupply(token, input.taskNumber);
  if (!input.externalId) {
    await db.prepare("UPDATE supplies SET external_id = ? WHERE id = ?").bind(externalId, input.supplyId).run();
  }

  // Большинство заданий попало в поставку ещё на упаковке: повторное
  // добавление — не ошибка, и останавливать из-за него отгрузку нельзя.
  await addOrdersToWildberriesSupply(token, externalId, input.orderIds).catch(() => undefined);

  const documents: SupplyDocument[] = [];

  // Без способа, даты и пункта отгрузки WB не закрывает поставку: отвечает
  // 409 на «передать в доставку». Дата по умолчанию — сегодня по Москве.
  const today = moscowDate();
  const requested = (input.shippingDate ?? "").slice(0, 10);
  const shippingDate = /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= today ? requested : today;
  await setWildberriesShippingMethod(token, {
    supplyId: externalId,
    shippingPointId: input.shippingPointId,
    shippingDate,
    shippingType: "selfShipping",
  });
  await db.prepare("UPDATE supplies SET shipping_type = 'selfShipping', shipping_date = ? WHERE id = ?")
    .bind(shippingDate, input.supplyId).run();

  // Грузоместа WB требует только для поставок на ПВЗ (officeType = pp): там
  // коробки сдают по одной, и на каждой нужен свой QR грузоместа. На
  // сортировочный центр и склад WB короба не заводятся — хватает QR поставки.
  //
  // Короба и их стикеры получаем ДО передачи в доставку: в закрытую поставку
  // грузоместо уже не добавить. Любая ошибка здесь останавливает оформление,
  // поставка остаётся открытой, и повторная попытка доделает начатое.
  const boxStickers: Array<{ id: string; file: string }> = [];
  const needsBoxes = String(input.shippingPointType ?? "").toLowerCase() === "pp";
  if (needsBoxes) {
    const wanted = Math.max(1, Math.trunc(input.boxCount || 1));
    let boxIds = await getWildberriesSupplyBoxIds(token, externalId);
    if (boxIds.length < wanted) {
      try {
        await addWildberriesSupplyBoxes(token, externalId, wanted - boxIds.length);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "ошибка WB";
        throw new Error(
          `Wildberries не завёл короба (${wanted} шт.) для ПВЗ: ${detail}. `
          + "WB разрешает не больше одного короба на два отправления — уменьшите число коробов и оформите ещё раз.",
        );
      }
      boxIds = await getWildberriesSupplyBoxIds(token, externalId);
    }
    if (boxIds.length === 0) throw new Error("Wildberries не вернул короба поставки — повторите оформление.");

    // В ответе нет ID грузоместа: стикеры идут в порядке запроса.
    const stickers = await getWildberriesBoxStickers(token, externalId, boxIds);
    const files = stickers.map((row) => row.file ?? "").filter(Boolean);
    if (files.length < boxIds.length) {
      throw new Error(
        `Wildberries отдал ${files.length} стикеров коробов из ${boxIds.length} — повторите оформление, поставка ещё открыта.`,
      );
    }
    boxIds.forEach((id, index) => boxStickers.push({ id, file: files[index] }));
  }

  await deliverWildberriesSupply(token, externalId);

  const barcode = await getWildberriesSupplyBarcode(token, externalId);
  documents.push({
    kind: "supply_qr",
    label: `QR поставки ${externalId}`,
    storageKey: await storeDocument(runtime, input.supplyId, "supply_qr", 1, barcode, "image/png"),
    contentType: "image/png",
  });

  for (const [index, sticker] of boxStickers.entries()) {
    documents.push({
      kind: "box_sticker",
      label: `Короб ${index + 1} из ${boxStickers.length}`,
      storageKey: await storeDocument(runtime, input.supplyId, "box_sticker", index + 1, sticker.file, "image/png"),
      contentType: "image/png",
    });
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

/**
 * Отгрузка заказов Яндекс Маркета: вызов курьера Яндекс Доставки.
 *
 * Поставки в привычном смысле на DBS нет — есть заявка на курьера по каждому
 * заказу. Порядок по каждому заказу: оффер → бронь → трек-номер в Маркет →
 * статус «передан в доставку». Номер заявки сохраняется, чтобы повторное
 * оформление не вызвало второго курьера на ту же посылку.
 *
 * Один сорвавшийся заказ не отменяет остальные: ошибки копятся и показываются
 * текстом, а ярлыки и акт печатаются по тем заявкам, которые создались.
 */
async function createYandexSupplyFlow(
  db: D1Database,
  runtime: AppRuntimeEnv,
  input: { supplyId: number; taskId: number; orderIds: string[]; actorEmail: string },
) {
  const credentials = await getMarketplaceCredentials(db, runtime, "yandex");
  const apiKey = credentials.YANDEX_API_KEY;
  const campaignId = credentials.YANDEX_CAMPAIGN_ID;
  if (!apiKey || !campaignId) throw new Error("Ключи Яндекс Маркета не добавлены.");
  if (!deliveryConfigured(credentials)) {
    throw new Error("Не заполнены реквизиты Яндекс Доставки: токен, станция отправления и код службы доставки.");
  }
  const token = credentials.YANDEX_DELIVERY_TOKEN as string;
  const stationId = credentials.YANDEX_DELIVERY_STATION_ID as string;
  const deliveryServiceId = Number(credentials.YANDEX_DELIVERY_SERVICE_ID);
  if (!Number.isFinite(deliveryServiceId)) throw new Error("Код службы доставки в Маркете должен быть числом.");

  // Уже созданные заявки по этим же заказам: повторное оформление отгрузки
  // не должно вызвать второго курьера на ту же посылку.
  const existing = new Map<string, string>();
  for (let start = 0; start < input.orderIds.length; start += 100) {
    const chunk = input.orderIds.slice(start, start + 100);
    const rows = await db.prepare(
      `SELECT external_order_id AS externalOrderId, request_id AS requestId
       FROM delivery_requests
       WHERE marketplace_id = 'yandex' AND request_id IS NOT NULL AND status = 'confirmed'
         AND external_order_id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(...chunk).all<{ externalOrderId: string; requestId: string }>();
    for (const row of rows.results) existing.set(row.externalOrderId, row.requestId);
  }

  const requestIds: string[] = [];
  const failures: string[] = [];

  for (const orderId of input.orderIds) {
    const ready = existing.get(orderId);
    if (ready) {
      requestIds.push(ready);
      continue;
    }

    try {
      const order = await getYandexOrder(apiKey, campaignId, orderId);
      if (!order) throw new Error("заказ не найден в Маркете");

      const request = buildDeliveryRequest({
        orderId,
        items: (order.items ?? []).map((item) => ({
          article: String(item.offerId ?? ""),
          name: item.offerName ?? null,
          count: Number(item.count ?? 1),
          price: Number(item.buyerPrice ?? item.price ?? 0),
        })),
        recipient: {
          name: [order.delivery?.address?.recipient, order.buyer?.lastName, order.buyer?.firstName]
            .filter(Boolean).join(" ") || null,
          phone: order.delivery?.address?.phone ?? order.buyer?.phone ?? null,
          email: order.buyer?.email ?? null,
        },
        address: { full: formatYandexAddress(order.delivery?.address ?? null) },
        stationId,
        barcode: orderId,
      });

      // Оффер — это забронированное время вывоза с ценой. Если офферов нет
      // (например, поздно для сегодняшнего вывоза), Доставка подбирает
      // ближайшее время сама методом request/create.
      const offers = await createDeliveryOffers(token, request).catch(() => []);
      const offer = offers[0] ?? null;
      const requestId = offer
        ? await confirmDeliveryOffer(token, offer.offerId)
        : await createDeliveryRequest(token, request);

      await db.prepare(
        `INSERT INTO delivery_requests
           (marketplace_id, external_order_id, task_id, supply_id, offer_id, request_id, status, created_by, confirmed_at)
         VALUES ('yandex', ?, ?, ?, ?, ?, 'confirmed', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET
           task_id = excluded.task_id,
           supply_id = excluded.supply_id,
           offer_id = excluded.offer_id,
           request_id = excluded.request_id,
           status = 'confirmed',
           error = NULL,
           confirmed_at = CURRENT_TIMESTAMP`,
      ).bind(orderId, input.taskId, input.supplyId, offer?.offerId ?? null, requestId, input.actorEmail).run();

      // Трек-номер связывает заказ с заявкой: дальше Маркет сам доводит его
      // до «доставлен» и показывает покупателю отслеживание.
      await setYandexOrderTrack(apiKey, campaignId, orderId, requestId, deliveryServiceId);
      for (const step of yandexHandoverSteps(yandexStatusKey(order.status, order.substatus))) {
        await updateYandexOrderStatus(apiKey, campaignId, orderId, step.status, step.substatus);
      }

      requestIds.push(requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "неизвестная ошибка";
      failures.push(`${orderId}: ${message}`);
      await db.prepare(
        `INSERT INTO delivery_requests (marketplace_id, external_order_id, task_id, supply_id, status, error, created_by)
         VALUES ('yandex', ?, ?, ?, 'error', ?, ?)
         ON CONFLICT(marketplace_id, external_order_id) DO UPDATE SET
           task_id = excluded.task_id,
           supply_id = excluded.supply_id,
           status = 'error',
           error = excluded.error`,
      ).bind(orderId, input.taskId, input.supplyId, message.slice(0, 500), input.actorEmail).run();
    }
  }

  if (requestIds.length === 0) {
    throw new Error(`Яндекс Доставка не приняла ни одной заявки. ${failures.join("; ")}`.slice(0, 500));
  }

  await db.prepare("UPDATE supplies SET external_id = ?, posting_count = ? WHERE id = ?")
    .bind(requestIds[0], requestIds.length, input.supplyId).run();

  const documents: SupplyDocument[] = [];
  const labels = await generateDeliveryLabels(token, requestIds).catch(() => null);
  if (labels) {
    documents.push({
      kind: "box_sticker",
      label: `Ярлыки Яндекс Доставки, заявок: ${requestIds.length}`,
      storageKey: await storeDocument(runtime, input.supplyId, "box_sticker", 1, Buffer.from(labels).toString("base64"), "application/pdf"),
      contentType: "application/pdf",
    });
  }
  const act = await getDeliveryHandoverAct(token, requestIds).catch(() => null);
  if (act) {
    documents.push({
      kind: "act",
      label: `Акт приёма-передачи, заявок: ${requestIds.length}`,
      storageKey: await storeDocument(runtime, input.supplyId, "act", 1, Buffer.from(act).toString("base64"), "application/pdf"),
      contentType: "application/pdf",
    });
  }
  await saveDocuments(db, input.supplyId, documents);

  // Частичный отказ не прячем: остальные заказы уехали, а эти остались на складе.
  if (failures.length > 0) {
    await db.prepare("UPDATE supplies SET error = ? WHERE id = ?")
      .bind(`Не оформлены заказы — ${failures.join("; ")}`.slice(0, 500), input.supplyId).run();
  }
}

/** Адрес доставки одной строкой: Яндекс Доставка принимает его текстом. */
function formatYandexAddress(address: YandexOrderAddress | null) {
  if (!address) return "";
  const parts = [
    address.postcode,
    address.country,
    address.city,
    address.street,
    address.house ? `д. ${address.house}` : null,
    address.block ? `корп. ${address.block}` : null,
    address.entrance ? `подъезд ${address.entrance}` : null,
    address.floor ? `этаж ${address.floor}` : null,
    address.apartment ? `кв. ${address.apartment}` : null,
  ];
  return parts.filter(Boolean).join(", ");
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
