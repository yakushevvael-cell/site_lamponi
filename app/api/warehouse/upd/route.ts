/**
 * Загрузка УПД: из неё берутся пары «артикул + УИН».
 *
 * Файл не хранится — из него нужны только пары, а сам документ лежит в 1С.
 * Повторная загрузка того же файла ничего не ломает: УИН уникален, старые
 * записи просто обновляются.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { parseUpdWorkbook } from "@/lib/upd-parser";
import { logWarehouseEvent } from "@/lib/warehouse";

const MAX_FILE_SIZE = 12 * 1024 * 1024;

export async function GET() {
  const auth = await authorizePermission(["warehouse.scan", "warehouse.tasks"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const uploads = await db.prepare(
    `SELECT id, file_name AS fileName, item_count AS itemCount, new_count AS newCount,
            uploaded_by AS uploadedBy, created_at AS createdAt
     FROM upd_uploads ORDER BY id DESC LIMIT 10`,
  ).all();
  const totals = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN used_external_order_id IS NULL THEN 1 ELSE 0 END) AS free
     FROM uin_items`,
  ).first<{ total: number; free: number }>();

  return Response.json({
    uploads: uploads.results,
    total: Number(totals?.total ?? 0),
    free: Number(totals?.free ?? 0),
  });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.scan");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const form = await request.formData();
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

  const uins = parsed.items.map((item) => item.uin);
  const knownCount = await countKnown(db, uins);

  const statements = parsed.items.map((item) => db.prepare(
    `INSERT INTO uin_items (uin, article, size, description, upload_id, created_at)
     VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(uin) DO UPDATE SET
       article = excluded.article,
       size = excluded.size,
       description = excluded.description`,
  ).bind(item.uin, item.article, item.size, item.description));
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }

  const newCount = parsed.items.length - knownCount;
  const insert = await db.prepare(
    `INSERT INTO upd_uploads (file_name, item_count, new_count, uploaded_by) VALUES (?, ?, ?, ?)`,
  ).bind(file.name.slice(0, 200), parsed.items.length, newCount, auth.user.email).run();
  const uploadId = Number(insert.meta.last_row_id ?? 0);
  if (uploadId) {
    // Привязка к загрузке ставится после вставки: у УИН, пришедшего повторно,
    // остаётся первая загрузка — так видно, когда изделие появилось впервые.
    const links = parsed.items.map((item) => db.prepare(
      "UPDATE uin_items SET upload_id = COALESCE(upload_id, ?) WHERE uin = ?",
    ).bind(uploadId, item.uin));
    for (let start = 0; start < links.length; start += 100) {
      await db.batch(links.slice(start, start + 100));
    }
  }

  await logWarehouseEvent(db, {
    kind: "upd_uploaded",
    actorEmail: auth.user.email,
    payload: { file: file.name, items: parsed.items.length, newItems: newCount, sheets: parsed.sheetCount },
  });

  return Response.json({
    ok: true,
    parsed: parsed.items.length,
    newItems: newCount,
    updated: knownCount,
    sheets: parsed.sheetCount,
    errors: parsed.errors.slice(0, 20),
    sample: parsed.items.slice(0, 10),
  });
}

async function countKnown(db: D1Database, uins: string[]) {
  let known = 0;
  for (let start = 0; start < uins.length; start += 200) {
    const chunk = uins.slice(start, start + 200);
    const placeholders = chunk.map(() => "?").join(",");
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM uin_items WHERE uin IN (${placeholders})`)
      .bind(...chunk).first<{ count: number }>();
    known += Number(row?.count ?? 0);
  }
  return known;
}
