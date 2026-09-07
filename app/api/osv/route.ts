import { desc } from "drizzle-orm";

import { getDb } from "@/db";
import { osvUploads } from "@/db/schema";
import { authorizeApi } from "@/lib/app-auth";
import { parseOsvWorkbook } from "@/lib/osv-parser";
import { rebuildReservations } from "@/lib/reservations";
import { getRuntimeEnv } from "@/lib/runtime-env";

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const PREVIEW_ROWS = 25;

function safeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]+/g, "-").slice(0, 120);
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  if (message.includes("no such table")) return "Хранилище еще не подготовлено. Повторите загрузку через минуту.";
  return message;
}

/** Дата ОСВ: администратор указывает её явно, по умолчанию — момент загрузки. */
function normalizeBalanceDate(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return new Date().toISOString();
  const parsed = new Date(raw.length === 10 ? `${raw}T23:59:59Z` : raw);
  if (Number.isNaN(parsed.getTime())) throw new Error("Некорректная дата ОСВ.");
  if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new Error("Дата ОСВ не может быть в будущем.");
  return parsed.toISOString();
}

export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  try {
    const rows = await getDb().select().from(osvUploads).orderBy(desc(osvUploads.createdAt)).limit(20);
    return Response.json({ uploads: rows });
  } catch (error) {
    return Response.json({ error: errorMessage(error), uploads: [] }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Предпросмотр доступен всем, у кого есть доступ к сервису; применение ОСВ
  // меняет остатки и запускает выгрузку, поэтому это действие администратора.
  const formData = await request.formData();
  const mode = formData.get("mode") === "apply" ? "apply" : "preview";
  const auth = await authorizeApi(mode === "apply");
  if ("response" in auth) return auth.response;
  try {
    const file = formData.get("file");
    const acceptBlockers = formData.get("acceptBlockers") === "1";
    const balanceDate = normalizeBalanceDate(formData.get("balanceDate"));

    if (!(file instanceof File)) return Response.json({ error: "Выберите файл ОСВ." }, { status: 400 });
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return Response.json({ error: "Поддерживается только формат .xlsx." }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: "Файл слишком большой. Максимальный размер — 12 МБ." }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const parsed = parseOsvWorkbook(buffer);
    const runtime = getRuntimeEnv();
    if (!runtime.DB) throw new Error("База данных временно недоступна.");
    const db = runtime.DB;

    // Сравнение с текущими остатками: администратор видит «было / стало» до применения.
    const currentRows = await db.prepare(
      "SELECT source_sku AS sourceSku, article, size, current_physical_qty AS quantity FROM products",
    ).all<{ sourceSku: string; article: string; size: string | null; quantity: number }>();
    const currentBySku = new Map(currentRows.results.map((row) => [row.sourceSku, row]));
    const nextBySku = new Map(parsed.products.map((product) => [product.variantKey, product]));

    const changes: Array<{ sourceSku: string; article: string; size: string | null; before: number; after: number; delta: number }> = [];
    for (const product of parsed.products) {
      const before = Number(currentBySku.get(product.variantKey)?.quantity ?? 0);
      const after = product.quantity;
      if (Math.abs(after - before) > 0.001) {
        changes.push({ sourceSku: product.variantKey, article: product.article, size: product.size, before, after, delta: after - before });
      }
    }
    for (const row of currentRows.results) {
      if (nextBySku.has(row.sourceSku) || Number(row.quantity) === 0) continue;
      // Позиция исчезла из новой ОСВ — её остаток обнулится.
      changes.push({ sourceSku: row.sourceSku, article: row.article, size: row.size, before: Number(row.quantity), after: 0, delta: -Number(row.quantity) });
    }
    changes.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

    const diff = {
      changedCount: changes.length,
      addedCount: parsed.products.filter((product) => !currentBySku.has(product.variantKey)).length,
      disappearedCount: currentRows.results.filter((row) => !nextBySku.has(row.sourceSku) && Number(row.quantity) !== 0).length,
      quantityBefore: currentRows.results.reduce((sum, row) => sum + Number(row.quantity), 0),
      quantityAfter: parsed.totalQuantity,
      topChanges: changes.slice(0, PREVIEW_ROWS),
    };

    const preview = {
      fileName: file.name,
      balanceDate,
      sheetName: parsed.sheetName,
      quantityColumn: parsed.quantityColumn,
      headerRowNumber: parsed.headerRowNumber,
      articleCount: parsed.articleCount,
      variantCount: parsed.variantCount,
      sizedVariantCount: parsed.sizedVariantCount,
      unsizedVariantCount: parsed.unsizedVariantCount,
      totalQuantity: parsed.totalQuantity,
      reportedTotal: parsed.reportedTotal,
      zeroQuantityCount: parsed.zeroQuantityCount,
      warnings: parsed.warnings,
      blockers: parsed.blockers,
      diff,
    };

    if (mode === "preview") {
      return Response.json({ mode: "preview", preview, canApply: parsed.blockers.length === 0 });
    }

    // Расхождение итогов означает, что данным доверять нельзя: без явного
    // подтверждения администратора такую ОСВ применять запрещено (ТЗ, п. 9).
    if (parsed.blockers.length > 0 && !acceptBlockers) {
      return Response.json({
        error: "ОСВ не сходится. Проверьте выгрузку или подтвердите загрузку явно.",
        preview,
        blockers: parsed.blockers,
      }, { status: 409 });
    }

    const uploadedBy = auth.user.email;
    const storageKey = `osv/${new Date().toISOString().replaceAll(":", "-")}-${safeFileName(file.name)}`;

    if (runtime.BUCKET) {
      await runtime.BUCKET.put(storageKey, buffer, {
        httpMetadata: { contentType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        customMetadata: { originalName: file.name },
      });
    }

    const [upload] = await getDb()
      .insert(osvUploads)
      .values({
        fileName: file.name,
        storageKey: runtime.BUCKET ? storageKey : null,
        articleCount: parsed.articleCount,
        skuCount: parsed.variantCount,
        sizedVariantCount: parsed.sizedVariantCount,
        totalQuantity: parsed.totalQuantity,
        zeroQuantityCount: parsed.zeroQuantityCount,
        warningCount: parsed.warnings.length,
        warningsJson: JSON.stringify(parsed.warnings),
        balanceDate,
        acceptedWithBlockers: parsed.blockers.length > 0,
        blockersJson: JSON.stringify(parsed.blockers),
        uploadedBy,
      })
      .returning({ id: osvUploads.id, createdAt: osvUploads.createdAt });

    const statements = parsed.products.flatMap((product) => [
      db.prepare(
        `INSERT INTO products (source_sku, article, size, current_physical_qty, latest_upload_id, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(source_sku) DO UPDATE SET
           article = excluded.article,
           size = excluded.size,
           current_physical_qty = excluded.current_physical_qty,
           latest_upload_id = excluded.latest_upload_id,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(product.variantKey, product.article, product.size, product.quantity, upload.id),
      db.prepare(
        "INSERT INTO stock_snapshots (upload_id, product_sku, physical_qty) VALUES (?, ?, ?)",
      ).bind(upload.id, product.variantKey, product.quantity),
    ]);

    for (let index = 0; index < statements.length; index += 80) {
      await db.batch(statements.slice(index, index + 80));
    }
    await db.prepare(
      "UPDATE products SET current_physical_qty = 0, latest_upload_id = ?, updated_at = CURRENT_TIMESTAMP WHERE latest_upload_id IS NULL OR latest_upload_id <> ?",
    ).bind(upload.id, upload.id).run();

    // Резерв пересчитывается целиком: гасим только те отгрузки, которые эта ОСВ
    // уже учла (сравнение с датой ОСВ), и снимаем протухшие резервы.
    const reservations = await rebuildReservations(db);

    return Response.json({
      mode: "apply",
      upload: {
        id: upload.id,
        fileName: file.name,
        createdAt: upload.createdAt,
        balanceDate,
        articleCount: parsed.articleCount,
        variantCount: parsed.variantCount,
        sizedVariantCount: parsed.sizedVariantCount,
        unsizedVariantCount: parsed.unsizedVariantCount,
        totalQuantity: parsed.totalQuantity,
        zeroQuantityCount: parsed.zeroQuantityCount,
        warnings: parsed.warnings,
        blockers: parsed.blockers,
        acceptedWithBlockers: parsed.blockers.length > 0,
      },
      diff,
      reservations,
    }, { status: 201 });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }
}
