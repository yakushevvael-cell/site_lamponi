/**
 * Типы интерфейса D1.
 *
 * Раньше они приходили из типов Cloudflare Workers. Приложение переехало на
 * обычный Node, но интерфейс работы с базой остался прежним (его повторяет
 * lib/sqlite-d1.mjs), поэтому типы объявлены здесь — чтобы не тащить весь
 * пакет типов Cloudflare ради трёх интерфейсов.
 */

declare global {
  type D1PrimitiveValue = string | number | boolean | null | ArrayBuffer | Uint8Array;

  interface D1Meta {
    duration: number;
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
  }

  interface D1Result<T = Record<string, unknown>> {
    success: boolean;
    results: T[];
    meta: D1Meta;
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    first<V = D1PrimitiveValue>(column: string): Promise<V | null>;
    raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<{ count: number; duration: number }>;
  }
}

export {};
