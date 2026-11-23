import type { NetworkInfo } from "@vmbridge/contracts";
import { BadRequest, type BridgeNetwork } from "../admin.ts";
import type { Secrets, Settings } from "../settings.ts";
import { AllowedHosts } from "./hosts.ts";
import { disableTailscaleHttps, enableTailscaleHttps, networkInfo, type Served } from "./network.ts";
import { normalizeHostname, tunnelTokenSecret, type CloudflareTunnel } from "./tunnel.ts";

const text = (value: unknown, label: string) => {
  if (typeof value !== "string") throw new BadRequest(`${label} must be text.`);
  return value.trim();
};

interface BunNetworkDeps {
  served: () => Served;
  /** Opens or closes listeners to match the local network switch. */
  applyAddresses: () => Promise<void>;
  settings: Settings;
  secrets: Secrets;
  tunnel: () => CloudflareTunnel;
}

/** The dashboard's addresses on this machine: loopback, the local network, Tailscale and Cloudflare Tunnel. */
export class BunNetwork implements BridgeNetwork {
  private readonly hosts: AllowedHosts;

  constructor(private readonly deps: BunNetworkDeps) {
    this.hosts = new AllowedHosts(() => this.info(), () => deps.tunnel().info());
  }

  async info(): Promise<NetworkInfo> {
    const info = await networkInfo(this.deps.served(), this.deps.tunnel().info());
    this.hosts.learn(info);
    return info;
  }

  allows(host: string | null) {
    return this.hosts.allows(host);
  }

  async change(setting: string, input: Record<string, unknown>): Promise<NetworkInfo | null> {
    const { settings, secrets } = this.deps;
    if (setting === "https") {
      const { port } = this.deps.served();
      if (input.enabled === true) await enableTailscaleHttps(port);
      else await disableTailscaleHttps(port);
      return this.info();
    }
    if (setting === "local") {
      if (typeof input.enabled !== "boolean") throw new BadRequest("Say whether to turn the local network on.");
      if (this.deps.served().fixed) throw new BadRequest("VM Bridge was started with --host, which decides this.");
      settings.set("localNetwork", input.enabled);
      await this.deps.applyAddresses();
      return this.info();
    }
    if (setting === "cloudflare") {
      const next = { ...settings.get("cloudflareTunnel") };
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean") throw new BadRequest("Say whether to turn the tunnel on.");
        next.enabled = input.enabled;
      }
      if (input.hostname !== undefined) {
        const hostname = input.hostname === null ? "" : text(input.hostname, "The hostname");
        next.hostname = hostname ? normalizeHostname(hostname) : null;
        if (hostname && !next.hostname) throw new BadRequest("Use a hostname such as bridge.example.com.");
      }
      // Like provider secrets: empty leaves the token as it is, null removes it.
      if (input.token === null) secrets.set(tunnelTokenSecret, null);
      else if (input.token !== undefined) {
        const token = text(input.token, "The token");
        if (token) secrets.set(tunnelTokenSecret, token);
      }
      settings.set("cloudflareTunnel", next);
      // Setup mistakes fail within apply. The address can take a minute to work, which the dashboard shows while it waits.
      await this.deps.tunnel().apply();
      return this.info();
    }
    return null;
  }
}
