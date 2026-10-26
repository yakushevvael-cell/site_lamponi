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

/**
 * Сколько база может держать процесс подряд, прежде чем пропустить вперёд
 * других.
 *
 * node:sqlite синхронный, а методы адаптера только выглядят асинхронными:
 * `await` на них не отдаёт ход событиям. Синхронизация заказов или выгрузка
 * остатков — тысячи запросов подряд — держала сервер секундами, и скан с
 * печатью этикетки на столе ждали её окончания. Теперь, если база занимает
 * процесс дольше этого срока, очередной запрос сначала уступает очередь:
 * новые HTTP-запросы принимаются и обрабатываются между запросами фоновой
 * задачи.
 */
const HOLD_LIMIT_MS = 20;

/** Начало текущего непрерывного владения процессом. */
let holdStartedAt = performance.now();
let turnMarkPending = false;

/**
 * Отметка «цикл событий получил ход»: setImmediate срабатывает, только когда
 * процесс дошёл до очереди событий. Пока отметка не сработала, процесс
 * держит одна непрерывная цепочка кода.
 */
function markTurn() {
  if (turnMarkPending) return;
  turnMarkPending = true;
  setImmediate(() => {
    turnMarkPending = false;
    holdStartedAt = performance.now();
  });
}

/**
 * Уступает очередь, если процесс занят дольше HOLD_LIMIT_MS. Внутри открытой
 * транзакции не уступает никогда: запросы другого обработчика попали бы в
 * чужую транзакцию на том же соединении.
 *
 * @param {SqliteD1Database} owner
 */
async function yieldIfHeld(owner) {
  if (!owner.inTransaction() && performance.now() - holdStartedAt >= HOLD_LIMIT_MS) {
    await new Promise((resolve) => setImmediate(resolve));
    holdStartedAt = performance.now();
  }
  markTurn();
}

/** D1 отдаёт обычные объекты; node:sqlite — тоже, но с прототипом null. */
function plain(row) {
  return row === undefined || row === null ? null : { ...row };
}

class PreparedStatement {
  /**
   * @param {SqliteD1Database} owner
   * @param {string} sql
   * @param {unknown[]} params
   */
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.database = owner.database;
    this.sql = sql;
    this.params = params;
  }

  /** D1 возвращает НОВЫЙ объект: `stmt.bind(a)` не меняет исходный. */
  bind(...params) {
    return new PreparedStatement(this.owner, this.sql, params);
  }

  #statement() {
    return this.database.prepare(this.sql);
  }

  async all() {
    await yieldIfHeld(this.owner);
    const started = Date.now();
    const rows = this.#statement().all(...normalizeParams(this.params));
    return {
      success: true,
      results: rows.map((row) => ({ ...row })),
      meta: { duration: Date.now() - started, rows_read: rows.length, rows_written: 0 },
    };
  }

  async first(column) {
    await yieldIfHeld(this.owner);
    const row = this.#statement().get(...normalizeParams(this.params));
    const result = plain(row);
    if (result === null) return null;
    return column === undefined ? result : result[column] ?? null;
  }

  /** Массив массивов значений — этот вид использует drizzle. */
  async raw(options = {}) {
    await yieldIfHeld(this.owner);
    const rows = this.#statement().all(...normalizeParams(this.params));
    const values = rows.map((row) => Object.values(row));
    if (!options.columnNames) return values;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return [columns, ...values];
  }

  async run() {
    await yieldIfHeld(this.owner);
    return this.runNow();
  }

  /** Выполнение без уступки очереди — для запросов внутри транзакции пакета. */
  runNow() {
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
    /** Транзакция, открытая через exec("BEGIN") — так их открывают миграции. */
    this.explicitTransaction = false;
  }

  /** Открыта ли транзакция на соединении: в ней очередь не уступается. */
  inTransaction() {
    return this.explicitTransaction || this.database.isTransaction === true;
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  /**
   * Пакет запросов. У D1 пакет выполняется атомарно — здесь это транзакция,
   * поэтому частично применённого пакета быть не может, как и раньше.
   */
  async batch(statements) {
    // Очередь уступается до BEGIN, а не внутри: пакет выполняется целиком,
    // без чужих запросов посередине.
    await yieldIfHeld(this);
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(statement.runNow());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* транзакция уже откатилась */ }
      throw error;
    }
  }

  async exec(sql) {
    const started = Date.now();
    const ends = /^\s*(COMMIT|END|ROLLBACK)\b/i.test(sql);
    try {
      this.database.exec(sql);
    } finally {
      // ROLLBACK падает, если SQLite уже откатила транзакцию сама, — и тогда
      // транзакции больше нет.
      if (ends) this.explicitTransaction = false;
    }
    if (/^\s*BEGIN\b/i.test(sql)) this.explicitTransaction = true;
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
