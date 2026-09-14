/**
 * Перенос раскладки «артикул → ячейка».
 *
 * Три способа, все заканчиваются одним и тем же: вставить столбцы прямо в поле
 * (Ctrl+V из таблицы), загрузить файл Excel .xlsx или текстовый CSV. Разбор —
 * parsePlacementRows в lib/warehouse-core.mjs, он покрыт тестами.
 *
 * Ответ всегда говорит, сколько строк прочитано и сколько потеряно и почему:
 * потерянная строка раскладки — это изделие, которого сборщик не найдёт, и
 * узнать об этом надо на загрузке, а не на отгрузке.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { parsePlacementTable } from "@/lib/warehouse-core.mjs";
import {
  decodeTextFile,
  looksLikeXlsx,
  parsePlacementWorkbook,
  type PlacementParseResult,
} from "@/lib/placement-parser";
import { importPlacements, logWarehouseEvent, readCells } from "@/lib/warehouse";

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LENGTH = 8 * 1024 * 1024;
const MAX_ROWS = 60000;

function report(parsed: PlacementParseResult) {
  return {
    parsed: parsed.rows.length,
    readRows: parsed.readRows,
    skippedHeader: parsed.skippedHeader,
    headerRow: parsed.headerRow,
    carried: parsed.carried,
    split: parsed.split,
    merged: parsed.merged ?? 0,
    duplicates: parsed.duplicates,
    skipped: parsed.skipped,
    errors: parsed.errors.slice(0, 50),
    newCells: [...new Set(parsed.rows.map((row) => row.cell))].length,
  };
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.cells");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  let parsed: PlacementParseResult | null = null;
  let replace = false;
  let dryRun = false;
  let source = "text";

  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      replace = form.get("replace") === "1";
      dryRun = form.get("dryRun") === "1";
      const options = {
        carryCellDown: form.get("carryCellDown") !== "0",
        splitArticles: form.get("splitArticles") !== "0",
      };
      if (!(file instanceof File)) return Response.json({ error: "Выберите файл." }, { status: 400 });
      if (file.size > MAX_FILE_BYTES) return Response.json({ error: "Файл слишком большой. До 12 МБ." }, { status: 400 });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksLikeXlsx(bytes)) {
        source = "xlsx";
        parsed = parsePlacementWorkbook(bytes, options);
      } else {
        source = "csv";
        parsed = parsePlacementTable(decodeTextFile(bytes), options) as PlacementParseResult;
      }
    } else {
      const body = await request.json().catch(() => null) as {
        text?: unknown; replace?: unknown; dryRun?: unknown;
        carryCellDown?: unknown; splitArticles?: unknown;
      } | null;
      const text = typeof body?.text === "string" ? body.text : "";
      replace = body?.replace === true;
      dryRun = body?.dryRun === true;
      if (text.length > MAX_TEXT_LENGTH) return Response.json({ error: "Слишком много строк за один раз." }, { status: 400 });
      parsed = parsePlacementTable(text, {
        carryCellDown: body?.carryCellDown !== false,
        splitArticles: body?.splitArticles !== false,
      }) as PlacementParseResult;
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Файл не разобрался." }, { status: 400 });
  }

  if (!parsed) return Response.json({ error: "Файл не разобрался." }, { status: 400 });

  if (parsed.rows.length === 0) {
    return Response.json({
      error: "Не удалось разобрать ни одной строки. Нужны два столбца: артикул и номер ячейки.",
      ...report(parsed),
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
      source,
      ...report(parsed),
      sample: parsed.rows.slice(0, 20),
    });
  }

  // Полная замена нужна при переносе: старая раскладка уходит целиком, иначе
  // исчезнувшие из выгрузки артикулы останутся с прежними адресами.
  let removed = 0;
  if (replace) {
    const result = await db.prepare("DELETE FROM cell_placements").run();
    removed = Number(result.meta.changes ?? 0);
  }

  const saved = await importPlacements(db, parsed.rows, auth.user.email);
  await logWarehouseEvent(db, {
    kind: "placements_import_finished",
    actorEmail: auth.user.email,
    payload: { source, parsed: parsed.rows.length, replaced: replace, removed, ...saved },
  });

  const total = await db.prepare("SELECT COUNT(*) AS count FROM cell_placements").first<{ count: number }>();

  return Response.json({
    ok: true,
    source,
    ...report(parsed),
    removed,
    cellsCreated: saved.cellsCreated,
    placements: saved.placements,
    total: Number(total?.count ?? 0),
    cells: await readCells(db),
  });
}
