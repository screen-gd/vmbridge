import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { CloudflareInfo, TunnelMode } from "@vmbridge/contracts";
import type { Secrets, Settings } from "./settings.ts";
import type { Traffic } from "./traffic.ts";

export const tunnelTokenSecret = "cloudflare.tunnelToken";
const knownPaths = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
const maxBackoffMs = 60_000;
// A tunnel that ran this long before stopping starts again right away, not after the last crash's delay.
const stableMs = 60_000;

export function findCloudflared(PATH = process.env.PATH ?? "", fallbacks = knownPaths): string | null {
  return Bun.which("cloudflared", { PATH }) ?? fallbacks.find((path) => existsSync(path)) ?? null;
}

/** `cloudflared tunnel login` leaves this certificate, which lets cloudflared create tunnels and DNS records. */
export const isLoggedIn = (home = homedir()) => existsSync(join(home, ".cloudflared", "cert.pem"));

export function tunnelMode(hostname: string | null, hasToken: boolean): TunnelMode {
  if (hasToken) return "token";
  return hostname ? "named" : "quick";
}

/** Accepts `bridge.example.com`, also pasted as a URL. Null when it is not a hostname. */
export function normalizeHostname(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

/** The address in cloudflared's quick tunnel banner. Other trycloudflare.com URLs it logs, like its API, are not it. */
export function quickTunnelUrl(line: string): string | null {
  return /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0] ?? null;
}

/** Hides the token VM Bridge knows about, and anything shaped like a tunnel token or credential, from log lines. */
export function redact(line: string, secrets: string[] = []): string {
  let safe = line;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]");
  return safe
    .replace(/eyJ[A-Za-z0-9_-]{16,}={0,2}/g, "[redacted]")
    .replace(/((?:token|secret|password)["']?\s*[=:]\s*["']?)[^\s"',]+/gi, "$1[redacted]");
}

/** cloudflared's config for a named tunnel. JSON strings are valid YAML, which keeps paths with spaces safe. */
export function namedTunnelConfig(options: { id: string; credentials: string; hostname: string; port: number }): string {
  return [
    `tunnel: ${options.id}`,
    `credentials-file: ${JSON.stringify(options.credentials)}`,
    "no-autoupdate: true",
    "ingress:",
    `  - hostname: ${JSON.stringify(options.hostname)}`,
    `    service: http://127.0.0.1:${options.port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

const isLoopback = (address: string) => /^(?:127\.|::ffff:127\.)/.test(address) || address === "::1";

/**
 * Who sent a request, for login throttling, and whether it arrived over HTTPS, for the cookie's Secure flag.
 * Proxy headers are only believed from loopback: `cf-connecting-ip` on the listener only cloudflared is told about
 * (Cloudflare's edge sets it, replacing any the client sent), and `x-forwarded-proto` from a local proxy such as
 * `tailscale serve`. Anyone else could send either header to dodge throttling.
 */
export function requestOrigin(request: Request, peer: string | undefined, viaTunnel: boolean): { address: string; secure: boolean } {
  const address = peer ?? "unknown";
  const local = isLoopback(address);
  const forwardedHttps = local && request.headers.get("x-forwarded-proto") === "https";
  if (viaTunnel && local) return { address: request.headers.get("cf-connecting-ip") ?? address, secure: forwardedHttps };
  return { address, secure: new URL(request.url).protocol === "https:" || forwardedHttps };
}

export interface TunnelListener {
  port: number | undefined;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

interface TunnelDeps {
  settings: Settings;
  secrets: Secrets;
  traffic: Traffic;
  /** Holds cloudflared's config, named tunnel credentials and pid file. */
  dir: string;
  /** Opens the loopback listener cloudflared forwards to. Port 0 picks a free one. */
  listen: (port: number) => TunnelListener;
  home?: string;
  PATH?: string;
  fallbacks?: string[];
}

class TunnelSetupError extends Error {}

/**
 * Runs `cloudflared` as a child process while the tunnel is on: a quick tunnel without an account, a named tunnel
 * on the user's hostname when cloudflared is logged in, or a dashboard-made tunnel from its token. cloudflared
 * forwards to its own loopback listener, so requests through it are told apart from local ones. Restarts it with
 * backoff when it stops, and logs its output with tokens hidden.
 */
export class CloudflareTunnel {
  private child: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private listener: TunnelListener | null = null;
  private state: CloudflareInfo["state"] = "off";
  private url: string | null = null;
  private error: string | null = null;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every apply and stop, so a child or setup step from before one changes nothing after it. */
  private generation = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly deps: TunnelDeps) {}

  private get folder() {
    return join(this.deps.dir, "cloudflared");
  }

  private binary() {
    return findCloudflared(this.deps.PATH, this.deps.fallbacks);
  }

  info(): CloudflareInfo {
    const { enabled, hostname, port } = this.deps.settings.get("cloudflareTunnel");
    const hasToken = this.deps.secrets.has(tunnelTokenSecret);
    return {
      installed: this.binary() !== null,
      loggedIn: isLoggedIn(this.deps.home),
      enabled,
      hostname,
      hasToken,
      mode: tunnelMode(hostname, hasToken),
      state: this.state,
      url: this.url,
      error: this.error,
      port: this.listener?.port ?? port,
    };
  }

  /** Resolves once the address is known or the tunnel failed or is off, or after `ms`. */
  async ready(ms: number): Promise<void> {
    if (this.state !== "starting" || this.url) return;
    let done = () => {};
    await Promise.race([new Promise<void>((resolve) => this.waiters.add((done = resolve))), Bun.sleep(ms)]);
    this.waiters.delete(done);
  }

  /** Starts, restarts or stops cloudflared to match the settings. */
  async apply(): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.retry);
    this.failures = 0;
    const enabled = this.deps.settings.get("cloudflareTunnel").enabled;
    // Set before anything is awaited, so `ready` right after this call waits for the new tunnel.
    this.update(enabled ? "starting" : "off", null, null);
    await this.halt();
    if (generation !== this.generation) return;
    this.killStale();
    if (!enabled) return this.closeListener();
    await this.launch(generation);
  }

  async stop(): Promise<void> {
    this.generation++;
    clearTimeout(this.retry);
    await this.halt();
    await this.closeListener();
    this.update("off", null, null);
  }

  private update(state: CloudflareInfo["state"], url: string | null, error: string | null) {
    this.state = state;
    this.url = url;
    this.error = error;
    if (state !== "starting" || url) {
      for (const done of this.waiters) done();
      this.waiters.clear();
    }
  }

  private async launch(generation: number) {
    const started = Date.now();
    const token = this.deps.secrets.get(tunnelTokenSecret);
    try {
      const binary = this.binary();
      if (!binary) throw new TunnelSetupError("cloudflared is not installed.");
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      const port = this.openListener();
      const { hostname } = this.deps.settings.get("cloudflareTunnel");
      const args = await this.command(binary, port, hostname, token);
      if (generation !== this.generation) return;
      const mode = tunnelMode(hostname, Boolean(token));
      const child = Bun.spawn([binary, "tunnel", "--no-autoupdate", "--no-prechecks", "--grace-period", "3s", "--pidfile", join(this.folder, "cloudflared.pid"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // In the environment, not the arguments, so other users on this machine cannot read it from the process list.
        env: token ? { ...process.env, TUNNEL_TOKEN: token } : { ...process.env, TUNNEL_TOKEN: undefined },
      });
      this.child = child;
      let lastError: string | null = null;
      const onLine = (line: string) => {
        const safe = redact(line, token ? [token] : []);
        // Its routine info lines would bury VM Bridge's own output. Warnings, errors and connections stay.
        if (!/\sINF\s/.test(safe) || safe.includes("Registered tunnel connection")) console.log(`[cloudflared] ${safe}`);
        if (generation !== this.generation) return;
        const error = /(?:^|\s)(?:ERR|FTL)\s+(.*)$/.exec(safe)?.[1];
        if (error) lastError = error;
        const quick = mode === "quick" ? quickTunnelUrl(safe) : null;
        if (quick) this.update(this.state, quick, null);
        if (safe.includes("Registered tunnel connection") && this.state !== "running") {
          const url = mode === "quick" ? this.url : `https://${hostname}`;
          this.update("running", url, null);
          this.deps.traffic.record({ kind: "system", operation: "Cloudflare Tunnel connected", status: "ok" });
        }
      };
      // The reason it stopped is in its last lines, so read them all before handling the exit.
      void Promise.all([child.exited, readLines(child.stdout, onLine), readLines(child.stderr, onLine)]).then(([code]) => {
        if (generation !== this.generation) return;
        this.child = null;
        this.failed(generation, lastError ?? `cloudflared stopped (exit code ${code}).`, Date.now() - started >= stableMs);
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const reason = redact(error instanceof Error ? error.message : String(error), token ? [token] : []);
      // Setup mistakes, like a missing login, need the user, not another try.
      if (error instanceof TunnelSetupError) return this.update("failed", null, reason);
      this.failed(generation, reason, false);
    }
  }

  /** Records the failure and tries again later, waiting longer after each failure in a row. */
  private failed(generation: number, reason: string, stable: boolean) {
    if (stable) this.failures = 0;
    if (this.failures === 0) this.deps.traffic.record({ kind: "system", operation: "Cloudflare Tunnel", status: "error", reason });
    const delay = Math.min(1000 * 2 ** this.failures, maxBackoffMs);
    this.failures++;
    this.update("failed", null, reason);
    this.retry = setTimeout(() => {
      if (generation !== this.generation) return;
      this.update("starting", null, null);
      void this.launch(generation);
    }, delay);
  }

  /** Arguments after `cloudflared tunnel`. A named tunnel is created or reused first, with its DNS record. */
  private async command(binary: string, port: number, hostname: string | null, token: string | undefined): Promise<string[]> {
    if (token) {
      if (!hostname) throw new TunnelSetupError("Add the hostname this tunnel serves.");
      return ["run"];
    }
    if (!hostname) {
      // Its own config, so a config.yml the user keeps in ~/.cloudflared for other tunnels does not apply here.
      const config = join(this.folder, "quick.yml");
      writeFileSync(config, "no-autoupdate: true\n");
      return ["--config", config, "--url", `http://127.0.0.1:${port}`];
    }
    if (!isLoggedIn(this.deps.home)) {
      throw new TunnelSetupError("To use your own domain, run `cloudflared tunnel login` on this machine, or paste a tunnel token.");
    }
    const name = `vmbridge-${this.deps.settings.get("bridgeId").slice(0, 8)}`;
    const credentials = join(this.folder, `${name}.json`);
    const listed = JSON.parse(await cloudflared(binary, ["tunnel", "list", "--output", "json", "--name", name])) as { id: string; name: string }[] | null;
    let id = listed?.find((tunnel) => tunnel.name === name)?.id;
    if (!id) {
      id = (JSON.parse(await cloudflared(binary, ["tunnel", "create", "--output", "json", "--credentials-file", credentials, name])) as { id: string }).id;
    } else if (!existsSync(credentials)) {
      await cloudflared(binary, ["tunnel", "token", "--credentials-file", credentials, id]);
    }
    // Without --overwrite-dns: a record the user already has for this hostname is theirs to remove.
    await cloudflared(binary, ["tunnel", "route", "dns", id, hostname]);
    const config = join(this.folder, "config.yml");
    writeFileSync(config, namedTunnelConfig({ id, credentials, hostname, port }), { mode: 0o600 });
    return ["--config", config, "run"];
  }

  private openListener(): number {
    if (this.listener?.port) return this.listener.port;
    const saved = this.deps.settings.get("cloudflareTunnel");
    try {
      this.listener = this.deps.listen(saved.port ?? 0);
    } catch {
      // The saved port is taken. A dashboard-made tunnel then needs pointing at the new one, which Settings shows.
      this.listener = this.deps.listen(0);
    }
    const port = this.listener.port!;
    if (port !== saved.port) this.deps.settings.set("cloudflareTunnel", { ...this.deps.settings.get("cloudflareTunnel"), port });
    return port;
  }

  private async closeListener() {
    const listener = this.listener;
    this.listener = null;
    await listener?.stop(true);
  }

  private async halt() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) child.kill("SIGKILL");
    rmSync(join(this.folder, "cloudflared.pid"), { force: true });
  }

  /**
   * A cloudflared left running by a VM Bridge that was killed would keep the old public address open, even with
   * the tunnel now off. Its pid file says which process to stop, and only when that process is still cloudflared.
   */
  private killStale() {
    const pidFile = join(this.folder, "cloudflared.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    rmSync(pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0) return;
    const name = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]).stdout.toString().trim();
    if (!name.endsWith("cloudflared")) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  }
  if (buffer.trim()) onLine(buffer);
}

/** Runs a short cloudflared command and returns its output, or throws with its last error line. */
async function cloudflared(binary: string, args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(redact(stderr.trim().split("\n").at(-1) || `cloudflared ${args[1]} failed.`));
  return stdout;
}
