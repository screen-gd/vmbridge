import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareInfo, NetworkInfo } from "@vmbridge/contracts";
import { AllowedHosts } from "../src/bun/hosts.ts";
import { dashboardKey, start } from "../src/index.ts";

describe("the dashboard API over HTTP", () => {
  const password = "correct horse battery";
  let dir: string;
  let bridge: Awaited<ReturnType<typeof start>>;
  const api = (path: string, host: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${bridge.port}/admin/api${path}`, { ...init, headers: { host, ...init.headers } });
  const login = (host: string, headers: Record<string, string>) =>
    api("/login", host, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ key: password }) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vmbridge-hosts-"));
    const key = dashboardKey(dir);
    await key.set(password);
    key.close();
    bridge = await start({ dir, host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a name pointed at this machine by someone else gets nothing, even with a cookie from its real address", async () => {
    const rebound = `rebind.attacker.example:${bridge.port}`;
    expect((await api("/auth", rebound)).status).toBe(421);
    expect((await login(rebound, { origin: `http://${rebound}` })).status).toBe(421);

    const local = `localhost:${bridge.port}`;
    const response = await login(local, { origin: `http://${local}` });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect((await api("/network", local, { headers: { cookie } })).status).toBe(200);
    expect((await api("/network", rebound, { headers: { cookie } })).status).toBe(421);
  });

  test("changes need a request from a page on the same address", async () => {
    const local = `127.0.0.1:${bridge.port}`;
    expect((await login(local, {})).status).toBe(403);
    expect((await login(local, { origin: "http://attacker.example" })).status).toBe(403);
    expect((await login(local, { origin: `http://localhost:${bridge.port}` })).status).toBe(403);
    expect((await login(local, { origin: "null" })).status).toBe(403);
    expect((await login(local, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await login(local, { origin: `http://${local}` })).status).toBe(200);
    expect((await login(local, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });
});

describe("allowed hosts", () => {
  const tunnelOff: CloudflareInfo = { installed: true, loggedIn: false, enabled: false, hostname: null, hasToken: false, mode: "quick", state: "off", url: null, error: null, port: null };

  function setup() {
    const state = { tailscaleHttps: null as string | null, tunnel: tunnelOff, reads: 0 };
    const network = async (): Promise<NetworkInfo> => {
      state.reads++;
      const addresses = [{ kind: "local" as const, label: "This machine", url: "http://127.0.0.1:3774" }];
      if (state.tailscaleHttps) addresses.push({ kind: "local", label: "Tailscale HTTPS", url: state.tailscaleHttps });
      return {
        platform: "bun",
        localNetwork: { enabled: false, fixed: false },
        port: 3774,
        addresses,
        tailscale: { installed: true, running: true, dnsName: "box.tail1234.ts.net", httpsUrl: state.tailscaleHttps },
        cloudflare: state.tunnel,
      };
    };
    return { state, hosts: new AllowedHosts(network, () => state.tunnel, ["proxy.example.com"]) };
  }

  test("IP addresses, localhost, this machine's names and extra hosts are allowed, others are not", async () => {
    const { hosts } = setup();
    for (const host of ["127.0.0.1:3774", "[::1]:3774", "192.168.1.20:3774", "100.64.0.1", "LOCALHOST:3774", "box.tail1234.ts.net:3774", "proxy.example.com"]) {
      expect({ host, allowed: await hosts.allows(host) }).toEqual({ host, allowed: true });
    }
    for (const host of ["rebind.attacker.example:3774", "localhost.attacker.example", "", null]) {
      expect({ host, allowed: await hosts.allows(host) }).toEqual({ host, allowed: false });
    }
  });

  test("a name that appears later is allowed without a restart, and unknown names do not run the tailscale CLI each time", async () => {
    const { state, hosts } = setup();
    try {
      setSystemTime(new Date("2026-01-01T00:00:00Z"));
      expect(await hosts.allows("box.tail1234.ts.net:8443")).toBe(true);
      expect(state.reads).toBe(1);
      for (let i = 0; i < 20; i++) expect(await hosts.allows(`rebind${i}.attacker.example`)).toBe(false);
      expect(state.reads).toBe(1);

      state.tailscaleHttps = "https://serve.tail1234.ts.net:8443";
      setSystemTime(new Date("2026-01-01T00:00:06Z"));
      expect(await hosts.allows("serve.tail1234.ts.net:8443")).toBe(true);
      expect(state.reads).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("the Cloudflare Tunnel's hostname is allowed once it is set, and quick tunnel names only while one is on", async () => {
    const { state, hosts } = setup();
    expect(await hosts.allows("bridge.example.com")).toBe(false);
    expect(await hosts.allows("random-words.trycloudflare.com")).toBe(false);

    state.tunnel = { ...tunnelOff, enabled: true, mode: "quick", state: "starting" };
    expect(await hosts.allows("random-words.trycloudflare.com")).toBe(true);
    expect(await hosts.allows("trycloudflare.com.attacker.example")).toBe(false);

    state.tunnel = { ...tunnelOff, enabled: true, hostname: "bridge.example.com", mode: "named", state: "running", url: "https://bridge.example.com" };
    expect(await hosts.allows("bridge.example.com")).toBe(true);
    expect(await hosts.allows("random-words.trycloudflare.com")).toBe(false);
  });
});
