#!/usr/bin/env node
/**
 * Резервная копия базы.
 *
 * Обычное копирование файла SQLite во время работы приложения даёт битую копию:
 * часть данных в этот момент лежит в журнале WAL. `VACUUM INTO` создаёт
 * согласованный снимок, не останавливая сервис.
 *
 * Запускается таймером systemd раз в сутки; копии старше срока хранения удаляются.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const databasePath = process.env.DATABASE_PATH ?? join(dataDir, "lamponi.db");
const backupDir = process.env.BACKUP_DIR ?? join(dataDir, "backups");

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = join(backupDir, `lamponi-${stamp}.db`);

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  // Путь подставляется в SQL строкой — экранируем кавычки, чтобы имя папки
  // с апострофом не сломало запрос.
  database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  log(`Копия создана: ${target}`);
} finally {
  database.close();
}

const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
let removed = 0;
for (const name of readdirSync(backupDir)) {
  if (!name.startsWith("lamponi-") || !name.endsWith(".db")) continue;
  const path = join(backupDir, name);
  if (statSync(path).mtimeMs < cutoff) {
    unlinkSync(path);
    removed += 1;
  }
}
if (removed > 0) log(`Удалено устаревших копий: ${removed}.`);
