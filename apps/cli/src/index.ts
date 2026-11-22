#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dashboardKey, dataDir, defaultHost, defaultPort, start, version } from "@vmbridge/server";
import { service } from "./service.ts";

const help = `VM Bridge ${version}

Usage:
  vmbridge [run] [--host 0.0.0.0] [--port ${defaultPort}]   Start VM Bridge in this terminal
  vmbridge stop                                     Stop VM Bridge, including the background service
  vmbridge service install [--host] [--port]        Run VM Bridge in the background at login
  vmbridge service uninstall                        Remove the background service
  vmbridge password                                 Set a new dashboard password

The password can also come from VMBRIDGE_PASSWORD. Data lives in ${dataDir()}.`;

const pidFile = () => join(dataDir(), "vmbridge.pid");

/**
 * Another live VM Bridge process from the pid file. A file naming this process
 * does not count: `bun --watch` restarts in place and keeps the pid, so `run` sees its own.
 */
function runningPid(): number | null {
  if (!existsSync(pidFile())) return null;
  const pid = Number(readFileSync(pidFile(), "utf8"));
  if (pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Reads a line without echoing it. */
async function readSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            return resolve(value);
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            return reject(new Error("Cancelled."));
          }
          if (char === "\u007f") value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\n");
  }
}

async function chooseKey(): Promise<string> {
  for (;;) {
    const key = await readSecret("Choose a dashboard password (at least 8 characters): ");
    if (key.length < 8) {
      console.log("Too short.");
      continue;
    }
    if ((await readSecret("Type it again: ")) === key) return key;
    console.log("The passwords did not match.");
  }
}

/** Makes sure a dashboard password exists before the server starts listening. */
async function ensureKey(force = false) {
  const keys = dashboardKey();
  try {
    if (keys.isSet() && !force) return;
    const fromEnv = process.env.VMBRIDGE_PASSWORD;
    if (fromEnv && !force) return await keys.set(fromEnv);
    if (!process.stdin.isTTY) {
      throw new Error("Set a dashboard password first: run `vmbridge password` in a terminal, or set VMBRIDGE_PASSWORD.");
    }
    await keys.set(await chooseKey());
    console.log("Password saved.");
  } finally {
    keys.close();
  }
}

function serverOptions(values: { host?: string; port?: string }) {
  const port = values.port === undefined ? defaultPort : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be a port number.");
  return { host: values.host ?? defaultHost, port };
}

async function run(options: { host: string; port: number }) {
  const existing = runningPid();
  if (existing) throw new Error(`VM Bridge is already running (process ${existing}). Stop it with \`vmbridge stop\`.`);
  await ensureKey();
  const server = await start(options);
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), String(process.pid));

  const network = await server.network();
  console.log(`VM Bridge ${version} is running.\n`);
  for (const address of network.addresses) console.log(`  ${address.label.padEnd(20)} ${address.url}/dashboard`);
  if (network.tailscale.running && !network.tailscale.httpsUrl) console.log("\n  Turn on Tailscale HTTPS in the dashboard settings for an https:// address.");
  console.log("\nOpen the dashboard to set up providers and pair devices. Press Ctrl+C to stop.");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop().catch(() => {});
    if (!runningPid()) rmSync(pidFile(), { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function stop() {
  const stoppedService = await service.stop();
  const pid = runningPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && runningPid(); i++) await Bun.sleep(100);
  }
  if (!pid && !stoppedService) return console.log("VM Bridge is not running.");
  console.log("VM Bridge stopped.");
  if (stoppedService) console.log("The background service starts again at next login, or now with `vmbridge service install`.");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command = "run", subcommand] = positionals;
  if (values.help) return console.log(help);
  if (values.version) return console.log(version);

  switch (command) {
    case "run":
      return run(serverOptions(values));
    case "stop":
      return stop();
    case "password":
      return ensureKey(true);
    case "service":
      if (subcommand === "install") {
        await ensureKey();
        const existing = runningPid();
        if (existing) throw new Error(`VM Bridge is already running in a terminal (process ${existing}). Stop it first.`);
        const options = serverOptions(values);
        await service.install(options);
        return console.log(`VM Bridge now runs in the background on port ${options.port}. Logs: ${join(dataDir(), "vmbridge.log")}`);
      }
      if (subcommand === "uninstall") {
        await service.uninstall();
        return console.log("Background service removed.");
      }
      throw new Error("Use `vmbridge service install` or `vmbridge service uninstall`.");
    default:
      console.log(help);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

