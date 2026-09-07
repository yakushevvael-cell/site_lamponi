/** Типы для lib/migrate.mjs. */
export declare function applyMigrations(
  db: { prepare: (sql: string) => unknown; exec: (sql: string) => Promise<unknown> },
  migrationsDir: string,
  log?: (message: string) => void,
): Promise<{ applied: string[]; skipped: string[] }>;
