/**
 * Proves the provider drivers work in workerd. Runs checks.ts on Bun, then in local workerd (`wrangler dev`)
 * without and with `workersFetchCompat`, and passes when workerd with the shim gets every fake key refused the same
 * way Bun does. Stops workerd and removes everything wrangler wrote.
 *
 *   bun run test:workerd
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks, type Result } from "./checks.ts";

const wrangler = "wrangler@4.166.0";
const dir = import.meta.dir;

function freePort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port;
}

async function waitUntilUp(base: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("workerd did not start within 2 minutes");
}

const describe = (result: Result | undefined) => (result?.refused ? `${result.code}: ${result.message}` : "not refused");
const sameAsBun = (result: Result, bun: Result | undefined) => result.refused && bun?.refused === true && result.code === bun.code;

console.log("Bun (default drivers):");
const onBun = new Map((await runChecks()).map((result) => [result.name, result]));
for (const result of onBun.values()) console.log(`  ${result.name.padEnd(20)} ${describe(result)}`);

const state = mkdtempSync(join(tmpdir(), "vmbridge-workerd-"));
const port = freePort();
const base = `http://127.0.0.1:${port}`;
// Its own process group, so stopping it stops workerd too and nothing else.
const child = Bun.spawn(
  ["bunx", wrangler, "dev", "--config", join(dir, "wrangler.jsonc"), "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, "--log-level", "error"],
  { cwd: dir, detached: true, stdout: "ignore", stderr: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
);

let failed = false;
try {
  await waitUntilUp(base, child);

  const bare = (await (await fetch(`${base}/?shim=0`)).json()) as { results: Result[] };
  console.log("workerd without workersFetchCompat:");
  for (const result of bare.results) {
    const note = sameAsBun(result, onBun.get(result.name)) ? "same as Bun" : "DIFFERS from Bun";
    console.log(`  ${result.name.padEnd(20)} ${note.padEnd(16)} ${describe(result)}`);
  }

  const shimmed = (await (await fetch(base)).json()) as { userAgent: string; results: Result[] };
  console.log(`workerd with workersFetchCompat (${shimmed.userAgent}):`);
  for (const result of shimmed.results) {
    const pass = sameAsBun(result, onBun.get(result.name));
    failed ||= !pass;
    console.log(`  ${pass ? "ok  " : "FAIL"} ${result.name.padEnd(20)} ${describe(result)}`);
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  if (child.pid) process.kill(-child.pid, "SIGTERM");
  await child.exited;
  rmSync(state, { recursive: true, force: true });
  rmSync(join(dir, ".wrangler"), { recursive: true, force: true });
}

console.log(failed ? "FAILED" : "Every provider gets its fake key refused in workerd the same way as on Bun.");
process.exit(failed ? 1 : 0);
