import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { migrations } from "../src/db.ts";

// placement.test.ts covers a database from before some migrations, which then run.
test("migrations an older version applied by PRAGMA user_version are recorded, not run again", () => {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-db-"));
  try {
    const path = join(dir, "main.db");
    const old = openDatabase(path);
    old.exec(`DROP TABLE migrations; PRAGMA user_version = ${migrations.length};`);
    old.run("INSERT INTO settings (key, value) VALUES ('kept', '1')");
    old.close();

    // Running any migration again would throw on its CREATE TABLE.
    const db = openDatabase(path);
    const versions = db.all<{ version: number }>("SELECT version FROM migrations ORDER BY version").map((row) => row.version);
    expect(versions).toEqual(migrations.map((_, index) => index + 1));
    expect(db.one("SELECT value FROM settings WHERE key = 'kept'")).toEqual({ value: "1" });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
