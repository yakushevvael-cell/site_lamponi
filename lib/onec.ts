/**
 * Обмен с 1С «Ювелирное производство»: ключ, регистр ШК и задания для «Расход ГП».
 *
 * Обмен начинает 1С (внешняя обработка «ОбменFBSLamponi»), сайт только
 * отвечает на /api/onec/*. Вход — по ключу в заголовке Authorization, а не по
 * сессии: у регламентного задания 1С нет браузера и пользователя сайта.
 */
import {
  ONEC_TASK_STATUSES,
  bearerToken,
  buildTaskLines,
  generateToken,
  hashToken,
  taskVersion,
  tokenHint,
  type RegistryItem,
  type TaskAck,
  type TaskLine,
} from "@/lib/onec-core.mjs";
import { getRuntimeEnv } from "@/lib/runtime-env";

/** С какого момента задания уходят в 1С — задаётся выпуском первого ключа. */
const TASKS_SINCE_KEY = "onec.tasksSince";
/** Старые задания 1С не пересчитывает каждую минуту: окно — месяц. */
const TASK_WINDOW_DAYS = 30;
/** Столько заданий 1С получает за один опрос. */
const TASK_BATCH = 50;

export type OnecAuth = { db: D1Database; keyId: number };

/** Проверка ключа 1С: контекст с базой или готовый ответ 401/500. */
export async function authorizeOnec(request: Request): Promise<OnecAuth | { response: Response }> {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return { response: Response.json({ error: "База данных недоступна." }, { status: 500 }) };
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return { response: Response.json({ error: "Нужен ключ обмена в заголовке Authorization." }, { status: 401 }) };

  const key = await runtime.DB.prepare(
    "SELECT id FROM onec_api_keys WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(hashToken(token)).first<{ id: number }>();
  if (!key) return { response: Response.json({ error: "Ключ обмена неверный или отозван." }, { status: 401 }) };

  await runtime.DB.prepare("UPDATE onec_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(key.id).run();
  return { db: runtime.DB, keyId: key.id };
}

/**
 * Выпускает новый ключ и отзывает прежние: действующий ключ всегда один,
 * и выпуск нового — это и есть замена утёкшего или потерянного.
 */
export async function issueKey(db: D1Database, actorEmail: string) {
  const token = generateToken();
  await db.batch([
    db.prepare("UPDATE onec_api_keys SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE revoked_at IS NULL").bind(actorEmail),
    db.prepare("INSERT INTO onec_api_keys (token_hash, token_hint, created_by) VALUES (?, ?, ?)")
      .bind(hashToken(token), tokenHint(token), actorEmail),
    // Задания до первого ключа в 1С не уходят: иначе 1С создала бы черновики
    // за всю историю склада. Повторный выпуск ключа эту дату не сдвигает.
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(TASKS_SINCE_KEY, new Date().toISOString()),
  ]);
  return token;
}

export async function revokeKeys(db: D1Database, actorEmail: string) {
  await db.prepare("UPDATE onec_api_keys SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE revoked_at IS NULL")
    .bind(actorEmail).run();
}

/** Состояние обмена для карточки на странице «Подключения». */
export async function readOnecStatus(db: D1Database) {
  const [key, since, registry, upload, tasks, errors] = await Promise.all([
    db.prepare(
      `SELECT token_hint AS hint, created_by AS createdBy, created_at AS createdAt, last_used_at AS lastUsedAt
       FROM onec_api_keys WHERE revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
    ).first<{ hint: string; createdBy: string | null; createdAt: string; lastUsedAt: string | null }>(),
    db.prepare("SELECT value FROM settings WHERE key = ?").bind(TASKS_SINCE_KEY).first<{ value: string }>(),
    db.prepare("SELECT COUNT(*) AS count, MAX(updated_at) AS updatedAt FROM dmdk_registry_items")
      .first<{ count: number; updatedAt: string | null }>(),
    db.prepare(
      `SELECT accepted_count AS acceptedCount, created_at AS createdAt FROM dmdk_registry_uploads
       WHERE uploaded_by = '1С' ORDER BY id DESC LIMIT 1`,
    ).first<{ acceptedCount: number; createdAt: string }>(),
    db.prepare(
      `SELECT COUNT(CASE WHEN last_ok = 1 THEN 1 END) AS ok, COUNT(CASE WHEN last_ok = 0 THEN 1 END) AS failed
       FROM onec_task_sync`,
    ).first<{ ok: number; failed: number }>(),
    db.prepare(
      `SELECT s.task_id AS taskId, t.number AS taskNumber, s.last_message AS message, s.updated_at AS updatedAt
       FROM onec_task_sync s LEFT JOIN pick_tasks t ON t.id = s.task_id
       WHERE s.last_ok = 0 ORDER BY s.updated_at DESC LIMIT 10`,
    ).all<{ taskId: number; taskNumber: string | null; message: string | null; updatedAt: string }>(),
  ]);
  return {
    key: key ?? null,
    tasksSince: since?.value ?? null,
    registry: { count: registry?.count ?? 0, updatedAt: registry?.updatedAt ?? null, lastUpload: upload ?? null },
    tasks: { ok: tasks?.ok ?? 0, failed: tasks?.failed ?? 0, errors: errors.results },
  };
}

/** Что из регистра уже есть на сайте: «ШК<TAB>УИН» построчно — 1С по нему решает, что досылать. */
export async function readKnownRegistry(db: D1Database) {
  const rows = await db.prepare("SELECT barcode, uin FROM dmdk_registry_items ORDER BY barcode").all<{ barcode: string; uin: string }>();
  return rows.results.map((row) => `${row.barcode}\t${row.uin}`).join("\n");
}

/** Записывает пачку регистра: новые строки добавляются, существующие обновляются по ШК. */
export async function saveRegistry(db: D1Database, items: RegistryItem[], rowCount: number, full: boolean) {
  const statements = items.map((item) => db.prepare(
    `INSERT INTO dmdk_registry_items (barcode, uin, article, size, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(barcode) DO UPDATE SET uin = excluded.uin, article = excluded.article,
       size = excluded.size, updated_at = CURRENT_TIMESTAMP`,
  ).bind(item.barcode, item.uin, item.article, item.size));
  statements.push(db.prepare(
    `INSERT INTO dmdk_registry_uploads (file_name, row_count, accepted_count, skipped_count, uploaded_by)
     VALUES (?, ?, ?, ?, '1С')`,
  ).bind(full ? "1С: полная выгрузка" : "1С: новые ШК", rowCount, items.length, rowCount - items.length));
  await db.batch(statements);
}

export type OnecTask = {
  id: number;
  number: string;
  marketplace: string;
  status: string;
  createdAt: string;
  version: string;
  document: string;
  lines: TaskLine[];
};

/**
 * Задания, по которым 1С должна что-то сделать: новые и изменившиеся с
 * последнего подтверждения. Отменённое задание уходит, только если по нему
 * уже есть документ — иначе в 1С нечего помечать на удаление.
 */
export async function readPendingTasks(db: D1Database): Promise<OnecTask[]> {
  const since = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(TASKS_SINCE_KEY).first<{ value: string }>();
  if (!since?.value) return [];
  const windowStart = new Date(Date.now() - TASK_WINDOW_DAYS * 86_400_000).toISOString();
  const from = since.value > windowStart ? since.value : windowStart;

  const placeholders = ONEC_TASK_STATUSES.map(() => "?").join(", ");
  const tasks = await db.prepare(
    `SELECT t.id, t.number, t.marketplace_id AS marketplace, t.status, t.created_at AS createdAt,
            s.acked_version AS ackedVersion, s.document_id AS documentId
     FROM pick_tasks t
     LEFT JOIN onec_task_sync s ON s.task_id = t.id
     WHERE t.status IN (${placeholders})
       AND datetime(COALESCE(t.issued_at, t.created_at)) >= datetime(?)
     ORDER BY t.id`,
  ).bind(...ONEC_TASK_STATUSES, from).all<{
    id: number; number: string; marketplace: string; status: string; createdAt: string;
    ackedVersion: string | null; documentId: string | null;
  }>();

  const result: OnecTask[] = [];
  for (const task of tasks.results) {
    if (task.status === "cancelled" && !task.documentId) continue;
    const lines = task.status === "cancelled" ? [] : await readTaskLines(db, task.id);
    const version = taskVersion(task.status, lines);
    if (version === task.ackedVersion) continue;
    result.push({
      id: task.id,
      number: task.number,
      marketplace: task.marketplace,
      status: task.status,
      createdAt: task.createdAt,
      version,
      document: task.documentId ?? "",
      lines,
    });
    if (result.length >= TASK_BATCH) break;
  }
  return result;
}

/**
 * Строки задания: отсканированные на столе изделия с ШК из регистра 1С и ценой из заказа.
 * Цена — `order_items.unit_price` той позиции отправления, к которой относится
 * изделие; строка задания — одна штука, поэтому это и есть сумма строки.
 */
async function readTaskLines(db: D1Database, taskId: number) {
  const rows = await db.prepare(
    `SELECT i.id, i.uin, i.scanned_at AS scannedAt,
            (SELECT MIN(r.barcode) FROM dmdk_registry_items r WHERE r.uin = i.uin) AS barcode,
            (SELECT oi.unit_price FROM orders o
               JOIN order_items oi ON oi.order_id = o.id
              WHERE o.marketplace_id = i.marketplace_id
                AND o.external_order_id = i.external_order_id
                AND oi.external_sku = i.external_sku
              LIMIT 1) AS unitPrice
     FROM pick_task_items i
     WHERE i.task_id = ?`,
  ).bind(taskId).all<{ id: number; uin: string | null; scannedAt: string | null; barcode: string | null; unitPrice: number | null }>();
  return buildTaskLines(rows.results);
}

/**
 * Ответ 1С по заданию. Успех подтверждает версию — задание больше не уходит,
 * пока не изменится. Ошибка версию не подтверждает: задание уйдёт снова.
 */
export async function saveTaskAck(db: D1Database, ack: TaskAck) {
  const task = await db.prepare("SELECT id FROM pick_tasks WHERE id = ?").bind(ack.id).first<{ id: number }>();
  if (!task) return false;
  await db.prepare(
    `INSERT INTO onec_task_sync (task_id, acked_version, document_id, document_number, document_date,
                                 last_ok, last_message, attempts, updated_at)
     VALUES (?1, CASE WHEN ?2 = 1 THEN ?3 END, NULLIF(?4, ''), NULLIF(?5, ''), NULLIF(?6, ''), ?2, ?7, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(task_id) DO UPDATE SET
       acked_version = CASE WHEN ?2 = 1 THEN ?3 ELSE onec_task_sync.acked_version END,
       document_id = COALESCE(NULLIF(?4, ''), onec_task_sync.document_id),
       document_number = COALESCE(NULLIF(?5, ''), onec_task_sync.document_number),
       document_date = COALESCE(NULLIF(?6, ''), onec_task_sync.document_date),
       last_ok = ?2,
       last_message = ?7,
       attempts = onec_task_sync.attempts + 1,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(ack.id, ack.ok ? 1 : 0, ack.version, ack.document, ack.documentNumber, ack.documentDate, ack.message).run();
  return true;
}
