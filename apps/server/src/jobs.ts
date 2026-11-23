import type { Fleet } from "./fleet.ts";
import type { Hub } from "./gateway/hub.ts";
import type { Traffic } from "./traffic.ts";
import { heartbeatMs, type Usage } from "./usage.ts";
import type { Stats } from "./vm/stats.ts";

/** Work repeated on a schedule. Bun runs each on a timer (bun/jobs.ts); a Durable Object would run them from alarms. */
export interface Job {
  name: string;
  everyMs: number;
  run(): Promise<void>;
}

/** VM Bridge's periodic work. Each run handles its own failures. */
export function bridgeJobs(deps: { hub: Hub; fleet: Fleet; stats: Stats; usage: Usage; traffic: Traffic }): Job[] {
  const { hub, fleet, stats, usage, traffic } = deps;
  return [
    {
      name: "idle sweep",
      everyMs: 15_000,
      run: () =>
        hub.sweep().catch((error) => {
          traffic.record({ kind: "system", operation: "idle sweep", status: "error", reason: error instanceof Error ? error.message : String(error) });
        }),
    },
    { name: "Codex sign-in refresh", everyMs: 60 * 60_000, run: () => fleet.syncCodexAuth().catch(() => {}) },
    // Often enough for the dashboard's high memory warning; opening a VM's details reads it right away.
    { name: "VM stats", everyMs: 30_000, run: () => stats.sampleAll().catch(() => {}) },
    { name: "usage heartbeat", everyMs: heartbeatMs, run: async () => usage.sync(Date.now(), true) },
  ];
}
