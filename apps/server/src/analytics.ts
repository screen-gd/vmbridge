import {
  providerIds,
  type AgentActivity,
  type AnalyticsDay,
  type AnalyticsReport,
  type Estimate,
  type ProviderActivity,
  type ProviderDay,
  type ProviderId,
  type RepoActivity,
  type SizeActivity,
  type VmSize,
} from "@vmbridge/contracts";
import { agentName } from "./gateway/agents.ts";
import { githubName } from "./gateway/repos.ts";
import { estimate } from "./pricing.ts";
import type { Store, VmEvent } from "./store.ts";
import type { Usage } from "./usage.ts";

/**
 * The midnight starting each calendar day in `timeZone` that overlaps `from` to `to`.
 * Throws a RangeError for an unknown time zone.
 */
export function dayStarts(from: number, to: number, timeZone: string): number[] {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const parts = (ms: number) => {
    const values = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
    return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
  };
  // How far the zone's wall clock is ahead of UTC at `ms`.
  const offset = (ms: number) => {
    const local = parts(ms);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(ms / 1000) * 1000;
  };
  // Twice, so a day whose offset differs from the guess's (a DST change) still lands on its own midnight.
  const midnight = (year: number, month: number, day: number) => {
    const utc = Date.UTC(year, month - 1, day);
    return utc - offset(utc - offset(utc));
  };

  const first = parts(from);
  const starts: number[] = [];
  for (let day = first.day; ; day++) {
    const start = midnight(first.year, first.month, day);
    if (starts.length && (start >= to || start === starts.at(-1))) break;
    starts.push(start);
  }
  return starts;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const add = (a: Estimate, b: Estimate): Estimate => ({ amount: a.amount + b.amount, partial: a.partial || b.partial });

/**
 * VM time, spend, lifecycle, turns and errors from `from` to `until` (which ends at `now` at the latest), by day in
 * `timeZone` where it helps. Time and spend come from `usage`, so they match the Costs page.
 */
export function analyticsReport(store: Store, usage: Usage, from: number, until: number, timeZone: string, now = Date.now()): AnalyticsReport {
  const to = Math.min(until, now);
  const starts = dayStarts(from, to, timeZone);
  const days = starts.map(
    (start): AnalyticsDay & { threadIds: Set<string>; byProvider: Map<ProviderId, ProviderDay>; errorCounts: Map<ProviderId | null, number> } => ({
      start,
      providers: [],
      created: 0,
      deleted: 0,
      wakes: 0,
      sleeps: 0,
      threads: 0,
      turns: 0,
      errors: [],
      threadIds: new Set(),
      byProvider: new Map(),
      errorCounts: new Map(),
    }),
  );
  const dayIndex = (ms: number) => {
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1]! <= ms) index++;
    return index;
  };

  // VM time, split at midnights.
  const sizes = new Map<string, { provider: ProviderId; size: VmSize; vms: Set<string>; awakeMs: number }>();
  for (const interval of usage.intervals(from, to, now)) {
    const sizeKey = `${interval.provider}:${interval.size}`;
    const size = sizes.get(sizeKey) ?? { provider: interval.provider, size: interval.size, vms: new Set(), awakeMs: 0 };
    sizes.set(sizeKey, size);
    size.vms.add(interval.vmId);
    if (interval.state === "awake") size.awakeMs += interval.endedAt - interval.startedAt;

    for (let index = dayIndex(interval.startedAt); index < days.length; index++) {
      const day = days[index]!;
      const start = Math.max(interval.startedAt, day.start);
      const end = Math.min(interval.endedAt, starts[index + 1] ?? Infinity);
      if (end <= start) break;
      const awakeMs = interval.state === "awake" ? end - start : 0;
      const asleepMs = interval.state === "asleep" ? end - start : 0;
      const part = estimate(interval.provider, interval.size, awakeMs, asleepMs);
      const previous = day.byProvider.get(interval.provider);
      day.byProvider.set(
        interval.provider,
        previous
          ? { provider: interval.provider, awakeMs: previous.awakeMs + awakeMs, asleepMs: previous.asleepMs + asleepMs, estimate: add(previous.estimate, part) }
          : { provider: interval.provider, awakeMs, asleepMs, estimate: part },
      );
    }
  }

  const events = store.vmEvents(from, to);
  for (const event of events) {
    const day = days[dayIndex(event.at)]!;
    if (event.kind === "create") day.created++;
    else if (event.kind === "delete") day.deleted++;
    else if (event.kind === "wake") day.wakes++;
    else if (event.kind === "sleep") day.sleeps++;
  }

  const turns = store.turns(from, to);
  const repoTurns = new Map<string, { threads: Set<string>; turns: number }>();
  const agentTurns = new Map<string, AgentActivity & { threadIds: Set<string> }>();
  for (const turn of turns) {
    const day = days[dayIndex(turn.at)]!;
    day.turns++;
    day.threadIds.add(turn.threadId);
    if (turn.repo) {
      const repo = githubName(turn.repo) ?? turn.repo;
      const entry = repoTurns.get(repo) ?? { threads: new Set(), turns: 0 };
      entry.threads.add(turn.threadId);
      entry.turns++;
      repoTurns.set(repo, entry);
    }
    const agent = turn.agent ? agentName(turn.agent) : "Unknown";
    const agentKey = `${agent}\n${turn.model ?? ""}`;
    const entry = agentTurns.get(agentKey) ?? { agent, model: turn.model, threads: 0, turns: 0, threadIds: new Set() };
    entry.threadIds.add(turn.threadId);
    entry.turns++;
    agentTurns.set(agentKey, entry);
  }

  for (const error of store.errorsIn(from, to)) {
    const counts = days[dayIndex(error.at)]!.errorCounts;
    counts.set(error.provider, (counts.get(error.provider) ?? 0) + 1);
  }

  const costs = usage.report(from, to, now);
  const repos = new Map<string, RepoActivity>(costs.repos.map((repo) => [repo.repo, { repo: repo.repo, awakeMs: repo.awakeMs, threads: 0, turns: 0 }]));
  for (const [repo, entry] of repoTurns) {
    repos.set(repo, { repo, awakeMs: repos.get(repo)?.awakeMs ?? 0, threads: entry.threads.size, turns: entry.turns });
  }

  const providers = providerIds.flatMap((provider): ProviderActivity[] => {
    const own = events.filter((event) => event.provider === provider);
    const used = costs.providers.some((entry) => entry.provider === provider);
    if (!own.length && !used) return [];
    const of = (kind: VmEvent["kind"]) => own.filter((event) => event.kind === kind);
    const timed = (kind: VmEvent["kind"]) => median(of(kind).flatMap((event) => (event.durationMs === null ? [] : [event.durationMs])));
    return [{
      provider,
      created: of("create").length,
      deleted: of("delete").length,
      wakes: of("wake").length,
      sleeps: of("sleep").length,
      createMs: timed("create"),
      startMs: timed("start"),
      wakeMs: timed("wake"),
    }];
  });

  return {
    from,
    to,
    days: days.map(({ threadIds, byProvider, errorCounts, ...day }) => ({
      ...day,
      providers: providerIds.flatMap((provider) => byProvider.get(provider) ?? []),
      threads: threadIds.size,
      errors: [...errorCounts].map(([provider, count]) => ({ provider, count })),
    })),
    providers,
    sizes: [...sizes.values()]
      .map(({ vms, ...size }): SizeActivity => ({ ...size, vms: vms.size }))
      .sort((a, b) => b.awakeMs - a.awakeMs),
    repos: [...repos.values()].sort((a, b) => b.awakeMs - a.awakeMs || b.turns - a.turns),
    agents: [...agentTurns.values()].map(({ threadIds, ...entry }) => ({ ...entry, threads: threadIds.size })).sort((a, b) => b.turns - a.turns),
    snapshots: costs.snapshots,
    threads: new Set(turns.map((turn) => turn.threadId)).size,
    total: costs.total,
  };
}
