import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../db.ts";
import type { Sql, SqlValue } from "../sql.ts";

/** `Sql` on bun:sqlite. Statements are cached by their text, so the core can pass SQL strings freely. */
export class BunSql implements Sql {
  constructor(readonly database: Database) {}

  all<T>(sql: string, ...binds: SqlValue[]): T[] {
    return this.database.query<T, SQLQueryBindings[]>(sql).all(...binds);
  }

  one<T>(sql: string, ...binds: SqlValue[]): T | undefined {
    return this.database.query<T, SQLQueryBindings[]>(sql).get(...binds) ?? undefined;
  }

  run(sql: string, ...binds: SqlValue[]): number {
    return this.database.query(sql).run(...binds).changes;
  }

  exec(sql: string) {
    this.database.run(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.database.transaction(fn)();
  }

  close() {
    this.database.close();
  }
}

export function openDatabase(path: string): BunSql {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Also for a folder made before, or by someone else, with the usual 0755: it holds the key, logs and tunnel files.
    chmodSync(dirname(path), 0o700);
  }
  const database = new Database(path, { create: true, strict: true });
  // The database holds provider keys and tokens: owner-only. WAL side files share the 0700 directory.
  if (path !== ":memory:") chmodSync(path, 0o600);
  database.run("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version: legacyVersion } = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  const db = new BunSql(database);
  migrate(db, legacyVersion);
  return db;
}
