import { EventEmitter } from "node:events";
import { SandboxError, type Preview } from "@opencoredev/sandbox-sdk";
import type { ProviderId, VmSize, VmState } from "@vmbridge/contracts";
import { providers, type Box, type Driver } from "./providers/index.ts";
import type { CreateVm } from "./providers/types.ts";
import { envVars, type Settings, type Secrets } from "./settings.ts";
import { busyNotice, choose, maxVmsPerProject, overflowRetryMs, type VmLoad } from "./placement.ts";
import { primaryVm, type ProjectRow, type Store, type VmRow } from "./store.ts";
import type { Traffic } from "./traffic.ts";
import { Backend, TokenRejected } from "./vm/backend.ts";
import type { AgentAuth } from "./agent-auth/profiles.ts";
import { githubName } from "./gateway/repos.ts";
import { hasLiveWork, type Shell } from "./gateway/types.ts";
import type { Skills } from "./skills.ts";
import { Bases } from "./vm/bases.ts";
import { syncSkills } from "./vm/skills.ts";
import { checkoutRoot, credentialsFingerprint, prepareVm, quote, readCodexAuth, resolveT3Version, startT3, t3Port, writeCodexAuth, writeCredentials, type VmCredentials } from "./vm/runtime.ts";

type FleetEvents = {
  /** A VM's T3 server is connected and subscribed. */
  awake: [vmId: string];
  /** A VM went to sleep, disconnected, or was removed. */
  offline: [vmId: string];
  /** Anything the dashboard shows about the fleet changed. */
  changed: [];
};

export class NoProvider extends Error {
  constructor() {
    super("Choose a VM provider in the VM Bridge dashboard first.");
  }
}

/**
 * Logs how long each step of a VM operation took, one line per step, so slow wakes and connects show where the time
 * went. Only step names and durations: never commands or their output.
 */
function stopwatch(operation: string, vmId: string) {
  const started = performance.now();
  let last = started;
  return {
    lap(step: string) {
      const now = performance.now();
      console.log(`[${operation} ${vmId}] ${step}: ${Math.round(now - last)} ms`);
      last = now;
    },
    done() {
      console.log(`[${operation} ${vmId}] total: ${Math.round(performance.now() - started)} ms`);
    },
  };
}

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/** Provider config: the non-secret options plus every secret field, read from the secrets table. */
export function providerValues(settings: Settings, secrets: Secrets, id: ProviderId) {
  const values = { ...settings.get("providerOptions")[id] };
  for (const field of providers[id].fields) {
    if (field.kind !== "secret") continue;
    const value = secrets.get(`provider.${id}.${field.key}`);
    if (value) values[field.key] = value;
  }
  return values;
}

const repoName = (url: string) =>
  new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "repository";

/** Where a new top-level thread went. `notice` is set when that VM had no room for it. */
export interface ThreadPlacement {
  vmId: string;
  notice: string | null;
}

/**
 * Owns every VM: creating, waking, connecting to its T3 server, cloning its project, and sleeping.
 * A VM holds one project, and a busy project gets more VMs (see `placeThread`). Each VM operation runs
 * under that VM's lock, and each project's placement under the project's.
 */
export class Fleet extends EventEmitter<FleetEvents> {
  private readonly backends = new Map<string, Backend>();
  private readonly boxes = new Map<string, Box>();
  private readonly connecting = new Map<string, Promise<Backend>>();
  private readonly placing = new Map<string, Promise<string>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, number>();
  private readonly drivers = new Map<ProviderId, { signature: string; driver: Driver }>();
  /** The first VM started to read T3's configuration, shared by everyone asking at once. */
  private bootstrapping?: Promise<string>;
  /** Fingerprint of the sign-ins and variables VM Bridge last gave out, once it has. */
  private latest?: string;
  /** VMs whose T3 server could not be restarted for these sign-ins, so the idle sweep stops trying. */
  private readonly unrestartable = new Map<string, string>();
  /** When adding a VM to each project last failed. */
  private readonly overflowFailedAt = new Map<string, number>();
  private closed = false;
  readonly bases: Bases;

  /** Runs once a VM's backend is connected, before anyone else can use it. */
  onConnect: (vmId: string, backend: Backend) => Promise<void> = async () => {};

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
    private readonly secrets: Secrets,
    private readonly traffic: Traffic,
    private readonly agents: AgentAuth,
    private readonly skills: Pick<Skills, "state" | "files">,
  ) {
    super();
    this.bases = new Bases(store, (provider) => this.driver(provider), traffic, () => this.labels());
  }

  driver(provider: ProviderId): Driver {
    const values = providerValues(this.settings, this.secrets, provider);
    const signature = JSON.stringify(values);
    const cached = this.drivers.get(provider);
    if (cached?.signature === signature) return cached.driver;
    const driver = providers[provider].open({ values });
    this.drivers.set(provider, { signature, driver });
    return driver;
  }

  backend(vmId: string): Backend | undefined {
    const backend = this.backends.get(vmId);
    return backend?.open ? backend : undefined;
  }

  /** The provider handle of a connected VM. Undefined while it sleeps, so callers cannot wake it. */
  box(vmId: string): Box | undefined {
    return this.backend(vmId) ? this.boxes.get(vmId) : undefined;
  }

  connected(): string[] {
    return [...this.backends.keys()].filter((id) => this.backend(id));
  }

  leased(vmId: string) {
    return (this.leases.get(vmId) ?? 0) > 0;
  }

  /** Holds a VM awake while a request runs. Call the result once to release. */
  lease(vmId: string): () => void {
    this.leases.set(vmId, (this.leases.get(vmId) ?? 0) + 1);
    this.touch(vmId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(vmId, (this.leases.get(vmId) ?? 1) - 1);
    };
  }

  touch(vmId: string, now = Date.now()) {
    this.store.updateVm(vmId, { lastActivityAt: now });
  }

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }

  private setState(vmId: string, state: VmState, error: string | null = null) {
    this.store.updateVm(vmId, { state, error });
    this.emit("changed");
  }

  private labels() {
    return { vmbridge: this.settings.get("bridgeId").slice(0, 12) };
  }

  /** Creates a VM, on the default provider and size unless told otherwise. It is not started or connected yet. */
  async create(choice: { provider?: ProviderId; size?: VmSize; discardOnError?: boolean } = {}): Promise<VmRow> {
    const provider = choice.provider ?? this.settings.get("defaultProvider");
    if (!provider) throw new NoProvider();
    if (!this.settings.get("providers").includes(provider)) throw new Error(`Add ${providers[provider].label} in Setup first.`);
    const driver = this.driver(provider);
    const id = shortId();
    const size = choice.size ?? this.settings.get("vmSize") ?? providers[provider].defaultSize;
    this.store.insertVm({ id, provider, name: `vm-${id.slice(0, 6)}`, size, state: "provisioning", createdAt: Date.now() });
    this.emit("changed");
    // Under the VM's lock, so deleting a VM that is still being created waits and then deletes it at the provider too.
    return this.exclusive(id, async () => {
      const started = performance.now();
      const watch = stopwatch("create", id);
      let box: Box;
      let based: boolean;
      try {
        ({ box, based } = await this.createBox(provider, driver, { key: id, size, labels: this.labels(), ports: [t3Port] }));
        watch.lap(based ? "provider create from base snapshot" : "provider create");
      } catch (error) {
        this.traffic.record({ kind: "provider", operation: "create VM", vmId: id, status: "error" });
        // A refused create leaves nothing at the provider, so a caller with its own error report drops the row.
        if (choice.discardOnError) {
          this.store.deleteVm(id);
          this.emit("changed");
        } else this.setState(id, "error", message(error));
        throw error;
      }
      this.store.updateVm(id, { sandboxId: box.id });
      const vm = this.store.vm(id);
      if (!vm) {
        // The row went away some other way: do not leave a billable VM nobody knows about.
        await driver.destroy(box.id).catch(() => {});
        throw new Error(`VM ${id} was deleted while it was being created.`);
      }
      this.boxes.set(id, box);
      const operation = based ? "create VM from base snapshot" : "create VM";
      this.traffic.record({ kind: "provider", operation, vmId: id, status: "ok", durationMs: Math.round(performance.now() - started) });
      return vm;
    });
  }

  /**
   * Creates a VM at the provider from the current base snapshot, or the plain way when there is none yet. Then starts
   * building a new snapshot when one is due.
   */
  private async createBox(provider: ProviderId, driver: Driver, input: CreateVm): Promise<{ box: Box; based: boolean }> {
    // Without the t3 version there is no telling which snapshot is current. Opening the VM will report the failure.
    await this.bases.reap(provider);
    const version = await resolveT3Version(this.settings.get("t3Version")).catch(() => null);
    if (!version) return { box: await driver.create(input), based: false };
    const choice = this.bases.choose(provider, input.size, version);
    let rebuild = choice.rebuild;
    let created: { box: Box; based: boolean } | undefined;
    if (choice.from) {
      try {
        created = { box: await driver.create(input, choice.from), based: true };
      } catch (error) {
        this.traffic.record({ kind: "provider", operation: `create VM from base snapshot: ${message(error)}`, vmId: input.key, status: "error" });
        this.bases.failed(provider, input.size, choice.from);
        rebuild = true;
      }
    }
    created ??= { box: await driver.create(input), based: false };
    if (rebuild) this.bases.rebuild(provider, input.size, version);
    return created;
  }

  /** Builds the base snapshot for new VMs on a provider just added, at the size they get by default. */
  async prepareBase(provider: ProviderId) {
    const size = this.settings.get("vmSize") ?? providers[provider].defaultSize;
    const version = await resolveT3Version(this.settings.get("t3Version"));
    // Removed while the version resolved. Checked with no await before `rebuild`, so a later `drop` waits for the build.
    if (!this.settings.get("providers").includes(provider)) return;
    if (this.bases.choose(provider, size, version).rebuild) this.bases.rebuild(provider, size, version);
  }

  /** Wakes and connects a VM. Concurrent callers share one attempt. */
  ensure(vmId: string): Promise<Backend> {
    const ready = this.backend(vmId);
    if (ready) return Promise.resolve(ready);
    let flight = this.connecting.get(vmId);
    if (!flight) {
      flight = this.exclusive(vmId, () => this.open(vmId)).finally(() => this.connecting.delete(vmId));
      this.connecting.set(vmId, flight);
    }
    return flight;
  }

  private async open(vmId: string): Promise<Backend> {
    if (this.closed) throw new Error("VM Bridge is stopping.");
    const ready = this.backend(vmId);
    if (ready) return ready;
    const vm = this.store.vm(vmId);
    if (!vm) throw new Error(`VM ${vmId} does not exist.`);
    if (vm.state === "gone") throw new Error("This VM was removed from the provider. Start a new thread to get a new VM.");
    if (!vm.sandboxId) throw new Error(`VM ${vmId} was never created at the provider.`);
    // Asleep (or never started) until now, so nothing runs there that restarting T3, or putting it back to sleep, could interrupt.
    const wasAsleep = (vm.lastSleptAt ?? 0) >= (vm.lastConnectedAt ?? 0);
    this.setState(vmId, "starting");
    const started = performance.now();
    const watch = stopwatch("wake", vmId);
    let box: Box | undefined;
    // Looked up while the VM wakes. Awaited below; until then, a failed lookup must not count as unhandled.
    const version = resolveT3Version(this.settings.get("t3Version"));
    version.catch(() => {});
    try {
      const driver = this.driver(vm.provider);
      box = await driver.wake({
        key: vm.id,
        size: vm.size,
        labels: this.labels(),
        ports: [t3Port],
        sandboxId: vm.sandboxId,
        checkpoint: vm.checkpoint,
      });
      watch.lap("provider wake");
      // Restoring a checkpoint makes a new sandbox. It holds the files now, so the checkpoint can go.
      if (box.id !== vm.sandboxId) {
        this.store.updateVm(vmId, { sandboxId: box.id, checkpoint: null });
        if (vm.checkpoint) {
          await driver.deleteCheckpoint(vm.checkpoint).catch(() => this.traffic.record({ kind: "provider", operation: "delete checkpoint", vmId, status: "error" }));
        }
      }
      this.boxes.set(vmId, box);
      // A T3 server still running from before VM Bridge restarted may be in the middle of a turn: then the idle sweep restarts it later.
      const backend = await this.connect(vm, box, await version, async (preview) => {
        if (wasAsleep || !vm.t3Token) return true;
        const shell = await new Backend(vmId, preview, vm.t3Token).json<Shell>("/api/orchestration/shell").catch(() => null);
        return Boolean(shell && !hasLiveWork(shell));
      }, watch);
      watch.done();
      this.touch(vmId);
      this.traffic.record({ kind: "provider", operation: "wake VM", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      return backend;
    } catch (error) {
      this.traffic.record({ kind: "provider", operation: "wake VM", vmId, status: "error" });
      if (error instanceof SandboxError && error.code === "not_found") this.markGone(vmId);
      else {
        // Woken but unusable: put it back to sleep so it does not run, and bill, outside the idle sweep.
        if (box && wasAsleep) await this.sleepBox(vmId, this.driver(vm.provider), box).catch(() => {});
        this.setState(vmId, "error", message(error));
      }
      throw error;
    }
  }

  /**
   * Installs what the VM needs, gives it the current sign-ins, and connects to its T3 server. A server
   * running from before with older sign-ins is restarted first when `idle` says nothing runs on it.
   */
  private async connect(
    vm: VmRow,
    box: Box,
    version: string,
    idle: (preview: Preview) => Promise<boolean>,
    watch = stopwatch("connect", vm.id),
  ): Promise<Backend> {
    // Codex on this VM may have refreshed its own tokens while VM Bridge could not reach it. Refreshing here with the
    // refresh token that retired would fail, so take the VM's first. Otherwise `prepareVm` keeps the newer file.
    if (this.agents.codexDue()) {
      const codexAuth = await readCodexAuth(box);
      if (codexAuth) this.agents.adoptCodex(codexAuth);
      watch.lap("read Codex sign-in");
    }
    const credentials = await this.credentials();
    const fingerprint = credentialsFingerprint(credentials);
    const [prepared, preview] = await Promise.all([prepareVm(box, version, credentials), box.preview(t3Port)]);
    watch.lap("prepare VM, preview URL");
    if (prepared.codexAuth) {
      this.agents.adoptCodex(prepared.codexAuth);
      // A file VM Bridge did not adopt, such as another account's, is replaced after all.
      const ours = (await this.credentials()).codexAuthJson;
      if (ours && ours !== prepared.codexAuth) await writeCodexAuth(box, ours);
      watch.lap("adopt Codex sign-in");
    }
    // Before T3 starts or VM Bridge sends it anything, so no agent on a woken VM runs with old skills.
    if (await this.syncSkills(vm.id, box, prepared.skillsManifest)) watch.lap("sync skills");
    const restart = vm.t3Credentials !== fingerprint && (await idle(preview));
    let server = await startT3(box, vm.t3Token, restart, prepared.t3);
    watch.lap("start T3, session");
    if (server.descriptor.orchestrationProtocolVersion !== 2) {
      throw new Error(`T3 ${version} speaks orchestration protocol ${server.descriptor.orchestrationProtocolVersion}. VM Bridge supports 2.`);
    }
    if (restart && server.credentials !== fingerprint) this.unrestartable.set(vm.id, fingerprint);
    let backend = new Backend(vm.id, preview, server.token);
    try {
      try {
        await backend.connect();
      } catch (error) {
        if (!(error instanceof TokenRejected)) throw error;
        server = await startT3(box, null);
        backend = new Backend(vm.id, preview, server.token);
        await backend.connect();
      }
      watch.lap("open T3 socket");
      this.store.updateVm(vm.id, { t3Token: server.token, t3Version: version, t3Credentials: server.credentials, lastConnectedAt: Date.now() });
      await this.onConnect(vm.id, backend);
      watch.lap("read T3 config");
    } catch (error) {
      await backend.close();
      throw error;
    }
    const connected = backend;
    connected.onClose = () => this.disconnected(vm.id, connected);
    this.backends.set(vm.id, connected);
    this.setState(vm.id, "ready");
    this.emit("awake", vm.id);
    return connected;
  }

  /** True when an awake VM's T3 server runs with older sign-ins or variables than VM Bridge now gives out. */
  stale(vmId: string) {
    const vm = this.store.vm(vmId);
    return Boolean(vm && this.latest && vm.t3Credentials !== this.latest && this.unrestartable.get(vmId) !== this.latest);
  }

  /** True when a VM, awake or asleep, has yet to start T3 with the current sign-ins and variables. */
  behind(vm: VmRow) {
    return Boolean(this.latest && vm.t3Credentials !== null && vm.t3Credentials !== this.latest);
  }

  /**
   * Restarts T3 on an awake VM whose sign-ins changed since it started, so its agents get the new ones.
   * `idle` runs with the backend still connected and says whether nothing runs there; the restart is also
   * dropped when a request holds the VM. Streams it ends see a VM starting rather than a dropped connection,
   * and requests arriving meanwhile wait for it and use the new connection.
   */
  restart(vmId: string, idle: (backend: Backend) => Promise<boolean>) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      const backend = this.backend(vmId);
      const box = this.boxes.get(vmId);
      if (!vm || !backend || !box || vm.t3Credentials === credentialsFingerprint(await this.credentials())) return;
      if (!(await idle(backend))) return;
      // Nothing may wait between this check and taking the backend away, or new work could start on a closing socket.
      if (this.leased(vmId)) return;
      const started = performance.now();
      this.backends.delete(vmId);
      this.setState(vmId, "starting");
      await backend.close();
      try {
        await this.connect(vm, box, vm.t3Version ?? (await resolveT3Version(this.settings.get("t3Version"))), async () => true);
        this.traffic.record({ kind: "system", operation: "restart T3 for new sign-ins or variables", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        this.setState(vmId, "error", message(error));
        this.traffic.record({ kind: "system", operation: "restart T3 for new sign-ins or variables", vmId, status: "error" });
        this.emit("offline", vmId);
        throw error;
      }
    });
  }

  /** Writes the current sign-ins to every awake VM now. Git uses them at once; agents once T3 restarts. */
  async shareCredentials() {
    const awake = this.connected().flatMap((vmId) => {
      const box = this.boxes.get(vmId);
      return box ? [{ vmId, box }] : [];
    });
    // A VM's Codex may have refreshed its tokens since VM Bridge last saw them. Keep the newest before overwriting.
    for (const { box } of awake) {
      const current = await readCodexAuth(box);
      if (current) this.agents.adoptCodex(current);
    }
    const credentials = await this.credentials();
    await Promise.all(
      awake.map(({ vmId, box }) =>
        this.exclusive(vmId, async () => {
          if (this.backend(vmId)) await writeCredentials(box, credentials);
        }).catch(() => this.traffic.record({ kind: "provider", operation: "write sign-ins", vmId, status: "error" })),
      ),
    );
  }

  /**
   * Brings a VM's skills and instructions up to date. A VM that never had any, and still should not, is left alone.
   * `manifest` is the VM's skills manifest when the caller read it already. Returns whether anything changed on the VM.
   */
  private async syncSkills(vmId: string, box: Box, manifest?: string | null) {
    const state = this.skills.state();
    if (!state.skills.length && !state.instructions.length && !this.store.vm(vmId)?.skills) return false;
    const started = performance.now();
    let changed: boolean;
    try {
      changed = await syncSkills(box, state, (name) => this.skills.files(name), manifest);
      if (changed) this.traffic.record({ kind: "provider", operation: "sync skills", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      this.traffic.record({ kind: "provider", operation: "sync skills", vmId, status: "error" });
      throw error;
    }
    this.store.updateVm(vmId, { skills: state.fingerprint });
    return changed;
  }

  /**
   * Gives every awake VM the installed skills now, busy or not: they are only files, so nothing restarts and running
   * turns go on. Sleeping VMs get them when they wake, and VMs still waking get them before they connect.
   */
  async shareSkills() {
    await Promise.all(
      [...this.boxes.keys()].map((vmId) =>
        this.exclusive(vmId, async () => {
          const box = this.boxes.get(vmId);
          if (!box || !this.backend(vmId) || this.store.vm(vmId)?.skills === this.skills.state().fingerprint) return;
          await this.syncSkills(vmId, box);
        }).catch(() => {}),
      ),
    );
    this.emit("changed");
  }

  private async sleepBox(vmId: string, driver: Driver, box: Box) {
    this.boxes.delete(vmId);
    const { checkpoint } = await driver.sleep(box);
    this.store.updateVm(vmId, { checkpoint: checkpoint ?? null, lastSleptAt: Date.now() });
  }

  private disconnected(vmId: string, backend: Backend) {
    if (this.backends.get(vmId) !== backend) return;
    this.backends.delete(vmId);
    if (this.store.vm(vmId)?.state === "ready") this.setState(vmId, "error", "The T3 connection dropped. The next request reconnects.");
    this.traffic.record({ kind: "system", operation: "VM disconnected", vmId, status: "error" });
    this.emit("offline", vmId);
  }

  private markGone(vmId: string) {
    this.store.updateVm(vmId, { state: "gone", error: "The provider no longer has this VM." });
    this.store.removeVmFromProjects(vmId);
    this.emit("offline", vmId);
    this.emit("changed");
  }

  /**
   * Puts a VM to sleep. With `idle`, this is an idle sleep: `idle` runs with the backend still
   * connected and says whether the VM is still idle, and the sleep is also dropped when a request
   * holds the VM meanwhile. Once a sleep goes ahead, new requests wait for it and wake the VM again.
   */
  sleep(vmId: string, idle?: (backend: Backend) => Promise<boolean>) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      const backend = this.backends.get(vmId);
      // A checkpoint means the sandbox is already gone, such as after a failed wake put the VM back to sleep.
      if (!vm?.sandboxId || vm.checkpoint || vm.state === "sleeping" || vm.state === "gone") return;
      const started = performance.now();
      const driver = this.driver(vm.provider);
      const box = this.boxes.get(vmId) ?? (await driver.connect(vm.sandboxId));
      if (idle && backend?.open && !(await idle(backend))) return;
      // Nothing may wait between this check and taking the backend away, or new work could start on a closing socket.
      if (idle && this.leased(vmId)) return;
      this.backends.delete(vmId);
      // Before the socket closes, so streams it ends see a VM going to sleep rather than a dropped connection.
      this.setState(vmId, "sleeping");
      await backend?.close();
      this.emit("offline", vmId);
      try {
        await this.sleepBox(vmId, driver, box);
        this.emit("changed");
        this.traffic.record({ kind: "provider", operation: "sleep VM", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        this.setState(vmId, "error", message(error));
        this.traffic.record({ kind: "provider", operation: "sleep VM", vmId, status: "error" });
        throw error;
      }
    });
  }

  /** Extends provider-side auto-stop timers while agents work. */
  async keepAlive(vmId: string) {
    const vm = this.store.vm(vmId);
    const box = this.boxes.get(vmId);
    if (vm && box) await this.driver(vm.provider).keepAlive(box);
  }

  /** Deletes the VM at the provider. Its projects keep their other VMs, or get a new one next time. */
  destroy(vmId: string) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      if (!vm) return;
      this.backends.get(vmId)?.close();
      this.backends.delete(vmId);
      this.boxes.delete(vmId);
      if (vm.sandboxId && vm.state !== "gone") await this.driver(vm.provider).destroy(vm.sandboxId);
      // A VM asleep as a checkpoint has no sandbox left, only the checkpoint.
      if (vm.checkpoint) await this.driver(vm.provider).deleteCheckpoint(vm.checkpoint);
      this.store.deleteVm(vmId);
      this.traffic.record({ kind: "provider", operation: "delete VM", vmId, status: "ok" });
      // A replaced base snapshot this VM was made from may only now be deletable.
      void this.bases.sweep(vm.provider).catch(() => {});
      this.emit("offline", vmId);
      this.emit("changed");
    });
  }

  /** Provider and size for a new VM holding this repository: its rule, else the defaults. */
  placement(url: string): { provider: ProviderId; size: VmSize } {
    const name = githubName(url)?.toLowerCase();
    const rule = name ? this.settings.get("repoRules").find((entry) => entry.repo.toLowerCase() === name) : undefined;
    // A rule naming a provider that was removed since falls back to the default.
    const provider = rule?.provider && this.settings.get("providers").includes(rule.provider) ? rule.provider : this.settings.get("defaultProvider");
    if (!provider) throw new NoProvider();
    return { provider, size: rule?.size ?? this.settings.get("vmSize") ?? providers[provider].defaultSize };
  }

  /** A VM to read T3's configuration from when none is cached: any existing VM, or a new one. Concurrent callers share one. */
  any(): Promise<string> {
    const added = this.settings.get("providers");
    const vms = this.store.vms().filter((vm) => added.includes(vm.provider) && vm.state !== "gone" && vm.sandboxId);
    const awake = vms.find((vm) => this.backend(vm.id));
    if (awake) return Promise.resolve(awake.id);
    this.bootstrapping ??= (async () => {
      const vmId = vms[0]?.id ?? (await this.create()).id;
      await this.ensure(vmId);
      return vmId;
    })().finally(() => (this.bootstrapping = undefined));
    return this.bootstrapping;
  }

  /**
   * The project's primary VM, creating, cloning and registering it as needed.
   * A VM without a project (such as the first one, started to read T3's configuration) is reused.
   */
  place(projectId: string, progress: (detail: string) => void = () => {}): Promise<string> {
    let flight = this.placing.get(projectId);
    if (!flight) {
      flight = this.exclusive(`project:${projectId}`, () => this.placePrimary(projectId, progress)).finally(() =>
        this.placing.delete(projectId),
      );
      this.placing.set(projectId, flight);
    }
    return flight;
  }

  /**
   * The VM a new top-level thread of this project runs on (see `choose`): one of the project's VMs with
   * room, waking it if it sleeps, else a new VM like the primary, else the least loaded one with a notice.
   * Threads already running never move. `placed` runs before the next placement for this project starts,
   * so it can count the thread toward that VM's load before T3 reports it.
   */
  placeThread(
    projectId: string,
    options: {
      /** Only these VMs, as when the thread starts from a branch only they have, unless none of them can take it. */
      only?: ReadonlySet<string>;
      load: (vm: VmRow) => VmLoad;
      placed: (vmId: string) => void;
      progress: (detail: string) => void;
    },
  ): Promise<ThreadPlacement> {
    const { only, load, placed, progress } = options;
    return this.exclusive(`project:${projectId}`, async () => {
      const primary = await this.placePrimary(projectId, progress);
      // VMs that failed to wake or set up during this placement.
      const failed = new Set<string>();
      for (;;) {
        const project = this.project(projectId);
        const vms = project.vms.flatMap(({ vmId }) => {
          const vm = this.store.vm(vmId);
          return vm && vm.state !== "gone" && !failed.has(vmId) ? [vm] : [];
        });
        const holders = only ? vms.filter((vm) => only.has(vm.id)) : [];
        const loads = (holders.length ? holders : vms).map(load);
        const retryAt = (this.overflowFailedAt.get(projectId) ?? -Infinity) + overflowRetryMs;
        // A new VM would not have the branch either.
        const choice = choose(loads, !holders.length && project.vms.length < maxVmsPerProject && Date.now() >= retryAt);
        if (!choice) throw new Error("None of this project's VMs could start, and VM Bridge could not add one.");
        if (choice.kind === "create") {
          const like = this.store.vm(primary);
          const target = like ? { provider: like.provider, size: like.size } : this.placement(project.url);
          let vmId: string | undefined;
          try {
            vmId = await this.addVm(project, progress, { ...target, discardOnError: true });
            await this.setUp(vmId, projectId, progress);
            this.overflowFailedAt.delete(projectId);
            placed(vmId);
            return { vmId, notice: null };
          } catch (error) {
            this.overflowFailedAt.set(projectId, Date.now());
            if (vmId) failed.add(vmId);
            this.traffic.record({ kind: "system", operation: `add a VM for ${project.title}: ${message(error)}`, vmId, status: "error" });
            continue;
          }
        }
        const { vmId } = choice.load;
        if (!choice.load.awake || !project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath) {
          try {
            await this.setUp(vmId, projectId, progress);
          } catch (error) {
            // Nothing to fall back to from the primary: fail the launch as before.
            if (vmId === primary) throw error;
            failed.add(vmId);
            continue;
          }
        }
        placed(vmId);
        return { vmId, notice: choice.room ? null : busyNotice(choice.load) };
      }
    });
  }

  private project(projectId: string): ProjectRow {
    const project = this.store.project(projectId);
    if (!project) throw new Error("Unknown project.");
    return project;
  }

  private async placePrimary(projectId: string, progress: (detail: string) => void): Promise<string> {
    const project = this.project(projectId);
    const primary = primaryVm(project);
    if (primary?.checkoutPath) return primary.vmId;
    const vmId = primary?.vmId ?? (await this.addVm(project, progress, this.placement(project.url)));
    await this.setUp(vmId, projectId, progress);
    return vmId;
  }

  /** Gives a project another VM: an idle one holding no project if one matches, else a new one. */
  private async addVm(
    project: ProjectRow,
    progress: (detail: string) => void,
    target: { provider: ProviderId; size: VmSize; discardOnError?: boolean },
  ): Promise<string> {
    const taken = new Set(this.store.projects().flatMap((p) => p.vms.map((entry) => entry.vmId)));
    const free = this.store
      .vms()
      .find((vm) => vm.provider === target.provider && vm.size === target.size && !taken.has(vm.id) && vm.state !== "gone" && vm.state !== "error" && vm.sandboxId);
    progress(free ? "Using an idle VM" : `Creating a VM on ${providers[target.provider].label}`);
    const vmId = free?.id ?? (await this.create(target)).id;
    this.store.addProjectVm(project.id, vmId);
    this.emit("changed");
    return vmId;
  }

  /** Wakes one of a project's VMs and makes sure it holds the checkout and T3 knows the project. */
  private async setUp(vmId: string, projectId: string, progress: (detail: string) => void) {
    const project = this.project(projectId);
    const awake = Boolean(this.backend(vmId));
    if (!awake) progress(this.store.vm(vmId)?.state === "sleeping" ? "Waking a VM" : "Starting the VM");
    const backend = await this.ensure(vmId);
    if (project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath) return;
    const release = this.lease(vmId);
    try {
      progress("Cloning the repository");
      const checkoutPath = await this.clone(vmId, project);
      progress("Registering the project with T3");
      await this.register(backend, project, checkoutPath);
      this.store.setCheckout(projectId, vmId, checkoutPath);
      this.emit("changed");
    } finally {
      release();
    }
  }

  private async clone(vmId: string, project: ProjectRow): Promise<string> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} is not connected.`);
    const path = `${checkoutRoot}/${repoName(project.url)}`;
    const branch = project.branch ? `--branch ${quote(project.branch)} ` : "";
    const result = await box.run(
      `set -eu
. /workspace/.vmbridge/env
if [ -d ${quote(`${path}/.git`)} ]; then
  [ "$(git -C ${quote(path)} remote get-url origin)" = ${quote(project.url)} ] || { echo "${path} holds another repository" >&2; exit 3; }
else
  rm -rf ${quote(`${path}.cloning`)}
  GIT_TERMINAL_PROMPT=0 git clone ${branch}-- ${quote(project.url)} ${quote(`${path}.cloning`)}
  mv ${quote(`${path}.cloning`)} ${quote(path)}
fi`,
      { timeoutMs: 10 * 60_000 },
    );
    if (!result.ok) {
      const output = result.stderr.slice(-400);
      if (/not found|could not read|authentication|403|404/i.test(output)) {
        throw new Error("The VM could not read this repository. Check GitHub access in the VM Bridge dashboard.");
      }
      throw new Error(`Cloning failed: ${output}`);
    }
    return path;
  }

  private async register(backend: Backend, project: ProjectRow, checkoutPath: string) {
    const { projects } = await backend.json<{ projects: { id: string; workspaceRoot: string }[] }>("/api/projects");
    if (projects.some((p) => p.id === project.id)) return;
    const response = await backend.http("/api/projects/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId: project.id,
        title: project.title,
        workspaceRoot: checkoutPath,
      }),
    });
    if (!response.ok) throw new Error(`T3 refused to register the project (${response.status}).`);
  }

  /** Reconnects VMs that were awake when VM Bridge stopped. */
  async resume() {
    // So the dashboard can tell sleeping VMs behind on sign-ins or variables before any VM wakes.
    void this.credentials().catch(() => {});
    void this.bases.reap().catch(() => {});
    for (const vm of this.store.vms()) {
      if (!["ready", "busy", "starting"].includes(vm.state)) continue;
      void this.ensure(vm.id).catch(() => {});
    }
  }

  private async credentials(): Promise<VmCredentials> {
    const token = this.secrets.get("github.token");
    const account = this.settings.get("github");
    const github = token && account ? { token, login: account.login, name: account.name ?? account.login, email: account.email } : undefined;
    const env = envVars(this.secrets);
    const credentials: VmCredentials = { ...(await this.agents.vmSecrets()), github, ...(Object.keys(env).length ? { env } : {}) };
    const fingerprint = credentialsFingerprint(credentials);
    if (fingerprint !== this.latest) {
      this.latest = fingerprint;
      this.emit("changed");
    }
    return credentials;
  }

  /**
   * Refreshes the Codex sign-in when it is due and gives the new tokens to every awake VM, before
   * Codex there refreshes on its own and retires the refresh token the other VMs hold.
   */
  async syncCodexAuth() {
    if (!this.agents.codexDue()) return;
    const boxes = [...this.boxes.values()];
    for (const box of boxes) {
      const current = await readCodexAuth(box);
      if (current) this.agents.adoptCodex(current);
    }
    const authJson = await this.agents.refreshCodex(true);
    if (!authJson) return;
    await Promise.all(boxes.map((box) => writeCodexAuth(box, authJson).catch(() => {})));
  }

  close() {
    this.closed = true;
    for (const backend of this.backends.values()) backend.close();
    this.backends.clear();
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
