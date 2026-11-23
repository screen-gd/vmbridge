import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { translate } from "../src/gateway/paths.ts";
import { githubName, normalizeRemote } from "../src/gateway/repos.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Traffic } from "../src/traffic.ts";
import { machineName, Settings } from "../src/settings.ts";
import type { Wire } from "../src/gateway/types.ts";
import type { VmLoad } from "../src/placement.ts";
import { Store, type ProjectRow, type VmRow } from "../src/store.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

/** No resource readings: placement goes by thread counts and size labels alone. */
const unmeasured = { get: () => null, lastDisk: () => null };

const project: ProjectRow = {
  id: "p1",
  url: "https://github.com/acme/app.git",
  branch: null,
  title: "app",
  createdAt: 0,
  vms: [{ vmId: "vm1", checkoutPath: "/workspace/app" }],
};

/** The same project with a second VM, whose checkout sits at another path. */
const spread: ProjectRow = { ...project, vms: [...project.vms, { vmId: "vm2", checkoutPath: "/workspace/app-2" }] };

describe("path translation", () => {
  test("maps checkouts and other VM paths both ways, and leaves IDs alone", () => {
    const vm = { cwd: "/workspace/app/src", worktreePath: "/workspace/.t3/wt/1", threadId: "/workspace/app", nested: [{ path: "/workspace/app" }] };
    const client = translate(vm, "vm1", "out", [project]);
    expect(client).toEqual({
      cwd: "/projects/p1/app/src",
      worktreePath: "/vms/vm1/workspace/.t3/wt/1",
      threadId: "/workspace/app",
      nested: [{ path: "/projects/p1/app" }],
    });
    expect(translate(client, "vm1", "in", [project])).toEqual(vm);
  });

  test("does not rewrite a project's paths for a different VM", () => {
    expect(translate({ cwd: "/projects/p1/app" }, "vm2", "in", [project])).toEqual({ cwd: "/projects/p1/app" });
  });

  test("a project on two VMs maps its one client root to each VM's own checkout", () => {
    expect(translate({ cwd: "/projects/p1/app/src" }, "vm1", "in", [spread])).toEqual({ cwd: "/workspace/app/src" });
    expect(translate({ cwd: "/projects/p1/app/src" }, "vm2", "in", [spread])).toEqual({ cwd: "/workspace/app-2/src" });
    expect(translate({ cwd: "/workspace/app-2/src", worktreePath: "/workspace/.t3/wt/1" }, "vm2", "out", [spread])).toEqual({
      cwd: "/projects/p1/app/src",
      worktreePath: "/vms/vm2/workspace/.t3/wt/1",
    });
  });
});

describe("routing a project on two VMs", () => {
  function setup() {
    const store = new Store(openDatabase(":memory:"), testEncryption);
    for (const id of ["vm1", "vm2", "vm3"]) store.insertVm({ id, provider: "boxd", name: id, size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    store.setCheckout("p1", "vm1", "/workspace/app");
    store.addProjectVm("p1", "vm2");
    store.setCheckout("p1", "vm2", "/workspace/app");
    store.setThreadVm("t1", "vm1");
    store.setThreadVm("t2", "vm2");
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, unmeasured);
    return { store, hub };
  }

  test("a thread's requests stay on its VM, and the project root alone goes to the primary", () => {
    const { hub } = setup();
    expect(hub.route({ threadId: "t2", cwd: "/projects/p1/app" })).toBe("vm2");
    expect(hub.route({ threadId: "t1", projectId: "p1" })).toBe("vm1");
    expect(hub.route({ cwd: "/vms/vm2/workspace/.t3/wt/1" })).toBe("vm2");
    expect(hub.route({ cwd: "/projects/p1/app" })).toBe("vm1");
    expect(hub.into({ threadId: "t2", cwd: "/projects/p1/app/src" }, "vm2")).toEqual({ threadId: "t2", cwd: "/workspace/app/src" });
  });

  test("a request pairing the project with a VM that does not hold it is refused", () => {
    const { hub } = setup();
    expect(() => hub.route({ projectId: "p1", cwd: "/vms/vm3/workspace" })).toThrow("This project has no checkout on that VM.");
  });

  test("a running thread stays on its VM, whatever new threads do", async () => {
    const { hub, store } = setup();
    const prepared = await hub.prepare("orchestration.dispatchCommand", { type: "message.dispatch", commandId: "c9", threadId: "t2", message: "Go on" }, true);
    expect(prepared.vmId).toBe("vm2");
    expect(store.threadVm("t2")).toBe("vm2");
  });

  test("a thread placed on a busy VM shows why in its setup, and counts toward that VM until T3 lists it", async () => {
    const { store, hub } = setup();
    const seen: number[] = [];
    const placeThread = async (_projectId: string, options: { load: (vm: VmRow) => VmLoad; placed: (vmId: string) => void }) => {
      seen.push(options.load(store.vm("vm1")!).turns);
      options.placed("vm1");
      return { vmId: "vm1", notice: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." };
    };
    Object.assign(hub.fleet, { placeThread });
    const first = await hub.prepare("orchestration.launchThread", { commandId: "l1", projectId: "p1" }, true);
    await hub.prepare("orchestration.launchThread", { commandId: "l2", projectId: "p1" }, true);
    expect(seen).toEqual([0, 1]);

    const threadId = first.payload.threadId as string;
    hub.reportSetup(threadId, "Preparing the workspace");
    const stage = (hub.setupSnapshot(threadId)?.stages as Wire[])[0];
    expect(stage).toMatchObject({ status: "warning", detail: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." });
    const native = { stages: [{ id: "checkout", detail: null }, { id: "agent", detail: null }] };
    expect(hub.withBusyNotice(threadId, native).stages).toEqual([
      { id: "checkout", detail: null },
      { id: "agent", detail: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." },
    ]);
    // T3's own detail, such as why the agent failed to start, is not hidden by the notice.
    const failed = { stages: [{ id: "agent", status: "failed", detail: "Agent exited" }] };
    expect(hub.withBusyNotice(threadId, failed).stages).toEqual([{ id: "agent", status: "failed", detail: "Agent exited" }]);
  });

  test("after VM Bridge restarts, a VM still reconnecting counts the turns its saved shell had", async () => {
    const { store } = setup();
    const working = (id: string) => ({ id, projectId: "p1", activeRunId: `run-${id}` });
    store.saveSnapshot("vm1", "shell", { threads: [working("t1"), working("t3"), { id: "t4", projectId: "p1" }] });
    store.saveSnapshot("vm2", "shell", { threads: [working("t2")] });
    store.updateVm("vm2", { state: "sleeping" });
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, unmeasured);
    const seen: Record<string, number> = {};
    const placeThread = async (_projectId: string, options: { load: (vm: VmRow) => VmLoad; placed: (vmId: string) => void }) => {
      for (const vmId of ["vm1", "vm2"]) seen[vmId] = options.load(store.vm(vmId)!).turns;
      options.placed("vm2");
      return { vmId: "vm2", notice: null };
    };
    Object.assign(fleet, { placeThread });
    await hub.prepare("orchestration.launchThread", { commandId: "l1", projectId: "p1" }, true);
    // A sleeping VM runs nothing, whatever it was doing when it went to sleep.
    expect(seen).toEqual({ vm1: 2, vm2: 0 });
  });

  test("the provider losing one VM takes only that VM from the project", () => {
    const { store } = setup();
    store.removeVmFromProjects("vm1");
    expect(store.project("p1")?.vms).toEqual([{ vmId: "vm2", checkoutPath: "/workspace/app" }]);
    store.deleteVm("vm2");
    expect(store.project("p1")?.vms).toEqual([]);
  });
});

describe("remotes", () => {
  test("accepts GitHub shorthands and plain HTTPS", () => {
    expect(githubName("git@github.com:acme/app.git")).toBe("acme/app");
    expect(normalizeRemote("acme/app")).toBe("https://github.com/acme/app.git");
    expect(normalizeRemote("https://gitlab.com/acme/app.git")).toBe("https://gitlab.com/acme/app.git");
  });

  test("rejects anything that could smuggle options or credentials into git", () => {
    for (const bad of ["http://example.com/a/b", "https://user:pass@example.com/a/b", "ext::sh -c id", "https://example.com/a b", "--upload-pack=x"]) {
      expect(() => normalizeRemote(bad)).toThrow();
    }
  });
});

describe("machine name", () => {
  test("defaults to VM Bridge, trims, resets when blank and refuses long names", () => {
    expect(new Settings(openDatabase(":memory:")).get("machineName")).toBe("VM Bridge");
    expect(machineName("  Cloud ")).toBe("Cloud");
    expect(machineName("   ")).toBe("VM Bridge");
    expect(machineName("x".repeat(40))).toBe("x".repeat(40));
    expect(machineName("x".repeat(41))).toBeNull();
  });

  test("is the label T3 gets, and reaches clients already watching the config", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"), testEncryption);
    const settings = new Settings(store.db);
    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
    store.saveSnapshot("vm1", "config", { environment: { orchestrationProtocolVersion: 2 }, providers: [] });
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined }) as unknown as Fleet;
    const hub = new Hub(store, settings, fleet, traffic, unmeasured);
    expect(hub.descriptor().label).toBe("VM Bridge");

    const sent: { values?: { config: { environment: { label: string } } }[] }[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame), open: () => true };
    await new Rpc(hub, {} as never, {} as never, traffic, () => false).handle(client, { _tag: "Request", id: 1, tag: "subscribeServerConfig", payload: {} });
    settings.set("machineName", "Cloud");
    hub.emit("config");
    expect(hub.descriptor().label).toBe("Cloud");
    expect(sent.at(-1)?.values?.[0]?.config.environment.label).toBe("Cloud");
  });
});

describe("rpc", () => {
  test("answers with the request ID's own type, as T3 clients match replies by value", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const rpc = new Rpc({} as never, {} as never, {} as never, traffic, () => false);
    const sent: unknown[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame), open: () => true };
    await rpc.handle(client, { _tag: "Request", id: 0, tag: "server.probe", payload: {} });
    await rpc.handle(client, { _tag: "Request", id: "1", tag: "server.probe", payload: {} });
    expect(sent.map((frame) => (frame as { requestId: unknown }).requestId)).toEqual([0, "1"]);
  });

  test("a config stream that cannot start leaves no listener, and one that fails later ends without failing the emitter", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"), testEncryption);
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, any: async () => "vm1" }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
    const sent: { _tag?: string; exit?: { _tag: string } }[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame), open: () => true };

    // No VM has reported a config yet, and no provider is set up to start one.
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "subscribeServerConfig", payload: {} });
    expect(sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(hub.listenerCount("config")).toBe(0);
    expect(client.cancels.size).toBe(0);

    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
    store.saveSnapshot("vm1", "config", { environment: { orchestrationProtocolVersion: 2 }, providers: [] });
    const restarted = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const live = new Rpc(restarted, {} as never, {} as never, traffic, () => false);
    await live.handle(client, { _tag: "Request", id: 2, tag: "subscribeServerConfig", payload: {} });
    expect(sent.at(-1)?._tag).toBe("Chunk");
    expect(restarted.listenerCount("config")).toBe(1);

    // A push that fails ends the stream without failing whoever emitted the event.
    restarted.config = () => {
      throw new Error("Gone.");
    };
    expect(() => restarted.emit("config")).not.toThrow();
    expect(sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(restarted.listenerCount("config")).toBe(0);
    expect(client.cancels.size).toBe(0);
  });

  test("removing the last VM while a client watches the config, as with a queued turn on it, starts no VM", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"), testEncryption);
    const settings = new Settings(store.db);
    settings.set("defaultProvider", "boxd");
    let started = 0;
    const fleet = Object.assign(new EventEmitter(), {
      backend: () => undefined,
      any: async () => {
        started++;
        return "vm9";
      },
    }) as unknown as Fleet;
    const busy = { environment: { orchestrationProtocolVersion: 2 }, providers: [{ instanceId: "codex", driver: "codex", enabled: true, models: [{ slug: "gpt" }] }] };
    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "busy", createdAt: 0 });
    store.saveSnapshot("vm1", "config", busy);
    const hub = new Hub(store, settings, fleet, traffic, unmeasured);
    const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
    const sent: { _tag?: string; exit?: { _tag: string } }[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame), open: () => true };
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "subscribeServerConfig", payload: {} });

    store.deleteVm("vm1");
    fleet.emit("offline", "vm1");
    expect(started).toBe(0);
    expect(sent.at(-1)?._tag).toBe("Chunk");
    // T3 keeps its agents and models, so a new message can still start a thread.
    expect(hub.agents().find((agent) => agent.instanceId === "codex")?.models).toHaveLength(1);

    // Still so after VM Bridge restarts.
    const restarted = new Hub(store, settings, fleet, traffic, unmeasured);
    await new Rpc(restarted, {} as never, {} as never, traffic, () => false).handle(client, { _tag: "Request", id: 2, tag: "server.getConfig", payload: {} });
    expect(started).toBe(0);
    expect(sent.at(-1)?.exit?._tag).toBe("Success");

    // The next VM to connect replaces it.
    store.insertVm({ id: "vm2", provider: "boxd", name: "vm2", size: "medium", state: "starting", createdAt: 0 });
    const fresh = { environment: { orchestrationProtocolVersion: 2, serverVersion: "2.0.0" }, providers: [] };
    const backend = { call: async () => fresh, request: () => () => {} };
    await fleet.onConnect("vm2", backend as never);
    expect(restarted.descriptor().serverVersion).toBe("2.0.0");
    expect(settings.get("fallbackConfig")).toBeNull();
  });

  test("two retries of one launch racing through placement launch the same thread", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"), testEncryption);
    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    const placeThread = async (_projectId: string, options: { placed: (vmId: string) => void }) => {
      await Bun.sleep(1);
      store.addProjectVm("p1", "vm1");
      store.setCheckout("p1", "vm1", "/workspace/app");
      options.placed("vm1");
      return { vmId: "vm1", notice: null };
    };
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, placeThread }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const launch = { commandId: "c1", projectId: "p1", message: "Fix the login page" };
    const [a, b] = await Promise.all([hub.prepare("orchestration.launchThread", launch, true), hub.prepare("orchestration.launchThread", launch, true)]);
    expect(a.payload.threadId).toBeString();
    expect(b.payload.threadId).toBe(a.payload.threadId);
  });

  test("a project's branch list adds the branches only its other VMs have, and a launch from one goes to a VM that has it", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"), testEncryption);
    for (const id of ["vm1", "vm2"]) store.insertVm({ id, provider: "boxd", name: id, size: "medium", state: "ready", createdAt: 0 });
    store.updateVm("vm2", { state: "sleeping" });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    store.setCheckout("p1", "vm1", "/workspace/app");
    store.addProjectVm("p1", "vm2");
    store.setCheckout("p1", "vm2", "/workspace/app");
    // vm2 is asleep: its branches come from what was read there before it slept, and from the threads it last reported.
    store.saveSnapshot("vm2", "shell", { threads: [{ id: "t2", projectId: "p1", branch: "t3code/fix-login" }, { id: "t3", projectId: "p1", branch: "main" }] });
    store.setBranches("p1", "vm2", ["main", "hand-made"]);
    const main = { name: "main", current: true, isDefault: true, worktreePath: null };
    const primary = {
      call: async () => ({ refs: [main] }),
      request: (_tag: string, _payload: unknown, handler: (frame: Wire) => void) => {
        queueMicrotask(() =>
          handler({ _tag: "Exit", exit: { _tag: "Success", value: { refs: [main], isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 1 } } }),
        );
        return () => {};
      },
    };
    const only: (ReadonlySet<string> | undefined)[] = [];
    const placeThread = async (_projectId: string, options: { only?: ReadonlySet<string>; placed: (vmId: string) => void }) => {
      only.push(options.only);
      options.placed("vm1");
      return { vmId: "vm1", notice: null };
    };
    let primaryAwake = true;
    const backend = (vmId: string) => (vmId === "vm1" && primaryAwake ? primary : undefined);
    const fleet = Object.assign(new EventEmitter(), { backend, placeThread }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    // With the primary asleep too, its part of the list comes from the remote.
    const remote = { refs: async () => ({ refs: [main], isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 1 }) };
    const rpc = new Rpc(hub, {} as never, remote as never, traffic, () => false);
    const sent: Wire[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "vcs.listRefs", payload: { cwd: "/projects/p1/app" } });
    expect((sent.at(-1)?.exit as Wire).value).toMatchObject({
      refs: [main, ...["hand-made", "t3code/fix-login"].map((name) => ({ name, current: false, isDefault: false, worktreePath: null }))],
      totalCount: 3,
    });
    primaryAwake = false;
    await rpc.handle(client, { _tag: "Request", id: 2, tag: "vcs.listRefs", payload: { cwd: "/projects/p1/app" } });
    expect((sent.at(-1)?.exit as Wire).value).toMatchObject({
      refs: [main, ...["hand-made", "t3code/fix-login"].map((name) => ({ name, current: false, isDefault: false, worktreePath: null }))],
      totalCount: 3,
    });
    primaryAwake = true;

    const launch = (baseRef: string) => ({ commandId: crypto.randomUUID(), projectId: "p1", workspaceStrategy: { type: "worktree", baseRef } });
    await hub.prepare("orchestration.launchThread", launch("t3code/fix-login"), true);
    await hub.prepare("orchestration.launchThread", launch("hand-made"), true);
    await hub.prepare("orchestration.launchThread", launch("main"), true);
    expect(only).toEqual([new Set(["vm2"]), new Set(["vm2"]), undefined]);
  });

  // With or without a thread ID from the client: without one, each retry mints its own.
  for (const threadId of [undefined, "t-explicit"]) {
    test(`a retry that placement sent to another VM follows the VM and thread that won, and gives back its own reservation (${threadId ? "client" : "minted"} thread ID)`, async () => {
      const traffic = { record: () => {} } as unknown as Traffic;
      const store = new Store(openDatabase(":memory:"), testEncryption);
      for (const id of ["vm1", "vm2"]) store.insertVm({ id, provider: "boxd", name: id, size: "medium", state: "ready", createdAt: 0 });
      store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
      store.addProjectVm("p1", "vm1");
      store.setCheckout("p1", "vm1", "/workspace/app");
      store.addProjectVm("p1", "vm2");
      store.setCheckout("p1", "vm2", "/workspace/app-2");
      // The first retry lands on vm1, the second, seeing it, on vm2 with a busy notice.
      let calls = 0;
      const turnsSeen: number[] = [];
      const placeThread = async (_projectId: string, options: { load: (vm: VmRow) => VmLoad; placed: (vmId: string) => void }) => {
        const vmId = calls++ === 0 ? "vm1" : "vm2";
        await Bun.sleep(calls === 1 ? 1 : 5);
        options.placed(vmId);
        return { vmId, notice: vmId === "vm2" ? "busy" : null };
      };
      const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, placeThread }) as unknown as Fleet;
      const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
      const launch = { commandId: "c1", projectId: "p1", message: "Fix the login page", cwd: "/projects/p1/app", ...(threadId ? { threadId } : {}) };
      const [a, b] = await Promise.all([hub.prepare("orchestration.launchThread", launch, true), hub.prepare("orchestration.launchThread", launch, true)]);
      expect([a.vmId, b.vmId]).toEqual(["vm1", "vm1"]);
      expect(b.payload.threadId).toBe(a.payload.threadId);
      if (threadId) expect(a.payload.threadId).toBe(threadId);
      expect(b.payload.cwd).toBe("/workspace/app");
      expect(store.threadVm(a.payload.threadId as string)).toBe("vm1");
      // vm2 no longer counts the losing thread toward its load.
      Object.assign(fleet, {
        placeThread: async (_projectId: string, options: { load: (vm: VmRow) => VmLoad }) => {
          turnsSeen.push(options.load(store.vm("vm1")!).turns, options.load(store.vm("vm2")!).turns);
          return { vmId: "vm1", notice: null };
        },
      });
      await hub.prepare("orchestration.launchThread", { commandId: "c2", projectId: "p1" }, true);
      expect(turnsSeen).toEqual([1, 0]);
    });
  }
});

describe("child threads a VM starts itself", () => {
  const parent = { id: "parent", projectId: "p1", title: "Fix login", status: "running", worktreePath: "/workspace/.t3/wt/1" };
  // As T3's delegate_task names it: the ID holds the MCP command, not the parent.
  const child = {
    id: "thread:delegated-task:command%3Amcp%3Ac1%3Adelegate-task%3Ad1",
    projectId: "p1",
    title: "Run the tests",
    status: "running",
    creationSource: "mcp",
    worktreePath: "/workspace/.t3/wt/1",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent" },
  };

  /** A project on two VMs, primary vm1, with the parent thread running on vm2 as vm2's shell reports it. */
  async function setup() {
    const store = new Store(openDatabase(":memory:"), testEncryption);
    for (const id of ["vm1", "vm2"]) store.insertVm({ id, provider: "boxd", name: id, size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    for (const id of ["vm1", "vm2"]) {
      store.addProjectVm("p1", id);
      store.setCheckout("p1", id, "/workspace/app");
    }
    let shell: (values: unknown[]) => void = () => {};
    const requested: string[] = [];
    const vm2 = {
      call: async () => ({ environment: { orchestrationProtocolVersion: 2, environmentId: "env-vm2" } }),
      request: (tag: string, _payload: unknown, handler: (frame: unknown) => void) => {
        requested.push(tag);
        if (tag === "orchestration.subscribeShell") shell = (values) => handler({ _tag: "Chunk", values });
        return () => {};
      },
    } as unknown as Backend;
    const placeThread = async () => {
      throw new Error("A child thread is never placed.");
    };
    const fleet = Object.assign(new EventEmitter(), { backend: (id: string) => (id === "vm2" ? vm2 : undefined), touch: () => {}, placeThread }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, unmeasured);
    await fleet.onConnect("vm2", vm2);
    shell([{ kind: "snapshot", snapshot: { projects: [], threads: [parent], archivedThreads: [] } }]);
    return { hub, requested, report: (thread: Wire) => shell([{ kind: "thread.updated", thread, location: "active", sequence: 2 }]) };
  }

  test("a child opened before its VM's shell lists it routes to the parent's VM once the shell does", async () => {
    const { hub, report } = await setup();
    expect(() => hub.route({ threadId: child.id })).toThrow("cannot tell which VM");
    const opened = hub.routeSoon({ threadId: child.id });
    const messaged = hub.prepare("orchestration.dispatchCommand", { type: "message.dispatch", commandId: "m1", threadId: child.id, text: "Go on" }, true);
    report(child);
    expect(await opened).toBe("vm2");
    expect((await messaged).vmId).toBe("vm2");
    // From then on it routes at once, and stays on vm2 although the project's primary VM is vm1.
    expect(hub.route({ threadId: child.id, cwd: "/projects/p1/app" })).toBe("vm2");
    hub.close();
  });

  test("a child opened with its project's path waits for the shell instead of taking the project's primary VM", async () => {
    const { hub, report } = await setup();
    const opened = hub.routeSoon({ threadId: child.id, cwd: "/projects/p1/app" });
    report(child);
    expect(await opened).toBe("vm2");
    // A request naming only the project still goes to its primary VM at once.
    expect(await hub.routeSoon({ cwd: "/projects/p1/app" })).toBe("vm1");
    hub.close();
  });

  test("a child's stream cancelled while it waits for routing never opens on the VM", async () => {
    const { hub, report, requested } = await setup();
    const rpc = new Rpc(hub, {} as never, {} as never, { record: () => {} } as unknown as Traffic, () => false);
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: () => {}, open: () => true };
    const subscribing = rpc.handle(client, { _tag: "Request", id: 1, tag: "orchestration.subscribeThread", payload: { threadId: child.id } });
    await rpc.handle(client, { _tag: "Interrupt", requestId: "1" });
    report(child);
    await subscribing;
    expect(requested).not.toContain("orchestration.subscribeThread");
    expect(client.cancels.size).toBe(0);
    hub.close();
  });

  test("the merged shell keeps the child's lineage and IDs, and maps its shared worktree to its VM", async () => {
    const { hub, report } = await setup();
    report(child);
    const rows = hub.shell().threads ?? [];
    expect(rows.find((row) => row.id === child.id)).toEqual({ ...child, worktreePath: "/vms/vm2/workspace/.t3/wt/1" });
    expect(rows.find((row) => row.id === "parent")?.worktreePath).toBe("/vms/vm2/workspace/.t3/wt/1");
    hub.close();
  });

  test("the parent's link to its child names VM Bridge's environment, so T3 opens it, and the VM's going back", async () => {
    const { hub } = await setup();
    const bridge = hub.settings.get("bridgeId");
    const reply = (environment: string) => ({
      type: "assistant_message",
      text: `Child done ([thread](t3-thread://v2/${environment}/${child.id})), also https://app.t3.codes/threads/${environment}/parent`,
    });
    expect(hub.out(reply("env-vm2"), "vm2")).toEqual(reply(bridge));
    expect(hub.into(reply(bridge), "vm2")).toEqual(reply("env-vm2"));
    hub.close();
  });
});
