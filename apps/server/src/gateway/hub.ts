import { EventEmitter, once } from "node:events";
import { providers } from "../providers/index.ts";
import { message, type Fleet } from "../fleet.ts";
import { labelVcpus, type VmLoad } from "../placement.ts";
import type { Settings } from "../settings.ts";
import { primaryVm, type ProjectRow, type Store, type VmRow } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import { T3Rejected, type Backend, type Frame } from "../vm/backend.ts";
import type { Stats } from "../vm/stats.ts";
import { defaultAgents, pendingAgent, presentAgent, type AgentReport } from "./agents.ts";
import { applyHeldCommand } from "./held.ts";
import { isPathKey, projectForPath, projectRoot, translate, vmForPath, type Environments } from "./paths.ts";
import { repositoryIdentity } from "./repos.ts";
import {
  hasLiveWork,
  isWorking,
  str,
  threadsOf,
  type Projection,
  type ProviderEntry,
  type Row,
  type ScheduledTasks,
  type ServerConfig,
  type Shell,
  type ShellItem,
  type Wire,
} from "./types.ts";

type HubEvents = {
  shell: [];
  config: [];
  scheduledTasks: [];
  clones: [];
  /** Worktree setup progress changed for a thread. */
  setup: [threadId: string];
  /** A "waking the VM" notice started or ended for a thread. */
  wake: [threadId: string];
  /** A project's placement progressed (VM creation, clone). */
  placement: [projectId: string, detail: string];
  awake: [vmId: string];
  offline: [vmId: string];
};

export const bridgeScopes = [
  "orchestration:read",
  "orchestration:operate",
  "filesystem:read",
  "filesystem:write",
  "source-control:write",
  "access:read",
  "providers:manage",
];

export const bridgeAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "vmbridge_t3_session",
};

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** How long a thread just placed on a VM counts toward its load before T3 lists it. */
const launchGraceMs = 2 * 60_000;

/** How long a request naming a thread no VM has reported yet waits for one to report it. */
const unseenThreadWaitMs = 5_000;

/** The local branch a launch starts its worktree from. One taken from origin is on every VM. */
function launchBranch(strategy: unknown): string | undefined {
  const value = (strategy ?? {}) as Wire;
  if (value.type === "worktree" && !value.startFromOrigin) return str(value.baseRef);
  if (value.type === "root") return str(value.branch);
  return undefined;
}

/**
 * Everything T3 clients see: one merged shell, one config, and routing from each request to the
 * VM that owns it. Caches what every VM last reported so sleeping VMs keep their threads visible.
 */
export class Hub extends EventEmitter<HubEvents> {
  private readonly shells: Map<string, Shell>;
  private readonly configs: Map<string, ServerConfig>;
  private readonly schedules: Map<string, ScheduledTasks>;
  private readonly setupProgress = new Map<string, Wire>();
  /** Threads placed on a VM without room, with the notice their setup shows. */
  private readonly busyNotices = new Map<string, string>();
  /** Top-level threads placed on a VM, by thread ID, counted toward its load until T3 lists them. */
  private readonly launches = new Map<string, { vmId: string; at: number }>();
  private readonly waking = new Map<string, { count: number; id: string; startedAt: string; message: string }>();
  private readonly projectionRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  /** Fleet-wide agent updates T3 started, by agent instance. */
  private readonly agentUpdates = new Map<string, Wire>();
  /** VMs an agent update woke, so they go back to sleep after it, even when updates overlap. */
  private readonly wokenForUpdate = new Set<string>();
  private sequence: number;

  constructor(
    readonly store: Store,
    readonly settings: Settings,
    readonly fleet: Fleet,
    readonly traffic: Traffic,
    private readonly stats: Pick<Stats, "get" | "lastDisk">,
  ) {
    super();
    this.setMaxListeners(0);
    this.shells = store.snapshots<Shell>("shell");
    this.configs = store.snapshots<ServerConfig>("config");
    const fallback = settings.get("fallbackConfig");
    if (fallback && !this.configs.size) this.configs.set(fallback.vmId, fallback.config);
    this.schedules = store.snapshots<ScheduledTasks>("scheduled_tasks");
    this.sequence = settings.get("shellSequence");
    fleet.onConnect = (vmId, backend) => this.attach(vmId, backend);
    fleet.on("awake", (vmId) => {
      this.emit("awake", vmId);
      void this.replayHeld(vmId);
    });
    fleet.on("offline", (vmId) => {
      if (!store.vm(vmId)) this.forget(vmId);
      this.emit("offline", vmId);
      this.emit("config");
    });
  }

  projects(): readonly ProjectRow[] {
    return this.store.projects();
  }

  out(value: unknown, vmId: string) {
    return translate(value, vmId, "out", this.projects(), this.environments(vmId));
  }

  into<T>(value: T, vmId: string): T {
    return translate(value, vmId, "in", this.projects(), this.environments(vmId)) as T;
  }

  /** The VM's own environment ID, from its last config, and VM Bridge's, which clients know. */
  private environments(vmId: string): Environments | undefined {
    const vm = str(this.configs.get(vmId)?.environment?.environmentId);
    return vm ? { vm, client: this.settings.get("bridgeId") } : undefined;
  }

  private bump() {
    this.sequence++;
    this.settings.set("shellSequence", this.sequence);
  }

  /** Called by the fleet when a VM's T3 server connects: read its config and follow its streams. */
  private async attach(vmId: string, backend: Backend) {
    const config = await backend.call<ServerConfig>("server.getConfig", {});
    if (config.environment?.orchestrationProtocolVersion !== 2) throw new Error("The VM's T3 server changed protocol.");
    const fallback = this.settings.get("fallbackConfig");
    if (fallback) {
      this.configs.delete(fallback.vmId);
      this.settings.set("fallbackConfig", null);
    }
    this.configs.set(vmId, config);
    this.store.saveSnapshot(vmId, "config", config);

    backend.request(
      "subscribeServerConfig",
      { providerCatalogsOnDemand: false, providerCatalogDigests: false, providerStatusDeltas: false },
      (frame) => {
        for (const event of chunks(frame)) {
          const current = this.configs.get(vmId);
          if (event.type === "snapshot") this.configs.set(vmId, event.config as ServerConfig);
          else if (event.type === "providerStatuses" && current) {
            current.providers = (event.payload as { providers: ProviderEntry[] }).providers;
          }
          const latest = this.configs.get(vmId);
          if (latest) this.store.saveSnapshot(vmId, "config", latest);
        }
        this.emit("config");
      },
    );
    backend.request("orchestration.subscribeShell", { requestCompletionMarker: true }, (frame) => {
      for (const item of chunks(frame)) this.applyShell(vmId, item as ShellItem);
    });
    backend.request("scheduledTasks.subscribe", {}, (frame) => {
      for (const snapshot of chunks(frame)) {
        if (!Array.isArray(snapshot.tasks)) continue;
        this.schedules.set(vmId, snapshot as ScheduledTasks);
        this.store.saveSnapshot(vmId, "scheduled_tasks", snapshot);
      }
      this.emit("scheduledTasks");
    });
    // A VM may have slept through agent releases. T3 checks for them when its agents refresh
    // and reports the result on the config stream above.
    void backend.call("server.refreshProviders", { omitProviders: true }, 5 * 60_000).catch(() => {});
    this.emit("config");
  }

  private applyShell(vmId: string, item: ShellItem) {
    // T3 follows its snapshot with one that only fills in repositories: its threads are always empty.
    const enrichment = item.kind === "snapshot" && Array.isArray(item.resolvedRepositoryIdentityRoots);
    if (item.kind === "snapshot" && item.snapshot && !enrichment) this.shells.set(vmId, item.snapshot);
    else {
      const shell = this.shells.get(vmId);
      if (!shell) return;
      const without = (rows: Row[] | undefined, id: string | undefined) => (rows ?? []).filter((row) => row.id !== id);
      if (enrichment) {
        const enriched = new Map((item.snapshot?.projects ?? []).map((project) => [project.id, project]));
        shell.projects = (shell.projects ?? []).map((project) => {
          const candidate = enriched.get(project.id);
          return candidate && candidate.workspaceRoot === project.workspaceRoot ? { ...project, repositoryIdentity: candidate.repositoryIdentity } : project;
        });
      } else if (item.kind === "project.updated" && item.project) shell.projects = [...without(shell.projects, item.project.id), item.project];
      else if (item.kind === "project.removed") shell.projects = without(shell.projects, item.projectId);
      else if (item.kind === "thread.updated" && item.thread) {
        shell.threads = without(shell.threads, item.thread.id);
        shell.archivedThreads = without(shell.archivedThreads, item.thread.id);
        const field = item.location === "archive" ? "archivedThreads" : "threads";
        shell[field] = [...(shell[field] ?? []), item.thread];
      } else if (item.kind === "thread.removed") {
        const field = item.location === "archive" ? "archivedThreads" : "threads";
        shell[field] = without(shell[field], item.threadId);
      } else return;
      if (typeof item.sequence === "number") shell.snapshotSequence = item.sequence;
    }
    const shell = this.shells.get(vmId)!;
    // Commands VM Bridge applied while the VM was away stay visible until the VM has replayed them.
    for (const held of this.store.heldCommands(vmId)) applyHeldCommand(shell, held.payload, new Date(held.createdAt).toISOString());
    for (const thread of threadsOf(shell)) this.store.setThreadVm(thread.id, vmId);
    this.store.saveSnapshot(vmId, "shell", shell);
    if (item.kind === "thread.updated" && item.thread) this.refreshProjectionSoon(vmId, item.thread.id);
    if (item.kind === "snapshot" && !enrichment) void this.cacheMissingProjections(vmId);
    const working = hasLiveWork(shell);
    if (working) this.fleet.touch(vmId);
    // Shown as soon as the VM reports it, rather than on the next idle sweep.
    this.setBusy(vmId, working);
    this.bump();
    this.emit("shell");
  }

  /**
   * A removed VM's rows are gone from the store; drop what is still cached in memory too. The last VM's config
   * stays until another VM connects: T3 clients need one, and without it VM Bridge would start a VM to read one.
   */
  private forget(vmId: string) {
    this.shells.delete(vmId);
    const config = this.configs.get(vmId);
    if (config && this.configs.size === 1) this.settings.set("fallbackConfig", { vmId, config });
    else this.configs.delete(vmId);
    this.schedules.delete(vmId);
    this.bump();
    this.emit("shell");
    this.emit("scheduledTasks");
  }

  /**
   * Applies a sidebar-only thread command (see `heldCommandTypes`) without its VM, when the VM is
   * not connected. It is saved and replayed on the VM when it next connects. Returns the shell
   * sequence to answer with, or null when the VM is connected and should apply it itself.
   */
  holdCommand(payload: Wire): number | null {
    const threadId = str(payload.threadId);
    const vmId = threadId ? this.store.threadVm(threadId) : null;
    const vm = vmId ? this.store.vm(vmId) : null;
    // No VM holds this thread any more (removed, or lost by the provider), so there is nothing left to change.
    if (!vm || vm.state === "gone") return this.sequence;
    if (this.fleet.backend(vm.id)) return null;
    const shell = this.shells.get(vm.id);
    const commandId = str(payload.commandId) ?? crypto.randomUUID();
    const now = Date.now();
    this.store.holdCommand(commandId, vm.id, this.into({ ...payload }, vm.id), now);
    if (shell) {
      applyHeldCommand(shell, payload, new Date(now).toISOString());
      this.store.saveSnapshot(vm.id, "shell", shell);
    }
    this.bump();
    this.emit("shell");
    return this.sequence;
  }

  /**
   * Sends held commands to a VM that just connected. A command the VM rejects is dropped: its state wins.
   * One that did not get an answer (the socket dropped, a timeout) stays, with those after it, for the next connect.
   */
  private async replayHeld(vmId: string) {
    for (const held of this.store.heldCommands(vmId)) {
      const backend = this.fleet.backend(vmId);
      if (!backend) return;
      const outcome = await backend.call("orchestration.dispatchCommand", held.payload).then(
        () => "ok" as const,
        (error) => (error instanceof T3Rejected ? ("rejected" as const) : ("unanswered" as const)),
      );
      this.traffic.record({ kind: "system", operation: `replay ${String(held.payload.type)}`, vmId, status: outcome === "ok" ? "ok" : "error" });
      if (outcome === "unanswered") return;
      this.store.dropHeldCommand(held.id);
    }
  }

  /** The merged shell: every registered project, then each VM's threads. */
  shell(): Shell {
    const projects: Row[] = this.projects().map((project) => this.catalogProject(project));
    const threads: Row[] = [];
    const archivedThreads: Row[] = [];
    for (const [vmId, shell] of this.shells) {
      if (this.store.vm(vmId)?.state === "gone") continue;
      for (const project of (this.out(shell.projects ?? [], vmId) as Row[])) {
        const index = projects.findIndex((existing) => existing.id === project.id);
        if (index < 0) projects.push(project);
        else {
          const registered = projects[index]!;
          projects[index] = {
            ...registered,
            ...project,
            workspaceRoot: registered.workspaceRoot,
            repositoryIdentity: { ...(registered.repositoryIdentity as Wire), ...(project.repositoryIdentity as Wire) },
          };
        }
      }
      threads.push(...(this.out(shell.threads ?? [], vmId) as Row[]));
      archivedThreads.push(...(this.out(shell.archivedThreads ?? [], vmId) as Row[]));
    }
    return { schemaVersion: 1, snapshotSequence: this.sequence, projects, threads, archivedThreads };
  }

  private catalogProject(project: ProjectRow): Row {
    const root = projectRoot(project);
    const at = new Date(project.createdAt).toISOString();
    return {
      id: project.id,
      title: project.title,
      workspaceRoot: root,
      defaultModelSelection: null,
      defaultThreadEnvMode: "worktree",
      scripts: [],
      repositoryIdentity: repositoryIdentity(project, root),
      createdAt: at,
      updatedAt: at,
    };
  }

  descriptor(): Wire {
    const native = [...this.configs.values()][0]?.environment;
    return {
      environmentId: this.settings.get("bridgeId"),
      label: "VM Bridge",
      serverVersion: native?.serverVersion ?? "0.1.0",
      platform: { os: "linux", arch: "x64", machine: "cloud" },
      orchestrationProtocolVersion: 2,
      capabilities: { repositoryIdentity: true, connectionProbe: true, inlineMessageContext: true, vcsBranchStatus: true },
    };
  }

  hasConfig() {
    return this.configs.size > 0;
  }

  /** T3's server config, built from one VM's and adjusted for a fleet behind one endpoint. */
  config(): Wire {
    const [entry] = this.configs;
    if (!entry) throw new Error("VM Bridge is starting its first VM. Try again in a minute.");
    const [vmId, native] = entry;
    const base = this.out(native, vmId) as ServerConfig;
    base.environment = this.descriptor();
    base.auth = bridgeAuth;
    const agents = this.agents();
    base.providers = agents;
    if (base.settings) {
      base.settings.addProjectBaseDirectory = "/projects";
      base.settings.providerInstances = Object.fromEntries(
        agents.map((agent) => [agent.instanceId, { driver: agent.driver, displayName: agent.displayName, enabled: agent.enabled }]),
      );
      // These belong to each VM's server and can describe its credentials.
      base.settings.secretProviders = {};
      base.settings.usageLimitSources = {};
      base.settings.textGenerators = {};
    }
    delete base.directEndpoints;
    base.shellResumeCompletionMarker = true;
    base.shellThreadFamilies = false;
    base.shellOlderSettled = false;
    base.threadSnapshotPagination = true;
    base.serverTime = new Date().toISOString();
    return base;
  }

  /** Agents across the fleet, preferring what a connected VM (or the given one) reports. */
  agents(preferredVm?: string): AgentReport[] {
    const byId = new Map<string, { vmId: string | null; entry: ProviderEntry }>();
    const rank = (vmId: string) => (vmId === preferredVm ? 2 : this.fleet.backend(vmId) ? 1 : 0);
    const entries = [...this.configs].sort(([a], [b]) => rank(a) - rank(b));
    for (const [vmId, config] of entries) {
      for (const entry of config.providers ?? []) byId.set(entry.instanceId, { vmId, entry });
    }
    for (const driver of defaultAgents) if (!byId.has(driver)) byId.set(driver, { vmId: null, entry: pendingAgent(driver) });
    const preferences = this.settings.get("agentPreferences");
    const added = this.settings.get("providers");
    const badge = added.length === 1 ? providers[added[0]!].label : "VM Bridge";
    return [...byId.values()].map(({ vmId, entry }) => {
      const shown = vmId ? (this.out(entry, vmId) as ProviderEntry) : entry;
      const report = presentAgent(shown, preferences[entry.instanceId], badge);
      // An update is offered while any VM last reported this agent behind its latest release.
      const advised = this.outdated(entry.instanceId)[0]?.entry ?? entry;
      if (report.enabled && advised.versionAdvisory) {
        report.versionAdvisory = advised.versionAdvisory;
        if (advised.compatibilityAdvisory) report.compatibilityAdvisory = advised.compatibilityAdvisory;
      }
      const update = this.agentUpdates.get(entry.instanceId);
      if (update) report.updateState = update;
      return report;
    });
  }

  /** VMs whose last report, from when they were awake, says this agent can update. */
  private outdated(instanceId: string) {
    return [...this.configs].flatMap(([vmId, config]) => {
      const vm = this.store.vm(vmId);
      if (!vm || vm.state === "gone") return [];
      const entry = config.providers?.find((provider) => provider.instanceId === instanceId);
      const advisory = entry?.versionAdvisory as Wire | undefined;
      return entry && advisory?.status === "behind_latest" && advisory.canUpdate === true && advisory.updateCommand ? [{ vmId, entry }] : [];
    });
  }

  /**
   * Runs T3's own agent update on every VM that reported the agent out of date. A sleeping VM is
   * woken for it and put back to sleep once its update is done.
   */
  async updateAgent(input: Wire) {
    const instanceId = str(input.instanceId) ?? str(input.provider);
    if (!instanceId) throw new Error("Name the agent to update.");
    if (this.agentUpdates.get(instanceId)?.status === "running") throw new Error("An update is already running for this agent.");
    const targets = this.outdated(instanceId).map(({ vmId }) => vmId);
    const startedAt = new Date().toISOString();
    const state = (status: string, message: string) => {
      this.agentUpdates.set(instanceId, { status, startedAt, finishedAt: status === "running" ? null : new Date().toISOString(), message, output: null });
      this.emit("config");
    };
    state("running", `Updating on ${targets.length === 1 ? "1 VM" : `${targets.length} VMs`}`);
    const failures: string[] = [];
    await Promise.all(
      targets.map(async (vmId) => {
        const name = this.store.vm(vmId)?.name ?? vmId;
        if (!this.fleet.backend(vmId)) this.wokenForUpdate.add(vmId);
        const release = this.fleet.lease(vmId);
        try {
          const backend = await this.fleet.ensure(vmId);
          const result = await backend.call<{ providers?: ProviderEntry[] }>("server.updateProvider", this.into({ ...input }, vmId), 10 * 60_000);
          const config = this.configs.get(vmId);
          if (result.providers?.length && config) {
            const merged = new Map((config.providers ?? []).map((entry) => [entry.instanceId, entry]));
            for (const entry of result.providers) merged.set(entry.instanceId, entry);
            config.providers = [...merged.values()];
            this.store.saveSnapshot(vmId, "config", config);
          }
          const outcome = result.providers?.find((entry) => entry.instanceId === instanceId)?.updateState as Wire | undefined;
          if (outcome?.status === "failed") failures.push(`${name}: ${str(outcome.message) ?? "the update failed"}`);
        } catch (error) {
          failures.push(`${name}: ${message(error)}`);
        } finally {
          release();
          if (this.wokenForUpdate.has(vmId) && !this.fleet.leased(vmId)) {
            this.wokenForUpdate.delete(vmId);
            await this.sleepVm(vmId);
          }
        }
      }),
    );
    this.traffic.record({ kind: "system", operation: `update ${instanceId} on ${targets.length} VMs`, status: failures.length ? "error" : "ok" });
    if (failures.length) {
      state("failed", failures.join("; "));
      throw new Error(failures.join("; "));
    }
    state(targets.length ? "succeeded" : "unchanged", targets.length ? "Updated on every VM" : "Every VM is up to date");
    return this.agents();
  }

  /** Refreshes agent status on one VM (the request's, or any connected one) and returns the catalog. */
  async refreshAgents(input: Wire) {
    const cwd = str(input.cwd);
    const vmId = (cwd && this.routeOrNull({ cwd })) || this.fleet.connected()[0];
    const backend = vmId ? this.fleet.backend(vmId) : undefined;
    if (vmId && backend) {
      const request = this.into({ ...input }, vmId);
      if (!this.routeOrNull({ cwd })) delete request.cwd;
      const result = await backend
        .call<{ providers?: ProviderEntry[] }>("server.refreshProviders", { ...request, omitProviders: false, providerCatalogsOnDemand: false })
        .catch(() => null);
      const config = this.configs.get(vmId);
      if (result?.providers?.length && config) {
        // Instance-scoped refreshes return only that instance, so merge by ID.
        const merged = new Map((config.providers ?? []).map((entry) => [entry.instanceId, entry]));
        for (const entry of result.providers) merged.set(entry.instanceId, entry);
        config.providers = [...merged.values()];
        this.store.saveSnapshot(vmId, "config", config);
      }
    }
    this.emit("config");
    const agents = this.agents(vmId);
    const instanceId = str(input.instanceId);
    return instanceId ? agents.filter((agent) => agent.instanceId === instanceId) : agents;
  }

  /** Only the on/off switch and display name are settable from T3. Returns T3's settings. */
  updateAgentPreferences(input: Wire): Wire {
    const mutation = input.providerInstanceMutation as Wire | undefined;
    const patch = (input.patch ?? {}) as Wire;
    const instanceId = str(mutation?.instanceId);
    if (!mutation || !instanceId || Object.keys(patch).length > 0) {
      throw new Error("VM Bridge manages agent settings. Only the on/off switch and name can change here.");
    }
    const agent = this.agents().find((entry) => entry.instanceId === instanceId);
    if (!agent) throw new Error("Unknown agent.");
    const preferences = { ...this.settings.get("agentPreferences") };
    if (mutation.operation === "remove") delete preferences[instanceId];
    else {
      const instance = (mutation.instance ?? {}) as Wire;
      const name = instance.displayName;
      const valid =
        mutation.operation === "upsert" &&
        instance.driver === agent.driver &&
        Object.keys(instance).every((key) => ["driver", "enabled", "displayName"].includes(key)) &&
        (instance.enabled === undefined || typeof instance.enabled === "boolean") &&
        (name === undefined || (typeof name === "string" && name.trim().length > 0 && name.length <= 100));
      if (!valid) throw new Error("Only the on/off switch and name can change for an agent.");
      preferences[instanceId] = {
        enabled: instance.enabled as boolean | undefined,
        displayName: typeof name === "string" ? name.trim() : undefined,
      };
    }
    this.settings.set("agentPreferences", preferences);
    this.emit("config");
    return this.config().settings as Wire;
  }

  scheduledTasks(): Wire {
    const live = [...this.schedules].filter(([vmId]) => this.store.vm(vmId)?.state !== "gone");
    const timeZone = live.find(([, value]) => typeof value.timeZone === "string")?.[1].timeZone;
    return { tasks: live.flatMap(([vmId, value]) => this.out(value.tasks, vmId) as Wire[]), ...(timeZone ? { timeZone } : {}) };
  }

  hasEnabledSchedule(vmId: string) {
    return this.schedules.get(vmId)?.tasks.some((task) => task.enabled && !task.blockedByPolicy) ?? false;
  }

  /** The VM owning a scheduled task request. A new task goes with its thread or project. */
  async scheduleTarget(tag: string, payload: Wire): Promise<string> {
    const taskId = str(payload.id);
    if (taskId) {
      const owners = [...this.schedules].filter(([, value]) => value.tasks.some((task) => task.id === taskId));
      if (owners.length !== 1) throw new Error("Could not find the VM that owns this automation.");
      return owners[0]![0];
    }
    if (tag !== "scheduledTasks.upsert") throw new Error("An automation ID is required.");
    const projectId = str(payload.projectId);
    if (!payload.threadId && projectId && this.store.project(projectId)) return this.fleet.place(projectId);
    return this.route(payload);
  }

  // Routing

  /** VMs and projects a payload refers to, through thread IDs, project IDs, paths and run IDs. */
  private targets(payload: unknown) {
    const vms = new Set<string>();
    const projects = new Map<string, ProjectRow>();
    const all = this.projects();
    const visit = (value: unknown, key: string) => {
      if (typeof value === "string") {
        if (["threadId", "parentThreadId", "sourceThreadId"].includes(key)) {
          const vmId = this.store.threadVm(value);
          if (vmId) vms.add(vmId);
        }
        if (key === "projectId") {
          const project = all.find((p) => p.id === value);
          if (project) projects.set(project.id, project);
          else for (const [vmId, shell] of this.shells) if (shell.projects?.some((p) => p.id === value)) vms.add(vmId);
        }
        if (isPathKey(key)) {
          const project = projectForPath(value, all);
          if (project) projects.set(project.id, project);
          const vmId = vmForPath(value);
          if (vmId && this.store.vm(vmId)) vms.add(vmId);
        }
        if (key === "runId") {
          for (const [vmId, shell] of this.shells) {
            if (threadsOf(shell).some((thread) => thread.latestRunId === value || thread.activeRunId === value)) vms.add(vmId);
          }
        }
      } else if (Array.isArray(value)) for (const item of value) visit(item, key);
      else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, name);
    };
    visit(payload, "");
    return { vms, projects: [...projects.values()] };
  }

  /** The one VM a request belongs to. Throws when it names none, or several. */
  route(payload: unknown, chosen?: string): string {
    const { vms, projects } = this.targets(payload);
    if (chosen) vms.add(chosen);
    for (const project of projects) {
      // A request naming a thread or VM path goes there. One naming only the project goes to its primary VM.
      if (vms.size) {
        if ([...vms].some((vmId) => !project.vms.some((entry) => entry.vmId === vmId))) throw new Error("This project has no checkout on that VM.");
      } else {
        const primary = primaryVm(project);
        if (primary) vms.add(primary.vmId);
      }
    }
    if (vms.size === 1) return [...vms][0]!;
    throw new Error(
      vms.size
        ? "This request mixes projects or threads from different VMs."
        : "VM Bridge cannot tell which VM this request is for. Use a project or an existing thread.",
    );
  }

  /**
   * Routes a request, waiting briefly when it names a thread no VM has reported yet. A child thread a VM starts
   * itself (T3's delegate_task) reaches its parent's stream a moment before that VM's shell lists it, so a
   * client can open the child before VM Bridge knows which VM it is on.
   */
  async routeSoon(payload: Wire): Promise<string> {
    const threadId = str(payload.threadId);
    const deadline = Date.now() + unseenThreadWaitMs;
    // Until then a project path alone would pick the project's primary VM, which need not be the one running the child.
    while (threadId && !this.store.threadVm(threadId) && !this.targets(payload).vms.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await once(this, "shell", { signal: AbortSignal.timeout(remaining) }).catch(() => {});
    }
    return this.route(payload);
  }

  routeOrNull(payload: unknown) {
    try {
      return this.route(payload);
    } catch {
      return null;
    }
  }

  /**
   * Routes a request, placing its project on a VM first when `allocate` is set. Command routing is
   * saved before the request is forwarded, so a retried command reaches the same VM.
   */
  async prepare(tag: string, payload: Wire, allocate: boolean, progress?: (detail: string) => void) {
    const fingerprint = sha256(JSON.stringify({ tag, payload }));
    const commandId = str(payload.commandId);
    const previous = commandId ? this.store.command(commandId) : null;
    if (previous && previous.fingerprint !== fingerprint) throw new Error("This commandId was already used for another request.");
    const { vms, projects } = this.targets(payload);
    if (projects.length > 1 || vms.size > 1) throw new Error("This request mixes projects from different VMs.");
    const [project] = projects;
    const launching = tag === "orchestration.launchThread";
    // Known before placement, so placement can count it toward its VM's load.
    let threadId = launching ? (previous?.threadId ?? str(payload.threadId) ?? crypto.randomUUID()) : undefined;
    let vmId: string;
    if (previous || vms.size) vmId = this.route(payload, previous?.vmId);
    else if (project && allocate) {
      const listener = (projectId: string, detail: string) => projectId === project.id && progress?.(detail);
      const report = (detail: string) => this.emit("placement", project.id, detail);
      this.on("placement", listener);
      try {
        if (threadId) {
          const placed = await this.fleet.placeThread(project.id, {
            only: await this.branchHolders(project.id, launchBranch(payload.workspaceStrategy)),
            load: (vm) => this.load(vm),
            placed: (id) => this.launches.set(threadId!, { vmId: id, at: Date.now() }),
            progress: report,
          });
          vmId = placed.vmId;
          if (placed.notice) this.busyNotices.set(threadId, placed.notice);
        } else vmId = await this.fleet.place(project.id, report);
      } finally {
        this.off("placement", listener);
      }
    } else vmId = await this.routeSoon(payload);

    if (commandId && !previous) {
      // Claimed in one insert: a retry racing this one through placement adopts whatever VM and thread won,
      // and gives back the reservation it made for its own.
      this.store.saveCommand(commandId, vmId, fingerprint, threadId ?? null);
      const claimed = this.store.command(commandId)!;
      if (claimed.fingerprint !== fingerprint) throw new Error("This commandId was already used for another request.");
      const winner = claimed.threadId ?? undefined;
      if (winner !== threadId) {
        if (threadId) {
          this.launches.delete(threadId);
          this.busyNotices.delete(threadId);
        }
        threadId = winner;
      } else if (threadId && claimed.vmId !== vmId) {
        this.launches.set(threadId, { vmId: claimed.vmId, at: Date.now() });
        this.busyNotices.delete(threadId);
      }
      vmId = claimed.vmId;
    }
    const outgoing = this.into({ ...payload }, vmId);
    if (threadId) outgoing.threadId = threadId;
    if (launching) {
      this.store.setThreadVm(outgoing.threadId as string, vmId);
      const strategy = outgoing.workspaceStrategy as Wire | undefined;
      const placed = project && this.store.project(project.id);
      // A project is a fresh clone, so threads start in their own worktree by default.
      if (placed && (!strategy || strategy.type === "root")) {
        outgoing.workspaceStrategy = { type: "worktree", baseRef: str(strategy?.branch) ?? placed.branch ?? "HEAD" };
      }
    }
    const created = str(payload.threadId);
    if (payload.type === "thread.create" && created) this.store.setThreadVm(created, vmId);
    return { vmId, payload: outgoing };
  }

  /**
   * The local branches one of a project's VMs has: from its checkout while it is awake, else what VM Bridge last
   * read there plus the branches of the threads it last reported.
   */
  async localBranches(projectId: string, vmId: string): Promise<Set<string>> {
    const backend = this.fleet.backend(vmId);
    const live = backend && (await this.readBranches(backend, projectId, vmId));
    if (live) return live;
    const threads = threadsOf(this.shells.get(vmId)).filter((thread) => thread.projectId === projectId);
    const named = threads.flatMap((thread) => (typeof thread.branch === "string" ? [thread.branch] : []));
    return new Set([...this.store.branches(projectId, vmId), ...named]);
  }

  /** Reads a project's local branches from an awake VM and keeps them for while it sleeps. Null when it cannot. */
  private async readBranches(backend: Backend, projectId: string, vmId: string) {
    const cwd = this.store.project(projectId)?.vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (!cwd) return null;
    const listed = await backend.call<{ refs?: Wire[] }>("vcs.listRefs", { cwd, refKind: "local", limit: 200 }, 10_000).catch(() => null);
    if (!listed) return null;
    const names = (listed.refs ?? []).flatMap((ref) => (!ref.isRemote && typeof ref.name === "string" ? [ref.name] : []));
    this.store.setBranches(projectId, vmId, names);
    return new Set(names);
  }

  /** Local branches only some of a project's VMs have: each name with the VMs that have it. */
  async sparseBranches(projectId: string): Promise<Map<string, Set<string>>> {
    const vms = this.store.project(projectId)?.vms.filter((entry) => this.store.vm(entry.vmId)?.state !== "gone") ?? [];
    const holders = new Map<string, Set<string>>();
    if (vms.length < 2) return holders;
    const lists = await Promise.all(vms.map(({ vmId }) => this.localBranches(projectId, vmId)));
    lists.forEach((names, index) => {
      for (const name of names) holders.set(name, (holders.get(name) ?? new Set()).add(vms[index]!.vmId));
    });
    for (const [name, on] of holders) if (on.size === vms.length) holders.delete(name);
    return holders;
  }

  /** The VMs a new thread starting from `branch` must go to, when only some of the project's VMs have it. */
  private async branchHolders(projectId: string, branch: string | undefined) {
    return branch ? (await this.sparseBranches(projectId)).get(branch) : undefined;
  }

  /** One of a project's VMs as placement sees it, from the cached shell and the latest resource reading. */
  private load(vm: VmRow): VmLoad {
    const shell = this.shells.get(vm.id);
    const listed = new Set(threadsOf(shell).map((thread) => thread.id));
    const now = Date.now();
    let launched = 0;
    for (const [threadId, launch] of this.launches) {
      if (now - launch.at > launchGraceMs) this.launches.delete(threadId);
      else if (launch.vmId === vm.id && !listed.has(threadId)) launched++;
    }
    const awake = Boolean(this.fleet.backend(vm.id));
    const stats = awake ? this.stats.get(vm.id) : null;
    // A sleeping VM runs nothing. One that is not connected yet, as after VM Bridge restarts, counts the turns
    // its last saved shell had, so it does not look empty until it reconnects.
    const running = vm.state === "sleeping" ? 0 : threadsOf(shell).filter(isWorking).length;
    return {
      vmId: vm.id,
      awake,
      turns: running + launched,
      vcpus: stats?.cpu?.cores ?? labelVcpus(providers[vm.provider].sizes[vm.size]),
      memory: stats?.memory ?? null,
      disk: stats?.disk ?? this.stats.lastDisk(vm.id),
    };
  }

  // Worktree setup progress shown while VM Bridge places a new thread

  setupSnapshot(threadId: string) {
    return this.setupProgress.get(threadId) ?? null;
  }

  /**
   * The VM's own setup snapshot for a thread, carrying its busy notice when it has one. T3 has no other place
   * for a notice on a starting thread, and its setup card hides once the agent runs, so the notice goes on
   * the agent stage while T3 leaves it without detail. T3's own detail, such as a failure, wins.
   */
  withBusyNotice(threadId: string, snapshot: Wire): Wire {
    const notice = this.busyNotices.get(threadId);
    if (!notice || !Array.isArray(snapshot.stages)) return snapshot;
    const stages = (snapshot.stages as Wire[]).map((stage) => (stage.id === "agent" && stage.detail == null ? { ...stage, detail: notice } : stage));
    return { ...snapshot, stages };
  }

  reportSetup(threadId: string, detail: string, phase: "running" | "done" | "failed" = "running") {
    const previous = this.setupProgress.get(threadId);
    const now = new Date().toISOString();
    // A busy VM's notice stays on the stage through the rest of the setup. Failures show their own text.
    const notice = phase === "failed" ? undefined : this.busyNotices.get(threadId);
    const startedAt = previous?.phase === "running" ? previous.startedAt : now;
    const stage = (previous?.stages as Wire[] | undefined)?.[0];
    this.setupProgress.delete(threadId);
    this.setupProgress.set(threadId, {
      threadId,
      phase,
      startedAt,
      endedAt: phase === "running" ? null : now,
      branch: null,
      baseRef: null,
      worktreePath: null,
      setupScript: null,
      stages: [
        {
          id: "checkout",
          status: notice ? "warning" : phase,
          startedAt: stage?.startedAt ?? now,
          endedAt: phase === "running" ? null : now,
          percent: null,
          detail: (notice ?? detail).slice(0, 200),
          tail: [],
        },
      ],
      error: phase === "failed" ? detail.slice(0, 1000) : null,
      sequence: ((previous?.sequence as number | undefined) ?? -1) + 1,
    });
    // Keep the newest 200, dropping settled ones first.
    if (this.setupProgress.size > 200) {
      const settled = [...this.setupProgress].find(([, snapshot]) => snapshot.phase !== "running");
      if (settled) {
        this.setupProgress.delete(settled[0]);
        this.busyNotices.delete(settled[0]);
      }
    }
    this.emit("setup", threadId);
  }

  // Sleeping threads

  /** Shows a "waking" notice in a sleeping thread until the VM answers. Call the result when done. */
  beginWake(threadId: string, vmId: string): () => void {
    const label = providers[this.store.vm(vmId)?.provider ?? "boat"].label;
    const wake = this.waking.get(threadId) ?? {
      count: 0,
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      message: this.store.vm(vmId)?.state === "sleeping" ? `Waking the ${label} VM...` : `Reconnecting to the ${label} VM...`,
    };
    wake.count++;
    this.waking.set(threadId, wake);
    if (wake.count === 1) this.emit("wake", threadId);
    return () => {
      if (--wake.count !== 0) return;
      this.waking.delete(threadId);
      this.emit("wake", threadId);
    };
  }

  /** The cached projection of a thread on a sleeping VM, with the waking notice when one is showing. */
  sleepingProjection(threadId: string): Projection | null {
    const projection = this.store.projection<Projection>(threadId);
    const wake = this.waking.get(threadId);
    if (!projection || !wake) return projection;
    const turnItems = projection.turnItems ?? [];
    const visible = projection.visibleTurnItems ?? [];
    const item = {
      id: wake.id,
      threadId,
      type: "system_notice",
      level: "info",
      status: "running",
      message: wake.message,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: Math.max(0, ...turnItems.map((entry) => entry.ordinal ?? 0)) + 1,
      title: null,
      startedAt: wake.startedAt,
      completedAt: null,
      updatedAt: wake.startedAt,
    };
    return {
      ...projection,
      turnItems: [...turnItems, item],
      visibleTurnItems: [
        ...visible,
        { position: (visible.at(-1)?.position ?? -1) + 1, visibility: "synthetic", sourceThreadId: threadId, sourceItemId: item.id, item },
      ],
    };
  }

  shellSequence(vmId: string) {
    return this.shells.get(vmId)?.snapshotSequence ?? 0;
  }

  cacheProjection(threadId: string, vmId: string, projection: unknown) {
    const value = projection as Projection | null;
    if (value?.thread?.id !== threadId) return;
    this.store.saveProjection(threadId, vmId, value.updatedAt ?? null, value);
  }

  refreshProjectionSoon(vmId: string, threadId: string) {
    if (this.projectionRefreshes.has(threadId)) return;
    const timer = setTimeout(() => {
      const backend = this.fleet.backend(vmId);
      if (!backend) return void this.projectionRefreshes.delete(threadId);
      void backend
        .call("orchestration.getThreadProjection", { threadId })
        .then((projection) => this.cacheProjection(threadId, vmId, projection))
        .catch(() => {})
        .finally(() => this.projectionRefreshes.delete(threadId));
    }, 350);
    this.projectionRefreshes.set(threadId, timer);
  }

  private async cacheMissingProjections(vmId: string) {
    const backend = this.fleet.backend(vmId);
    if (!backend) return;
    for (const thread of threadsOf(this.shells.get(vmId))) {
      if (this.fleet.backend(vmId) !== backend) return;
      if (this.store.hasProjection(thread.id)) continue;
      try {
        this.cacheProjection(thread.id, vmId, await backend.call("orchestration.getThreadProjection", { threadId: thread.id }));
      } catch {
        // A later shell change retries it.
      }
    }
  }

  // Idle sleep

  /**
   * Sleeps VMs idle longer than the configured minutes. The VM's own shell decides: a running
   * turn, queued work, a pending approval, or an enabled automation keeps it awake. First, an idle
   * VM still running with older sign-ins restarts T3 to take the new ones.
   */
  async sweep(now = Date.now()) {
    const idleMs = this.settings.get("idleMinutes") * 60_000;
    // Automations need their VM awake to fire.
    for (const vm of this.store.vms()) {
      if (vm.state === "sleeping" && this.hasEnabledSchedule(vm.id)) void this.fleet.ensure(vm.id).catch(() => {});
    }
    for (const vmId of this.fleet.connected()) {
      const backend = this.fleet.backend(vmId);
      const vm = this.store.vm(vmId);
      if (!backend || !vm || this.fleet.leased(vmId)) continue;
      const shell = await backend.json<Shell>("/api/orchestration/shell").catch(() => null);
      if (!shell) continue;
      if (await this.updateCredentials(vmId, shell)) continue;
      if (hasLiveWork(shell) || this.hasEnabledSchedule(vmId)) {
        this.fleet.touch(vmId, now);
        this.setBusy(vmId, hasLiveWork(shell));
        await this.fleet.keepAlive(vmId).catch(() => {});
        continue;
      }
      this.setBusy(vmId, false);
      if (now - (vm.lastActivityAt ?? vm.createdAt) < idleMs) continue;
      this.traffic.record({ kind: "system", operation: `Idle ${this.settings.get("idleMinutes")} min, sleeping VM`, vmId });
      await this.sleepVm(vmId, shell);
    }
  }

  /**
   * Sign-ins changed: every awake VM gets the new ones written now, and those with nothing running restart
   * T3 so their agents get them too. Busy VMs restart in a later sweep, once idle; sleeping ones when they wake.
   */
  async credentialsChanged() {
    await this.fleet.shareCredentials();
    await Promise.all(
      this.fleet.connected().map(async (vmId) => {
        const shell = await this.fleet.backend(vmId)?.json<Shell>("/api/orchestration/shell").catch(() => null);
        if (shell) await this.updateCredentials(vmId, shell);
      }),
    );
  }

  /** Restarts T3 on an idle VM running with older sign-ins. Returns whether it tried. */
  private async updateCredentials(vmId: string, shell: Shell) {
    if (!this.fleet.stale(vmId) || hasLiveWork(shell) || this.fleet.leased(vmId)) return false;
    await this.fleet.restart(vmId, async (live) => !hasLiveWork(await live.json<Shell>("/api/orchestration/shell"))).catch(() => {});
    return true;
  }

  /** Puts an idle VM to sleep, caching every transcript first so threads stay readable. */
  private async sleepVm(vmId: string, known?: Shell) {
    const shell = known ?? (await this.fleet.backend(vmId)?.json<Shell>("/api/orchestration/shell").catch(() => null));
    if (!shell || hasLiveWork(shell) || this.fleet.leased(vmId)) return;
    await this.fleet
      .sleep(vmId, async (live) => {
        for (const thread of threadsOf(shell)) {
          this.cacheProjection(thread.id, vmId, await live.call("orchestration.getThreadProjection", { threadId: thread.id }));
          this.store.setThreadVm(thread.id, vmId);
        }
        // Its branches too, so the project's branch list and placement still know them while it sleeps.
        for (const project of this.store.projects()) {
          if (project.vms.some((entry) => entry.vmId === vmId)) await this.readBranches(live, project.id, vmId);
        }
        // Caching took a while: work may have started on the VM meanwhile.
        const latest = await live.json<Shell>("/api/orchestration/shell");
        if (hasLiveWork(latest)) return false;
        this.shells.set(vmId, latest);
        this.store.saveSnapshot(vmId, "shell", latest);
        return true;
      })
      .catch(() => {});
    this.bump();
    this.emit("shell");
  }

  private setBusy(vmId: string, busy: boolean) {
    const vm = this.store.vm(vmId);
    if (!vm || !["ready", "busy"].includes(vm.state)) return;
    const state = busy ? "busy" : "ready";
    if (vm.state !== state) {
      this.store.updateVm(vmId, { state });
      this.fleet.emit("changed");
    }
  }

  /** Threads on a VM, for the dashboard. */
  vmThreads(vmId: string) {
    return threadsOf(this.shells.get(vmId));
  }

  close() {
    for (const timer of this.projectionRefreshes.values()) clearTimeout(timer);
  }
}

/** The values of a stream chunk; nothing for other frames. */
function chunks(frame: Frame): Wire[] {
  return frame._tag === "Chunk" && Array.isArray(frame.values) ? (frame.values as Wire[]) : [];
}
