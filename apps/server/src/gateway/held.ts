import { str, threadsOf, type Row, type Shell, type Wire } from "./types.ts";

/**
 * Commands that only change how T3 files a thread. VM Bridge applies these itself when the
 * thread's VM is asleep, unreachable or removed, instead of waking a VM to flip a sidebar flag.
 */
export const heldCommandTypes = new Set(["thread.settle", "thread.auto-settle", "thread.unsettle", "thread.archive", "thread.unarchive"]);

/**
 * Mirrors T3's own reducer for these commands on a cached shell. Re-applying a command gives the
 * same result, since `at` is when VM Bridge accepted it, so it can be laid over every VM update
 * until the VM confirms it.
 */
export function applyHeldCommand(shell: Shell, command: Wire, at: string) {
  const id = str(command.threadId);
  const thread = threadsOf(shell).find((row) => row.id === id);
  if (!thread) return;
  const next = changed(thread, command, at);
  if (next === thread) return;
  shell.threads = (shell.threads ?? []).filter((row) => row.id !== id);
  shell.archivedThreads = (shell.archivedThreads ?? []).filter((row) => row.id !== id);
  const field = next.archivedAt ? "archivedThreads" : "threads";
  shell[field] = [...shell[field]!, next];
}

function changed(thread: Row, command: Wire, at: string): Row {
  // T3 skips an automatic settle once the user chose a state or the thread moved on.
  if (
    command.type === "thread.auto-settle" &&
    (thread.settledOverride != null || Date.parse(String(thread.updatedAt)) > Date.parse(String(command.snapshotAt)))
  ) {
    return thread;
  }
  switch (command.type) {
    case "thread.settle":
    case "thread.auto-settle": {
      const already = thread.settledOverride === "settled" && thread.settledAt != null && thread.pinnedAt == null;
      return {
        ...thread,
        settledOverride: "settled",
        settledAt: already ? thread.settledAt : (str(command.settledAt) ?? at),
        unsettledAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: already ? thread.updatedAt : at,
      };
    }
    case "thread.unsettle": {
      const already = thread.settledOverride === "active";
      const restore = command.restoreUnsettledAt;
      return {
        ...thread,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: already ? (thread.unsettledAt ?? null) : restore === undefined ? at : restore,
        updatedAt: already ? thread.updatedAt : at,
      };
    }
    case "thread.archive":
      return thread.archivedAt ? thread : { ...thread, archivedAt: at, updatedAt: at };
    case "thread.unarchive":
      return thread.archivedAt ? { ...thread, archivedAt: null, updatedAt: at } : thread;
    default:
      return thread;
  }
}
