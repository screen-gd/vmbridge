import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { servedHosts } from "../src/bun/network.ts";
import { dashboardKey, start } from "../src/index.ts";

// A local network address of this machine. Tailscale's 100.64.0.0/10 range is left out: it is not the local network.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && !entry.internal && entry.family === "IPv4" && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(entry.address))?.address;

const password = "listener test key";
const bridges: Awaited<ReturnType<typeof start>>[] = [];
const dirs: string[] = [];

async function startBridge(host?: string) {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-listeners-"));
  dirs.push(dir);
  const keys = dashboardKey(dir);
  await keys.set(password);
  keys.close();
  const bridge = await start({ dir, host, port: 0 });
  bridges.push(bridge);
  const base = `http://127.0.0.1:${bridge.port}`;
  const login = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ key: password }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const setLocalNetwork = (enabled: boolean) =>
    fetch(`${base}/admin/api/network/local`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify({ enabled }) });
  return { bridge, setLocalNetwork };
}

const serves = (ip: string, port: number) =>
  fetch(`http://${ip}:${port}/dashboard`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.status === 200,
    () => false,
  );

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("serves loopback and the tailnet address, and the local network only when switched on", () => {
  const interfaces = ["192.168.1.20", "100.101.102.103", "10.0.0.1"];
  const tailnet = new Set(["100.101.102.103", "fd7a:115c:a1e0::1"]);
  expect(servedHosts(interfaces, tailnet, false)).toEqual(["127.0.0.1", "100.101.102.103"]);
  expect(servedHosts(interfaces, tailnet, true)).toEqual(["127.0.0.1", "192.168.1.20", "100.101.102.103", "10.0.0.1"]);
  // Tailscale not installed or not up yet.
  expect(servedHosts(interfaces, new Set(), false)).toEqual(["127.0.0.1"]);
});

describe.skipIf(!lanIp)("on this machine's local network address", () => {
  test("by default VM Bridge does not answer there, and the switch opens and closes it without a restart", async () => {
    const { bridge, setLocalNetwork } = await startBridge();
    expect(await serves("127.0.0.1", bridge.port)).toBe(true);
    expect(await serves(lanIp!, bridge.port)).toBe(false);
    let network = await bridge.network();
    expect(network.addresses.some((address) => address.kind === "lan")).toBe(false);
    expect(network.localNetwork).toEqual({ enabled: false, fixed: false });

    expect((await setLocalNetwork(true)).status).toBe(200);
    expect(await serves(lanIp!, bridge.port)).toBe(true);
    network = await bridge.network();
    expect(network.addresses.some((address) => address.url === `http://${lanIp}:${bridge.port}`)).toBe(true);
    expect(network.localNetwork.enabled).toBe(true);

    expect((await setLocalNetwork(false)).status).toBe(200);
    expect(await serves(lanIp!, bridge.port)).toBe(false);
    expect(await serves("127.0.0.1", bridge.port)).toBe(true);
  });

  test("--host 0.0.0.0 serves every network, and the switch cannot change it", async () => {
    const { bridge, setLocalNetwork } = await startBridge("0.0.0.0");
    expect(await serves(lanIp!, bridge.port)).toBe(true);
    expect((await bridge.network()).localNetwork).toEqual({ enabled: true, fixed: true });
    expect((await setLocalNetwork(false)).status).toBe(400);
    expect(await serves(lanIp!, bridge.port)).toBe(true);
  });

  test("--host 127.0.0.1 serves only this machine", async () => {
    const { bridge } = await startBridge("127.0.0.1");
    expect(await serves(lanIp!, bridge.port)).toBe(false);
    const network = await bridge.network();
    expect(network.addresses.map((address) => address.kind)).toEqual(["local"]);
    expect(network.localNetwork).toEqual({ enabled: false, fixed: true });
  });
});
