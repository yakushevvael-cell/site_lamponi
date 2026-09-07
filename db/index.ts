import { drizzle } from "drizzle-orm/d1";

import { getRuntimeEnv } from "@/lib/runtime-env";
import * as schema from "./schema";

/**
 * Drizzle работает поверх адаптера с интерфейсом D1 (lib/sqlite-d1.mjs),
 * поэтому драйвер остаётся прежним — меняется только источник соединения.
 */
export function getDb() {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) {
    throw new Error("База данных недоступна: не удалось открыть файл SQLite. Проверьте переменную DATABASE_PATH и права на папку данных.");
  }

  return drizzle(runtime.DB, { schema });
}
