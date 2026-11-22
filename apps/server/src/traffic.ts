import type { Database } from "bun:sqlite";
import type { ProviderId, TrafficEvent } from "@vmbridge/contracts";

type Listener = (event: TrafficEvent) => void;

/** How many provider and system failures stay on record across restarts. */
export const keptErrors = 200;
/** How long a failure nothing has put right flags its VM or provider in the dashboard. */
export const problemMs = 24 * 60 * 60_000;

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
 */
export class Traffic {
  private nextId = 1;
  private readonly listeners = new Set<Listener>();
  readonly recent: TrafficEvent[] = [];

  constructor(private readonly db?: Database) {
    if (!db) return;
    const rows = db
      .query<ErrorRow, []>("SELECT at, kind, operation, reason, vm_id AS vmId, provider FROM errors ORDER BY id")
      .all();
    for (const row of rows) {
      this.recent.push({
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

  record(event: Omit<TrafficEvent, "id" | "at">): void {
    const entry: TrafficEvent = { ...event, id: this.nextId++, at: Date.now() };
    // Short enough to show next to a VM or provider.
    if (entry.reason) entry.reason = entry.reason.trim().split("\n")[0]!.slice(0, 300);
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    if (entry.kind === "provider" || entry.kind === "system") this.keep(entry);
    for (const listener of this.listeners) listener(entry);
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
    const rows = this.db
      .query<ErrorRow, [number]>(
        "SELECT at, kind, operation, reason, vm_id AS vmId, provider FROM errors WHERE resolved = 0 AND kind = 'provider' AND at >= ? ORDER BY id",
      )
      .all(now - problemMs);
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
      this.db
        .query("INSERT INTO errors (at, kind, operation, reason, vm_id, provider) VALUES (?, ?, ?, ?, ?, ?)")
        .run(entry.at, entry.kind, entry.operation, entry.reason ?? null, entry.vmId ?? null, entry.provider ?? null);
      this.db.query("DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?").run(keptErrors);
      return;
    }
    // The same operation working again for the same VM, or for the provider as a whole, puts its failures right.
    if (!this.db || entry.status !== "ok" || (!entry.vmId && !entry.provider)) return;
    this.db
      .query(
        "UPDATE errors SET resolved = 1 WHERE resolved = 0 AND operation = ?1 AND (vm_id = ?2 OR (?2 IS NULL AND provider = ?3))",
      )
      .run(entry.operation, entry.vmId ?? null, entry.provider ?? null);
  }
}
