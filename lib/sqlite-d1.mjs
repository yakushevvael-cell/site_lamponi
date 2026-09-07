/**
 * Совместимая с Cloudflare D1 обёртка над локальной SQLite.
 *
 * Приложение писалось под D1: сотни строк в роутах вызывают
 * `db.prepare(sql).bind(...).all()` и `db.batch([...])`. Переписывать их все
 * под другой драйвер — большой и рискованный труд без пользы. Вместо этого
 * здесь воспроизведён интерфейс D1 поверх встроенного в Node модуля
 * `node:sqlite`, и остальной код остаётся нетронутым.
 *
 * Почему `node:sqlite`, а не better-sqlite3: он встроен в Node и не требует
 * компиляции нативного модуля на сервере. Меньше того, что может сломаться
 * при установке и при обновлении Node.
 *
 * Диалект совпадает: все миграции проекта и так написаны под SQLite.
 */
import { DatabaseSync } from "node:sqlite";

/**
 * Приводит значения к тому, что понимает node:sqlite.
 * D1 принимает булевы значения и undefined, node:sqlite — нет.
 */
function normalizeParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  return value;
}

function normalizeParams(params) {
  return params.map(normalizeParam);
}

/** D1 отдаёт обычные объекты; node:sqlite — тоже, но с прототипом null. */
function plain(row) {
  return row === undefined || row === null ? null : { ...row };
}

class PreparedStatement {
  /**
   * @param {DatabaseSync} database
   * @param {string} sql
   * @param {unknown[]} params
   */
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  /** D1 возвращает НОВЫЙ объект: `stmt.bind(a)` не меняет исходный. */
  bind(...params) {
    return new PreparedStatement(this.database, this.sql, params);
  }

  #statement() {
    return this.database.prepare(this.sql);
  }

  async all() {
    const started = Date.now();
    const rows = this.#statement().all(...normalizeParams(this.params));
    return {
      success: true,
      results: rows.map((row) => ({ ...row })),
      meta: { duration: Date.now() - started, rows_read: rows.length, rows_written: 0 },
    };
  }

  async first(column) {
    const row = this.#statement().get(...normalizeParams(this.params));
    const result = plain(row);
    if (result === null) return null;
    return column === undefined ? result : result[column] ?? null;
  }

  /** Массив массивов значений — этот вид использует drizzle. */
  async raw(options = {}) {
    const rows = this.#statement().all(...normalizeParams(this.params));
    const values = rows.map((row) => Object.values(row));
    if (!options.columnNames) return values;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return [columns, ...values];
  }

  async run() {
    const started = Date.now();
    const statement = this.#statement();
    // SELECT в run() у D1 допустим; node:sqlite на нём падает, поэтому
    // читающие запросы выполняем через all().
    if (/^\s*(select|with|pragma)\b/i.test(this.sql)) {
      const rows = statement.all(...normalizeParams(this.params));
      return {
        success: true,
        results: rows.map((row) => ({ ...row })),
        meta: { duration: Date.now() - started, changes: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0 },
      };
    }
    const info = statement.run(...normalizeParams(this.params));
    return {
      success: true,
      results: [],
      meta: {
        duration: Date.now() - started,
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        rows_read: 0,
        rows_written: Number(info.changes ?? 0),
      },
    };
  }
}

class SqliteD1Database {
  /** @param {DatabaseSync} database */
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new PreparedStatement(this.database, sql);
  }

  /**
   * Пакет запросов. У D1 пакет выполняется атомарно — здесь это транзакция,
   * поэтому частично применённого пакета быть не может, как и раньше.
   */
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* транзакция уже откатилась */ }
      throw error;
    }
  }

  async exec(sql) {
    const started = Date.now();
    this.database.exec(sql);
    return { count: sql.split(";").filter((part) => part.trim()).length, duration: Date.now() - started };
  }

  async dump() {
    throw new Error("Выгрузка базы через dump() не поддерживается. Используйте файловую копию базы.");
  }
}

/**
 * Открывает файл базы и настраивает его под небольшой рабочий сервер.
 *
 * WAL нужен, чтобы чтение страниц не блокировалось записью во время
 * синхронизации; `busy_timeout` — чтобы фоновая задача и человек в интерфейсе
 * не выбивали друг у друга ошибку «database is locked», а подождали.
 *
 * @param {string} filePath
 */
export function openDatabase(filePath) {
  const database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 10000");
  return new SqliteD1Database(database);
}

export { SqliteD1Database, PreparedStatement };
