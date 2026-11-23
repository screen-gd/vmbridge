/** A value SQLite can bind. No booleans: Durable Object SQL does not take them. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * The synchronous SQLite access the server core uses. Bun implements it with bun:sqlite (see bun/sqlite.ts); a
 * Durable Object can implement it with `ctx.storage.sql`, which allows at most 100 bound values per statement.
 */
export interface Sql {
  all<T>(sql: string, ...binds: SqlValue[]): T[];
  /** The first row, or undefined when there is none. */
  one<T>(sql: string, ...binds: SqlValue[]): T | undefined;
  /** Runs one statement. Returns how many rows it changed. */
  run(sql: string, ...binds: SqlValue[]): number;
  /** Runs a script of one or more statements without bound values, such as a migration. */
  exec(sql: string): void;
  /** Runs `fn` atomically and returns its result. A throw rolls everything back. */
  transaction<T>(fn: () => T): T;
}
