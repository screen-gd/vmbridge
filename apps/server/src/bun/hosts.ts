import { isIP } from "node:net";
import { hostname } from "node:os";
import type { CloudflareInfo, NetworkInfo } from "@vmbridge/contracts";

/** How often an unknown name may make VM Bridge look up its addresses again, which runs the tailscale CLI. */
const lookupEveryMs = 5_000;

/** The name in a Host header or URL host, lowercased, without its port, IPv6 brackets or trailing dot. */
function nameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** This machine's own name, such as `mac-mini.local` on a home network, with and without `.local`. */
function machineNames(): string[] {
  const name = hostname().toLowerCase().replace(/\.local$/, "");
  return [name, `${name}.local`];
}

const extraHosts = () => (process.env.VMBRIDGE_ALLOWED_HOSTS ?? "").split(",").flatMap((host) => nameOf(host.trim()) ?? []);

/**
 * The names the dashboard's API answers on, against DNS rebinding: a page on a name someone points at this machine is
 * otherwise same-origin with VM Bridge, and its requests carry the user's dashboard cookie. Rebinding needs a name the
 * attacker controls, so any IP address is fine. Names are this machine's own: localhost, its hostname, the names
 * VM Bridge lists under its addresses (Tailscale and Cloudflare Tunnel), and any in `VMBRIDGE_ALLOWED_HOSTS`.
 */
export class AllowedHosts {
  private names = new Set<string>();
  private lookedUpAt = 0;
  private lookup: Promise<void> | null = null;
  private readonly fixed: Set<string>;

  constructor(
    private readonly network: () => Promise<NetworkInfo>,
    private readonly tunnel: () => CloudflareInfo,
    extra = extraHosts(),
  ) {
    this.fixed = new Set(["localhost", ...machineNames(), ...extra]);
  }

  /** Takes the names from addresses read for any reason, such as the dashboard showing them. */
  learn(info: NetworkInfo) {
    const names = info.addresses.flatMap((address) => nameOf(new URL(address.url).host) ?? []);
    if (info.tailscale.dnsName) names.push(info.tailscale.dnsName.toLowerCase());
    this.names = new Set(names);
    this.lookedUpAt = Date.now();
  }

  async allows(host: string | null): Promise<boolean> {
    const name = host ? nameOf(host) : null;
    if (!name) return false;
    if (this.known(name)) return true;
    // Possibly a name that appeared since the last look, such as Tailscale HTTPS turned on outside VM Bridge.
    if (Date.now() - this.lookedUpAt >= lookupEveryMs) {
      this.lookup ??= this.network()
        .then((info) => this.learn(info), () => {})
        .finally(() => {
          this.lookedUpAt = Date.now();
          this.lookup = null;
        });
      await this.lookup;
    }
    return this.known(name);
  }

  private known(name: string): boolean {
    if (isIP(name) || this.fixed.has(name) || this.names.has(name)) return true;
    // Read each time, so the tunnel works as soon as it is set up.
    const tunnel = this.tunnel();
    if (tunnel.hostname === name) return true;
    // A quick tunnel's address is only listed once it works, and VM Bridge checks that it works through this API.
    // trycloudflare.com names are Cloudflare's, so no one can point one at this machine.
    return tunnel.enabled && tunnel.mode === "quick" && name.endsWith(".trycloudflare.com");
  }
}
