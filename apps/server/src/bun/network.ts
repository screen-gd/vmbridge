import { networkInterfaces } from "node:os";
import type { Address, CloudflareInfo, NetworkInfo } from "@vmbridge/contracts";
import { childEnv } from "./env.ts";

const macAppBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const httpsPortCandidates = [443, 8443, 10443, 11443, 12443];

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
  CertDomains?: string[] | null;
}

interface ServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

function tailscaleBinary(): string | null {
  return Bun.which("tailscale") ?? (process.platform === "darwin" && Bun.file(macAppBinary).size > 0 ? macAppBinary : null);
}

async function tailscale(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const binary = tailscaleBinary();
  if (!binary) return { ok: false, stdout: "", stderr: "Tailscale is not installed." };
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 10_000, env: childEnv() });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, stdout, stderr };
}

async function readJson<T>(args: string[]): Promise<T | null> {
  const result = await tailscale(args);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

/** The HTTPS origin `tailscale serve` exposes for our port, if one is configured. */
function servedUrl(serve: ServeStatus | null, port: number): string | null {
  const targets = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  for (const [hostPort, web] of Object.entries(serve?.Web ?? {})) {
    if (!targets.has(web.Handlers?.["/"]?.Proxy ?? "")) continue;
    const [host, httpsPort] = hostPort.split(":");
    return httpsPort === "443" ? `https://${host}` : `https://${host}:${httpsPort}`;
  }
  return null;
}

/** This machine's own IPv4 addresses, by interface, leaving out loopback. */
function localIpv4(): { name: string; address: string }[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? []).filter((entry) => !entry.internal && entry.family === "IPv4").map((entry) => ({ name, address: entry.address })),
  );
}

let tailnet: { key: string; at: number; ips: Promise<Set<string>> } | null = null;

/**
 * Tailscale's addresses for this machine, empty while it is not installed or not up. Asks Tailscale again when this
 * machine's addresses change, such as when Tailscale comes up, and every 30 seconds in case it was still starting.
 */
function tailnetIps(): Promise<Set<string>> {
  const key = localIpv4()
    .map((entry) => entry.address)
    .join(",");
  if (!tailnet || tailnet.key !== key || Date.now() - tailnet.at > 30_000) {
    const ips = readJson<TailscaleStatus>(["status", "--json"]).then((status) => new Set(status?.BackendState === "Running" ? (status.Self?.TailscaleIPs ?? []) : []));
    tailnet = { key, at: Date.now(), ips };
  }
  return tailnet.ips;
}

/**
 * The addresses VM Bridge listens on without --host: loopback, Tailscale's address (WireGuard already encrypts the
 * tailnet), and the local network only when switched on, since plain HTTP there shows passwords and cookies to anyone
 * on the same Wi-Fi.
 */
export function servedHosts(addresses: string[], tailnetIps: Set<string>, localNetwork: boolean): string[] {
  const hosts = new Set(["127.0.0.1"]);
  for (const address of addresses) {
    if (localNetwork || tailnetIps.has(address)) hosts.add(address);
  }
  return [...hosts];
}

export async function wantedHosts(localNetwork: boolean): Promise<string[]> {
  return servedHosts(
    localIpv4().map((entry) => entry.address),
    await tailnetIps(),
    localNetwork,
  );
}

export interface Served {
  /** The addresses VM Bridge listens on right now. */
  hosts: string[];
  port: number;
  /** Started with --host, which decides the addresses instead of the local network switch. */
  fixed: boolean;
  /** The saved local network switch. */
  localNetwork: boolean;
}

/** Only addresses VM Bridge actually answers on, so links never point at one that does not work. */
export async function networkInfo(served: Served, cloudflare: CloudflareInfo): Promise<NetworkInfo> {
  const { hosts, port, fixed } = served;
  const wildcard = hosts.some((host) => host === "0.0.0.0" || host === "::");
  const serves = (ip: string) => wildcard || hosts.includes(ip);
  const loopback = serves("127.0.0.1") || hosts.includes("localhost");
  const addresses: Address[] = loopback ? [{ kind: "local", label: "This machine", url: `http://127.0.0.1:${port}` }] : [];
  const installed = tailscaleBinary() !== null;
  const status = installed ? await readJson<TailscaleStatus>(["status", "--json"]) : null;
  const running = status?.BackendState === "Running";
  const tailnetIps = new Set(status?.Self?.TailscaleIPs ?? []);
  const dnsName = status?.Self?.DNSName?.replace(/\.$/, "") || null;

  for (const { name, address } of localIpv4()) {
    if (tailnetIps.has(address) || !serves(address)) continue;
    addresses.push({ kind: "lan", label: `Local network (${name})`, url: `http://${address}:${port}` });
  }
  const ipv4 = running ? [...tailnetIps].find((ip) => !ip.includes(":")) : undefined;
  if (ipv4 && serves(ipv4)) {
    addresses.push({ kind: "tailscale", label: "Tailscale IP", url: `http://${ipv4}:${port}` });
    if (dnsName) addresses.push({ kind: "tailscale-dns", label: "Tailscale name", url: `http://${dnsName}:${port}` });
  }

  // tailscale serve forwards to the loopback listener.
  const httpsUrl = running ? servedUrl(await readJson<ServeStatus>(["serve", "status", "--json"]), port) : null;
  if (httpsUrl && loopback) addresses.push({ kind: "tailscale-https", label: "Tailscale HTTPS", url: httpsUrl });
  if (cloudflare.url) addresses.push({ kind: "cloudflare", label: "Cloudflare Tunnel", url: cloudflare.url });
  const localNetwork = { enabled: fixed ? wildcard || addresses.some((address) => address.kind === "lan") : served.localNetwork, fixed };
  return { platform: "bun", port, localNetwork, addresses, tailscale: { installed, running, dnsName, httpsUrl }, cloudflare };
}

/**
 * Publishes VM Bridge over HTTPS on the tailnet with `tailscale serve`. Uses the first
 * HTTPS port that no other serve config holds. The tailnet must have HTTPS certificates on.
 */
export async function enableTailscaleHttps(port: number): Promise<string> {
  const status = await readJson<TailscaleStatus>(["status", "--json"]);
  if (status?.BackendState !== "Running") throw new Error("Tailscale is not running on this machine.");
  if (!status.CertDomains?.length) throw new Error("Turn on HTTPS certificates for your tailnet in the Tailscale admin console.");
  const serve = await readJson<ServeStatus>(["serve", "status", "--json"]);
  const existing = servedUrl(serve, port);
  if (existing) return existing;
  const used = new Set(Object.keys(serve?.TCP ?? {}).map(Number));
  const httpsPort = httpsPortCandidates.find((candidate) => candidate !== port && !used.has(candidate));
  if (!httpsPort) throw new Error("Every HTTPS port VM Bridge tries is already served by Tailscale.");
  const result = await tailscale(["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`]);
  if (!result.ok) throw new Error(result.stderr.trim().split("\n").at(-1) || "tailscale serve failed.");
  const url = servedUrl(await readJson<ServeStatus>(["serve", "status", "--json"]), port);
  if (!url) throw new Error("tailscale serve did not report the new HTTPS address.");
  return url;
}

export async function disableTailscaleHttps(port: number): Promise<void> {
  const url = servedUrl(await readJson<ServeStatus>(["serve", "status", "--json"]), port);
  if (!url) return;
  const httpsPort = new URL(url).port || "443";
  const result = await tailscale(["serve", `--https=${httpsPort}`, "off"]);
  if (!result.ok) throw new Error(result.stderr.trim().split("\n").at(-1) || "tailscale serve failed.");
}
