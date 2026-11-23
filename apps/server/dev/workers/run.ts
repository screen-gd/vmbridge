/**
 * Runs VM Bridge's Worker in local workerd (`wrangler dev`) with fresh secrets and checks it end to end: the
 * dashboard page, login, pairing and the T3 WebSocket, then a restart, after which the same password and device
 * still work from the Durable Object's SQLite. Removes everything it wrote.
 *
 *   bun run test:workers
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc, smoke } from "./smoke.ts";

const wrangler = "wrangler@4.166.0";
const root = join(import.meta.dir, "../../../..");

function freePort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port;
}

const dir = mkdtempSync(join(tmpdir(), "vmbridge-workers-"));
const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
const envFile = join(dir, "secrets.env");
writeFileSync(envFile, `VMBRIDGE_PASSWORD=${password}\nVMBRIDGE_ENCRYPTION_KEY=${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}\n`, { mode: 0o600 });
const port = freePort();
const base = `http://127.0.0.1:${port}`;

async function startWorker() {
  // Its own process group, so stopping it stops workerd too and nothing else.
  const child = Bun.spawn(
    ["bunx", wrangler, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "state"), "--env-file", envFile, "--log-level", "error"],
    { cwd: root, detached: true, stdout: "ignore", stderr: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/admin/api/auth`)).ok) return child;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("workerd did not start within 2 minutes");
}

async function stopWorker(child: Bun.Subprocess) {
  if (child.pid) process.kill(-child.pid, "SIGTERM");
  await child.exited;
}

let failed = false;
let child: Bun.Subprocess | undefined;
try {
  const built = Bun.spawnSync(["bun", "run", "build"], { cwd: root, stdout: "ignore", stderr: "inherit" });
  if (built.exitCode !== 0) throw new Error("bun run build failed");
  child = await startWorker();
  console.log("Worker in workerd:");
  const page = await fetch(`${base}/dashboard`);
  console.log(`  ${page.ok && page.headers.get("content-security-policy") ? "ok  " : "FAIL"} the dashboard page has security headers`);
  failed ||= !page.ok;
  const { device } = await smoke(base, password);

  await stopWorker(child);
  child = await startWorker();
  console.log("After a restart:");
  await smoke(base, password);
  const replies = await rpc(base, device, [{ _tag: "Ping" }]);
  console.log(`  ${replies[0]?._tag === "Pong" ? "ok  " : "FAIL"} the device paired before the restart still connects`);
  failed ||= replies[0]?._tag !== "Pong";
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed = true;
} finally {
  if (child) await stopWorker(child);
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(root, ".wrangler"), { recursive: true, force: true });
}

console.log(failed ? "FAILED" : "The Worker works end to end in workerd.");
process.exit(failed ? 1 : 0);
