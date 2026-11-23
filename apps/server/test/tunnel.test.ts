import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childVariables } from "../src/bun/env.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";
import {
  addressWorks,
  CloudflareTunnel,
  type Fetcher,
  findCloudflared,
  isLoggedIn,
  namedTunnelConfig,
  normalizeHostname,
  quickTunnelUrl,
  redact,
  requestOrigin,
  tunnelTokenSecret,
  waitForAddress,
} from "../src/bun/tunnel.ts";

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

  test("tailscale serve's user header gives each tailnet user their own address, only from tailscale serve", () => {
    const tailnet = { "tailscale-user-login": "alice@example.com", "x-forwarded-proto": "https" };
    expect(requestOrigin(request(tailnet), "127.0.0.1", false)).toEqual({ address: "tailscale:alice@example.com", secure: true });
    expect(requestOrigin(request(tailnet), "192.0.2.4", false).address).toBe("192.0.2.4");
    expect(requestOrigin(request({ ...tailnet, ...proxied }), "127.0.0.1", true).address).toBe("203.0.113.9");
  });
});

test("redacts tunnel tokens and credentials from log lines", () => {
  const token = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
  expect(redact(`INF running with token ${token}`)).toBe("INF running with token [redacted]");
  expect(redact("ERR bad value plain-secret-123 here", ["plain-secret-123"])).toBe("ERR bad value [redacted] here");
  expect(redact('settings map[token:abc123 url:http://127.0.0.1:1]')).toBe("settings map[token:[redacted] url:http://127.0.0.1:1]");
  expect(redact("INF Registered tunnel connection connIndex=0")).toBe("INF Registered tunnel connection connIndex=0");
});

describe("address check", () => {
  const url = "https://fake-quick-tunnel.trycloudflare.com";
  const found = { Status: 0, Answer: [{ type: 5 }, { type: 1 }] };

  /** Answers DNS over HTTPS with `dns` and the tunnel with `origin`, and records every request. */
  function network(dns: object, origin: () => Response) {
    const requests: { url: string; accept: string | null }[] = [];
    const fetcher: Fetcher = async (target, init) => {
      requests.push({ url: target, accept: new Headers(init?.headers).get("accept") });
      return target.startsWith("https://cloudflare-dns.com/") ? Response.json(dns) : origin();
    };
    return { fetcher, requests };
  }

  test("asks public DNS first, and never requests an address that does not resolve yet", async () => {
    const { fetcher, requests } = network({ Status: 3 }, () => Response.json({ hasPassword: true }));
    expect(await addressWorks(url, fetcher)).toBe(false);
    expect(requests).toEqual([{ url: "https://cloudflare-dns.com/dns-query?name=fake-quick-tunnel.trycloudflare.com&type=A", accept: "application/dns-json" }]);
  });

  test("works only when the request reaches VM Bridge", async () => {
    expect(await addressWorks(url, network(found, () => new Response("error code: 1033", { status: 530 })).fetcher)).toBe(false);
    expect(await addressWorks(url, network(found, () => new Response("<html>", { status: 200 })).fetcher)).toBe(false);
    expect(await addressWorks(url, network(found, () => { throw new TypeError("fetch failed"); }).fetcher)).toBe(false);
    const { fetcher, requests } = network(found, () => Response.json({ authenticated: false, hasPassword: true }));
    expect(await addressWorks(url, fetcher)).toBe(true);
    expect(requests.at(-1)?.url).toBe(`${url}/admin/api/auth`);
  });

  test("checks again until the address works", async () => {
    let lookups = 0;
    const { fetcher } = network({}, () => Response.json({ hasPassword: false }));
    const resolvesThirdTime: Fetcher = (target, init) => {
      if (target.startsWith("https://cloudflare-dns.com/") && ++lookups < 3) return Promise.resolve(Response.json({ Status: 3 }));
      return target.startsWith("https://cloudflare-dns.com/") ? Promise.resolve(Response.json(found)) : fetcher(target, init);
    };
    expect(await waitForAddress(url, () => true, { fetcher: resolvesThirdTime, delays: [1] })).toBe(true);
    expect(lookups).toBe(3);
  });

  test("gives up at the time limit, or as soon as the address is not wanted", async () => {
    const { fetcher, requests } = network({ Status: 3 }, () => Response.json({ hasPassword: true }));
    expect(await waitForAddress(url, () => true, { fetcher, delays: [5], limitMs: 30 })).toBe(false);
    expect(requests.length).toBeGreaterThan(1);
    requests.length = 0;
    expect(await waitForAddress(url, () => false, { fetcher, delays: [1] })).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  function setup(script: string, checkAddress: (url: string, wanted: () => boolean) => Promise<boolean> = async () => true) {
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
      checkAddress,
      listen: async (port) => {
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

  test("gives cloudflared only the variables it needs, never VM Bridge's password or key", async () => {
    const saved = { password: process.env.VMBRIDGE_PASSWORD, key: process.env.VMBRIDGE_ENCRYPTION_KEY };
    process.env.VMBRIDGE_PASSWORD = "password-secret-value";
    process.env.VMBRIDGE_ENCRYPTION_KEY = "key-secret-value";
    try {
      // Names only, so a failure never prints a value from the environment the tests run in.
      const { dir, settings, tunnel } = setup(`env | cut -d= -f1 > "$(dirname "$0")/names"\n${quick}`);
      settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
      await tunnel.apply();
      await tunnel.ready(5_000);
      await tunnel.stop();
      const names = (await Bun.file(join(dir, "bin", "names")).text()).split("\n").filter((name) => name && name !== "PWD" && name !== "SHLVL" && name !== "_");
      expect(names).toContain("PATH");
      expect(names.filter((name) => !childVariables.includes(name))).toEqual([]);
    } finally {
      for (const [name, value] of [["VMBRIDGE_PASSWORD", saved.password], ["VMBRIDGE_ENCRYPTION_KEY", saved.key]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("keeps a named tunnel's credentials private while it runs, and deletes them once it is off", async () => {
    // Answers the commands that make a named tunnel, writing its credentials file as cloudflared does (world-readable).
    const { dir, settings, tunnel } = setup(`case "$*" in
  "tunnel list"*) echo "[]" ;;
  "tunnel create"*) shift 4; umask 022; echo '{"TunnelSecret":"tunnel-secret"}' > "$2"; echo '{"id":"abc-123"}' ;;
  "tunnel route"*) ;;
  *) echo "INF Registered tunnel connection connIndex=0" >&2; exec sleep 30 ;;
esac`);
    mkdirSync(join(dir, ".cloudflared"));
    writeFileSync(join(dir, ".cloudflared", "cert.pem"), "");
    settings.set("cloudflareTunnel", { enabled: true, hostname: "bridge.example.com", port: null });
    await tunnel.apply();
    await tunnel.ready(5_000);
    expect(tunnel.info()).toMatchObject({ mode: "named", state: "running" });
    const folder = join(dir, "cloudflared");
    const credentials = join(folder, `vmbridge-${settings.get("bridgeId").slice(0, 8)}.json`);
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect(existsSync(join(folder, "config.yml"))).toBe(true);

    settings.set("cloudflareTunnel", { ...settings.get("cloudflareTunnel"), enabled: false });
    await tunnel.apply();
    expect(existsSync(credentials)).toBe(false);
    expect(existsSync(join(folder, "config.yml"))).toBe(false);
  });

  test("asks for a login before making a named tunnel", async () => {
    const { settings, tunnel } = setup(quick);
    settings.set("cloudflareTunnel", { enabled: true, hostname: "bridge.example.com", port: null });
    await tunnel.apply();
    expect(tunnel.info()).toMatchObject({ mode: "named", state: "failed", url: null });
    expect(tunnel.info().error).toContain("cloudflared tunnel login");
    await tunnel.stop();
  });

  test("shows a quick tunnel's address only once it works", async () => {
    let works = (_: boolean) => {};
    const checked: string[] = [];
    const { settings, tunnel } = setup(quick, (url) => {
      checked.push(url);
      return new Promise((resolve) => (works = resolve));
    });
    settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
    await tunnel.apply();
    await Bun.sleep(300);
    expect(checked).toEqual(["https://fake-quick-tunnel.trycloudflare.com"]);
    expect(tunnel.info()).toMatchObject({ state: "starting", url: null });
    works(true);
    await tunnel.ready(1_000);
    expect(tunnel.info()).toMatchObject({ state: "running", url: "https://fake-quick-tunnel.trycloudflare.com", error: null });
    await tunnel.stop();
  });

  test("stops a quick tunnel whose address never works, and says so", async () => {
    const { dir, settings, tunnel } = setup(quick, async () => false);
    settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
    await tunnel.apply();
    await tunnel.ready(5_000);
    await Bun.sleep(1_500);
    expect(tunnel.info()).toMatchObject({ state: "failed", url: null });
    expect(tunnel.info().error).toContain("did not start working");
    // Stopped for good, not restarted as if it had crashed.
    const pid = Number(await Bun.file(join(dir, "bin", "pid")).text());
    expect(() => process.kill(pid, 0)).toThrow();
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
