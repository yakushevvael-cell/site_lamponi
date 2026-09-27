/**
 * Загрузка УПД к заданию: одна УПД — одно задание.
 *
 * Порядок на столе: скан листа подбора, затем загрузка УПД. Сайт сверяет
 * изделия задания («артикул + размер + отправление») с УПД («артикул +
 * размер + УИН»). Только если сошлось всё, УИН закрепляются за изделиями, и
 * подготовка этикеток передаёт их на площадку. Если не сошлось — ничего не
 * записывается, на экране список расхождений, и упаковка по заданию
 * заблокирована до загрузки верной УПД.
 *
 * Свободных УИН на сайте нет: УИН не из УПД этого задания не используются
 * ни для чего, а после закрытия поставки УИН задания удаляются.
 *
 * Файл не хранится — из него нужны только тройки, а сам документ лежит в 1С.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { matchUpdToTask } from "@/lib/upd-match.mjs";
import { parseUpdWorkbook } from "@/lib/upd-parser";
import { findTaskByPickSheet, logWarehouseEvent, readTask } from "@/lib/warehouse";

const MAX_FILE_SIZE = 12 * 1024 * 1024;

type UploadRow = {
  id: number;
  fileName: string;
  itemCount: number;
  status: "matched" | "mismatch" | null;
  problemsJson: string | null;
  uploadedBy: string | null;
  createdAt: string;
};

function parseProblems(value: string | null) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Состояние УПД задания: сверена ли, и что не сошлось в последней загрузке. */
export async function GET(request: Request) {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const taskId = Number(new URL(request.url).searchParams.get("task"));
  if (!Number.isFinite(taskId) || taskId <= 0) return Response.json({ error: "Не указано задание." }, { status: 400 });
  const task = await readTask(db, taskId);
  if (!task) return Response.json({ error: "Задание не найдено." }, { status: 404 });

  const last = await db.prepare(
    `SELECT id, file_name AS fileName, item_count AS itemCount, status, problems_json AS problemsJson,
            uploaded_by AS uploadedBy, created_at AS createdAt
     FROM upd_uploads WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
  ).bind(taskId).first<UploadRow>();

  return Response.json({
    matched: Boolean(task.updMatchedAt),
    matchedAt: task.updMatchedAt,
    lastUpload: last
      ? {
        fileName: last.fileName,
        items: Number(last.itemCount ?? 0),
        status: last.status,
        problems: parseProblems(last.problemsJson),
        uploadedBy: last.uploadedBy,
        createdAt: last.createdAt,
      }
      : null,
  });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.scan");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const form = await request.formData();
  const code = form.get("code");
  const task = typeof code === "string" && code ? await findTaskByPickSheet(db, code) : null;
  if (!task) return Response.json({ error: "Сначала отсканируйте лист подбора, затем загрузите УПД." }, { status: 400 });
  if (task.status === "cancelled") return Response.json({ error: `Задание ${task.number} отменено.` }, { status: 409 });
  if (task.status === "shipped") {
    return Response.json({ error: `По заданию ${task.number} уже оформлена поставка.` }, { status: 409 });
  }
  if (task.updMatchedAt) {
    return Response.json({
      error: `УПД задания ${task.number} уже сверена, УИН закреплены и передаются на площадку. Повторная загрузка не нужна.`,
    }, { status: 409 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Выберите файл УПД." }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return Response.json({ error: "Нужен файл в формате .xlsx. Старый .xls откройте в Excel и сохраните как .xlsx." }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) return Response.json({ error: "Файл слишком большой. До 12 МБ." }, { status: 400 });

  let parsed;
  try {
    parsed = parseUpdWorkbook(await file.arrayBuffer());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось прочитать файл." }, { status: 400 });
  }

  if (parsed.items.length === 0) {
    return Response.json({
      error: parsed.headerFound
        ? "В УПД не нашлось ни одной пары «артикул + УИН». Проверьте колонки «Код товара/работ, услуг» и «Наименование товара», где указан УИН."
        : "В файле не нашлось шапки УПД: нужны колонки «Код товара/работ, услуг» и «Наименование товара».",
      errors: parsed.errors.slice(0, 20),
    }, { status: 400 });
  }

  // Изделия задания. «Не найден» в поставку не едет, и УИН ему не нужен.
  // Изделие, которое уже отсканировано или чей УИН уже у площадки, держит
  // свой УИН: он обязан найтись в этой УПД.
  const items = await db.prepare(
    `SELECT ti.id, ti.external_order_id AS externalOrderId, ti.article, ti.size, ti.uin,
            CASE WHEN ti.uin IS NOT NULL AND (
              ti.scanned_at IS NOT NULL OR EXISTS (
                SELECT 1 FROM shipment_labels sl
                WHERE sl.marketplace_id = ti.marketplace_id AND sl.external_order_id = ti.external_order_id
                  AND (sl.status = 'ready' OR (sl.status = 'pending' AND sl.note IS NOT NULL) OR sl.ship_postings IS NOT NULL)
              )
            ) THEN 1 ELSE 0 END AS locked,
            ti.marketplace_id AS marketplaceId
     FROM pick_task_items ti
     WHERE ti.task_id = ? AND ti.status <> 'not_found'
     ORDER BY ti.external_order_id, ti.id`,
  ).bind(task.id).all<{
    id: number; externalOrderId: string; article: string; size: string | null; uin: string | null;
    locked: number; marketplaceId: string;
  }>();

  const match = matchUpdToTask({
    items: items.results.map((row) => ({ ...row, locked: Number(row.locked) === 1 })),
    uins: parsed.items,
  }) as { ok: boolean; assign: Array<{ itemId: number; uin: string }>; problems: string[] };

  // УИН уже в другом открытом задании — это чужая УПД или пересорт.
  const problems = [...match.problems];
  const uins = parsed.items.map((item) => item.uin);
  for (const conflict of await findForeignUins(db, uins, task.id)) {
    problems.push(`УИН ${conflict.uin} уже закреплён за заданием ${conflict.taskNumber ?? conflict.taskId}.`);
  }
  if (items.results.length === 0) problems.push("В задании нет изделий для упаковки.");
  const ok = problems.length === 0;

  const insert = await db.prepare(
    `INSERT INTO upd_uploads (file_name, item_count, new_count, uploaded_by, task_id, status, problems_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    file.name.slice(0, 200),
    parsed.items.length,
    parsed.items.length,
    auth.user.email,
    task.id,
    ok ? "matched" : "mismatch",
    ok ? null : JSON.stringify(problems.slice(0, 200)),
  ).run();
  const uploadId = Number(insert.meta.last_row_id ?? 0);

  if (!ok) {
    await logWarehouseEvent(db, {
      kind: "upd_mismatch",
      taskId: task.id,
      taskNumber: task.number,
      marketplaceId: task.marketplaceId,
      actorEmail: auth.user.email,
      payload: { file: file.name, items: parsed.items.length, problems: problems.slice(0, 50) },
    });
    return Response.json({
      ok: false,
      error: `УПД не сходится с заданием ${task.number}. Исправьте УПД и загрузите заново — до этого упаковка по заданию заблокирована.`,
      problems: problems.slice(0, 200),
    }, { status: 422 });
  }

  // Сошлось: каждый УИН закрепляется за своим изделием. Всё одной пачкой —
  // половина закреплённых УИН хуже, чем ни одного.
  const byItem = new Map(items.results.map((row) => [row.id, row]));
  const byUin = new Map(parsed.items.map((item) => [item.uin, item]));
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM uin_items WHERE task_id = ?").bind(task.id),
  ];
  for (const pair of match.assign) {
    const row = byItem.get(pair.itemId);
    const source = byUin.get(pair.uin);
    if (!row || !source) continue;
    statements.push(
      db.prepare(
        `INSERT INTO uin_items
           (uin, article, size, description, upload_id, task_id, created_at,
            used_marketplace_id, used_external_order_id, used_task_id, used_at, used_by)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      ).bind(
        pair.uin,
        source.article,
        source.size,
        source.description,
        uploadId || null,
        task.id,
        row.marketplaceId,
        row.externalOrderId,
        task.id,
        auth.user.email,
      ),
      db.prepare("UPDATE pick_task_items SET uin = ? WHERE id = ? AND task_id = ?").bind(pair.uin, pair.itemId, task.id),
    );
  }
  statements.push(
    db.prepare("UPDATE pick_tasks SET upd_matched_at = CURRENT_TIMESTAMP, upd_upload_id = ? WHERE id = ?")
      .bind(uploadId || null, task.id),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    // Соседний стол успел закрепить тот же УИН за другим заданием.
    const message = error instanceof Error ? error.message : "";
    return Response.json({
      error: /UNIQUE|PRIMARY KEY/i.test(message)
        ? "Часть УИН из этой УПД только что закрепили за другим заданием. Проверьте УПД."
        : "Не удалось закрепить УИН. Повторите загрузку.",
    }, { status: 409 });
  }

  await logWarehouseEvent(db, {
    kind: "upd_matched",
    taskId: task.id,
    taskNumber: task.number,
    marketplaceId: task.marketplaceId,
    actorEmail: auth.user.email,
    payload: { file: file.name, items: parsed.items.length, uploadId, sheets: parsed.sheetCount },
  });

  return Response.json({
    ok: true,
    taskId: task.id,
    taskNumber: task.number,
    bound: match.assign.length,
    parsed: parsed.items.length,
    errors: parsed.errors.slice(0, 20),
  });
}

async function findForeignUins(db: D1Database, uins: string[], taskId: number) {
  const found: Array<{ uin: string; taskId: number; taskNumber: string | null }> = [];
  for (let start = 0; start < uins.length; start += 200) {
    const chunk = uins.slice(start, start + 200);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT u.uin, u.task_id AS taskId, t.number AS taskNumber
       FROM uin_items u LEFT JOIN pick_tasks t ON t.id = u.task_id
       WHERE u.uin IN (${placeholders}) AND (u.task_id IS NULL OR u.task_id <> ?)`,
    ).bind(...chunk, taskId).all<{ uin: string; taskId: number; taskNumber: string | null }>();
    found.push(...rows.results);
  }
  return found;
}
