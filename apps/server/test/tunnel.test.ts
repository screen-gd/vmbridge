import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";
import {
  CloudflareTunnel,
  findCloudflared,
  isLoggedIn,
  namedTunnelConfig,
  normalizeHostname,
  quickTunnelUrl,
  redact,
  requestOrigin,
  tunnelTokenSecret,
} from "../src/tunnel.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-tunnel-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in cloudflared: prints what a quick tunnel prints, records how it was started, then waits to be stopped. */
function fakeCloudflared(dir: string, script: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cloudflared"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "cloudflared"), 0o755);
  return bin;
}

describe("detection", () => {
  test("finds cloudflared on PATH, or not at all", () => {
    const dir = tempDir();
    const bin = fakeCloudflared(dir, "exit 0");
    expect(findCloudflared(bin, [])).toBe(join(bin, "cloudflared"));
    expect(findCloudflared(join(dir, "empty"), [])).toBeNull();
    expect(findCloudflared(join(dir, "empty"), [join(bin, "cloudflared")])).toBe(join(bin, "cloudflared"));
  });

  test("logged in means cloudflared's origin certificate exists", () => {
    const home = tempDir();
    expect(isLoggedIn(home)).toBe(false);
    mkdirSync(join(home, ".cloudflared"));
    writeFileSync(join(home, ".cloudflared", "cert.pem"), "");
    expect(isLoggedIn(home)).toBe(true);
  });
});

test("reads the quick tunnel address from cloudflared's banner only", () => {
  expect(quickTunnelUrl("2026-11-23T00:44:15Z INF |  https://ought-que-avoid-prison.trycloudflare.com    |")).toBe("https://ought-que-avoid-prison.trycloudflare.com");
  expect(quickTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
  expect(quickTunnelUrl("ERR failed to request https://api.trycloudflare.com/tunnel")).toBeNull();
});

test("normalizes hostnames and rejects anything else", () => {
  expect(normalizeHostname(" https://Bridge.Example.com/ ")).toBe("bridge.example.com");
  expect(normalizeHostname("localhost")).toBeNull();
  expect(normalizeHostname("bridge.example.com/path")).toBeNull();
  expect(normalizeHostname("bad_host.example.com")).toBeNull();
});

test("named tunnel config routes only the hostname to the loopback listener", () => {
  expect(namedTunnelConfig({ id: "abc-123", credentials: "/Users/me/My Data/cloudflared/vmbridge-1.json", hostname: "bridge.example.com", port: 41234 })).toBe(
    [
      "tunnel: abc-123",
      'credentials-file: "/Users/me/My Data/cloudflared/vmbridge-1.json"',
      "no-autoupdate: true",
      "ingress:",
      '  - hostname: "bridge.example.com"',
      "    service: http://127.0.0.1:41234",
      "  - service: http_status:404",
      "",
    ].join("\n"),
  );
});

describe("proxy headers", () => {
  const request = (headers: Record<string, string>) => new Request("http://bridge.local/admin/api/login", { headers });
  const proxied = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-proto": "https" };

  test("are trusted from cloudflared on the tunnel listener", () => {
    expect(requestOrigin(request(proxied), "127.0.0.1", true)).toEqual({ address: "203.0.113.9", secure: true });
    expect(requestOrigin(request(proxied), "::ffff:127.0.0.1", true)).toEqual({ address: "203.0.113.9", secure: true });
  });

  test("are ignored from anyone else", () => {
    // Someone on the LAN sending Cloudflare's headers to dodge login throttling.
    expect(requestOrigin(request(proxied), "192.0.2.4", false)).toEqual({ address: "192.0.2.4", secure: false });
    expect(requestOrigin(request(proxied), "192.0.2.4", true)).toEqual({ address: "192.0.2.4", secure: false });
    // A local proxy such as tailscale serve on the main listener: its HTTPS is real, a cf-connecting-ip is not.
    expect(requestOrigin(request(proxied), "127.0.0.1", false)).toEqual({ address: "127.0.0.1", secure: true });
  });
});

test("redacts tunnel tokens and credentials from log lines", () => {
  const token = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
  expect(redact(`INF running with token ${token}`)).toBe("INF running with token [redacted]");
  expect(redact("ERR bad value plain-secret-123 here", ["plain-secret-123"])).toBe("ERR bad value [redacted] here");
  expect(redact('settings map[token:abc123 url:http://127.0.0.1:1]')).toBe("settings map[token:[redacted] url:http://127.0.0.1:1]");
  expect(redact("INF Registered tunnel connection connIndex=0")).toBe("INF Registered tunnel connection connIndex=0");
});

describe("lifecycle", () => {
  function setup(script: string) {
    const dir = tempDir();
    const db = openDatabase(":memory:");
    const settings = new Settings(db);
    const secrets = new Secrets(db, testEncryption);
    const listeners: ReturnType<typeof Bun.serve>[] = [];
    const tunnel = new CloudflareTunnel({
      settings,
      secrets,
      traffic: new Traffic(),
      dir,
      home: dir,
      PATH: fakeCloudflared(dir, script),
      fallbacks: [],
      listen: (port) => {
        const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
        listeners.push(server);
        return server;
      },
    });
    return { dir, settings, secrets, tunnel, listeners };
  }

  const quick = `echo "$@" > "$(dirname "$0")/args"; echo "token=$TUNNEL_TOKEN" > "$(dirname "$0")/env"; echo $$ > "$(dirname "$0")/pid"
echo "INF |  https://fake-quick-tunnel.trycloudflare.com  |" >&2
echo "INF Registered tunnel connection connIndex=0" >&2
exec sleep 30`;

  test("stays off until turned on", async () => {
    const { tunnel, listeners } = setup(quick);
    await tunnel.apply();
    expect(tunnel.info()).toMatchObject({ installed: true, enabled: false, state: "off", url: null });
    expect(listeners).toHaveLength(0);
  });

  test("runs a quick tunnel to its own loopback listener, and stops it", async () => {
    const { dir, settings, tunnel, listeners } = setup(quick);
    settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
    await tunnel.apply();
    await tunnel.ready(5_000);
    await Bun.sleep(100);
    const info = tunnel.info();
    expect(info).toMatchObject({ mode: "quick", state: "running", url: "https://fake-quick-tunnel.trycloudflare.com" });
    expect(info.port).toBe(listeners[0]!.port!);
    expect(settings.get("cloudflareTunnel").port).toBe(info.port);
    expect(await Bun.file(join(dir, "bin", "args")).text()).toContain(`--url http://127.0.0.1:${info.port}`);
    await tunnel.stop();
    expect(tunnel.info()).toMatchObject({ state: "off", url: null });
  });

  test("passes a dashboard tunnel's token in the environment, never the arguments", async () => {
    const { dir, settings, secrets, tunnel } = setup(quick);
    secrets.set(tunnelTokenSecret, "tok-secret-value");
    settings.set("cloudflareTunnel", { enabled: true, hostname: "bridge.example.com", port: null });
    await tunnel.apply();
    await tunnel.ready(5_000);
    expect(tunnel.info()).toMatchObject({ mode: "token", state: "running", url: "https://bridge.example.com" });
    expect(await Bun.file(join(dir, "bin", "args")).text()).not.toContain("tok-secret-value");
    expect(await Bun.file(join(dir, "bin", "env")).text()).toBe("token=tok-secret-value\n");
    await tunnel.stop();
  });

  test("asks for a login before making a named tunnel", async () => {
    const { settings, tunnel } = setup(quick);
    settings.set("cloudflareTunnel", { enabled: true, hostname: "bridge.example.com", port: null });
    await tunnel.apply();
    expect(tunnel.info()).toMatchObject({ mode: "named", state: "failed", url: null });
    expect(tunnel.info().error).toContain("cloudflared tunnel login");
    await tunnel.stop();
  });

  test("starts cloudflared again after it crashes", async () => {
    const { dir, settings, tunnel } = setup(`n=$(cat "$(dirname "$0")/runs" 2>/dev/null || echo 0); echo $((n + 1)) > "$(dirname "$0")/runs"
if [ "$n" = 0 ]; then echo "ERR failed to connect" >&2; exit 1; fi
${quick}`);
    settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
    await tunnel.apply();
    await Bun.sleep(300);
    expect(tunnel.info()).toMatchObject({ state: "failed", error: "failed to connect" });
    // The first retry waits a second.
    await Bun.sleep(1_500);
    expect(tunnel.info()).toMatchObject({ state: "running", url: "https://fake-quick-tunnel.trycloudflare.com" });
    expect((await Bun.file(join(dir, "bin", "runs")).text()).trim()).toBe("2");
    await tunnel.stop();
    // The restarted process is the one stopped.
    const pid = Number(await Bun.file(join(dir, "bin", "pid")).text());
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
