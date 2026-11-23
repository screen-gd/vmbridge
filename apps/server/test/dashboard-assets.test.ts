import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { databasePath, start } from "../src/index.ts";
import { Settings } from "../src/settings.ts";

let dir: string;
let bridge: Awaited<ReturnType<typeof start>>;
const path = process.env.PATH;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-dashboard-assets-"));
  // A stand-in cloudflared that marks when it started, so the tunnel listener is open, and waits to be stopped.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cloudflared"), `#!/bin/sh\ntouch "$(dirname "$0")/started"\nexec sleep 30\n`);
  chmodSync(join(bin, "cloudflared"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  const db = openDatabase(databasePath(dir));
  new Settings(db).set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
  db.close();
  bridge = await start({ dir, host: "127.0.0.1", port: 0 });
  while (!existsSync(join(bin, "started"))) await Bun.sleep(20);
});

afterAll(async () => {
  process.env.PATH = path;
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the tunnel listener serves the dashboard's files before anyone opened the page through it", async () => {
  const main = `http://127.0.0.1:${bridge.port}`;
  const page = await (await fetch(`${main}/dashboard`)).text();
  const files = [...page.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]!);
  const script = files.find((file) => file.endsWith(".js"));
  expect(script).toBeDefined();
  // Icons, like the agent and provider logos, are referenced from the script rather than the page.
  const code = await (await fetch(`${main}${script}`)).text();
  const icons = [...new Set([...code.matchAll(/"(\/[\w.-]+\.(?:svg|png))"/g)].map((match) => match[1]!))];
  expect(icons.length).toBeGreaterThan(0);

  const tunnel = `http://127.0.0.1:${(await bridge.network()).cloudflare.port}`;
  for (const file of [...files, ...icons]) {
    const response = await fetch(`${tunnel}${file}`);
    expect({ file, status: response.status }).toEqual({ file, status: 200 });
  }
});
