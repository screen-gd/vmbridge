import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import type { Job } from "../src/jobs.ts";
import type { Env } from "../src/workers/env.ts";
import { AlarmJobs, tickMs } from "../src/workers/jobs.ts";
import { DoSql, openDoDatabase, type SqlBackend } from "../src/workers/sql.ts";

// The Worker entry exports the Durable Object class, which extends one from a module only workerd has.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../src/workers/index.ts");

/** A Durable Object's SQL storage, played by bun:sqlite with the same rules: no BEGIN, foreign keys on. */
function storage(): SqlBackend {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  return {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(query)) throw new Error("Use transactionSync.");
        const statements = bindings.length ? [query] : query.split(";").filter((part) => part.trim());
        let rows: T[] = [];
        for (const statement of statements) rows = db.query(statement).all(...(bindings as never[])) as T[];
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      },
    } as SqlStorage,
    transactionSync: (fn) => db.transaction(fn)(),
  };
}

describe("DoSql", () => {
  test("migrates, counts changed rows and rolls a failed transaction back", () => {
    const db = openDoDatabase(storage());
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM migrations")?.n).toBeGreaterThan(0);
    db.run("INSERT INTO settings (key, value) VALUES ('a', '1'), ('b', '2')");
    expect(db.run("UPDATE settings SET value = 'x'")).toBe(2);
    expect(db.run("DELETE FROM settings WHERE key = 'none'")).toBe(0);
    expect(db.one("SELECT value FROM settings WHERE key = 'none'")).toBeUndefined();
    expect(() =>
      db.transaction(() => {
        db.run("DELETE FROM settings");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(db.all<{ key: string }>("SELECT key FROM settings ORDER BY key").map((row) => row.key)).toEqual(["a", "b"]);
  });

  test("opening again runs no migration twice", () => {
    const backend = storage();
    openDoDatabase(backend);
    expect(() => openDoDatabase(backend)).not.toThrow();
    expect(new DoSql(backend).one<{ n: number }>("SELECT COUNT(*) AS n FROM migrations WHERE version = 1")?.n).toBe(1);
  });
});

describe("AlarmJobs", () => {
  test("sets the next alarm, runs due jobs and skips one still running", async () => {
    let alarm = null as number | null;
    const store = { getAlarm: async () => alarm, setAlarm: async (time: number) => void (alarm = time) };
    let finishSlow = () => {};
    const runs: string[] = [];
    const jobs: Job[] = [
      { name: "fast", everyMs: tickMs, run: async () => void runs.push("fast") },
      {
        name: "slow",
        everyMs: tickMs,
        run: () =>
          new Promise<void>((resolve) => {
            finishSlow = () => {
              runs.push("slow");
              resolve();
            };
          }),
      },
      { name: "hourly", everyMs: 3_600_000, run: async () => void runs.push("hourly") },
    ];
    const scheduler = new AlarmJobs(store, jobs);
    await scheduler.start(1_000);
    expect(alarm).toBe(1_000 + tickMs);

    await Promise.all((await scheduler.alarm(20_000)).filter((_, index) => index !== 1));
    expect(alarm).toBe(20_000 + tickMs);
    expect(runs).toEqual(["fast", "hourly"]);

    // The slow job is still running, and the hourly one is not due.
    const second = await scheduler.alarm(35_000);
    expect(second.length).toBe(1);
    await Promise.all(second);
    expect(runs).toEqual(["fast", "hourly", "fast"]);

    finishSlow();
    await Bun.sleep(0);
    // Done now, so it runs again with the fast one.
    const third = await scheduler.alarm(50_000);
    expect(third.length).toBe(2);
    await third[0];
    expect(runs).toEqual(["fast", "hourly", "fast", "slow", "fast"]);
  });
});

describe("Worker entry", () => {
  const password = "a dashboard password";
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  function env(values: Partial<Env> = {}) {
    const sent: string[] = [];
    const env: Env = {
      VMBRIDGE_PASSWORD: password,
      VMBRIDGE_ENCRYPTION_KEY: key,
      BRIDGE: { getByName: () => ({ fetch: async (request: Request) => (sent.push(new URL(request.url).pathname), new Response("bridge")) }) },
      ASSETS: { fetch: async (request) => new Response(`asset ${new URL(typeof request === "string" ? request : request.url).pathname}`) },
      ...values,
    };
    return { env, sent };
  }

  test("serves only the setup page while a secret is missing or weak, and never shows one", async () => {
    for (const values of [{ VMBRIDGE_PASSWORD: undefined }, { VMBRIDGE_PASSWORD: "too-short" }, { VMBRIDGE_ENCRYPTION_KEY: "not a key" }]) {
      const { env: bindings, sent } = env(values);
      for (const path of ["/dashboard", "/admin/api/auth", "/ws"]) {
        const response = await worker.fetch(new Request(`https://bridge.example.com${path}`), bindings);
        const text = await response.text();
        expect(response.status).toBe(503);
        expect(text).toContain("VM Bridge needs setup");
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(text).not.toContain(key);
        if (values.VMBRIDGE_PASSWORD !== "too-short") expect(text).not.toContain(password);
        expect(text).not.toContain("too-short");
      }
      expect(sent).toEqual([]);
    }
  });

  test("routes the API and T3 to the Durable Object and serves the dashboard with security headers", async () => {
    const { env: bindings, sent } = env();
    const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://bridge.example.com${path}`, init), bindings);

    const page = await get("/dashboard/onboarding");
    expect(await page.text()).toBe("asset /dashboard/index.html");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await get("/")).headers.get("location")).toBe("/dashboard");
    expect((await get("/dashboard/?a=1")).headers.get("location")).toBe("/dashboard?a=1");

    for (const path of ["/admin/api/auth", "/ws", "/oauth/token", "/api/auth/session", "/.well-known/t3/environment"]) await get(path);
    expect(sent).toEqual(["/admin/api/auth", "/ws", "/oauth/token", "/api/auth/session", "/.well-known/t3/environment"]);
    expect((await get("/elsewhere")).status).toBe(404);
  });

  test("sends plain HTTP to HTTPS, where the dashboard's cookie works", async () => {
    const response = await worker.fetch(new Request("http://bridge.example.com/dashboard?x=1"), env().env);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://bridge.example.com/dashboard?x=1");
  });
});
