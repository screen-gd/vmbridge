import type { Database } from "bun:sqlite";
import type { ProviderId, VmSize, VmState } from "@vmbridge/contracts";

export interface VmRow {
  id: string;
  provider: ProviderId;
  sandboxId: string | null;
  name: string;
  size: VmSize;
  state: VmState;
  error: string | null;
  t3Token: string | null;
  t3Version: string | null;
  /** Fingerprint of the sign-ins the VM's running T3 server started with (see `credentialsFingerprint`). */
  t3Credentials: string | null;
  /** Fingerprint of the skills the VM last got (see `skillsFingerprint`). */
  skills: string | null;
  checkpoint: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  lastConnectedAt: number | null;
  lastSleptAt: number | null;
}

/** One VM holding a project. */
export interface ProjectVm {
  vmId: string;
  /** Absolute checkout path on the VM, once cloned. */
  checkoutPath: string | null;
}

export interface ProjectRow {
  id: string;
  url: string;
  branch: string | null;
  title: string;
  createdAt: number;
  /** VMs holding this project, primary (the first added) first. */
  vms: ProjectVm[];
}

/** The VM a project's root path and new automations go to. */
export const primaryVm = (project: ProjectRow): ProjectVm | undefined => project.vms[0];

const vmColumns = `id, provider, sandbox_id AS sandboxId, name, size, state, error, t3_token AS t3Token,
  t3_version AS t3Version, t3_credentials AS t3Credentials, skills, checkpoint, created_at AS createdAt, last_activity_at AS lastActivityAt,
  last_connected_at AS lastConnectedAt, last_slept_at AS lastSleptAt`;

const projectColumns = `id, url, branch, title, created_at AS createdAt`;

const vmFields = {
  sandboxId: "sandbox_id",
  state: "state",
  error: "error",
  t3Token: "t3_token",
  t3Version: "t3_version",
  t3Credentials: "t3_credentials",
  skills: "skills",
  checkpoint: "checkpoint",
  lastActivityAt: "last_activity_at",
  lastConnectedAt: "last_connected_at",
  lastSleptAt: "last_slept_at",
} as const satisfies Partial<Record<keyof VmRow, string>>;

type VmUpdate = Partial<Pick<VmRow, keyof typeof vmFields>>;

const projectFields = { branch: "branch", title: "title" } as const;

type ProjectUpdate = Partial<Pick<ProjectRow, keyof typeof projectFields>>;

/** The snapshot new VMs of one provider and size start from. */
export interface BaseSnapshot {
  snapshot: string | null;
  /** `setupStamp` of what the snapshot holds. */
  stamp: string | null;
  createdAt: number | null;
  /** The sandbox building the next snapshot, kept until it is deleted so a build cut short by a restart is cleaned up. */
  builder: string | null;
}

const baseFields = { snapshot: "snapshot", stamp: "stamp", createdAt: "created_at", builder: "builder" } as const;

/** `start` is a new VM's first start, `wake` a start from sleep. */
export type VmEventKind = "create" | "start" | "wake" | "sleep" | "delete";

export interface VmEvent {
  at: number;
  vmId: string;
  provider: ProviderId;
  size: VmSize;
  kind: VmEventKind;
  durationMs: number | null;
}

/** One agent turn (a T3 run) VM Bridge saw. */
export interface Turn {
  threadId: string;
  runId: string;
  at: number;
  vmId: string;
  provider: ProviderId;
  /** The project's URL. */
  repo: string | null;
  /** T3's agent instance, such as `codex`. */
  agent: string | null;
  model: string | null;
}

/** JSON caches of what each VM's T3 server last reported, kept so sleeping VMs still render. */
type SnapshotKind = "shell" | "config" | "scheduled_tasks";

function assignments<T extends object>(fields: Record<string, string>, update: T) {
  const entries = Object.entries(update).filter(([key]) => key in fields);
  return {
    sql: entries.map(([key]) => `${fields[key]} = ?`).join(", "),
    values: entries.map(([, value]) => value as string | number | null),
  };
}

/** Typed access to fleet, project, and routing tables. */
export class Store {
  /** Projects are read on every routed frame for path rewriting, so they are kept in memory. */
  private projectCache: ProjectRow[] | null = null;

  constructor(readonly db: Database) {}

  vms(): VmRow[] {
    return this.db.query<VmRow, []>(`SELECT ${vmColumns} FROM vms ORDER BY created_at`).all();
  }

  vm(id: string): VmRow | null {
    return this.db.query<VmRow, [string]>(`SELECT ${vmColumns} FROM vms WHERE id = ?`).get(id);
  }

  insertVm(vm: Pick<VmRow, "id" | "provider" | "name" | "size" | "state" | "createdAt">) {
    this.db
      .query("INSERT INTO vms (id, provider, name, size, state, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(vm.id, vm.provider, vm.name, vm.size, vm.state, vm.createdAt);
  }

  updateVm(id: string, update: VmUpdate) {
    const { sql, values } = assignments(vmFields, update);
    if (sql) this.db.query(`UPDATE vms SET ${sql} WHERE id = ?`).run(...values, id);
  }

  base(provider: ProviderId, size: VmSize): BaseSnapshot | null {
    return this.db
      .query<BaseSnapshot, [string, string]>(
        "SELECT snapshot, stamp, created_at AS createdAt, builder FROM base_snapshots WHERE provider = ? AND size = ?",
      )
      .get(provider, size);
  }

  bases(provider: ProviderId): (BaseSnapshot & { size: VmSize })[] {
    return this.db
      .query<BaseSnapshot & { size: VmSize }, [string]>(
        "SELECT size, snapshot, stamp, created_at AS createdAt, builder FROM base_snapshots WHERE provider = ?",
      )
      .all(provider);
  }

  /** Build VMs on record, of one provider or all. */
  builders(provider?: ProviderId): { provider: ProviderId; size: VmSize; builder: string }[] {
    return this.db
      .query<{ provider: ProviderId; size: VmSize; builder: string }, [string | null]>(
        "SELECT provider, size, builder FROM base_snapshots WHERE builder IS NOT NULL AND (?1 IS NULL OR provider = ?1)",
      )
      .all(provider ?? null);
  }

  saveBase(provider: ProviderId, size: VmSize, update: Partial<BaseSnapshot>) {
    const { sql, values } = assignments(baseFields, update);
    this.db.query("INSERT INTO base_snapshots (provider, size) VALUES (?, ?) ON CONFLICT DO NOTHING").run(provider, size);
    if (sql) this.db.query(`UPDATE base_snapshots SET ${sql} WHERE provider = ? AND size = ?`).run(...values, provider, size);
  }

  deleteBase(provider: ProviderId, size: VmSize) {
    this.db.query("DELETE FROM base_snapshots WHERE provider = ? AND size = ?").run(provider, size);
  }

  retiredSnapshots(provider: ProviderId): string[] {
    return this.db
      .query<{ snapshot: string }, [string]>("SELECT snapshot FROM retired_snapshots WHERE provider = ?")
      .all(provider)
      .map((row) => row.snapshot);
  }

  retireSnapshot(provider: ProviderId, snapshot: string) {
    this.db.query("INSERT INTO retired_snapshots (provider, snapshot) VALUES (?, ?) ON CONFLICT DO NOTHING").run(provider, snapshot);
  }

  forgetRetired(provider: ProviderId, snapshot: string) {
    this.db.query("DELETE FROM retired_snapshots WHERE provider = ? AND snapshot = ?").run(provider, snapshot);
  }

  /** Forgets a VM. Its projects stay, on their other VMs or a fresh one next time they are used. */
  deleteVm(id: string) {
    // Its project_vms rows go with it (ON DELETE CASCADE).
    this.db.query("DELETE FROM vms WHERE id = ?").run(id);
    this.projectCache = null;
  }

  projects(): readonly ProjectRow[] {
    if (!this.projectCache) {
      const links = this.db
        .query<ProjectVm & { projectId: string }, []>(
          "SELECT project_id AS projectId, vm_id AS vmId, checkout_path AS checkoutPath FROM project_vms ORDER BY added_at, rowid",
        )
        .all();
      this.projectCache = this.db
        .query<Omit<ProjectRow, "vms">, []>(`SELECT ${projectColumns} FROM projects ORDER BY created_at`)
        .all()
        .map((project) => ({
          ...project,
          vms: links.filter((link) => link.projectId === project.id).map(({ vmId, checkoutPath }) => ({ vmId, checkoutPath })),
        }));
    }
    return this.projectCache;
  }

  project(id: string): ProjectRow | null {
    return this.projects().find((project) => project.id === id) ?? null;
  }

  insertProject(project: Omit<ProjectRow, "vms">) {
    this.db
      .query("INSERT INTO projects (id, url, branch, title, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.url, project.branch, project.title, project.createdAt);
    this.projectCache = null;
  }

  updateProject(id: string, update: ProjectUpdate) {
    const { sql, values } = assignments(projectFields, update);
    if (sql) this.db.query(`UPDATE projects SET ${sql} WHERE id = ?`).run(...values, id);
    this.projectCache = null;
  }

  /** Adds a VM to a project, after its existing ones. */
  addProjectVm(projectId: string, vmId: string) {
    this.db
      .query("INSERT OR IGNORE INTO project_vms (project_id, vm_id, added_at) VALUES (?, ?, ?)")
      .run(projectId, vmId, Date.now());
    this.projectCache = null;
  }

  setCheckout(projectId: string, vmId: string, checkoutPath: string) {
    this.db.query("UPDATE project_vms SET checkout_path = ? WHERE project_id = ? AND vm_id = ?").run(checkoutPath, projectId, vmId);
    this.projectCache = null;
  }

  /** The local branches a project's checkout on a VM had when VM Bridge last read them. */
  branches(projectId: string, vmId: string): string[] {
    const row = this.db
      .query<{ branches: string | null }, [string, string]>("SELECT branches FROM project_vms WHERE project_id = ? AND vm_id = ?")
      .get(projectId, vmId);
    return row?.branches ? (JSON.parse(row.branches) as string[]) : [];
  }

  setBranches(projectId: string, vmId: string, branches: readonly string[]) {
    this.db.query("UPDATE project_vms SET branches = ? WHERE project_id = ? AND vm_id = ?").run(JSON.stringify(branches), projectId, vmId);
  }

  /** Takes a VM away from every project it held, such as when the provider lost it. */
  removeVmFromProjects(vmId: string) {
    this.db.query("DELETE FROM project_vms WHERE vm_id = ?").run(vmId);
    this.projectCache = null;
  }

  deleteProject(id: string) {
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
    this.projectCache = null;
  }

  snapshot<T>(vmId: string, kind: SnapshotKind): T | null {
    const row = this.db
      .query<{ value: string | null }, [string]>(`SELECT ${kind} AS value FROM vm_snapshots WHERE vm_id = ?`)
      .get(vmId);
    return row?.value ? (JSON.parse(row.value) as T) : null;
  }

  snapshots<T>(kind: SnapshotKind): Map<string, T> {
    const rows = this.db
      .query<{ vmId: string; value: string }, []>(
        `SELECT vm_id AS vmId, ${kind} AS value FROM vm_snapshots WHERE ${kind} IS NOT NULL`,
      )
      .all();
    return new Map(rows.map((row) => [row.vmId, JSON.parse(row.value) as T]));
  }

  saveSnapshot(vmId: string, kind: SnapshotKind, value: unknown) {
    this.db
      .query(
        `INSERT INTO vm_snapshots (vm_id, ${kind}) VALUES (?, ?) ON CONFLICT (vm_id) DO UPDATE SET ${kind} = excluded.${kind}`,
      )
      .run(vmId, JSON.stringify(value));
  }

  threadVm(threadId: string): string | null {
    return (
      this.db.query<{ vmId: string }, [string]>("SELECT vm_id AS vmId FROM threads WHERE id = ?").get(threadId)?.vmId ??
      null
    );
  }

  setThreadVm(threadId: string, vmId: string) {
    this.db
      .query("INSERT INTO threads (id, vm_id) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET vm_id = excluded.vm_id")
      .run(threadId, vmId);
  }

  command(id: string) {
    return this.db
      .query<{ vmId: string; fingerprint: string; threadId: string | null }, [string]>(
        "SELECT vm_id AS vmId, fingerprint, thread_id AS threadId FROM commands WHERE id = ?",
      )
      .get(id);
  }

  saveCommand(id: string, vmId: string, fingerprint: string, threadId: string | null) {
    this.db
      .query("INSERT OR IGNORE INTO commands (id, vm_id, fingerprint, thread_id) VALUES (?, ?, ?, ?)")
      .run(id, vmId, fingerprint, threadId);
  }

  projection<T>(threadId: string): T | null {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM projections WHERE thread_id = ?")
      .get(threadId);
    return row ? (JSON.parse(row.data) as T) : null;
  }

  hasProjection(threadId: string) {
    return this.db.query("SELECT 1 FROM projections WHERE thread_id = ?").get(threadId) !== null;
  }

  /** Keeps the newest projection: a late, older response never replaces a newer one. */
  saveProjection(threadId: string, vmId: string, updatedAt: string | null, data: unknown) {
    this.db
      .query(
        `INSERT INTO projections (thread_id, vm_id, updated_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET vm_id = excluded.vm_id, updated_at = excluded.updated_at, data = excluded.data
         WHERE projections.updated_at IS NULL OR excluded.updated_at IS NULL OR excluded.updated_at >= projections.updated_at`,
      )
      .run(threadId, vmId, updatedAt, JSON.stringify(data));
  }

  clones<T>(): T[] {
    return this.db
      .query<{ snapshot: string }, []>("SELECT snapshot FROM clones")
      .all()
      .map((row) => JSON.parse(row.snapshot) as T);
  }

  saveClone(projectId: string, snapshot: unknown) {
    this.db
      .query(
        "INSERT INTO clones (project_id, snapshot) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET snapshot = excluded.snapshot",
      )
      .run(projectId, JSON.stringify(snapshot));
  }

  recordVmEvent(vm: Pick<VmRow, "id" | "provider" | "size">, kind: VmEventKind, durationMs: number | null = null, at = Date.now()) {
    this.db
      .query("INSERT INTO vm_events (at, vm_id, provider, size, kind, duration_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(at, vm.id, vm.provider, vm.size, kind, durationMs);
  }

  vmEvents(from: number, to: number): VmEvent[] {
    return this.db
      .query<VmEvent, [number, number]>(
        "SELECT at, vm_id AS vmId, provider, size, kind, duration_ms AS durationMs FROM vm_events WHERE at >= ? AND at < ? ORDER BY at, id",
      )
      .all(from, to);
  }

  /** Keeps the first sighting: the same run seen again changes nothing. */
  recordTurn(turn: Turn) {
    this.db
      .query("INSERT OR IGNORE INTO turns (thread_id, run_id, at, vm_id, provider, repo, agent, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(turn.threadId, turn.runId, turn.at, turn.vmId, turn.provider, turn.repo, turn.agent, turn.model);
  }

  turns(from: number, to: number): Turn[] {
    return this.db
      .query<Turn, [number, number]>(
        `SELECT thread_id AS threadId, run_id AS runId, at, vm_id AS vmId, provider, repo, agent, model
         FROM turns WHERE at >= ? AND at < ? ORDER BY at`,
      )
      .all(from, to);
  }

  /** Background failures in a range, with the provider of their VM when they name only the VM. */
  errorsIn(from: number, to: number): { at: number; provider: ProviderId | null }[] {
    return this.db
      .query<{ at: number; provider: ProviderId | null }, [number, number]>(
        `SELECT e.at, COALESCE(e.provider, v.provider, (SELECT provider FROM vm_events WHERE vm_id = e.vm_id LIMIT 1)) AS provider
         FROM errors e LEFT JOIN vms v ON v.id = e.vm_id WHERE e.at >= ? AND e.at < ? ORDER BY e.at`,
      )
      .all(from, to);
  }

  /** Thread commands applied while their VM was away, waiting to be replayed on it. Oldest first. */
  heldCommands(vmId: string) {
    return this.db
      .query<{ id: string; payload: string; createdAt: number }, [string]>(
        "SELECT id, payload, created_at AS createdAt FROM held_commands WHERE vm_id = ? ORDER BY created_at, rowid",
      )
      .all(vmId)
      .map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.createdAt }));
  }

  holdCommand(id: string, vmId: string, payload: unknown, createdAt: number) {
    this.db
      .query("INSERT OR IGNORE INTO held_commands (id, vm_id, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(id, vmId, JSON.stringify(payload), createdAt);
  }

  dropHeldCommand(id: string) {
    this.db.query("DELETE FROM held_commands WHERE id = ?").run(id);
  }
}
