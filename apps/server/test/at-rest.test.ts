import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Encryption } from "../src/encryption.ts";
import { dashboardKey, databasePath, start } from "../src/index.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-at-rest-"));
  temps.push(dir);
  return dir;
}

async function startAndStop(dir: string) {
  const bridge = await start({ dir, host: "127.0.0.1", port: 0 });
  await bridge.stop();
}

const raw = (dir: string, sql: string) => {
  const db = openDatabase(databasePath(dir));
  try {
    return db.all<Record<string, string | null>>(sql);
  } finally {
    db.close();
  }
};

test("values planted unencrypted after the first start are dropped, not encrypted and used", async () => {
  const dir = tempDir();
  await startAndStop(dir);

  const db = openDatabase(databasePath(dir));
  db.run("INSERT INTO secrets (name, value) VALUES ('env', '{\"NODE_OPTIONS\":\"--require /tmp/x.js\"}'), ('github.token', 'planted')");
  db.run("INSERT INTO vms (id, provider, name, size, state, created_at, t3_token) VALUES ('vm1', 'e2b', 'one', 'medium', 'asleep', 0, 'planted')");
  db.run("INSERT INTO skills (name, source, ref, hash, files, installed_at, updated_at) VALUES ('planted', 'local', '/x', 'h', '[]', 0, 0)");
  db.close();
  await startAndStop(dir);

  expect(raw(dir, "SELECT name FROM secrets WHERE name IN ('env', 'github.token')")).toEqual([]);
  expect(raw(dir, "SELECT t3_token FROM vms")).toEqual([{ t3_token: null }]);
  expect(raw(dir, "SELECT name FROM skills")).toEqual([]);
});

test("values saved before encryption existed are encrypted once, also when the CLI checked the password first", async () => {
  const dir = tempDir();
  const db = openDatabase(databasePath(dir));
  db.run("INSERT INTO secrets (name, value) VALUES ('env', '{\"FOO\":\"bar\"}')");
  db.run("INSERT INTO vms (id, provider, name, size, state, created_at, t3_token) VALUES ('vm1', 'e2b', 'one', 'medium', 'asleep', 0, 't3-plain')");
  db.close();
  // As `vmbridge run` does before starting: it seals secrets only, so the start still seals the other tables.
  dashboardKey(dir).close();
  await startAndStop(dir);

  const [env] = raw(dir, "SELECT value FROM secrets WHERE name = 'env'");
  expect(Encryption.isSealed(env!.value!)).toBe(true);
  const [vm] = raw(dir, "SELECT t3_token FROM vms");
  expect(Encryption.isSealed(vm!.t3_token!)).toBe(true);
});

test("the data folder is made private on every start, even one made readable before", async () => {
  const dir = tempDir();
  chmodSync(dir, 0o755);
  await startAndStop(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
