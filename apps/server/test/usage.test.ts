import { describe, expect, test } from "bun:test";
import { providerIds, vmSizes } from "@vmbridge/contracts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { estimate, eurUsd, machine, pricing } from "../src/pricing.ts";
import { Store } from "../src/store.ts";
import { Usage } from "../src/usage.ts";
import { testEncryption } from "./key.ts";

const minute = 60_000;
const hour = 60 * minute;

function setup() {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const awake = new Set<string>();
  const usage = new Usage(store, () => awake);
  const addVm = (id: string, provider: "boat" | "boxd" | "railway" = "boat") =>
    store.insertVm({ id, provider, name: `vm-${id}`, size: "medium", state: "provisioning", createdAt: 0 });
  // A fleet change: the VM connected, or VM Bridge put it to sleep.
  const wake = (id: string, at: number) => {
    store.updateVm(id, { state: "ready" });
    awake.add(id);
    usage.sync(at);
  };
  const sleep = (id: string, at: number, checkpoint: string | null = null) => {
    awake.delete(id);
    store.updateVm(id, { state: "sleeping", checkpoint });
    usage.sync(at);
  };
  return { db, store, awake, usage, addVm, wake, sleep };
}

describe("VM intervals", () => {
  test("wake and sleep make awake and asleep intervals", () => {
    const { usage, addVm, wake, sleep } = setup();
    addVm("a");
    wake("a", 0);
    sleep("a", 2 * hour);
    wake("a", 3 * hour);
    sleep("a", 4 * hour);
    const intervals = usage.intervals(0, 10 * hour, 5 * hour);
    expect(intervals.map((entry) => [entry.state, entry.startedAt, entry.endedAt])).toEqual([
      ["awake", 0, 2 * hour],
      ["asleep", 2 * hour, 3 * hour],
      ["awake", 3 * hour, 4 * hour],
      // Still asleep: runs to now.
      ["asleep", 4 * hour, 5 * hour],
    ]);
  });

  test("syncing again without a change keeps one interval", () => {
    const { usage, addVm, wake } = setup();
    addVm("a");
    wake("a", 0);
    usage.sync(10 * minute);
    usage.sync(20 * minute, true);
    expect(usage.intervals(0, hour, 30 * minute)).toHaveLength(1);
  });

  test("a VM waking from sleep counts as neither awake nor asleep until it connects", () => {
    const { store, usage, addVm, wake, sleep } = setup();
    addVm("a");
    store.updateVm("a", { sandboxId: "box-a", lastConnectedAt: 0, lastSleptAt: hour });
    sleep("a", hour);
    store.updateVm("a", { state: "starting" });
    usage.sync(2 * hour);
    wake("a", 3 * hour);
    expect(usage.intervals(0, 4 * hour, 4 * hour).map((entry) => [entry.state, entry.startedAt, entry.endedAt])).toEqual([
      ["asleep", hour, 2 * hour],
      ["awake", 3 * hour, 4 * hour],
    ]);
  });

  test("a dropped connection stays awake while VM Bridge reconnects, as the VM still runs", () => {
    const { store, awake, usage, addVm, wake } = setup();
    addVm("a");
    store.updateVm("a", { sandboxId: "box-a", lastConnectedAt: 1 });
    wake("a", 0);
    awake.delete("a");
    store.updateVm("a", { state: "starting" });
    usage.sync(hour);
    // A failed try leaves it in error until the next one.
    store.updateVm("a", { state: "error" });
    usage.sync(2 * hour);
    wake("a", 3 * hour);
    expect(usage.intervals(0, 4 * hour, 4 * hour).map((entry) => [entry.state, entry.startedAt, entry.endedAt])).toEqual([["awake", 0, 4 * hour]]);
  });

  test("deleting a VM ends its interval and keeps its history", () => {
    const { store, usage, addVm, wake } = setup();
    addVm("a");
    wake("a", 0);
    store.deleteVm("a");
    usage.sync(hour);
    const report = usage.report(0, 2 * hour, 2 * hour);
    expect(report.vms).toMatchObject([{ vmId: "a", awakeMs: hour, deleted: true }]);
  });

  test("a crash ends awake intervals at the last heartbeat and keeps asleep ones going", () => {
    const { store, awake, usage, addVm, wake, sleep } = setup();
    addVm("a");
    addVm("b");
    wake("a", 0);
    wake("b", 0);
    sleep("b", minute);
    usage.sync(10 * minute, true);
    // VM Bridge dies at 12 minutes and starts again at 1 hour.
    awake.clear();
    const after = new Usage(store, () => awake);
    after.sync(hour);
    const intervals = after.intervals(0, 2 * hour, 2 * hour);
    expect(intervals.map((entry) => [entry.vmId, entry.state, entry.startedAt, entry.endedAt])).toEqual([
      ["a", "awake", 0, 10 * minute],
      ["b", "awake", 0, minute],
      ["b", "asleep", minute, 2 * hour],
    ]);
  });

  test("a clean stop ends awake intervals at the stop", () => {
    const { store, awake, usage, addVm, wake } = setup();
    addVm("a");
    wake("a", 0);
    usage.close(30 * minute);
    awake.clear();
    new Usage(store, () => awake).sync(hour);
    expect(usage.intervals(0, 2 * hour, 2 * hour).map((entry) => entry.endedAt)).toEqual([30 * minute]);
  });

  test("intervals are clipped to the range", () => {
    const { usage, addVm, wake, sleep } = setup();
    addVm("a");
    wake("a", 0);
    sleep("a", 4 * hour);
    expect(usage.intervals(hour, 2 * hour, 5 * hour).map((entry) => [entry.startedAt, entry.endedAt])).toEqual([[hour, 2 * hour]]);
  });

  test("repositories are credited with their VMs' awake time, including projects added while awake", () => {
    const { store, usage, addVm, wake, sleep } = setup();
    addVm("a");
    wake("a", 0);
    store.insertProject({ id: "p", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p", "a");
    sleep("a", 3 * hour);
    expect(usage.report(0, 4 * hour, 4 * hour).repos).toEqual([{ repo: "acme/app", awakeMs: 3 * hour, vms: 1 }]);
  });
});

describe("snapshots", () => {
  test("base snapshots stay open while replaced ones wait for deletion", () => {
    const { db, store, usage } = setup();
    store.saveBase("boat", "medium", { snapshot: "s1", createdAt: 0 });
    usage.sync(hour);
    store.saveBase("boat", "medium", { snapshot: "s2", createdAt: 2 * hour });
    store.retireSnapshot("boat", "s1");
    usage.sync(2 * hour);
    store.forgetRetired("boat", "s1");
    usage.sync(3 * hour);
    const spans = usage.snapshotSpans(0, 10 * hour, 4 * hour);
    expect(spans.map((span) => [span.snapshot, span.startedAt, span.endedAt])).toEqual([
      ["s1", 0, 3 * hour],
      ["s2", 2 * hour, 4 * hour],
    ]);
    expect(db.one("SELECT COUNT(*) AS count FROM snapshot_usage")).toEqual({ count: 2 });
  });

  test("a sleep checkpoint is kept until the VM wakes", () => {
    const { store, usage, addVm, wake, sleep } = setup();
    addVm("a", "railway");
    wake("a", 0);
    sleep("a", hour, "cp1");
    store.updateVm("a", { checkpoint: null });
    wake("a", 3 * hour);
    const report = usage.report(0, 4 * hour, 4 * hour);
    expect(report.snapshots).toEqual([{ provider: "railway", kind: "checkpoint", count: 1, heldMs: 2 * hour }]);
  });
});

describe("costs", () => {
  test("every size label of every provider is priced", () => {
    for (const provider of providerIds) {
      for (const size of vmSizes) {
        expect(machine(provider, size).vcpu).toBeGreaterThan(0);
        expect(pricing(provider).runningHourly[size]).toBeGreaterThan(0);
      }
    }
  });

  test("hourly prices follow the published rates", () => {
    // boxd medium: 2 vCPU, 8 GiB at €0.039 and €0.012.
    expect(pricing("boxd").runningHourly.medium).toBeCloseTo(2 * 0.039 + 8 * 0.012, 6);
    // Boat prices machines flat.
    expect(pricing("boat").runningHourly.large).toBe(0.072);
    // Daytona medium: 2 vCPU, 4 GiB, and its 8 GiB reserved disk.
    expect(pricing("daytona").runningHourly.medium).toBeCloseTo(2 * 0.0504 + 4 * 0.0162 + 8 * 0.000108, 6);
  });

  test("estimates charge awake and asleep time in US dollars, and flag asleep time without a price", () => {
    expect(estimate("boat", "medium", 10 * hour, 100 * hour)).toEqual({ amount: 0.36, partial: false });
    // boxd publishes euros.
    expect(pricing("boxd").currency).toBe("EUR");
    expect(estimate("boxd", "medium", hour, 2 * hour).amount).toBeCloseTo((2 * 0.039 + 8 * 0.012 + 2 * 8 * 0.012) * eurUsd.rate, 6);
    expect(estimate("railway", "medium", hour, hour).partial).toBe(true);
    expect(estimate("railway", "medium", hour, 0).partial).toBe(false);
  });

  test("the report totals every provider in one US dollar figure", () => {
    const { usage, addVm, wake, sleep } = setup();
    addVm("a", "boat");
    addVm("b", "boxd");
    wake("a", 0);
    wake("b", 0);
    sleep("a", hour);
    sleep("b", hour);
    const report = usage.report(0, hour, hour);
    expect(report.total.amount).toBeCloseTo(0.036 + pricing("boxd").runningHourly.medium * eurUsd.rate, 6);
    expect(report.total.partial).toBe(false);
    expect(report.eurUsd).toEqual(eurUsd);
  });
});
