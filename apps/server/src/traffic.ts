import type { Sql } from "./sql.ts";
import type { ProviderId, TrafficEvent } from "@vmbridge/contracts";

type Listener = (event: TrafficEvent) => void;

/** How many provider and system failures stay on record across restarts. */
export const keptErrors = 200;
/** How long a failure nothing has put right flags its VM or provider in the dashboard. */
export const problemMs = 24 * 60 * 60_000;
/** How often requests without a device session show up in the log, as one entry with their count. */
export const refusedWindowMs = 10_000;
const keptRequests = 500;
const keptEvents = 300;
const operationLength = 200;

interface ErrorRow {
  at: number;
  kind: "provider" | "system";
  operation: string;
  reason: string | null;
  vmId: string | null;
  provider: ProviderId | null;
}

/**
 * Request metadata for the dashboard. Never record payloads, tokens, URLs with
 * credentials, or agent output: only operation names, endpoints, and timings.
 *
 * Provider and system failures also go to the console and, with a database, to the `errors` table, so background
 * failures (a VM or snapshot that could not be deleted, a failed sleep) survive a restart and flag their VM or provider.
 *
 * RPC and HTTP requests are kept apart from provider and system events, so a burst of requests cannot push startup,
 * pairing or a failure out of the log.
 */
export class Traffic {
  private nextId = 1;
  private readonly listeners = new Set<Listener>();
  private readonly requests: TrafficEvent[] = [];
  private readonly events: TrafficEvent[] = [];
  private refusedCount = 0;
  private refusedTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly db?: Sql) {
    if (!db) return;
    const rows = db.all<ErrorRow>("SELECT at, kind, operation, reason, vm_id AS vmId, provider FROM errors ORDER BY id");
    for (const row of rows) {
      this.events.push({
        id: this.nextId++,
        at: row.at,
        kind: row.kind,
        operation: row.operation,
        status: "error",
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.vmId ? { vmId: row.vmId } : {}),
        ...(row.provider ? { provider: row.provider } : {}),
      });
    }
  }

  /** Oldest first. */
  get recent(): TrafficEvent[] {
    return [...this.events, ...this.requests].sort((a, b) => a.id - b.id);
  }

  record(event: Omit<TrafficEvent, "id" | "at">): void {
    const entry: TrafficEvent = { ...event, id: this.nextId++, at: Date.now(), operation: event.operation.slice(0, operationLength) };
    // Short enough to show next to a VM or provider.
    if (entry.reason) entry.reason = entry.reason.trim().split("\n")[0]!.slice(0, 300);
    const request = entry.kind === "rpc" || entry.kind === "http";
    const list = request ? this.requests : this.events;
    list.push(entry);
    if (list.length > (request ? keptRequests : keptEvents)) list.shift();
    if (entry.kind === "provider" || entry.kind === "system") this.keep(entry);
    for (const listener of this.listeners) listener(entry);
  }

  /**
   * A request without a device session. Anyone who can reach VM Bridge can send these, so they are only counted and
   * logged, and pushed to the dashboard, as one entry per `refusedWindowMs`.
   */
  refused(): void {
    this.refusedCount++;
    if (this.refusedTimer) return;
    this.refusedTimer = setTimeout(() => {
      const count = this.refusedCount;
      this.refusedCount = 0;
      this.refusedTimer = undefined;
      this.record({ kind: "http", operation: `Refused ${count} ${count === 1 ? "request" : "requests"} without a device session`, status: "error" });
    }, refusedWindowMs);
    this.refusedTimer.unref?.();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The latest failure of each VM and provider in the last `problemMs` that the same operation has not since worked
   * again for. Only provider calls flag anything: they are what can leave a machine running or a snapshot behind.
   * A failed base snapshot build does not: Setup shows it on its own, in plainer words, and a build VM left behind is
   * flagged by its own failed delete.
   */
  problems(now = Date.now()) {
    const vms = new Map<string, string>();
    const providers = new Map<ProviderId, string>();
    if (!this.db) return { vms, providers };
    const rows = this.db.all<ErrorRow>(
      "SELECT at, kind, operation, reason, vm_id AS vmId, provider FROM errors WHERE resolved = 0 AND kind = 'provider' AND at >= ? ORDER BY id",
      now - problemMs,
    );
    for (const row of rows) {
      if (/^build \w+ base snapshot$/.test(row.operation)) continue;
      const text = `${row.operation[0]?.toUpperCase() ?? ""}${row.operation.slice(1)} failed${row.reason ? `: ${row.reason}` : ""}`;
      if (row.vmId) vms.set(row.vmId, text);
      else if (row.provider) providers.set(row.provider, text);
    }
    return { vms, providers };
  }

  private keep(entry: TrafficEvent) {
    if (entry.status === "error") {
      const subject = entry.vmId ? ` (VM ${entry.vmId})` : entry.provider ? ` (${entry.provider})` : "";
      console.error(`[error] ${entry.operation}${entry.reason ? `: ${entry.reason}` : ""}${subject}`);
      if (!this.db) return;
      this.db.run(
        "INSERT INTO errors (at, kind, operation, reason, vm_id, provider) VALUES (?, ?, ?, ?, ?, ?)",
        entry.at, entry.kind, entry.operation, entry.reason ?? null, entry.vmId ?? null, entry.provider ?? null,
      );
      this.db.run("DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?", keptErrors);
      return;
    }
    // The same operation working again for the same VM, or for the provider as a whole, puts its failures right.
    if (!this.db || entry.status !== "ok" || (!entry.vmId && !entry.provider)) return;
    this.db.run(
      "UPDATE errors SET resolved = 1 WHERE resolved = 0 AND operation = ?1 AND (vm_id = ?2 OR (?2 IS NULL AND provider = ?3))",
      entry.operation, entry.vmId ?? null, entry.provider ?? null,
    );
  }
}
