import { migrate } from "../db.ts";
import type { Sql, SqlValue } from "../sql.ts";

/** What `DoSql` needs from a Durable Object's storage, so tests can hand it another SQLite. */
export type SqlBackend = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/**
 * `Sql` on a Durable Object's SQLite (`ctx.storage.sql`). It refuses BEGIN and COMMIT, so transactions go through
 * `transactionSync`, and it enforces foreign keys on its own, which Bun's side turns on with a PRAGMA.
 */
export class DoSql implements Sql {
  constructor(private readonly storage: SqlBackend) {}

  all<T>(sql: string, ...binds: SqlValue[]): T[] {
    return this.storage.sql.exec<T>(sql, ...binds).toArray();
  }

  one<T>(sql: string, ...binds: SqlValue[]): T | undefined {
    for (const row of this.storage.sql.exec<T>(sql, ...binds)) return row;
    return undefined;
  }

  run(sql: string, ...binds: SqlValue[]): number {
    // Drained, so the statement runs to the end. The cursor's rowsWritten also counts index writes, so ask SQLite.
    this.storage.sql.exec(sql, ...binds).toArray();
    return this.storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").toArray()[0]?.changes ?? 0;
  }

  exec(sql: string) {
    this.storage.sql.exec(sql).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

export function openDoDatabase(storage: SqlBackend): DoSql {
  const db = new DoSql(storage);
  migrate(db);
  return db;
}
