/**
 * Окружение приложения.
 *
 * Раньше здесь читались биндинги Cloudflare Workers (`cloudflare:workers`):
 * база D1 и хранилище R2. На своём сервере их нет, поэтому база — файл SQLite
 * рядом с приложением, а хранилище файлов ОСВ — обычная папка на диске.
 * Интерфейс намеренно оставлен прежним: весь код роутов работает без правок.
 */
import { mkdirSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { applyMigrations } from "@/lib/migrate.mjs";
import { openDatabase } from "@/lib/sqlite-d1.mjs";

export type AppRuntimeEnv = {
  DB?: D1Database;
  BUCKET?: FileBucket;
  WB_API_TOKEN?: string;
  OZON_CLIENT_ID?: string;
  OZON_API_KEY?: string;
  YANDEX_API_KEY?: string;
  CREDENTIALS_MASTER_KEY?: string;
  /** Секрет для запуска фоновой синхронизации без входа пользователя. */
  SYNC_TASK_TOKEN?: string;
};

/** Минимальная замена R2: файлы ОСВ лежат на диске сервера. */
export type FileBucket = {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ key: string }>;
  get(key: string): Promise<{ body: Buffer } | null>;
  delete(key: string): Promise<void>;
};

const DEFAULT_DATA_DIR = "./data";

function dataDir() {
  return resolve(process.env.DATA_DIR ?? DEFAULT_DATA_DIR);
}

function databasePath() {
  return process.env.DATABASE_PATH ?? join(dataDir(), "lamponi.db");
}

function storagePath() {
  return process.env.STORAGE_PATH ?? join(dataDir(), "storage");
}

function migrationsPath() {
  return process.env.MIGRATIONS_DIR ?? resolve("./drizzle");
}

/** Ключ хранилища приходит из кода приложения, но проверяем его всё равно. */
function safeKey(key: string) {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Некорректный ключ файла.");
  }
  return normalized;
}

function createBucket(): FileBucket {
  const root = storagePath();
  return {
    async put(key, body, _options) {
      const target = join(root, safeKey(key));
      mkdirSync(dirname(target), { recursive: true });
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      await writeFile(target, bytes);
      return { key };
    },
    async get(key) {
      try {
        return { body: await readFile(join(root, safeKey(key))) };
      } catch {
        return null;
      }
    },
    async delete(key) {
      try {
        await unlink(join(root, safeKey(key)));
      } catch {
        // Файла нет — считаем, что удаление уже произошло.
      }
    },
  };
}

let database: D1Database | null = null;
let migrationsPromise: Promise<unknown> | null = null;

/**
 * Открывает базу один раз на процесс и один раз прогоняет миграции.
 *
 * Миграции применяются при первом обращении, а не отдельной командой: так
 * невозможно выкатить код, которому нужна колонка, ещё не созданная в базе.
 */
function getDatabase(): D1Database {
  if (!database) {
    mkdirSync(dirname(databasePath()), { recursive: true });
    mkdirSync(storagePath(), { recursive: true });
    database = openDatabase(databasePath()) as unknown as D1Database;
  }
  if (!migrationsPromise) {
    migrationsPromise = applyMigrations(database, migrationsPath(), (message: string) => {
      console.log(`[migrate] ${message}`);
    }).catch((error: unknown) => {
      // Ошибку миграции нельзя проглатывать: с несовпадающей схемой
      // приложение посчитает остатки неверно.
      console.error("[migrate] Ошибка применения миграций:", error);
      throw error;
    });
  }
  return database;
}

/** Дожидается миграций. Вызывается фоновыми задачами перед работой с базой. */
export async function ensureDatabaseReady() {
  getDatabase();
  await migrationsPromise;
}

let bucket: FileBucket | null = null;

export function getRuntimeEnv(): AppRuntimeEnv {
  if (!bucket) bucket = createBucket();
  return {
    DB: getDatabase(),
    BUCKET: bucket,
    WB_API_TOKEN: process.env.WB_API_TOKEN || undefined,
    OZON_CLIENT_ID: process.env.OZON_CLIENT_ID || undefined,
    OZON_API_KEY: process.env.OZON_API_KEY || undefined,
    YANDEX_API_KEY: process.env.YANDEX_API_KEY || undefined,
    CREDENTIALS_MASTER_KEY: process.env.CREDENTIALS_MASTER_KEY || undefined,
    SYNC_TASK_TOKEN: process.env.SYNC_TASK_TOKEN || undefined,
  };
}
