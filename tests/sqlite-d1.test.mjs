import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../lib/sqlite-d1.mjs";

function freshDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), "lamponi-sqlite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "test.db"));
  return db;
}

/** Длинная фоновая работа: запросы подряд, каждый ~1 мс. */
async function busyChain(db, millis) {
  const started = performance.now();
  let count = 0;
  while (performance.now() - started < millis) {
    await db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3000) SELECT SUM(x) AS s FROM n").first();
    count += 1;
  }
  return count;
}

test("длинная цепочка запросов пропускает вперёд другие события", async (t) => {
  const db = freshDatabase(t);
  // Запрос стола приходит, пока фоновая задача гоняет базу: он должен
  // дождаться не конца задачи, а ближайшей уступки (десятки миллисекунд).
  let waitedMs = null;
  const asked = performance.now();
  setImmediate(() => { waitedMs = performance.now() - asked; });
  await busyChain(db, 400);
  assert.ok(waitedMs !== null && waitedMs < 150, `событие ждало ${waitedMs} мс`);
});

test("внутри транзакции очередь не уступается: чужие запросы не попадают в неё", async (t) => {
  const db = freshDatabase(t);
  await db.exec("CREATE TABLE t (x INTEGER)");
  await busyChain(db, 30);

  let ranInside = false;
  let inTransaction = false;
  setImmediate(() => { ranInside = inTransaction; });
  await db.exec("BEGIN");
  inTransaction = true;
  const started = performance.now();
  while (performance.now() - started < 60) await db.prepare("INSERT INTO t (x) VALUES (?)").bind(1).run();
  inTransaction = false;
  await db.exec("COMMIT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ranInside, false);

  // Пакет — тоже транзакция: всё или ничего.
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO t (x) VALUES (2)"),
    db.prepare("INSERT INTO missing (x) VALUES (3)"),
  ]));
  const row = await db.prepare("SELECT COUNT(*) AS c FROM t WHERE x = 2").first();
  assert.equal(row.c, 0);
});

test("упавший ROLLBACK не оставляет адаптер «в транзакции»", async (t) => {
  const db = freshDatabase(t);
  await db.exec("BEGIN");
  await db.exec("ROLLBACK");
  await assert.rejects(db.exec("ROLLBACK"));
  // Уступка снова работает: событие не ждёт всю цепочку.
  let waitedMs = null;
  const asked = performance.now();
  setImmediate(() => { waitedMs = performance.now() - asked; });
  await busyChain(db, 300);
  assert.ok(waitedMs !== null && waitedMs < 150, `событие ждало ${waitedMs} мс`);
});
