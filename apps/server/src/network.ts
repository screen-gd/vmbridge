import { networkInterfaces } from "node:os";
import type { Address, CloudflareInfo, NetworkInfo } from "@vmbridge/contracts";

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
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 10_000 });
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

export async function networkInfo(host: string, port: number, cloudflare: CloudflareInfo): Promise<NetworkInfo> {
  const addresses: Address[] = [{ kind: "local", label: "This machine", url: `http://127.0.0.1:${port}` }];
  const installed = tailscaleBinary() !== null;
  const status = installed ? await readJson<TailscaleStatus>(["status", "--json"]) : null;
  const running = status?.BackendState === "Running";
  const tailnetIps = new Set(status?.Self?.TailscaleIPs ?? []);
  const dnsName = status?.Self?.DNSName?.replace(/\.$/, "") || null;

  if (host === "0.0.0.0" || host === "::") {
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== "IPv4" || tailnetIps.has(entry.address)) continue;
        addresses.push({ kind: "lan", label: `Local network (${name})`, url: `http://${entry.address}:${port}` });
      }
    }
    if (running) {
      const ipv4 = [...tailnetIps].find((ip) => !ip.includes(":"));
      if (ipv4) addresses.push({ kind: "tailscale", label: "Tailscale IP", url: `http://${ipv4}:${port}` });
      if (dnsName) addresses.push({ kind: "tailscale-dns", label: "Tailscale name", url: `http://${dnsName}:${port}` });
    }
  }

  const httpsUrl = running ? servedUrl(await readJson<ServeStatus>(["serve", "status", "--json"]), port) : null;
  if (httpsUrl) addresses.push({ kind: "tailscale-https", label: "Tailscale HTTPS", url: httpsUrl });
  if (cloudflare.url) addresses.push({ kind: "cloudflare", label: "Cloudflare Tunnel", url: cloudflare.url });
  return { host, port, addresses, tailscale: { installed, running, dnsName, httpsUrl }, cloudflare };
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
