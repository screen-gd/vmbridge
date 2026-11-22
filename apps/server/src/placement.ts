import type { Usage } from "@vmbridge/contracts";

/**
 * When a VM has room for one more top-level thread. From a load test on 2 vCPU / 8 GB with each turn
 * installing, testing and building in its own worktree: up to 2 live turns per vCPU slowed turns at most
 * 2x with no failures, while 3 or more per vCPU made timing-sensitive tests fail. CPU use is no guide:
 * it is full at 2 turns and cannot tell 2 from 20.
 */
export const turnsPerVcpu = 2;
/** Used memory leaves out what the kernel can reclaim, so this leaves room for another turn's ~0.5 GB. */
export const maxMemoryUsed = 0.8;
export const minDiskFree = 3 * 1024 ** 3;
/** A project gets at most this many VMs, so a miscount can never create VMs without end. */
export const maxVmsPerProject = 4;
/** After a failed attempt to add a VM (quota, billing), new threads stop trying for this long. */
export const overflowRetryMs = 10 * 60_000;

/** What VM Bridge knows about one of a project's VMs when placing a thread. Unknown readings are null. */
export interface VmLoad {
  vmId: string;
  /** Connected now. A VM that is not has no running turns. */
  awake: boolean;
  /** Turns running, queued or waiting on an approval, plus threads just placed there that have not shown up yet. */
  turns: number;
  vcpus: number;
  memory: Usage | null;
  disk: Usage | null;
}

export type Choice = { kind: "use"; load: VmLoad; room: boolean } | { kind: "create" };

export function hasRoom(load: VmLoad) {
  if (load.turns >= turnsPerVcpu * load.vcpus) return false;
  if (load.memory && load.memory.used >= load.memory.total * maxMemoryUsed) return false;
  return !load.disk || load.disk.total - load.disk.used >= minDiskFree;
}

/**
 * Where a new top-level thread goes, given its project's VMs with the primary first: the least loaded awake
 * VM with room, else a sleeping one with room, else a new VM when allowed, else the least loaded awake VM
 * (the primary when none is awake) even without room. Null when there is no VM and none may be created.
 */
export function choose(loads: readonly VmLoad[], canCreate: boolean): Choice | null {
  const share = (load: VmLoad) => load.turns / load.vcpus;
  const awake = loads.filter((load) => load.awake).sort((a, b) => share(a) - share(b));
  const roomy = awake.find(hasRoom) ?? loads.find((load) => !load.awake && hasRoom(load));
  if (roomy) return { kind: "use", load: roomy, room: true };
  if (canCreate) return { kind: "create" };
  const fallback = awake[0] ?? loads[0];
  return fallback ? { kind: "use", load: fallback, room: false } : null;
}

/** Shown on a thread placed on a VM without room. */
export function busyNotice(load: VmLoad) {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (load.turns >= turnsPerVcpu * load.vcpus) {
    return `This VM is running ${plural(load.turns, "thread")} on ${plural(load.vcpus, "vCPU")}, so this one may be slow.`;
  }
  if (load.memory && load.memory.used >= load.memory.total * maxMemoryUsed) {
    return `This VM is using ${Math.round((load.memory.used / load.memory.total) * 100)}% of its memory, so this one may be slow.`;
  }
  return "This VM is low on disk space, so this thread may fail to write files.";
}

/** The vCPU count a provider's size label states, such as "2 vCPU, 8 GB". */
export const labelVcpus = (label: string) => Number(/(\d+(?:\.\d+)?) vCPU/.exec(label)?.[1] ?? 1);
