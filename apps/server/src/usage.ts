import type { Database } from "bun:sqlite";
import { providerIds, type Estimate, type ProviderId, type SnapshotUsage, type UsageReport, type VmSize } from "@vmbridge/contracts";
import { githubName } from "./gateway/repos.ts";
import { mayBeAwake } from "./fleet.ts";
import { estimate, eurUsd, pricing } from "./pricing.ts";
import type { Store } from "./store.ts";

/**
 * Awake: VM Bridge is connected to its T3 server, or the VM may still run at its provider, such as while VM Bridge
 * reconnects a dropped connection or after a failed sleep. Asleep: VM Bridge put it to sleep. A VM waking from sleep
 * counts as neither until it connects.
 */
export type VmUsageState = "awake" | "asleep";

/** One stretch of a VM awake or asleep. */
export interface VmInterval {
  vmId: string;
  name: string;
  provider: ProviderId;
  size: VmSize;
  state: VmUsageState;
  /** URLs of the projects the VM held during it. */
  repos: string[];
  startedAt: number;
  endedAt: number;
}

/** How long a base snapshot or sleep checkpoint was kept at its provider. */
export interface SnapshotSpan {
  provider: ProviderId;
  kind: "base" | "checkpoint";
  snapshot: string;
  size: VmSize | null;
  vmId: string | null;
  startedAt: number;
  endedAt: number;
}

/** How often open intervals are saved, which bounds what a crash loses. */
export const heartbeatMs = 60_000;

interface OpenInterval {
  id: number;
  vmId: string;
  state: VmUsageState;
  repos: string;
}

interface OpenSpan {
  id: number;
  provider: ProviderId;
  snapshot: string;
}

const spanKey = (provider: string, snapshot: string) => `${provider}\n${snapshot}`;

/**
 * Records when each VM is awake or asleep and how long snapshots are kept, by comparing the fleet with what is on
 * record. `sync` is idempotent: call it whenever the fleet may have changed. Intervals still open carry the time of the
 * last heartbeat, so after a crash an awake interval ends at the last moment VM Bridge saw it awake. Asleep intervals and
 * snapshots stay open across restarts: the provider keeps them, and bills them, while VM Bridge is down.
 */
export class Usage {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: Store,
    /** IDs of the VMs connected now. */
    private readonly awake: () => Iterable<string>,
  ) {
    this.endAwake();
  }

  private get db(): Database {
    return this.store.db;
  }

  /** Saves open intervals every `heartbeatMs`. */
  start() {
    this.timer ??= setInterval(() => this.sync(Date.now(), true), heartbeatMs);
  }

  /** For VM Bridge stopping: awake intervals end now, since VM Bridge no longer knows. */
  close(now = Date.now()) {
    clearInterval(this.timer);
    this.timer = undefined;
    this.sync(now, true);
    this.endAwake(now);
  }

  private endAwake(now?: number) {
    if (now === undefined) this.db.run("UPDATE vm_usage SET open = 0 WHERE open = 1 AND state = 'awake'");
    else this.db.query("UPDATE vm_usage SET open = 0, ended_at = ? WHERE open = 1 AND state = 'awake'").run(now);
  }

  /** Opens and closes intervals to match the fleet now. `heartbeat` also saves `now` on the ones still open. */
  sync(now = Date.now(), heartbeat = false) {
    const awake = new Set(this.awake());
    const projects = this.store.projects();
    const wanted = new Map<string, { name: string; provider: ProviderId; size: VmSize; state: VmUsageState; repos: string[] }>();
    for (const vm of this.store.vms()) {
      let state: VmUsageState | null = null;
      if (vm.state === "sleeping") state = "asleep";
      else if (awake.has(vm.id) || (vm.state !== "gone" && mayBeAwake(vm))) state = "awake";
      if (!state) continue;
      const repos = projects.filter((project) => project.vms.some((entry) => entry.vmId === vm.id)).map((project) => project.url);
      wanted.set(vm.id, { name: vm.name, provider: vm.provider, size: vm.size, state, repos });
    }

    this.db.transaction(() => {
      const open = this.db
        .query<OpenInterval, []>("SELECT id, vm_id AS vmId, state, repos FROM vm_usage WHERE open = 1")
        .all();
      for (const row of open) {
        const next = wanted.get(row.vmId);
        // A project added during the interval counts for all of it.
        const known: string[] = JSON.parse(row.repos);
        const repos = [...new Set([...known, ...(next?.repos ?? [])])];
        if (repos.length !== known.length) this.db.query("UPDATE vm_usage SET repos = ? WHERE id = ?").run(JSON.stringify(repos), row.id);
        if (next?.state !== row.state) {
          this.db.query("UPDATE vm_usage SET ended_at = ?, open = 0 WHERE id = ?").run(now, row.id);
          continue;
        }
        wanted.delete(row.vmId);
        if (heartbeat) this.db.query("UPDATE vm_usage SET ended_at = ? WHERE id = ?").run(now, row.id);
      }
      for (const [vmId, next] of wanted) {
        this.db
          .query("INSERT INTO vm_usage (vm_id, name, provider, size, state, repos, started_at, ended_at, open) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)")
          .run(vmId, next.name, next.provider, next.size, next.state, JSON.stringify(next.repos), now, now);
      }
      this.syncSnapshots(now, heartbeat);
    })();
  }

  /** Snapshots on record now: base snapshots, replaced ones not deleted yet, and checkpoints of sleeping VMs. */
  private syncSnapshots(now: number, heartbeat: boolean) {
    const live = new Map<string, Omit<SnapshotSpan, "endedAt">>();
    const bases = this.db
      .query<{ provider: ProviderId; size: VmSize; snapshot: string; createdAt: number | null }, []>(
        "SELECT provider, size, snapshot, created_at AS createdAt FROM base_snapshots WHERE snapshot IS NOT NULL",
      )
      .all();
    for (const base of bases) {
      live.set(spanKey(base.provider, base.snapshot), { provider: base.provider, kind: "base", snapshot: base.snapshot, size: base.size, vmId: null, startedAt: Math.min(base.createdAt ?? now, now) });
    }
    const retired = this.db.query<{ provider: ProviderId; snapshot: string }, []>("SELECT provider, snapshot FROM retired_snapshots").all();
    for (const { provider, snapshot } of retired) {
      const key = spanKey(provider, snapshot);
      if (!live.has(key)) live.set(key, { provider, kind: "base", snapshot, size: null, vmId: null, startedAt: now });
    }
    for (const vm of this.store.vms()) {
      if (vm.checkpoint) live.set(spanKey(vm.provider, vm.checkpoint), { provider: vm.provider, kind: "checkpoint", snapshot: vm.checkpoint, size: vm.size, vmId: vm.id, startedAt: now });
    }

    const open = this.db.query<OpenSpan, []>("SELECT id, provider, snapshot FROM snapshot_usage WHERE open = 1").all();
    for (const row of open) {
      const key = spanKey(row.provider, row.snapshot);
      if (live.delete(key)) {
        if (heartbeat) this.db.query("UPDATE snapshot_usage SET ended_at = ? WHERE id = ?").run(now, row.id);
      } else this.db.query("UPDATE snapshot_usage SET ended_at = ?, open = 0 WHERE id = ?").run(now, row.id);
    }
    for (const span of live.values()) {
      this.db
        .query("INSERT INTO snapshot_usage (provider, kind, snapshot, size, vm_id, started_at, ended_at, open) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
        .run(span.provider, span.kind, span.snapshot, span.size, span.vmId, span.startedAt, now);
    }
  }

  /** VM intervals overlapping `from` to `to`, clipped to it. Open ones run to `now`. */
  intervals(from: number, to: number, now = Date.now()): VmInterval[] {
    const rows = this.db
      .query<Omit<VmInterval, "repos"> & { repos: string; open: number }, [number, number]>(
        `SELECT vm_id AS vmId, name, provider, size, state, repos, started_at AS startedAt, ended_at AS endedAt, open
         FROM vm_usage WHERE started_at < ?2 AND (open = 1 OR ended_at > ?1) ORDER BY started_at, id`,
      )
      .all(from, to);
    return rows.flatMap(({ open, repos, ...row }) => {
      const span = clip(row.startedAt, open ? now : row.endedAt, from, to);
      return span ? [{ ...row, ...span, repos: JSON.parse(repos) as string[] }] : [];
    });
  }

  /** Snapshot spans overlapping `from` to `to`, clipped to it. Open ones run to `now`. */
  snapshotSpans(from: number, to: number, now = Date.now()): SnapshotSpan[] {
    const rows = this.db
      .query<SnapshotSpan & { open: number }, [number, number]>(
        `SELECT provider, kind, snapshot, size, vm_id AS vmId, started_at AS startedAt, ended_at AS endedAt, open
         FROM snapshot_usage WHERE started_at < ?2 AND (open = 1 OR ended_at > ?1) ORDER BY started_at, id`,
      )
      .all(from, to);
    return rows.flatMap(({ open, ...row }) => {
      const span = clip(row.startedAt, open ? now : row.endedAt, from, to);
      return span ? [{ ...row, ...span }] : [];
    });
  }

  /** Usage and estimated costs from `from` to `to`, which ends at `now` at the latest. */
  report(from: number, until: number, now = Date.now()): UsageReport {
    const to = Math.min(until, now);
    const intervals = this.intervals(from, to, now);

    const vms = new Map<string, { name: string; provider: ProviderId; size: VmSize; awakeMs: number; asleepMs: number }>();
    const repos = new Map<string, { awakeMs: number; vms: Set<string> }>();
    for (const interval of intervals) {
      const length = interval.endedAt - interval.startedAt;
      const vm = vms.get(interval.vmId) ?? { name: interval.name, provider: interval.provider, size: interval.size, awakeMs: 0, asleepMs: 0 };
      vms.set(interval.vmId, vm);
      if (interval.state === "asleep") {
        vm.asleepMs += length;
        continue;
      }
      vm.awakeMs += length;
      for (const url of interval.repos) {
        const repo = githubName(url) ?? url;
        const entry = repos.get(repo) ?? { awakeMs: 0, vms: new Set() };
        entry.awakeMs += length;
        entry.vms.add(interval.vmId);
        repos.set(repo, entry);
      }
    }

    const vmUsage = [...vms].map(([vmId, vm]) => ({
      vmId,
      ...vm,
      deleted: !this.store.vm(vmId),
      estimate: estimate(vm.provider, vm.size, vm.awakeMs, vm.asleepMs),
    }));
    const providers = providerIds.flatMap((provider) => {
      const own = vmUsage.filter((vm) => vm.provider === provider);
      if (!own.length) return [];
      return [{
        provider,
        awakeMs: sum(own.map((vm) => vm.awakeMs)),
        asleepMs: sum(own.map((vm) => vm.asleepMs)),
        estimate: combine(own.map((vm) => vm.estimate)),
      }];
    });

    const snapshots = new Map<string, SnapshotUsage & { names: Set<string> }>();
    for (const span of this.snapshotSpans(from, to, now)) {
      const key = `${span.provider}:${span.kind}`;
      const entry = snapshots.get(key) ?? { provider: span.provider, kind: span.kind, count: 0, heldMs: 0, names: new Set() };
      entry.names.add(span.snapshot);
      entry.count = entry.names.size;
      entry.heldMs += span.endedAt - span.startedAt;
      snapshots.set(key, entry);
    }

    return {
      from,
      to,
      prices: providerIds.map(pricing),
      providers,
      vms: vmUsage.sort((a, b) => b.awakeMs - a.awakeMs),
      repos: [...repos]
        .map(([repo, entry]) => ({ repo, awakeMs: entry.awakeMs, vms: entry.vms.size }))
        .sort((a, b) => b.awakeMs - a.awakeMs),
      snapshots: [...snapshots.values()].map(({ names, ...entry }) => entry),
      total: combine(providers.map((provider) => provider.estimate)),
      eurUsd,
    };
  }
}

function clip(startedAt: number, endedAt: number, from: number, to: number) {
  const start = Math.max(startedAt, from);
  const end = Math.min(endedAt, to);
  return end > start ? { startedAt: start, endedAt: end } : null;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const combine = (estimates: Estimate[]): Estimate => ({
  amount: sum(estimates.map((entry) => entry.amount)),
  partial: estimates.some((entry) => entry.partial),
});
