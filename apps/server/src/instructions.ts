import { EventEmitter } from "node:events";
import { agentKinds, instructionFor, instructionNames, uploadLimits, type AgentKind, type InstructionFile, type InstructionName } from "@vmbridge/contracts";
import { Encryption } from "./encryption.ts";
import type { Settings, Plaintext } from "./settings.ts";
import type { Machine } from "./skills.ts";
import type { Sql } from "./sql.ts";
import { instructionHash, type InstructionsState } from "./vm/skills.ts";

export class InstructionsError extends Error {}

const context = (name: InstructionName) => `instructions:${name}`;

/**
 * The agents' global instructions every VM gets: AGENTS.md and CLAUDE.md pasted in the dashboard, stored encrypted, and
 * on Bun the files on this machine that are switched on. A pasted file wins over the machine's file for the agents
 * that read it. Machine files are read fresh by `refresh` and kept only in memory: they often hold personal details,
 * so they are never stored or logged. Emits `changed` when what VMs should get, or a switch, changes.
 */
export class Instructions extends EventEmitter<{ changed: [] }> {
  private found: Partial<Record<AgentKind, { path: string; text: string; hash: string }>> = {};

  constructor(
    private readonly db: Sql,
    private readonly encryption: Encryption,
    private readonly settings: Settings,
    private readonly machine?: Machine,
  ) {
    super();
  }

  /** The machine's files, with whether each is switched on. */
  list(): InstructionFile[] {
    const sync = this.settings.get("instructionSync");
    return agentKinds.flatMap((agent) => {
      const file = this.found[agent];
      return file ? [{ agent, path: file.path, sync: sync[agent] === true }] : [];
    });
  }

  setSync(agent: AgentKind, sync: boolean) {
    this.settings.set("instructionSync", { ...this.settings.get("instructionSync"), [agent]: sync });
    this.emit("changed");
  }

  /** The pasted files' text. */
  saved(): Partial<Record<InstructionName, string>> {
    const rows = this.db.all<{ name: InstructionName; text: string }>("SELECT name, text FROM instructions");
    return Object.fromEntries(rows.map((row) => [row.name, this.encryption.open(row.text, context(row.name))]));
  }

  savedNames(): InstructionName[] {
    return this.db.all<{ name: InstructionName }>("SELECT name FROM instructions ORDER BY name").map((row) => row.name);
  }

  /** Saves a pasted file. Blank text removes it, and VMs drop the copy VM Bridge wrote. */
  save(name: InstructionName, text: string) {
    if (new TextEncoder().encode(text).length > uploadLimits.instructionBytes) throw new InstructionsError(`${name} is larger than 256 KB.`);
    if (!text.trim()) {
      if (this.db.run("DELETE FROM instructions WHERE name = ?", name)) this.emit("changed");
      return;
    }
    if (this.saved()[name] === text) return;
    this.db.run(
      "INSERT INTO instructions (name, text, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
      name, this.encryption.seal(text, context(name)), Date.now(),
    );
    this.emit("changed");
  }

  /** The file every VM should have per agent: the pasted one, or else the machine's file if switched on. */
  state(): InstructionsState {
    const sync = this.settings.get("instructionSync");
    const saved = this.saved();
    return agentKinds.flatMap((agent) => {
      const text = saved[instructionFor[agent]];
      if (text !== undefined) return [{ agent, text, hash: instructionHash(text) }];
      const file = this.found[agent];
      return file && sync[agent] ? [{ agent, text: file.text, hash: file.hash }] : [];
    });
  }

  /** Re-reads every agent's file on the machine. Returns whether any appeared, changed or went. */
  refresh() {
    if (!this.machine) return false;
    let changed = false;
    for (const agent of agentKinds) {
      const read = this.machine.instructions(agent);
      const file = read && { ...read, hash: instructionHash(read.text) };
      if (file?.hash === this.found[agent]?.hash) continue;
      if (file) this.found[agent] = file;
      else delete this.found[agent];
      changed = true;
    }
    if (changed) this.emit("changed");
    return changed;
  }

  /** Encrypts, or drops, pasted files stored unencrypted (see `Plaintext`). Returns what it changed. */
  plaintext(action: Plaintext): string[] {
    const rows = this.db.all<{ name: InstructionName; text: string }>("SELECT name, text FROM instructions").filter((row) => !Encryption.isSealed(row.text));
    this.db.transaction(() => {
      for (const row of rows) {
        if (action === "seal") this.db.run("UPDATE instructions SET text = ? WHERE name = ?", this.encryption.seal(row.text, context(row.name)), row.name);
        else this.db.run("DELETE FROM instructions WHERE name = ?", row.name);
      }
    });
    return rows.map((row) => `pasted ${row.name}`);
  }
}

export const isInstructionName = (value: string): value is InstructionName => instructionNames.some((name) => name === value);
