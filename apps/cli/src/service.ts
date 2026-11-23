import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv, dataDir } from "@vmbridge/server";

const label = "dev.vmbridge";

/** The background service's output on macOS. It can hold provider errors and addresses, so only the owner reads it. */
export const logPath = () => join(dataDir(), "vmbridge.log");

/** launchd appends to the log with whatever mode it already has, and makes a new one world-readable. */
export function protectLog() {
  if (existsSync(logPath())) chmodSync(logPath(), 0o600);
}

interface ServiceOptions {
  host?: string;
  port: number;
}

/** The command that runs VM Bridge: the compiled binary itself, or Bun with this script in development. */
function command(options: ServiceOptions) {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
  return [process.execPath, ...(compiled ? [] : [Bun.main]), "run", ...(options.host ? ["--host", options.host] : []), "--port", String(options.port)];
}

/** Variables the service needs: a PATH that finds git and tailscale, and the data directory if it was moved. */
function environment() {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.VMBRIDGE_HOME ? { VMBRIDGE_HOME: process.env.VMBRIDGE_HOME } : {}),
  };
}

async function exec(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv() });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, stderr: stderr.trim() };
}

async function must(args: string[]) {
  const result = await exec(args);
  if (!result.ok) throw new Error(`${args.slice(0, 2).join(" ")} failed: ${result.stderr || "no details"}`);
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** macOS: a per-user LaunchAgent, started at login and restarted if it crashes. */
const launchd = {
  plist: () => join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  domain: () => `gui/${process.getuid?.()}`,

  async install(options: ServiceOptions) {
    const log = logPath();
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(log, "", { flag: "a", mode: 0o600 });
    protectLog();
    const strings = (values: string[]) => values.map((value) => `      <string>${xml(value)}</string>`).join("\n");
    const env = Object.entries(environment())
      .map(([key, value]) => `      <key>${key}</key>\n      <string>${xml(value)}</string>`)
      .join("\n");
    write(
      this.plist(),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${strings(command(options))}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
  </dict>
</plist>
`,
    );
    await exec(["launchctl", "bootout", `${this.domain()}/${label}`]);
    await must(["launchctl", "bootstrap", this.domain(), this.plist()]);
  },

  async stop() {
    if (!existsSync(this.plist())) return false;
    return (await exec(["launchctl", "bootout", `${this.domain()}/${label}`])).ok;
  },

  async uninstall() {
    await this.stop();
    rmSync(this.plist(), { force: true });
  },
};

const systemdQuote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/** Linux: a systemd user unit. Without lingering it runs only while the user is logged in. */
const systemd = {
  unit: () => join(homedir(), ".config", "systemd", "user", "vmbridge.service"),

  async install(options: ServiceOptions) {
    const env = Object.entries(environment())
      .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
      .join("\n");
    write(
      this.unit(),
      `[Unit]
Description=VM Bridge
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command(options).map(systemdQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`,
    );
    await must(["systemctl", "--user", "daemon-reload"]);
    await must(["systemctl", "--user", "enable", "vmbridge.service"]);
    await must(["systemctl", "--user", "restart", "vmbridge.service"]);
    console.log("To keep it running after you log out: loginctl enable-linger $USER");
  },

  async stop() {
    if (!existsSync(this.unit())) return false;
    if (!(await exec(["systemctl", "--user", "is-active", "--quiet", "vmbridge.service"])).ok) return false;
    await must(["systemctl", "--user", "stop", "vmbridge.service"]);
    return true;
  },

  async uninstall() {
    if (!existsSync(this.unit())) return;
    await exec(["systemctl", "--user", "disable", "--now", "vmbridge.service"]);
    rmSync(this.unit(), { force: true });
    await exec(["systemctl", "--user", "daemon-reload"]);
  },
};

const unsupported = {
  install: async (_: ServiceOptions) => {
    throw new Error("Background services work on macOS and Linux.");
  },
  stop: async () => false,
  uninstall: async () => {},
};

export const service = process.platform === "darwin" ? launchd : process.platform === "linux" ? systemd : unsupported;
