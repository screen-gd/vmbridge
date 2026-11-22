import type { AgentKind } from "@vmbridge/contracts";
import type { Box } from "../providers/index.ts";
import { check, root } from "./runtime.ts";

/** One file of a skill, relative to its folder. */
export interface SkillFile {
  path: string;
  /** Base64, so scripts and images survive as they are. */
  data: string;
  executable?: boolean;
}

/** The global instructions files every VM should have, one per agent. */
export type InstructionsState = { agent: AgentKind; hash: string; text: string }[];

/** The skills and instructions every VM should have. One fingerprint covers both. */
export interface SkillsState {
  fingerprint: string;
  skills: { name: string; hash: string }[];
  instructions: InstructionsState;
}

/** What the VM last applied, kept in `skills.json` next to the skills VM Bridge put there. */
interface Manifest {
  fingerprint: string;
  skills: Record<string, string>;
  /** The hash of each instructions file VM Bridge wrote and still manages. */
  instructions?: Partial<Record<AgentKind, string>>;
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export function skillHash(files: SkillFile[]) {
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(JSON.stringify(sorted.map((file) => [file.path, Boolean(file.executable), file.data])));
}

export const instructionHash = sha256;

/**
 * Identifies a set of skills and instructions, to tell when a VM has an older one. Instructions go in under `@agent`,
 * which no skill name can be, so a set without them keeps the fingerprint it had before VM Bridge synced instructions.
 */
export function skillsFingerprint(skills: { name: string; hash: string }[], instructions: { agent: AgentKind; hash: string }[] = []) {
  const entries = [...skills.map((skill) => [skill.name, skill.hash]), ...instructions.map((file) => [`@${file.agent}`, file.hash])];
  return sha256(JSON.stringify(entries.sort()));
}

/**
 * Runs on the VM with the folder VM Bridge keeps its files in. Applies `skills-incoming.json`: writes each skill
 * that came with files into `skills/<name>` (replacing the old copy whole, so deleted files go too), deletes the
 * skills the last manifest listed that are no longer wanted, and links every wanted skill into the folders Claude
 * Code and Codex read personal skills from. It only ever removes links that point into `skills/`, so skills a user
 * or a repository put on the VM stay, and one already there under the same name wins over VM Bridge's.
 *
 * It also writes each agent's global instructions file where that agent reads it, and deletes those no longer wanted.
 * VM Bridge only writes a file that is missing or still exactly what it last wrote there (or already what it wants).
 * Anything else was put there another way, or edited on the VM, so it is left alone and VM Bridge stops managing it.
 */
export const applyScript = `import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = process.argv[2];
const store = join(root, "skills");
const manifestPath = join(root, "skills.json");
const incomingPath = join(root, "skills-incoming.json");
const agentDirs = [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"), join(homedir(), ".agents", "skills")];
const instructionPaths = {
  claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "CLAUDE.md"),
  codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "AGENTS.md"),
  opencode: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "AGENTS.md"),
};
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

const incoming = JSON.parse(readFileSync(incomingPath, "utf8"));
const previous = exists(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { skills: {} };
const wanted = new Set(incoming.skills.map((skill) => skill.name));
mkdirSync(store, { recursive: true });

for (const skill of incoming.skills) {
  if (!skill.files) continue;
  const staging = join(store, "." + skill.name + ".new");
  rmSync(staging, { recursive: true, force: true });
  for (const file of skill.files) {
    const target = resolve(staging, file.path);
    if (!target.startsWith(staging + "/")) throw new Error("Unsafe path in " + skill.name + ": " + file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.data, "base64"), { mode: file.executable ? 0o755 : 0o644 });
  }
  rmSync(join(store, skill.name), { recursive: true, force: true });
  renameSync(staging, join(store, skill.name));
}
for (const name of Object.keys(previous.skills)) if (!wanted.has(name)) rmSync(join(store, name), { recursive: true, force: true });

for (const dir of agentDirs) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = resolve(dir, readlinkSync(path));
    if (dirname(target) === store && !wanted.has(basename(target))) rmSync(path);
  }
  for (const name of wanted) if (!exists(join(dir, name))) symlinkSync(join(store, name), join(dir, name));
}

const managed = {};
for (const [agent, path] of Object.entries(instructionPaths)) {
  const wanted = incoming.instructions.find((file) => file.agent === agent);
  let current = null;
  try {
    current = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // A folder, or a link to nothing, in the file's place is not VM Bridge's either.
    if (exists(path)) current = "unreadable";
  }
  const ours = current !== null && (current === previous.instructions?.[agent] || current === wanted?.hash);
  if (current !== null && !ours) continue;
  if (wanted) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".vmbridge-new", wanted.text, { mode: 0o600 });
    renameSync(path + ".vmbridge-new", path);
    managed[agent] = wanted.hash;
  } else if (ours) rmSync(path);
}

writeFileSync(
  manifestPath,
  JSON.stringify({ fingerprint: incoming.fingerprint, skills: Object.fromEntries(incoming.skills.map((skill) => [skill.name, skill.hash])), instructions: managed }),
);
rmSync(incomingPath);
`;

/**
 * Brings the VM's skills and instructions to `state`, sending only skills whose content the VM does not have.
 * Agents see them on their next session, so nothing restarts. Returns whether anything changed on the VM.
 * `manifestText` is the VM's `skills.json` when the caller already read it, null when it has none.
 */
export async function syncSkills(box: Box, state: SkillsState, files: (name: string) => SkillFile[], manifestText?: string | null) {
  const text = manifestText === undefined ? await box.files.read(`${root}/skills.json`).catch(() => null) : manifestText;
  let manifest: Manifest | null = null;
  try {
    if (text !== null) manifest = JSON.parse(text) as Manifest;
  } catch {
    // A damaged manifest counts as none: every skill is sent again.
  }
  if (manifest?.fingerprint === state.fingerprint) return false;
  const skills = state.skills.map((skill) => (manifest?.skills[skill.name] === skill.hash ? skill : { ...skill, files: files(skill.name) }));
  await box.files.write(
    { [`${root}/skills.mjs`]: applyScript, [`${root}/skills-incoming.json`]: JSON.stringify({ fingerprint: state.fingerprint, skills, instructions: state.instructions }) },
    { mode: 0o600 },
  );
  await check(box, `. ${root}/env && node ${root}/skills.mjs ${root}`, "Syncing skills");
  return true;
}
