/** A T3 wire object. VM Bridge reads a few known fields and forwards the rest untouched. */
export type Wire = Record<string, unknown>;

/** A shell row (project or thread): always has an ID. */
export type Row = Wire & { id: string };

export interface Shell extends Wire {
  projects?: Row[];
  threads?: Row[];
  archivedThreads?: Row[];
  snapshotSequence?: number;
}

export interface ShellItem extends Wire {
  kind: string;
  snapshot?: Shell;
  project?: Row;
  projectId?: string;
  thread?: Row;
  threadId?: string;
  location?: string;
  sequence?: number;
}

export interface ProviderEntry extends Wire {
  instanceId: string;
  driver: string;
  enabled?: boolean;
}

export interface ServerConfig extends Wire {
  environment?: Wire & { orchestrationProtocolVersion?: number; serverVersion?: string };
  providers?: ProviderEntry[];
  settings?: Wire;
}

export interface Projection extends Wire {
  thread?: Row;
  updatedAt?: string;
  turnItems?: (Wire & { ordinal?: number })[];
  visibleTurnItems?: (Wire & { position?: number })[];
  runs?: (Wire & { ordinal?: number })[];
}

export interface ScheduledTasks extends Wire {
  tasks: (Wire & { id: string; enabled?: boolean; blockedByPolicy?: boolean })[];
  timeZone?: string;
}

export const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export const threadsOf = (shell: Shell | undefined) => [...(shell?.threads ?? []), ...(shell?.archivedThreads ?? [])];

const busy = new Set(["preparing", "queued", "starting", "running", "waiting", "pending"]);

/** A running turn, queued work, or a pending approval. */
export const isWorking = (thread: Wire) =>
  Boolean(thread.activeRunId || thread.pendingRuntimeRequest) || busy.has(String(thread.status)) || busy.has(String(thread.activityRunStatus));

/** Working threads keep a VM awake. Open UIs do not. */
export const hasLiveWork = (shell: Shell) => threadsOf(shell).some(isWorking);
