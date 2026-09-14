/**
 * Разовый перенос раскладки из Google-таблицы.
 *
 * Два способа, оба заканчиваются одним и тем же: вставить два столбца прямо в
 * поле (Ctrl+V из таблицы) или загрузить CSV. Разбор — parsePlacementTable в
 * lib/warehouse-core.mjs, он же покрыт тестами.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { parsePlacementTable } from "@/lib/warehouse-core.mjs";
import { importPlacements, logWarehouseEvent, readCells } from "@/lib/warehouse";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 20000;

type ParsedTable = {
  rows: Array<{ article: string; size: string | null; cell: string }>;
  errors: Array<{ line: number; message: string }>;
  skippedHeader: boolean;
};

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.cells");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  let text = "";
  let replace = false;
  let dryRun = false;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    replace = form.get("replace") === "1";
    dryRun = form.get("dryRun") === "1";
    if (!(file instanceof File)) return Response.json({ error: "Выберите файл." }, { status: 400 });
    if (file.size > MAX_TEXT_BYTES) return Response.json({ error: "Файл слишком большой. До 4 МБ." }, { status: 400 });
    text = await file.text();
  } else {
    const body = await request.json().catch(() => null) as { text?: unknown; replace?: unknown; dryRun?: unknown } | null;
    text = typeof body?.text === "string" ? body.text : "";
    replace = body?.replace === true;
    dryRun = body?.dryRun === true;
    if (text.length > MAX_TEXT_BYTES) return Response.json({ error: "Слишком много строк за один раз." }, { status: 400 });
  }

  const parsed = parsePlacementTable(text) as ParsedTable;
  if (parsed.rows.length === 0) {
    return Response.json({
      error: "Не удалось разобрать ни одной строки. Нужны два столбца: артикул и ячейка.",
      errors: parsed.errors.slice(0, 20),
    }, { status: 400 });
  }
  if (parsed.rows.length > MAX_ROWS) {
    return Response.json({ error: `За один раз до ${MAX_ROWS} строк.` }, { status: 400 });
  }

  // Предпросмотр: показываем, что получилось, и ничего не пишем.
  if (dryRun) {
    return Response.json({
      ok: true,
      dryRun: true,
      parsed: parsed.rows.length,
      skippedHeader: parsed.skippedHeader,
      errors: parsed.errors.slice(0, 20),
      sample: parsed.rows.slice(0, 15),
      newCells: [...new Set(parsed.rows.map((row) => row.cell.toUpperCase()))].length,
    });
  }

  // Полная замена нужна при переносе: старая раскладка из таблицы уходит целиком,
  // иначе исчезнувшие в выгрузке артикулы останутся с прежними адресами.
  let removed = 0;
  if (replace) {
    const result = await db.prepare("DELETE FROM cell_placements").run();
    removed = Number(result.meta.changes ?? 0);
  }

  const saved = await importPlacements(db, parsed.rows, auth.user.email);
  await logWarehouseEvent(db, {
    kind: "placements_import_finished",
    actorEmail: auth.user.email,
    payload: { parsed: parsed.rows.length, replaced: replace, removed, ...saved },
  });

  return Response.json({
    ok: true,
    parsed: parsed.rows.length,
    skippedHeader: parsed.skippedHeader,
    errors: parsed.errors.slice(0, 20),
    removed,
    cellsCreated: saved.cellsCreated,
    placements: saved.placements,
    cells: await readCells(db),
  });
}
