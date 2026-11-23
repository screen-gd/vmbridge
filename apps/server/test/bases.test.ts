import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { AgentAuth } from "../src/agent-auth/profiles.ts";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Fleet, SettingUp } from "../src/fleet.ts";
import type { Box, Driver } from "../src/providers/index.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Skills } from "../src/skills.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { baseMaxAgeMs, baseSetupLimitMs, chooseBase } from "../src/vm/bases.ts";
import { setupStamp } from "../src/vm/runtime.ts";
import { testEncryption } from "./key.ts";

const now = 1_000_000_000_000;

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
const stamp = setupStamp("1.0.0");

describe("choosing a base snapshot for a new VM", () => {
  const base = { snapshot: "snap1", stamp, createdAt: now - 60_000, builder: null };

  test("uses a recent snapshot that holds what setup installs now", () => {
    expect(chooseBase(base, stamp, now)).toEqual({ from: "snap1", rebuild: false });
  });

  test("creates the plain way and rebuilds when there is none, it is out of date, or it is a week old", () => {
    const plain = { from: null, rebuild: true };
    expect(chooseBase(null, stamp, now)).toEqual(plain);
    expect(chooseBase({ ...base, snapshot: null }, stamp, now)).toEqual(plain);
    expect(chooseBase(base, setupStamp("1.0.1"), now)).toEqual(plain);
    expect(chooseBase({ ...base, createdAt: now - baseMaxAgeMs }, stamp, now)).toEqual(plain);
  });
});

const fleets: Fleet[] = [];
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.close();
});

/** A VM whose setup and T3 start succeed at once. */
function fakeBox(id: string) {
  const ok = (stdout = "") => ({ ok: true, exitCode: 0, stdout, stderr: "", output: stdout });
  return {
    id,
    run: async (command: string) => (command.includes("well-known") ? ok(JSON.stringify({ orchestrationProtocolVersion: 2 })) : ok("token")),
    files: { write: async () => {}, read: async () => Promise.reject(new Error("No such file.")) },
    process: () => ({ stop: async () => {} }),
  } as unknown as Box;
}

function setup() {
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  settings.set("providers", ["boxd"]);
  settings.set("defaultProvider", "boxd");
  settings.set("t3Version", "1.0.0");
  const store = new Store(db, testEncryption);
  const traffic = { record: () => {} } as unknown as Traffic;
  const agents = { vmSecrets: async () => ({}), adoptCodex: () => {} } as unknown as AgentAuth;
  const events: string[] = [];
  let boxes = 0;
  let snapshots = 0;
  const driver = {
    create: async (_input: unknown, from?: string) => {
      const box = fakeBox(`sb${++boxes}`);
      events.push(from ? `create ${box.id} from ${from}` : `create ${box.id}`);
      return box;
    },
    snapshot: async (box: Box) => {
      const id = `snap${++snapshots}`;
      events.push(`snapshot ${box.id} as ${id}`);
      return id;
    },
    destroy: async (sandboxId: string) => void events.push(`destroy ${sandboxId}`),
    deleteCheckpoint: async (snapshot: string) => void events.push(`delete ${snapshot}`),
  };
  const fleet = new Fleet(store, settings, new Secrets(db, testEncryption), traffic, agents, new Skills(db, testEncryption), openSocket);
  fleet.driver = () => driver as unknown as Driver;
  fleets.push(fleet);
  return { fleet, store, settings, driver, events };
}

describe("base snapshots", () => {
  test("the first VMs start the plain way while one build runs, then new VMs start from its snapshot", async () => {
    const { fleet, store, events } = setup();
    await Promise.all([fleet.create(), fleet.create()]);
    await fleet.bases.settled();
    // One build for both creates: its VM is set up, saved and deleted.
    expect(events.filter((event) => event.startsWith("snapshot"))).toHaveLength(1);
    const builder = /^snapshot (\S+) as snap1$/.exec(events.find((event) => event.startsWith("snapshot"))!)![1];
    expect(events).toContain(`destroy ${builder}`);
    expect(store.base("boxd", "medium")).toMatchObject({ snapshot: "snap1", stamp, builder: null });

    events.length = 0;
    await fleet.create();
    expect(events).toEqual([expect.stringMatching(/^create sb\d+ from snap1$/)]);
  });

  test("the build waits for the new VM, so it cannot take the last VM the provider allows", async () => {
    const { fleet, driver, events } = setup();
    const create = driver.create;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    driver.create = async (input, from) => (events.length ? create(input, from) : (await held, create(input, from)));
    const creating = fleet.create();
    await Bun.sleep(10);
    expect(events).toEqual([]);
    release();
    await creating;
    await fleet.bases.settled();
    expect(events[0]).toBe("create sb1");
    expect(events[1]).toBe("create sb2");
    expect(events[2]).toBe("snapshot sb2 as snap1");
  });

  test("a new t3 version rebuilds, and the old snapshot is deleted once the new one is saved", async () => {
    const { fleet, store, settings, events } = setup();
    store.saveBase("boxd", "medium", { snapshot: "old", stamp, createdAt: Date.now() });
    settings.set("t3Version", "1.0.1");
    await fleet.create();
    await fleet.bases.settled();
    expect(events.at(-1)).toBe("delete old");
    expect(store.base("boxd", "medium")).toMatchObject({ snapshot: "snap1", stamp: setupStamp("1.0.1") });
  });

  test("a replaced snapshot the provider will not delete yet is deleted once the VMs made from it are", async () => {
    const { fleet, store, settings, driver, events } = setup();
    store.saveBase("boxd", "medium", { snapshot: "old", stamp, createdAt: Date.now() });
    const vm = await fleet.create();
    // E2B refuses while a VM made from the snapshot exists.
    let inUse = true;
    driver.deleteCheckpoint = async (snapshot) => {
      if (inUse) throw new Error("Template is in use.");
      events.push(`delete ${snapshot}`);
    };
    settings.set("t3Version", "1.0.1");
    await fleet.create();
    await fleet.bases.settled();
    expect(store.retiredSnapshots("boxd")).toEqual(["old"]);

    inUse = false;
    await fleet.destroy(vm.id);
    await until(() => store.retiredSnapshots("boxd").length === 0);
    expect(events).toContain("delete old");
  });

  test("a snapshot the provider no longer has falls back to a plain create and is replaced", async () => {
    const { fleet, store, driver, events } = setup();
    store.saveBase("boxd", "medium", { snapshot: "gone", stamp, createdAt: Date.now() });
    const create = driver.create;
    const missing = new SandboxError("Snapshot not found.", { code: "not_found" });
    driver.create = async (input, from) => (from === "gone" ? Promise.reject(missing) : create(input, from));
    const vm = await fleet.create();
    expect(events).toContain(`create ${vm.sandboxId}`);
    await fleet.bases.settled();
    expect(events).toContain("delete gone");
    expect(store.base("boxd", "medium")?.snapshot).toBe("snap1");
  });

  test("a full plan or another error creating from a snapshot leaves the snapshot alone", async () => {
    const { fleet, store, driver, events } = setup();
    store.saveBase("boxd", "medium", { snapshot: "snap0", stamp, createdAt: Date.now() });
    const create = driver.create;
    let refusal: Error = new SandboxError("Quota exceeded.", { code: "quota" });
    driver.create = async (input, from) => (from ? Promise.reject(refusal) : create(input, from));
    // Full: a plain create would be refused too, so none is tried.
    await expect(fleet.create()).rejects.toBe(refusal);
    expect(events).toEqual([]);
    refusal = new SandboxError("Bad gateway.", { code: "unavailable" });
    await fleet.create();
    await fleet.bases.settled();
    expect(events).toEqual(["create sb1"]);
    expect(store.base("boxd", "medium")?.snapshot).toBe("snap0");
    expect(store.retiredSnapshots("boxd")).toEqual([]);
  });

  test("a build VM left by a restart is deleted before the next VM is created, so it cannot hold the last VM allowed", async () => {
    const { fleet, store, events } = setup();
    store.saveBase("boxd", "medium", { builder: "stale" });
    await fleet.create();
    await fleet.bases.settled();
    expect(events[0]).toBe("destroy stale");
    expect(events[1]).toBe("create sb1");
    expect(store.base("boxd", "medium")?.builder).toBeNull();
  });

  test("a build VM left on record is deleted on start, even for a removed provider, and a running build's is not", async () => {
    const { fleet, store, driver, events } = setup();
    store.saveBase("e2b", "medium", { builder: "orphan" });
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    driver.snapshot = async () => (await held, "snap1");
    await fleet.create();
    await until(() => store.base("boxd", "medium")?.builder != null);
    await fleet.resume();
    await until(() => events.includes("destroy orphan"));
    expect(store.builders("e2b")).toEqual([]);
    expect(events.filter((event) => event.startsWith("destroy"))).toEqual(["destroy orphan"]);
    release();
    await fleet.bases.settled();
  });

  test("removing a provider keeps a build VM it could not delete on record, so the next start deletes it", async () => {
    const { fleet, store, driver, events } = setup();
    store.saveBase("boxd", "medium", { snapshot: "snap0", stamp, createdAt: Date.now(), builder: "stuck" });
    const destroy = driver.destroy;
    driver.destroy = async () => Promise.reject(new Error("Provider is down."));
    await fleet.bases.drop("boxd");
    expect(store.base("boxd", "medium")).toEqual({ snapshot: null, stamp: null, createdAt: null, builder: "stuck" });
    expect(events).toContain("delete snap0");

    driver.destroy = destroy;
    await fleet.bases.reap();
    expect(events).toContain("destroy stuck");
    expect(store.builders()).toEqual([]);
  });

  test("a provider removed while its first build was being prepared builds nothing", async () => {
    const { fleet, settings, events } = setup();
    const preparing = fleet.prepareBase("boxd");
    settings.set("providers", []);
    await preparing;
    await fleet.bases.settled();
    expect(events).toEqual([]);
  });

  test("a failed build is not retried on every create", async () => {
    const { fleet, store, driver, events } = setup();
    driver.snapshot = async () => Promise.reject(new Error("Snapshots are not enabled."));
    await fleet.create();
    await fleet.bases.settled();
    await fleet.create();
    await fleet.bases.settled();
    // Two VMs, one build VM, and the build VM deleted after the failure.
    expect(events.filter((event) => event.startsWith("create"))).toHaveLength(3);
    expect(events.filter((event) => event.startsWith("destroy"))).toHaveLength(1);
    expect(store.base("boxd", "medium")?.snapshot ?? null).toBeNull();
  });

  test("providers that cannot snapshot create the plain way and build nothing", async () => {
    const { fleet, store, driver, events } = setup();
    delete (driver as Partial<typeof driver>).snapshot;
    fleet.prepareBase("boxd");
    expect(fleet.setup("boxd")).toEqual({ state: "unsupported" });
    await fleet.create();
    await fleet.bases.settled();
    expect(events).toEqual(["create sb1"]);
    expect(store.base("boxd", "medium")).toBeNull();
  });
});

describe("setting up a provider", () => {
  test("no VM is created on a provider while its first snapshot builds, and the first one starts from it", async () => {
    const { fleet, events } = setup();
    fleet.prepareBase("boxd");
    expect(fleet.setup("boxd")).toEqual({ state: "building", startedAt: expect.any(Number) });
    await expect(fleet.create()).rejects.toBeInstanceOf(SettingUp);
    await expect(fleet.create({ provider: "boxd", size: "large" })).rejects.toBeInstanceOf(SettingUp);
    await fleet.bases.settled();
    expect(fleet.setup("boxd")).toEqual({ state: "ready" });
    events.length = 0;
    await fleet.create();
    expect(events).toEqual(["create sb2 from snap1"]);
  });

  test("the provider stays set up only once the build VM is deleted, so a plan with one VM has it free again", async () => {
    const { fleet, driver } = setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const destroy = driver.destroy;
    driver.destroy = async (sandboxId) => (await held, destroy(sandboxId));
    fleet.prepareBase("boxd");
    await Bun.sleep(10);
    expect(fleet.setup("boxd").state).toBe("building");
    await expect(fleet.create()).rejects.toBeInstanceOf(SettingUp);
    release();
    await fleet.bases.settled();
    expect(fleet.setup("boxd").state).toBe("ready");
  });

  test("providers already added with no snapshot build on start and wait for it", async () => {
    const { fleet } = setup();
    await fleet.resume();
    expect(fleet.setup("boxd").state).toBe("building");
    await expect(fleet.create()).rejects.toBeInstanceOf(SettingUp);
    await fleet.bases.settled();
    expect(fleet.setup("boxd").state).toBe("ready");
  });

  test("while the default provider sets up, new VMs go to another added provider that is ready", async () => {
    const { fleet, store, settings } = setup();
    settings.set("providers", ["boxd", "e2b"]);
    store.saveBase("e2b", "medium", { snapshot: "e2b-base", stamp, createdAt: Date.now() });
    fleet.prepareBase("boxd");
    expect((await fleet.create()).provider).toBe("e2b");
    // A repository rule naming it falls back the same way.
    settings.set("repoRules", [{ repo: "acme/app", provider: "boxd", size: null }]);
    expect(fleet.placement("https://github.com/acme/app").provider).toBe("e2b");
    await fleet.bases.settled();
    expect(fleet.placement("https://github.com/acme/app").provider).toBe("boxd");
  });

  test("a failed setup shows why, leaves the provider usable the plain way, and builds again only on retry", async () => {
    const { fleet, store, driver, events } = setup();
    const create = driver.create;
    // A plan whose only VM is taken: the build cannot get one.
    driver.create = async () => Promise.reject(new Error("Machine limit reached.\nUpgrade your plan."));
    fleet.prepareBase("boxd");
    await fleet.bases.settled();
    expect(fleet.setup("boxd")).toEqual({ state: "failed", reason: "Machine limit reached." });

    driver.create = create;
    await fleet.create();
    fleet.prepareBase("boxd");
    await fleet.bases.settled();
    // The VM, and no build after it.
    expect(events).toEqual(["create sb1"]);
    expect(fleet.setup("boxd").state).toBe("failed");

    fleet.prepareBase("boxd", true);
    expect(fleet.setup("boxd").state).toBe("building");
    await fleet.bases.settled();
    expect(fleet.setup("boxd")).toEqual({ state: "ready" });
    expect(store.base("boxd", "medium")?.snapshot).toBe("snap1");
  });

  test("every build logs its start, and its end with the time taken or the reason it failed", async () => {
    const { fleet, driver } = setup();
    const refused = new SandboxError("Boat POST /sandboxes failed (HTTP 401 unauthorized): unauthorized.", { code: "auth" });
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const error = spyOn(console, "error").mockImplementation((line: string) => void logs.push(line));
    try {
      const create = driver.create;
      driver.create = async () => Promise.reject(refused);
      fleet.prepareBase("boxd");
      await fleet.bases.settled();
      // A rotated or revoked key: the reason says what to do, not the HTTP error.
      expect(fleet.setup("boxd")).toEqual({ state: "failed", reason: "boxd refused the API key. Enter a new one in Setup." });
      driver.create = create;
      fleet.prepareBase("boxd", true);
      await fleet.bases.settled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(logs).toEqual([
      "[base boxd:medium] build started",
      expect.stringMatching(/^\[base boxd:medium\] build failed after \d+ s: boxd refused the API key\. Enter a new one in Setup\.$/),
      "[base boxd:medium] build started",
      expect.stringMatching(/^\[base boxd:medium\] ready in \d+ s$/),
    ]);
  });

  test("a build that hangs is given up at the limit: its VM is deleted and Retry builds again at once", async () => {
    const { fleet, store, driver, events } = setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const snapshot = driver.snapshot;
    driver.snapshot = async (box) => (await held, snapshot(box));
    jest.useFakeTimers();
    try {
      fleet.prepareBase("boxd");
      // Fake timers stop `Bun.sleep`, so this waits on the event loop instead.
      for (let i = 0; i < 200 && !store.base("boxd", "medium")?.builder; i++) await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(baseSetupLimitMs);
    } finally {
      jest.useRealTimers();
    }
    const builder = events.find((event) => event.startsWith("create"))!.slice("create ".length);
    expect(fleet.setup("boxd")).toEqual({ state: "failed", reason: "Setup took longer than 15 minutes." });
    await until(() => events.includes(`destroy ${builder}`));
    expect(store.base("boxd", "medium")?.builder).toBeNull();

    driver.snapshot = snapshot;
    fleet.prepareBase("boxd", true);
    expect(fleet.setup("boxd").state).toBe("building");
    await fleet.bases.settled();
    expect(store.base("boxd", "medium")).toMatchObject({ snapshot: "snap1", builder: null });

    // The stuck call returns at last: its snapshot is too late to use and goes with the replaced ones.
    release();
    await until(() => store.retiredSnapshots("boxd").includes("snap2"));
    expect(store.base("boxd", "medium")?.snapshot).toBe("snap1");
    expect(fleet.setup("boxd")).toEqual({ state: "ready" });
  });

  test("removing a provider does not wait for a build that was given up", async () => {
    const { fleet, store, settings, driver } = setup();
    driver.snapshot = () => new Promise<string>(() => {});
    jest.useFakeTimers();
    try {
      fleet.prepareBase("boxd");
      for (let i = 0; i < 200 && !store.base("boxd", "medium")?.builder; i++) await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(baseSetupLimitMs);
    } finally {
      jest.useRealTimers();
    }
    settings.set("providers", []);
    const dropped = await Promise.race([fleet.bases.drop("boxd").then(() => true), Bun.sleep(500).then(() => false)]);
    expect(dropped).toBe(true);
  });
});
