import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { applyMigrations } from "../lib/migrate.mjs";
import { mergeSizeSpellings } from "../lib/size-merge.mjs";
import { openDatabase } from "../lib/sqlite-d1.mjs";

async function freshDb() {
  const db = openDatabase(":memory:");
  await applyMigrations(db, join(import.meta.dirname, "..", "drizzle"));
  await db.prepare("INSERT OR IGNORE INTO marketplaces (id, name) VALUES ('wildberries', 'WB'), ('ozon', 'Ozon')").run();
  await db.prepare("INSERT INTO osv_uploads (id, file_name) VALUES (1, 'a.xlsx'), (2, 'b.xlsx')").run();
  return db;
}

test("«17» и «17,0» сводятся в одну позицию вместе с сопоставлениями и снимками", async () => {
  const db = await freshDb();
  await db.batch([
    db.prepare("INSERT INTO products (source_sku, article, size, current_physical_qty, latest_upload_id) VALUES ('К-1::17', 'К-1', '17', 2, 2)"),
    db.prepare("INSERT INTO products (source_sku, article, size, current_physical_qty, latest_upload_id, safety_stock) VALUES ('К-1::17,0', 'К-1', '17,0', 3, 2, 1)"),
    db.prepare("INSERT INTO products (source_sku, article, size, current_physical_qty) VALUES ('К-1::18,0', 'К-1', '18,0', 4)"),
    db.prepare("INSERT INTO products (source_sku, article, size, current_physical_qty) VALUES ('К-1::16,0 +', 'К-1', '16,0 +', 1)"),
    db.prepare("INSERT INTO sku_mappings (product_sku, marketplace_id, external_sku) VALUES ('К-1::17', 'wildberries', '111')"),
    db.prepare("INSERT INTO sku_mappings (product_sku, marketplace_id, external_sku) VALUES ('К-1::17,0', 'ozon', 'К-1-17')"),
    db.prepare("INSERT INTO stock_snapshots (upload_id, product_sku, physical_qty) VALUES (1, 'К-1::17', 5), (2, 'К-1::17', 2), (2, 'К-1::17,0', 3)"),
  ]);

  const report = await mergeSizeSpellings(db);
  assert.deepEqual(report.map((item) => item.target).sort(), ["К-1::17", "К-1::18"]);

  const products = (await db.prepare("SELECT source_sku AS sku, size, current_physical_qty AS qty, safety_stock AS safety FROM products ORDER BY sku").all()).results;
  assert.deepEqual(products.map((row) => ({ ...row })), [
    { sku: "К-1::16,0 +", size: "16,0 +", qty: 1, safety: 0 },
    { sku: "К-1::17", size: "17", qty: 5, safety: 1 },
    { sku: "К-1::18", size: "18", qty: 4, safety: 0 },
  ]);

  const mappings = (await db.prepare("SELECT marketplace_id AS m, product_sku AS sku FROM sku_mappings ORDER BY m").all()).results;
  assert.deepEqual(mappings.map((row) => ({ ...row })), [{ m: "ozon", sku: "К-1::17" }, { m: "wildberries", sku: "К-1::17" }]);

  const snapshots = (await db.prepare("SELECT upload_id AS u, physical_qty AS q FROM stock_snapshots WHERE product_sku = 'К-1::17' ORDER BY u").all()).results;
  assert.deepEqual(snapshots.map((row) => ({ ...row })), [{ u: 1, q: 5 }, { u: 2, q: 5 }]);

  const dirty = (await db.prepare("SELECT product_sku AS sku FROM stock_dirty_skus ORDER BY sku").all()).results;
  assert.deepEqual(dirty.map((row) => row.sku), ["К-1::17", "К-1::18"]);

  // Повторный запуск ничего не меняет.
  assert.deepEqual(await mergeSizeSpellings(db), []);
});
