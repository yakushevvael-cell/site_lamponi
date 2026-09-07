/**
 * Применение миграций из папки drizzle/.
 *
 * На Cloudflare этим занимался `wrangler d1 migrations apply`. На своём сервере
 * миграции применяет само приложение при запуске: так невозможно выкатить код,
 * который ждёт колонку, которой в базе ещё нет.
 *
 * Порядок берётся из drizzle/meta/_journal.json, а применённые миграции
 * запоминаются в таблице `_migrations` — повторный запуск ничего не ломает.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const STATEMENT_SEPARATOR = "--> statement-breakpoint";

function readJournal(migrationsDir) {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  if (existsSync(journalPath)) {
    try {
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const entries = Array.isArray(journal.entries) ? journal.entries : [];
      return entries
        .slice()
        .sort((left, right) => Number(left.idx) - Number(right.idx))
        .map((entry) => `${entry.tag}.sql`)
        .filter((name) => existsSync(join(migrationsDir, name)));
    } catch {
      // Повреждённый журнал не повод не мигрировать: ниже берём файлы по именам.
    }
  }
  // Запасной путь: имена миграций начинаются с номера, сортировка по имени верна.
  return readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
}

/**
 * @param {{ prepare: Function, exec: Function }} db адаптер с интерфейсом D1
 * @param {string} migrationsDir
 * @param {(message: string) => void} [log]
 */
export async function applyMigrations(db, migrationsDir, log = () => {}) {
  if (!existsSync(migrationsDir)) {
    log(`Папка миграций не найдена: ${migrationsDir}`);
    return { applied: [], skipped: [] };
  }

  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const doneRows = await db.prepare("SELECT name FROM _migrations").all();
  const done = new Set(doneRows.results.map((row) => row.name));

  const applied = [];
  const skipped = [];
  for (const fileName of readJournal(migrationsDir)) {
    if (done.has(fileName)) {
      skipped.push(fileName);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, fileName), "utf8");
    const statements = sql
      .split(STATEMENT_SEPARATOR)
      .map((part) => part.trim())
      .filter(Boolean);

    // Каждая миграция применяется целиком или не применяется вовсе.
    await db.exec("BEGIN");
    try {
      for (const statement of statements) await db.exec(statement);
      await db.prepare("INSERT INTO _migrations (name) VALUES (?)").bind(fileName).run();
      await db.exec("COMMIT");
    } catch (error) {
      try { await db.exec("ROLLBACK"); } catch { /* уже откатилось */ }
      throw new Error(`Миграция ${fileName} не применилась: ${error instanceof Error ? error.message : error}`);
    }
    applied.push(fileName);
    log(`Применена миграция ${fileName}`);
  }

  if (applied.length === 0) log("Новых миграций нет.");
  return { applied, skipped };
}
