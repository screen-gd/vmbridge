import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { analyticsReport, dayStarts } from "../src/analytics.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import type { Wire } from "../src/gateway/types.ts";
import { eurUsd, pricing } from "../src/pricing.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import { Usage } from "../src/usage.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// Monday 2026-11-02 00:00 UTC.
const monday = Date.UTC(2026, 10, 2);

describe("days", () => {
  test("start at each midnight of the time zone, including half-hour zones and DST changes", () => {
    expect(dayStarts(monday + hour, monday + 2 * day, "UTC")).toEqual([monday, monday + day]);
    expect(dayStarts(monday + hour, monday + 2 * day + 1, "UTC")).toEqual([monday, monday + day, monday + 2 * day]);
    // India is 5:30 ahead: its midnight is 18:30 UTC the day before.
    expect(dayStarts(monday, monday + day, "Asia/Kolkata")).toEqual([monday - 5.5 * hour, monday + 18.5 * hour]);
    // New York leaves DST on 2026-11-01, so that day lasts 25 hours.
    const [first, second, third] = dayStarts(Date.UTC(2026, 9, 31, 12), Date.UTC(2026, 10, 2, 12), "America/New_York");
    expect([first, second, third]).toEqual([Date.UTC(2026, 9, 31, 4), Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5)]);
  });

  test("an unknown time zone is refused", () => {
    expect(() => dayStarts(0, day, "Mars/Olympus")).toThrow(RangeError);
  });
});

function setup() {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const awake = new Set<string>();
  const usage = new Usage(store, () => awake);
  const addVm = (id: string, provider: "boat" | "boxd" = "boat") => {
    store.insertVm({ id, provider, name: `vm-${id}`, size: "medium", state: "provisioning", createdAt: 0 });
    return store.vm(id)!;
  };
  const wake = (id: string, at: number) => {
    store.updateVm(id, { state: "ready" });
    awake.add(id);
    usage.sync(at);
  };
  const sleep = (id: string, at: number) => {
    awake.delete(id);
    store.updateVm(id, { state: "sleeping" });
    usage.sync(at);
  };
  const report = (from: number, to: number) => analyticsReport(store, usage, from, to, "UTC", to);
  return { db, store, usage, addVm, wake, sleep, report };
}

describe("report", () => {
  test("splits awake time and spend at midnight, by provider", () => {
    const { addVm, wake, sleep, report } = setup();
    addVm("a", "boat");
    addVm("b", "boxd");
    // 22:00 Monday to 02:00 Tuesday.
    wake("a", monday + 22 * hour);
    sleep("a", monday + day + 2 * hour);
    wake("b", monday + day);
    sleep("b", monday + day + hour);
    const { days, total } = report(monday, monday + 2 * day);
    expect(days.map((entry) => entry.providers.map((provider) => [provider.provider, provider.awakeMs]))).toEqual([
      [["boat", 2 * hour]],
      [["boat", 2 * hour], ["boxd", hour]],
    ]);
    // The second day's boat VM sleeps for the rest of it, which Boat does not charge.
    expect(days[1]!.providers[0]!.asleepMs).toBe(22 * hour);
    expect(days[0]!.providers[0]!.estimate).toEqual({ amount: 2 * 0.036, partial: false });
    // boxd bills memory while paused: one hour awake, then 23 asleep.
    const boxd = pricing("boxd");
    const boxdDay = (boxd.runningHourly.medium + 23 * boxd.asleepHourly.medium!) * eurUsd.rate;
    expect(days[1]!.providers[1]!.estimate.amount).toBeCloseTo(boxdDay, 6);
    // Matches what the Costs page totals, in US dollars.
    expect(total.amount).toBeCloseTo(4 * 0.036 + boxdDay, 6);
  });

  test("counts lifecycle events by day and provider, with median times", () => {
    const { store, addVm, report } = setup();
    const a = addVm("a", "boat");
    const b = addVm("b", "boxd");
    store.recordVmEvent(a, "create", 4000, monday + hour);
    store.recordVmEvent(a, "start", 20_000, monday + hour);
    store.recordVmEvent(a, "sleep", 500, monday + 2 * hour);
    store.recordVmEvent(a, "wake", 3000, monday + day);
    store.recordVmEvent(a, "wake", 5000, monday + day + hour);
    store.recordVmEvent(a, "wake", 10_000, monday + day + 2 * hour);
    store.recordVmEvent(b, "create", 1000, monday + day);
    store.recordVmEvent(b, "delete", null, monday + day + hour);
    const { days, providers } = report(monday, monday + 2 * day);
    expect(days.map(({ created, deleted, wakes, sleeps }) => [created, deleted, wakes, sleeps])).toEqual([
      [1, 0, 0, 1],
      [1, 1, 3, 0],
    ]);
    expect(providers).toEqual([
      { provider: "boat", created: 1, deleted: 0, wakes: 3, sleeps: 1, createMs: 4000, startMs: 20_000, wakeMs: 5000 },
      { provider: "boxd", created: 1, deleted: 1, wakes: 0, sleeps: 0, createMs: 1000, startMs: null, wakeMs: null },
    ]);
  });

  test("turns count by day, repository and agent, and threads count once", () => {
    const { store, addVm, wake, sleep, report } = setup();
    addVm("a");
    store.insertProject({ id: "p", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p", "a");
    wake("a", monday);
    sleep("a", monday + hour);
    const turn = (threadId: string, runId: string, at: number, agent: string | null, model: string | null, repo: string | null = "https://github.com/acme/app.git") =>
      store.recordTurn({ threadId, runId, at, vmId: "a", provider: "boat", repo, agent, model });
    turn("t1", "r1", monday + minute, "codex", "gpt-5.5");
    turn("t1", "r2", monday + 2 * minute, "codex", "gpt-5.5");
    turn("t2", "r1", monday + day, "claudeAgent", "opus");
    turn("t1", "r3", monday + day + minute, "codex", "gpt-5.5");
    turn("t3", "r1", monday + day + 2 * minute, null, null, null);
    // The same run seen again, as on every shell update.
    turn("t1", "r1", monday + day, "codex", "gpt-5.5");

    const result = report(monday, monday + 2 * day);
    expect(result.days.map(({ threads, turns }) => [threads, turns])).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(result.threads).toBe(3);
    expect(result.repos).toEqual([{ repo: "acme/app", awakeMs: hour, threads: 2, turns: 4 }]);
    expect(result.agents).toEqual([
      { agent: "Codex", model: "gpt-5.5", threads: 1, turns: 3 },
      { agent: "Claude", model: "opus", threads: 1, turns: 1 },
      { agent: "Unknown", model: null, threads: 1, turns: 1 },
    ]);
  });

  test("sizes count VMs and their awake time", () => {
    const { addVm, wake, sleep, report } = setup();
    addVm("a");
    addVm("b");
    wake("a", monday);
    wake("b", monday);
    sleep("a", monday + hour);
    sleep("b", monday + 3 * hour);
    expect(report(monday, monday + day).sizes).toEqual([{ provider: "boat", size: "medium", vms: 2, awakeMs: 4 * hour }]);
  });

  test("errors count by day and by the provider of their VM, even once the VM is deleted", () => {
    const { db, store, addVm, report } = setup();
    const a = addVm("b", "boxd");
    store.recordVmEvent(a, "create", 1, monday);
    store.deleteVm("b");
    const traffic = new Traffic(db);
    const at = (ms: number) => db.run("UPDATE errors SET at = ? WHERE id = (SELECT MAX(id) FROM errors)", ms);
    traffic.record({ kind: "provider", operation: "sleep VM", vmId: "b", status: "error" });
    at(monday + hour);
    traffic.record({ kind: "provider", operation: "create VM", provider: "boat", status: "error" });
    at(monday + day);
    traffic.record({ kind: "system", operation: "VM disconnected", status: "error" });
    at(monday + day + hour);
    expect(report(monday, monday + 2 * day).days.map((entry) => entry.errors)).toEqual([
      [{ provider: "boxd", count: 1 }],
      [{ provider: "boat", count: 1 }, { provider: null, count: 1 }],
    ]);
  });
});

describe("turns from the shell", () => {
  test("each run is recorded once with its repository, agent and model", async () => {
    const store = new Store(openDatabase(":memory:"), testEncryption);
    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    let shell: (values: unknown[]) => void = () => {};
    const backend = {
      call: async () => ({ environment: { orchestrationProtocolVersion: 2 } }),
      request: (tag: string, _payload: unknown, handler: (frame: unknown) => void) => {
        if (tag === "orchestration.subscribeShell") shell = (values) => handler({ _tag: "Chunk", values });
        return () => {};
      },
    } as unknown as Backend;
    const fleet = Object.assign(new EventEmitter(), { backend: () => backend, touch: () => {} }) as unknown as Fleet;
    new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, { get: () => null, lastDisk: () => null });
    await fleet.onConnect("vm1", backend);

    const thread = (runId: string | undefined, updatedAt: string): Wire => ({
      id: "t1",
      projectId: "p1",
      providerInstanceId: "codex",
      modelSelection: { model: "gpt-5.5" },
      latestRunId: runId,
      updatedAt,
      // Message text is never read.
      title: "Fix the login page",
    });
    shell([{ kind: "snapshot", snapshot: { projects: [], threads: [thread(undefined, "2026-11-02T00:00:00Z")], archivedThreads: [] } }]);
    shell([{ kind: "thread.updated", thread: thread("r1", "2026-11-02T01:00:00Z"), location: "active", sequence: 2 }]);
    shell([{ kind: "thread.updated", thread: thread("r1", "2026-11-02T01:05:00Z"), location: "active", sequence: 3 }]);
    shell([{ kind: "thread.updated", thread: thread("r2", "2026-11-02T02:00:00Z"), location: "active", sequence: 4 }]);
    expect(store.turns(0, Date.now())).toEqual([
      { threadId: "t1", runId: "r1", at: Date.UTC(2026, 10, 2, 1), vmId: "vm1", provider: "boxd", repo: "https://github.com/acme/app.git", agent: "codex", model: "gpt-5.5" },
      { threadId: "t1", runId: "r2", at: Date.UTC(2026, 10, 2, 2), vmId: "vm1", provider: "boxd", repo: "https://github.com/acme/app.git", agent: "codex", model: "gpt-5.5" },
    ]);
  });
});
