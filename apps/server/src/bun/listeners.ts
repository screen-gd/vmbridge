import type { Server } from "bun";

/**
 * VM Bridge's listeners on its main port, one per address it serves, since Bun.serve binds one address. Addresses come
 * and go (Tailscale comes up after VM Bridge, the local network switch flips, Wi-Fi changes), so `apply` opens and
 * closes listeners to match `wanted`.
 */
export class Listeners<T> {
  private readonly servers = new Map<string, Server<T>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly open: (hostname: string, port: number) => Promise<Server<T>>,
    private readonly wanted: () => Promise<string[]>,
    public port: number,
  ) {}

  /** Opens the first wanted address, loopback or the --host address. Unlike the others it must work, so this throws. */
  async start() {
    const [first] = await this.wanted();
    if (!first) throw new Error("No address to listen on.");
    const server = await this.open(first, this.port);
    this.port = server.port ?? this.port;
    this.servers.set(first, server);
    await this.apply();
  }

  hosts() {
    return [...this.servers.keys()];
  }

  /** One at a time, so a switch flipped during a scheduled run cannot open the same address twice. */
  apply(): Promise<void> {
    const run = this.queue.catch(() => {}).then(() => this.sync());
    this.queue = run;
    return run;
  }

  private async sync() {
    const wanted = new Set(await this.wanted());
    for (const [host, server] of this.servers) {
      if (wanted.has(host)) continue;
      this.servers.delete(host);
      // Stops taking connections now. A second later it also ends the ones still open, since turning the local network
      // off should cut off devices on it; the wait lets the request that turned it off get its answer.
      void server.stop();
      setTimeout(() => void server.stop(true), 1_000);
    }
    for (const host of wanted) {
      if (this.servers.has(host)) continue;
      try {
        this.servers.set(host, await this.open(host, this.port));
      } catch {
        // The address went away or another app holds the port there. The next run tries again.
      }
    }
  }

  async stop() {
    await this.queue.catch(() => {});
    await Promise.all([...this.servers.values()].map((server) => server.stop(true)));
    this.servers.clear();
  }
}
