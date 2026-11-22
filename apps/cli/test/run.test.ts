import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/index.ts");
let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `vmbridge run` on a free port with a new data folder, not in a terminal, until it says it is running. */
async function run(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-cli-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop();
  const child = Bun.spawn(["bun", cli, "run", "--host", "127.0.0.1", "--port", String(port)], {
    // HOME too, so nothing reads this machine's skills or instructions files.
    env: { PATH: process.env.PATH ?? "", HOME: dir, VMBRIDGE_HOME: join(dir, "data"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk);
    if (output.includes("Press Ctrl+C") || output.includes("No dashboard password yet")) break;
  }
  const auth = (await (await fetch(`http://127.0.0.1:${port}/admin/api/auth`)).json()) as { hasPassword: boolean };
  child.kill("SIGTERM");
  await child.exited;
  return { output, hasPassword: auth.hasPassword };
}

test("starts without a password, and keeps the setup code out of output that is not a terminal", async () => {
  const { output, hasPassword } = await run();
  expect(hasPassword).toBe(false);
  expect(output).toContain("is running");
  expect(output).toContain("No dashboard password yet");
  expect(output).not.toContain("#code=");
}, 30_000);

test("still takes the password from VMBRIDGE_PASSWORD", async () => {
  const { output, hasPassword } = await run({ VMBRIDGE_PASSWORD: "from the environment" });
  expect(hasPassword).toBe(true);
  expect(output).toContain("Open the dashboard");
}, 30_000);
