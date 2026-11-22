import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { agentKinds, type AgentKind, type InstructionFile } from "@vmbridge/contracts";
import type { Settings } from "./settings.ts";
import { instructionHash, type InstructionsState } from "./vm/skills.ts";

const home = homedir();
const tildify = (path: string) => (path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);

/**
 * Where each agent reads its global instructions on this machine. Claude Code reads CLAUDE.md in its config folder,
 * Codex AGENTS.md in its home, and OpenCode AGENTS.md in its XDG config folder.
 */
const localPath: Record<AgentKind, () => string> = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "CLAUDE.md"),
  codex: () => join(process.env.CODEX_HOME || join(home, ".codex"), "AGENTS.md"),
  opencode: () => join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "AGENTS.md"),
};

/**
 * The agents' global instructions files on this machine, and which of them every VM gets. Files are read fresh by
 * `refresh` and kept only in memory: they often hold personal details, so they are never stored or logged.
 * Emits `changed` when a file appears, changes or goes, or its sync is switched.
 */
export class Instructions extends EventEmitter<{ changed: [] }> {
  private found: Partial<Record<AgentKind, { text: string; hash: string }>> = {};

  constructor(private readonly settings: Settings) {
    super();
  }

  list(): InstructionFile[] {
    const sync = this.settings.get("instructionSync");
    return agentKinds.flatMap((agent) => (this.found[agent] ? [{ agent, path: tildify(localPath[agent]()), sync: sync[agent] === true }] : []));
  }

  setSync(agent: AgentKind, sync: boolean) {
    this.settings.set("instructionSync", { ...this.settings.get("instructionSync"), [agent]: sync });
    this.emit("changed");
  }

  /** The files every VM should have: switched on and present on this machine. */
  state(): InstructionsState {
    const sync = this.settings.get("instructionSync");
    return agentKinds.flatMap((agent) => {
      const file = this.found[agent];
      return file && sync[agent] ? [{ agent, ...file }] : [];
    });
  }

  /** Re-reads every agent's file. Returns whether any appeared, changed or went. */
  refresh() {
    let changed = false;
    for (const agent of agentKinds) {
      let text: string | undefined;
      try {
        text = readFileSync(localPath[agent](), "utf8");
      } catch {}
      const file = text === undefined ? undefined : { text, hash: instructionHash(text) };
      if (file?.hash === this.found[agent]?.hash) continue;
      if (file) this.found[agent] = file;
      else delete this.found[agent];
      changed = true;
    }
    if (changed) this.emit("changed");
    return changed;
  }
}
