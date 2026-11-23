import type { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { LocalSkill, SkillInfo, SkillSearchResult, SkillSource } from "@vmbridge/contracts";
import { Encryption } from "./encryption.ts";
import { Instructions } from "./instructions.ts";
import { Settings } from "./settings.ts";
import { skillHash, skillsFingerprint, type SkillFile, type SkillsState } from "./vm/skills.ts";

export class SkillError extends Error {}

interface SkillRow {
  name: string;
  source: SkillSource;
  ref: string;
  description: string | null;
  hash: string;
  files: string;
  installedAt: number;
  updatedAt: number;
}

const columns = "name, source, ref, description, hash, files, installed_at AS installedAt, updated_at AS updatedAt";
const skillsSh = "https://skills.sh";
/** A skill is a few instructions and scripts. Anything bigger is likely a folder picked by mistake. */
const maxBytes = 5 * 1024 * 1024;
const skipped = new Set([".git", "node_modules", ".DS_Store"]);
const validName = /^[A-Za-z0-9][\w.-]{0,99}$/;
const validRepo = /^[\w.-]+\/[\w.-]+$/;

const home = homedir();
const tildify = (path: string) => (path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);
const untildify = (path: string) => (path === "~" || path.startsWith("~/") ? home + path.slice(1) : path);

/** Where Claude Code and Codex read personal skills on this machine. */
function localRoots() {
  return [
    join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"),
    join(home, ".agents", "skills"),
    // Codex before ~/.agents/skills, still read by its skill installer.
    join(process.env.CODEX_HOME || join(home, ".codex"), "skills"),
  ];
}

const isSafePath = (path: string) => !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..");

/** The `description` from SKILL.md's front matter, including YAML's folded and literal block forms. */
export function skillDescription(skillMd: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1];
  if (!front) return null;
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) return null;
  let value = lines[at]!.slice("description:".length).trim();
  if (!value || /^[>|][+-]?$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line)) break;
      block.push(line.trim());
    }
    value = block.join(" ");
  }
  value = value.replace(/^(["'])(.*)\1$/, "$2").trim();
  return value ? value.slice(0, 400) : null;
}

function describe(files: SkillFile[]) {
  const skillMd = files.find((file) => file.path === "SKILL.md");
  return skillMd ? skillDescription(Buffer.from(skillMd.data, "base64").toString("utf8")) : null;
}

/** Every file in a local skill folder, following symlinks. */
export function readSkillFolder(dir: string): SkillFile[] {
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = (current: string, depth: number) => {
    if (depth > 8) return;
    for (const name of readdirSync(current).sort()) {
      if (skipped.has(name)) continue;
      const path = join(current, name);
      const info = statSync(path, { throwIfNoEntry: false });
      if (info?.isDirectory()) walk(path, depth + 1);
      else if (info?.isFile()) {
        bytes += info.size;
        if (bytes > maxBytes) throw new SkillError(`${tildify(dir)} is larger than 5 MB.`);
        const data = readFileSync(path).toString("base64");
        files.push({ path: relative(dir, path).split(sep).join("/"), data, ...(info.mode & 0o111 ? { executable: true } : {}) });
      }
    }
  };
  walk(dir, 0);
  if (!files.some((file) => file.path === "SKILL.md")) throw new SkillError(`${tildify(dir)} has no SKILL.md.`);
  return files;
}

/**
 * The skills every VM gets, kept in VM Bridge's database with their files: from skills.sh, or copied from a folder
 * on this machine and re-read when that folder changes. With `syncAll`, every skill in this machine's skill folders
 * is installed that way. The agents' global instructions files go to every VM with them, in the same sync. Emits
 * `changed` whenever the set, a skill's or instructions file's content, or `syncAll` changes.
 */
export class Skills extends EventEmitter<{ changed: [] }> {
  private readonly settings: Settings;
  readonly instructions: Instructions;

  constructor(
    private readonly db: Database,
    /** Skill files are stored encrypted: local skills can hold anything their folder does. */
    private readonly encryption: Encryption,
    /** The folders to find this machine's skills in. */
    private readonly roots = localRoots,
  ) {
    super();
    this.settings = new Settings(db);
    this.instructions = new Instructions(this.settings);
    this.instructions.on("changed", () => this.emit("changed"));
  }

  get syncAll() {
    return this.settings.get("syncLocalSkills");
  }

  /** Turning it off keeps the skills it installed until they are removed. */
  setSyncAll(sync: boolean) {
    this.settings.set("syncLocalSkills", sync);
    // The switch itself is part of what the dashboard shows, so it changed even when no skill did.
    if (!this.refreshLocal()) this.emit("changed");
  }

  private rows() {
    return this.db.query<SkillRow, []>(`SELECT ${columns} FROM skills ORDER BY name`).all();
  }

  private row(name: string) {
    return this.db.query<SkillRow, [string]>(`SELECT ${columns} FROM skills WHERE name = ?`).get(name);
  }

  list(): SkillInfo[] {
    return this.rows().map((row) => ({
      name: row.name,
      source: row.source,
      ref: row.source === "local" ? tildify(row.ref) : row.ref,
      description: row.description,
      updatedAt: row.updatedAt,
    }));
  }

  state(): SkillsState {
    const skills = this.db.query<{ name: string; hash: string }, []>("SELECT name, hash FROM skills ORDER BY name").all();
    const instructions = this.instructions.state();
    return { fingerprint: skillsFingerprint(skills, instructions), skills, instructions };
  }

  files(name: string): SkillFile[] {
    const row = this.row(name);
    if (!row) throw new Error(`The skill ${name} is no longer installed.`);
    return JSON.parse(this.encryption.open(row.files, `skill:${name}`)) as SkillFile[];
  }

  /** Encrypts skill files saved before they were encrypted. Returns how many skills. */
  sealPlaintext(): number {
    const rows = this.db
      .query<{ name: string; files: string }, []>("SELECT name, files FROM skills")
      .all()
      .filter((row) => !Encryption.isSealed(row.files));
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.query("UPDATE skills SET files = ? WHERE name = ?").run(this.encryption.seal(row.files, `skill:${row.name}`), row.name);
      }
    })();
    return rows.length;
  }

  private save(name: string, source: SkillSource, ref: string, files: SkillFile[]) {
    const hash = skillHash(files);
    const existing = this.row(name);
    if (existing?.hash === hash && existing.ref === ref) return false;
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO skills (name, source, ref, description, hash, files, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET source = excluded.source, ref = excluded.ref, description = excluded.description, hash = excluded.hash,
           files = excluded.files, updated_at = excluded.updated_at`,
      )
      .run(name, source, ref, describe(files), hash, this.encryption.seal(JSON.stringify(files), `skill:${name}`), now, now);
    this.emit("changed");
    return true;
  }

  private claim(name: string, source: SkillSource, ref: string) {
    if (!validName.test(name)) throw new SkillError(`${name} is not a usable skill folder name.`);
    const existing = this.row(name);
    if (existing && (existing.source !== source || existing.ref !== ref)) {
      throw new SkillError(`A skill named ${name} is already installed from ${existing.source === "local" ? tildify(existing.ref) : existing.ref}.`);
    }
  }

  async search(query: string): Promise<SkillSearchResult[]> {
    const response = await fetch(`${skillsSh}/api/search?${new URLSearchParams({ q: query })}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`skills.sh answered ${response.status}.`);
    const { skills } = (await response.json()) as { skills: { source?: string; skillId?: string; name?: string; installs?: number }[] };
    return skills.flatMap((skill) =>
      skill.source && validRepo.test(skill.source) && skill.skillId && validName.test(skill.skillId)
        ? [{ source: skill.source, skillId: skill.skillId, name: skill.name ?? skill.skillId, installs: skill.installs ?? 0 }]
        : [],
    );
  }

  /** Installs, or updates to what skills.sh has now. Returns whether anything changed. */
  async installFromSkillsSh(source: string, skillId: string) {
    if (!validRepo.test(source)) throw new SkillError("Name the repository as owner/repo.");
    this.claim(skillId, "skills.sh", source);
    const [owner, repo] = source.toLowerCase().split("/") as [string, string];
    const url = `${skillsSh}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(skillId)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) throw new SkillError(`skills.sh has no files for ${source}/${skillId}.`);
    if (!response.ok) throw new Error(`skills.sh answered ${response.status}.`);
    const download = (await response.json()) as { files?: { path?: unknown; contents?: unknown }[] };
    const files: SkillFile[] = [];
    for (const file of download.files ?? []) {
      if (typeof file.path !== "string" || typeof file.contents !== "string" || !isSafePath(file.path)) {
        throw new SkillError(`skills.sh sent an unusable file for ${skillId}.`);
      }
      files.push({ path: file.path, data: Buffer.from(file.contents).toString("base64") });
    }
    if (!files.some((file) => file.path === "SKILL.md")) throw new SkillError(`skills.sh sent no SKILL.md for ${skillId}.`);
    return this.save(skillId, "skills.sh", source, files);
  }

  async update(name: string) {
    const row = this.row(name);
    if (!row) throw new SkillError("That skill is not installed.");
    if (row.source === "local") throw new SkillError("Local skills update on their own when their files change.");
    return this.installFromSkillsSh(row.ref, row.name);
  }

  installLocal(path: string) {
    let dir: string;
    try {
      dir = realpathSync(untildify(path));
    } catch {
      throw new SkillError(`${path} does not exist.`);
    }
    const name = basename(dir);
    this.claim(name, "local", dir);
    return this.save(name, "local", dir, readSkillFolder(dir));
  }

  remove(name: string) {
    if (this.db.query("DELETE FROM skills WHERE name = ?").run(name).changes) this.emit("changed");
  }

  /** Skills in this machine's Claude Code and Codex skill folders. */
  discover(): LocalSkill[] {
    const names = new Set(this.rows().map((row) => row.name));
    return this.scan().map(({ name, dir, description }) => ({ name, path: tildify(dir), description, installed: names.has(name) }));
  }

  private scan() {
    const seen = new Set<string>();
    const found: { name: string; dir: string; description: string | null }[] = [];
    for (const root of this.roots()) {
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith(".")) continue;
        let dir: string;
        let skillMd: string;
        try {
          dir = realpathSync(join(root, entry));
          skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
        } catch {
          continue;
        }
        if (seen.has(dir)) continue;
        seen.add(dir);
        found.push({ name: basename(dir), dir, description: skillDescription(skillMd) });
      }
    }
    return found;
  }

  /**
   * Re-reads installed local skills, saving those whose files changed. A folder that is gone keeps its last copy, or
   * with `syncAll` is removed, and every skill new on this machine is installed. Two folders with the same skill name:
   * the first in `localRoots` order wins. A skill too big to read is skipped, keeping any copy it had.
   */
  refreshLocal() {
    const all = this.syncAll;
    let changed = false;
    for (const row of this.rows().filter((entry) => entry.source === "local")) {
      let files: SkillFile[];
      try {
        files = readSkillFolder(row.ref);
      } catch {
        if (all && !existsSync(join(row.ref, "SKILL.md"))) {
          this.remove(row.name);
          changed = true;
        }
        continue;
      }
      if (this.save(row.name, "local", row.ref, files)) changed = true;
    }
    if (!all) return changed;
    const names = new Set(this.rows().map((row) => row.name));
    for (const { name, dir } of this.scan()) {
      if (names.has(name) || !validName.test(name)) continue;
      names.add(name);
      try {
        if (this.save(name, "local", dir, readSkillFolder(dir))) changed = true;
      } catch {}
    }
    return changed;
  }
}
