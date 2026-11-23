import type { Traffic } from "../traffic.ts";
import { message, NoProvider } from "../fleet.ts";
import { primaryVm } from "../store.ts";
import type { Frame } from "../vm/backend.ts";
import type { Clones } from "./clones.ts";
import { heldCommandTypes } from "./held.ts";
import type { Hub } from "./hub.ts";
import { projectForPath, projectRoot } from "./paths.ts";
import { githubName, githubRepository, type RemoteBranches } from "./repos.ts";
import { str, type Wire } from "./types.ts";

/** One connected T3 client socket. */
export interface RpcClient {
  readonly clientId: string;
  send(frame: Wire): void;
  /** False once the socket closed or the device lost its access. */
  open(): boolean;
  /** Interrupt handlers for this client's open requests, by request ID. */
  readonly cancels: Map<string, () => void>;
}

/** Echoed back with the type it arrived as: newer T3 clients send numbers and match replies by value. */
type RequestId = string | number;

interface Call {
  id: RequestId;
  tag: string;
  payload: Wire;
  client: RpcClient;
  /** Set once the request reaches a VM, which then records the traffic with the VM's timing. */
  forwarded?: boolean;
}

const success = (requestId: RequestId, value: unknown) => ({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });
const defect = (requestId: RequestId, text: string) => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: text }] },
});
const tagged = (requestId: RequestId, error: Wire) => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
});

type StreamEvent = "shell" | "config" | "scheduledTasks" | "clones";

/** Requests T3 clients may forward to a VM. Anything else is refused rather than guessed at. */
const forwardable = /^(orchestration\.|projects\.|vcs\.|sourceControl\.|git\.|review\.|filesystem\.|server\.(getProvider|refreshProvider))/;
const mutation = /\.(create|write|mutate|switch|remove|stop|forceStop|pull$|runStackedAction$|preparePullRequestThread$|publishRepository$)/i;
const scheduleMutations = new Set(["scheduledTasks.upsert", "scheduledTasks.setEnabled", "scheduledTasks.delete", "scheduledTasks.runNow"]);

/**
 * T3's Effect RPC protocol, answered for a whole fleet. Requests VM Bridge can answer itself (the
 * merged shell, config, clone flow, sleeping transcripts) are handled here; the rest are routed to
 * the owning VM, waking it when the request needs it.
 */
export class Rpc {
  private readonly local: Record<string, (call: Call) => unknown>;

  constructor(
    private readonly hub: Hub,
    clones: Clones,
    private readonly branches: RemoteBranches,
    private readonly traffic: Traffic,
    private readonly githubConnected: () => boolean,
  ) {
    this.local = {
      "server.probe": (call) => this.reply(call, {}),
      "server.reportClientActivity": (call) => this.reply(call, undefined),
      "server.getConfig": (call) => this.reply(call, this.config()),
      "server.getSettings": (call) => this.reply(call, this.config().settings),
      "server.discoverSourceControl": (call) => this.reply(call, this.sourceControl()),
      "server.updateSettings": (call) => {
        try {
          this.reply(call, hub.updateAgentPreferences(call.payload));
        } catch (error) {
          call.client.send(
            tagged(call.id, {
              _tag: "ServerSettingsError",
              settingsPath: "vmbridge",
              operation: "write-managed-setting",
              managedSetting: message(error),
              managedBy: "VM Bridge",
            }),
          );
        }
      },
      "server.refreshProviders": async (call) => this.reply(call, { providers: await hub.refreshAgents(call.payload) }),
      "server.updateProvider": async (call) => this.reply(call, { providers: await hub.updateAgent(call.payload) }),
      subscribeServerConfig: (call) => this.stream(call, "config", () => ({ version: 1, type: "snapshot", config: this.config() })),
      "orchestration.subscribeShell": (call) => this.stream(call, "shell", () => ({ kind: "snapshot", snapshot: hub.shell() })),
      "scheduledTasks.subscribe": (call) => this.stream(call, "scheduledTasks", () => hub.scheduledTasks()),
      subscribeProjectClones: (call) => this.stream(call, "clones", () => clones.list()),
      "projectClone.start": (call) => {
        try {
          this.reply(call, clones.start(call.payload));
        } catch (error) {
          call.client.send(
            tagged(call.id, {
              _tag: "SourceControlRepositoryError",
              provider: str(call.payload.provider) ?? "github",
              operation: "clone",
              detail: message(error),
            }),
          );
        }
      },
      "projectClone.retry": (call) => this.reply(call, { applied: clones.retry(String(call.payload.projectId)) }),
      // A clone is one command on the VM with no handle to interrupt.
      "projectClone.cancel": (call) => this.reply(call, { applied: false }),
      "orchestration.getArchivedShellSnapshot": (call) => {
        const shell = hub.shell();
        this.reply(call, { ...shell, threads: shell.archivedThreads });
      },
      "orchestration.getThreadTitles": (call) => {
        const ids = new Set(Array.isArray(call.payload.threadIds) ? call.payload.threadIds : []);
        const shell = hub.shell();
        const rows = [...(shell.threads ?? []), ...(shell.archivedThreads ?? [])].filter((thread) => ids.has(thread.id));
        this.reply(call, Object.fromEntries(rows.map((thread) => [thread.id, thread.title])));
      },
      "sourceControl.appAccess": (call) =>
        call.payload.provider === "github" ? this.reply(call, { status: "signed-out" }) : this.forward(call),
      "sourceControl.lookupRepository": (call) => this.lookupRepository(call),
      subscribeWorktreeSetup: (call) => this.worktreeSetup(call),
      "worktreeSetup.cancel": (call) => {
        const vmId = this.hub.store.threadVm(String(call.payload.threadId));
        return vmId && this.hub.fleet.backend(vmId) ? this.forward(call) : this.reply(call, { cancelled: false });
      },
      "filesystem.browse": (call) => this.browse(call),
      "filesystem.getMetadata": (call) => this.metadata(call),
      "vcs.listRefs": (call) => this.listRefs(call),
      "vcs.refreshStatus": (call) => this.vcsFallback(call),
      "vcs.refreshBranch": (call) => this.vcsFallback(call),
      subscribeVcsBranch: (call) => this.vcsSubscription(call),
      subscribeVcsStatus: (call) => this.vcsSubscription(call),
      "orchestration.subscribeThread": (call) => this.subscribeThread(call),
    };
  }

  async handle(client: RpcClient, frame: Frame) {
    if (frame._tag === "Ping") return client.send({ _tag: "Pong" });
    if (frame._tag === "Ack") return;
    if (frame._tag === "Interrupt") {
      const requestId = String(frame.requestId);
      client.cancels.get(requestId)?.();
      client.cancels.delete(requestId);
      return;
    }
    if (frame._tag !== "Request" || !["string", "number"].includes(typeof frame.id) || typeof frame.tag !== "string") {
      throw new Error("Invalid RPC frame.");
    }
    const call: Call = { id: frame.id as RequestId, tag: frame.tag, payload: (frame.payload ?? {}) as Wire, client };
    const started = performance.now();
    const local = this.local[call.tag];
    try {
      if (!local) return await this.forward(call);
      await local(call);
      if (!call.forwarded) this.traffic.record({ kind: "rpc", operation: call.tag, clientId: client.clientId, status: "ok", durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      this.traffic.record({ kind: "rpc", operation: call.tag, clientId: client.clientId, status: "error", durationMs: Math.round(performance.now() - started) });
      this.fail(call, error);
    }
  }

  private reply(call: Call, value: unknown) {
    call.client.send(success(call.id, value));
  }

  private fail(call: Call, error: unknown) {
    const text = message(error);
    const { payload, tag, id, client } = call;
    if (tag === "orchestration.launchThread" && typeof payload.threadId === "string") this.hub.reportSetup(payload.threadId, text, "failed");
    if (tag === "orchestration.launchThread" && typeof payload.commandId === "string" && typeof payload.projectId === "string") {
      client.send(tagged(id, { _tag: "OrchestrationV2ThreadLaunchError", commandId: payload.commandId, projectId: payload.projectId, message: text }));
    } else if (tag === "orchestration.dispatchCommand" && typeof payload.commandId === "string" && typeof payload.type === "string") {
      client.send(tagged(id, { _tag: "OrchestrationV2DispatchCommandError", commandId: payload.commandId, commandType: payload.type, message: text }));
    } else if (tag === "server.updateProvider") {
      client.send(tagged(id, { _tag: "ServerProviderUpdateError", provider: str(payload.provider) ?? "unknown", reason: text }));
    } else if (tag.startsWith("scheduledTasks.")) {
      client.send(tagged(id, { _tag: "ScheduledTaskError", message: text, ...(typeof payload.id === "string" ? { taskId: payload.id } : {}) }));
    } else client.send(defect(id, text));
  }

  private chunk(call: Call, value: unknown) {
    call.client.send({ _tag: "Chunk", requestId: call.id, values: [value] });
  }

  /** Sends `value()` now and again on every `event`, until the client interrupts. */
  private stream(call: Call, event: StreamEvent, value: () => unknown) {
    const id = String(call.id);
    const first = value();
    const push = () => {
      try {
        this.chunk(call, value());
      } catch (error) {
        // Thrown into the emitter, this would fail whoever emitted the event. End this stream instead.
        this.hub.off(event, push);
        call.client.cancels.delete(id);
        this.fail(call, error);
      }
    };
    this.hub.on(event, push);
    call.client.cancels.set(id, () => this.hub.off(event, push));
    this.chunk(call, first);
    if (call.payload.requestCompletionMarker) this.chunk(call, { kind: "synchronized" });
  }

  private config() {
    if (!this.hub.hasConfig()) {
      // T3 needs one VM's config before it can show anything. Start one now.
      void this.hub.fleet.any().catch(() => {});
      if (!this.hub.settings.get("defaultProvider")) throw new NoProvider();
    }
    return this.hub.config() as Wire & { settings?: Wire };
  }

  private sourceControl() {
    const none = { _tag: "None" };
    const some = (value: string) => ({ _tag: "Some", value });
    const connected = this.githubConnected();
    const login = this.hub.settings.get("github")?.login;
    return {
      versionControlSystems: [
        { kind: "git", label: "Git", status: "available", implemented: true, executable: "git", version: none, detail: some("Runs on each VM"), installHint: "" },
      ],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: connected ? "available" : "missing",
          version: none,
          detail: some("Managed by VM Bridge"),
          installHint: "Connect GitHub in the VM Bridge dashboard.",
          appSignIn: false,
          auth: {
            status: connected ? "authenticated" : "unknown",
            account: login ? some(login) : none,
            host: some("github.com"),
            detail: none,
          },
        },
      ],
    };
  }

  private async lookupRepository(call: Call) {
    if (call.payload.provider !== "github") return this.forward(call);
    try {
      const name = githubName(String(call.payload.repository ?? ""));
      if (!name) throw new Error("Enter the GitHub owner and repository name.");
      await this.branches.check(`https://github.com/${name}.git`);
      this.reply(call, githubRepository(name));
    } catch (error) {
      call.client.send(tagged(call.id, { _tag: "SourceControlRepositoryError", provider: "github", operation: "lookupRepository", detail: message(error) }));
    }
  }

  private browse(call: Call) {
    const partial = str(call.payload.partialPath) ?? "";
    const path = partial.replace(/\/+$/, "") || "/";
    if (path === "/") return this.reply(call, { parentPath: "/", entries: [{ name: "projects", fullPath: "/projects" }] });
    if (path === "/projects") {
      const entries = this.hub.projects().map((project) => ({ name: project.title, fullPath: projectRoot(project) }));
      return this.reply(call, { parentPath: path, entries });
    }
    const vmId = this.hub.routeOrNull(call.payload);
    if (!vmId || !this.hub.fleet.backend(vmId)) {
      return call.client.send(
        tagged(call.id, {
          _tag: "FilesystemBrowseError",
          partialPath: partial || undefined,
          cwd: str(call.payload.cwd),
          failure: "read_directory_failed",
          message: "Start work in this project to browse its files.",
        }),
      );
    }
    return this.forward(call);
  }

  private async metadata(call: Call) {
    const paths = Array.isArray(call.payload.paths) ? call.payload.paths : [];
    if (paths.length > 64) throw new Error("Ask for at most 64 paths at once.");
    const projects = this.hub.projects();
    const entries = await Promise.all(
      paths.map(async (path) => {
        if (typeof path !== "string") return null;
        const project = projectForPath(path, projects);
        if (path === "/" || path === "/projects" || (project && [projectRoot(project), `/projects/${project.id}`].includes(path))) {
          return { kind: "directory" };
        }
        const vmId = this.hub.routeOrNull({ path });
        const backend = vmId ? this.hub.fleet.backend(vmId) : undefined;
        if (!vmId || !backend) return null;
        const response = await backend
          .call<{ entries?: unknown[] }>(call.tag, this.hub.into({ paths: [path] }, vmId))
          .catch(() => null);
        return response?.entries?.[0] ?? null;
      }),
    );
    this.reply(call, { entries });
  }

  /** The project a request's `cwd` points into, when its primary VM cannot answer right now. */
  private unreachableProject(call: Call) {
    const cwd = str(call.payload.cwd);
    const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
    const primary = project && primaryVm(project);
    if (!project || (primary?.checkoutPath && this.hub.fleet.backend(primary.vmId))) return undefined;
    return { project, cwd: cwd! };
  }

  /**
   * A project's branches come from its primary VM, followed by the local branches only its other VMs have, so a
   * branch made on any of them can start a new thread, which placement then puts on a VM that has it.
   */
  private async listRefs(call: Call) {
    const cwd = str(call.payload.cwd);
    const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
    const primary = project && primaryVm(project);
    if (!project || !primary || project.vms.length < 2 || call.payload.refKind === "remote") return this.vcsFallback(call);
    const query = (str(call.payload.query) ?? "").toLowerCase();
    const elsewhere = [...(await this.hub.sparseBranches(project.id))]
      .filter(([name, vms]) => !vms.has(primary.vmId) && name.toLowerCase().includes(query))
      .map(([name]) => name)
      .sort();
    if (!elsewhere.length) return this.vcsFallback(call);
    const backend = primary.checkoutPath ? this.hub.fleet.backend(primary.vmId) : undefined;
    let listed: Wire;
    if (backend) {
      const vmId = primary.vmId;
      const exit = await new Promise<Frame>((resolve, reject) => {
        try {
          backend.request(call.tag, this.hub.into(call.payload, vmId), (frame) => frame._tag === "Exit" && resolve(frame));
        } catch (error) {
          reject(error);
        }
      });
      if ((exit.exit as Wire | undefined)?._tag !== "Success") return call.client.send({ ...(this.hub.out(exit, vmId) as Wire), requestId: call.id });
      listed = this.hub.out((exit.exit as Wire).value, vmId) as Wire;
    } else {
      // The primary is asleep: its part comes from the remote, as for a project on one VM.
      const remote = await this.branches.refs(project, call.payload).catch(() => null);
      if (!remote) return this.vcsFallback(call);
      listed = remote;
    }
    const refs = (listed.refs as Wire[] | undefined) ?? [];
    const shown = new Set(refs.map((ref) => ref.name));
    const extra = elsewhere.filter((name) => !shown.has(name)).map((name) => ({ name, current: false, isDefault: false, worktreePath: null }));
    // They follow the primary's last page, so earlier pages and cursors stay as the primary gave them.
    this.reply(call, {
      ...listed,
      refs: listed.nextCursor == null ? [...refs, ...extra] : refs,
      totalCount: Number(listed.totalCount ?? 0) + extra.length,
    });
  }

  private async vcsFallback(call: Call) {
    const target = this.unreachableProject(call);
    if (!target) return this.forward(call);
    if (call.tag === "vcs.refreshBranch") return this.reply(call, null);
    if (call.tag === "vcs.refreshStatus") {
      const local = await this.branches.status(target.project, target.cwd);
      return this.reply(call, { ...local, hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null });
    }
    try {
      this.reply(call, await this.branches.refs(target.project, call.payload));
    } catch (error) {
      call.client.send(
        tagged(call.id, { _tag: "GitCommandError", operation: "listRefs", command: "git ls-remote", cwd: target.cwd, detail: message(error) }),
      );
    }
  }

  /**
   * VCS streams follow their VM: native while it is awake, VM Bridge's own answer while it sleeps. A project
   * root path follows the primary VM.
   */
  private async vcsSubscription(call: Call) {
    const cwd = str(call.payload.cwd);
    const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
    const routed = project ? undefined : this.hub.route(call.payload);
    let upstream: (() => void) | undefined;
    let closed = false;
    let generation = 0;
    const update = async () => {
      const serial = ++generation;
      upstream?.();
      upstream = undefined;
      const current = project ? this.hub.store.project(project.id) : null;
      const primary = current ? primaryVm(current) : undefined;
      const vmId = current ? primary?.vmId : routed;
      const backend = vmId && (!current || primary?.checkoutPath) ? this.hub.fleet.backend(vmId) : undefined;
      if (backend && vmId) {
        upstream = backend.request(call.tag, this.hub.into(call.payload, vmId), (frame) => {
          if (closed || serial !== generation || frame._tag === "Exit") return;
          call.client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
        });
      } else if (current && cwd) {
        const local = await this.branches.status(current, cwd);
        if (closed || serial !== generation) return;
        this.chunk(call, call.tag === "subscribeVcsBranch" ? { isRepo: local.isRepo, refName: local.refName } : { _tag: "snapshot", local, remote: null });
      }
    };
    const onLifecycle = (vmId: string) => {
      const current = project ? this.hub.store.project(project.id) : null;
      if ((current ? primaryVm(current)?.vmId : routed) === vmId) void update().catch(() => {});
    };
    this.hub.on("awake", onLifecycle);
    this.hub.on("offline", onLifecycle);
    const cancel = () => {
      closed = true;
      upstream?.();
      this.hub.off("awake", onLifecycle);
      this.hub.off("offline", onLifecycle);
    };
    call.client.cancels.set(String(call.id), cancel);
    try {
      await update();
    } catch (error) {
      cancel();
      call.client.cancels.delete(String(call.id));
      throw error;
    }
  }

  /** Worktree setup: VM Bridge's placement progress first, then the VM's own once it is connected. */
  private worktreeSetup(call: Call) {
    const threadId = str(call.payload.threadId);
    if (!threadId) return this.forward(call);
    let upstream: (() => void) | undefined;
    let attached: unknown;
    let nativeBase: number | undefined;
    const update = () => {
      if (nativeBase === undefined) this.chunk(call, this.hub.setupSnapshot(threadId));
      const vmId = this.hub.store.threadVm(threadId);
      const backend = vmId ? this.hub.fleet.backend(vmId) : undefined;
      if (!vmId || !backend || attached === backend) return;
      upstream?.();
      try {
        upstream = backend.request(call.tag, call.payload, (frame) => {
          if (frame._tag !== "Chunk") return;
          for (const snapshot of (frame.values ?? []) as (Wire | null)[]) {
            if (!snapshot) continue;
            // Continue the sequence from VM Bridge's own snapshots.
            nativeBase ??= Number(this.hub.setupSnapshot(threadId)?.sequence ?? -1) + 1;
            this.chunk(call, { ...this.hub.withBusyNotice(threadId, this.hub.out(snapshot, vmId) as Wire), sequence: nativeBase + Number(snapshot.sequence) });
          }
        });
        attached = backend;
      } catch {
        attached = undefined;
      }
    };
    const onSetup = (id: string) => id === threadId && update();
    const onAwake = (vmId: string) => this.hub.store.threadVm(threadId) === vmId && update();
    this.hub.on("setup", onSetup);
    this.hub.on("awake", onAwake);
    call.client.cancels.set(String(call.id), () => {
      this.hub.off("setup", onSetup);
      this.hub.off("awake", onAwake);
      upstream?.();
    });
    update();
  }

  /** A thread stream: live from the VM when awake, the cached transcript while it sleeps. */
  private async subscribeThread(call: Call) {
    const threadId = String(call.payload.threadId);
    const requestId = String(call.id);
    let end: (() => void) | undefined;
    let closed = false;
    // Routing can wait for a shell update, and a cancel or disconnect in that time must still stop the stream.
    call.client.cancels.set(requestId, () => {
      closed = true;
    });
    let vmId: string;
    try {
      vmId = await this.hub.routeSoon(call.payload);
    } catch (error) {
      call.client.cancels.delete(requestId);
      throw error;
    }
    if (closed || !call.client.open()) return;
    const attach = () => {
      const backend = this.hub.fleet.backend(vmId);
      if (!backend || closed) return;
      end?.();
      // Plain snapshots only: VM Bridge caches them, and a fresh one replaces the sleeping copy.
      const input: Wire = {
        ...call.payload,
        acceptBoundedSnapshot: false,
        acceptDeferredWork: false,
        acceptCompactIds: false,
        acceptCompactTurnItems: false,
        acceptDedupedBodies: false,
      };
      delete input.afterSequence;
      end = backend.request(call.tag, input, (frame) => {
        // The VM going to sleep ends the native stream; keep the client's stream open on the cache.
        if (frame._tag === "Exit" && this.hub.store.vm(vmId)?.state !== "ready") return;
        for (const item of (frame.values ?? []) as Wire[]) {
          if (item.kind === "snapshot") this.hub.cacheProjection(threadId, vmId, item.projection);
          else if (item.kind === "event") this.hub.refreshProjectionSoon(vmId, threadId);
        }
        call.client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
      });
    };
    const sleepingSnapshot = () => {
      const projection = this.hub.sleepingProjection(threadId, vmId);
      if (!projection) return false;
      this.chunk(call, { kind: "snapshot", snapshotSequence: this.hub.shellSequence(vmId), projection: this.hub.out(projection, vmId) });
      return true;
    };
    const onAwake = (id: string) => id === vmId && attach();
    const onWake = (id: string) => id === threadId && !this.hub.fleet.backend(vmId) && sleepingSnapshot();
    this.hub.on("awake", onAwake);
    this.hub.on("wake", onWake);
    const cancel = () => {
      closed = true;
      end?.();
      this.hub.off("awake", onAwake);
      this.hub.off("wake", onWake);
    };
    call.client.cancels.set(String(call.id), cancel);
    if (this.hub.fleet.backend(vmId)) return attach();
    if (!sleepingSnapshot()) {
      cancel();
      call.client.cancels.delete(String(call.id));
      throw new Error("This thread's VM is asleep and has no saved transcript. Send a message to wake it.");
    }
    if (call.payload.requestCompletionMarker) this.chunk(call, { kind: "synchronized" });
  }

  /** Routes a request to its VM, waking the VM only for requests that change something. */
  private async forward(call: Call) {
    const { tag, payload, client } = call;
    const scheduled = scheduleMutations.has(tag);
    if (!scheduled && !forwardable.test(tag) && tag !== "worktreeSetup.cancel" && tag !== "sourceControl.appAccess" && tag !== "sourceControl.lookupRepository") {
      throw new Error(`VM Bridge does not support '${tag}'.`);
    }
    if (["projects.createNew", "projects.ensureScratch"].includes(tag)) {
      throw new Error("Add a repository with Clone, so VM Bridge can put it on a VM.");
    }
    if (scheduled && (payload.schedule as Wire | undefined)?.type === "webhook") {
      throw new Error("Webhook automations need a directly reachable T3 server.");
    }
    if (tag === "orchestration.dispatchCommand" && heldCommandTypes.has(String(payload.type))) {
      const sequence = this.hub.holdCommand(payload);
      if (sequence !== null) return this.reply(call, { sequence });
    }
    const mutating = scheduled || tag === "orchestration.launchThread" || tag === "orchestration.dispatchCommand" || mutation.test(tag);
    const launching = tag === "orchestration.launchThread" ? str(payload.threadId) : undefined;
    const progress = (detail: string) => launching && this.hub.reportSetup(launching, detail);
    progress("Finding a VM for this project");

    const routed = scheduled
      ? await this.hub.scheduleTarget(tag, payload).then((vmId) => ({ vmId, payload: this.hub.into(payload, vmId) }))
      : await this.hub.prepare(tag, payload, mutating, progress);
    const { vmId } = routed;

    const awake = Boolean(this.hub.fleet.backend(vmId));
    if (!mutating && !awake) {
      const cached = tag === "orchestration.getThreadProjection" ? this.hub.store.projection(String(payload.threadId), vmId) : null;
      if (cached) return this.reply(call, this.hub.out(cached, vmId));
      throw new Error("This VM is asleep. Sending a message wakes it.");
    }

    const release = mutating ? this.hub.fleet.lease(vmId) : () => {};
    const threadId = str(payload.threadId);
    const wakeNotice =
      !awake && threadId && tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch" ? this.hub.beginWake(threadId, vmId) : undefined;
    progress(awake ? "Preparing the workspace" : "Starting the VM");
    let backend;
    try {
      backend = await this.hub.fleet.ensure(vmId);
    } catch (error) {
      release();
      throw error;
    } finally {
      wakeNotice?.();
    }
    // Placement and waking can take minutes. A device that left or was removed meanwhile gets nothing run for it.
    if (!client.open()) {
      release();
      if (launching) this.hub.reportSetup(launching, "The launch was interrupted.", "failed");
      return;
    }
    progress("Preparing the workspace");

    const started = performance.now();
    let done = false;
    let stop: () => void;
    try {
      stop = backend.request(tag, routed.payload, (frame) => {
        client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
        if (frame._tag !== "Exit") return;
        done = true;
        release();
        client.cancels.delete(String(call.id));
        const ok = (frame.exit as Wire | undefined)?._tag === "Success";
        this.traffic.record({ kind: "rpc", operation: tag, clientId: client.clientId, vmId, status: ok ? "ok" : "error", durationMs: Math.round(performance.now() - started) });
        if (launching) this.hub.reportSetup(launching, ok ? "Workspace handed to T3" : "T3 could not start the thread.", ok ? "done" : "failed");
      });
    } catch (error) {
      release();
      throw error;
    }
    call.forwarded = true;
    if (!done) {
      client.cancels.set(String(call.id), () => {
        release();
        stop();
        if (launching) this.hub.reportSetup(launching, "The launch was interrupted.", "failed");
      });
    }
  }
}
