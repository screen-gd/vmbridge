import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { AgentKind } from "@vmbridge/contracts";
import { SkillError, skillDescription, type Machine } from "../skills.ts";
import type { SkillFile } from "../vm/skills.ts";

/** A local skill is a few instructions and scripts. Anything bigger is likely a folder picked by mistake. */
const maxBytes = 5 * 1024 * 1024;
const skipped = new Set([".git", "node_modules", ".DS_Store"]);

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

/**
 * Where each agent reads its global instructions on this machine. Claude Code reads CLAUDE.md in its config folder,
 * Codex AGENTS.md in its home, and OpenCode AGENTS.md in its XDG config folder.
 */
const instructionPath: Record<AgentKind, () => string> = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "CLAUDE.md"),
  codex: () => join(process.env.CODEX_HOME || join(home, ".codex"), "AGENTS.md"),
  opencode: () => join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "AGENTS.md"),
};

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

/**
 * Every file in a local skill folder. The folder may itself be a link (a skill kept in some repository), but inside it
 * only links that stay inside it are followed: the files go to every VM, so a link to `~/.ssh` must not carry its
 * target along. Nothing in `exclude` (VM Bridge's data folder) is read either way. Sockets, pipes and devices are
 * skipped. A hard link can't be told apart from an ordinary file, but git never makes one, so cloned skills have none.
 */
export function readSkillFolder(dir: string, exclude?: string): SkillFile[] {
  const root = realpathSync(dir);
  let excluded: string | undefined;
  try {
    excluded = exclude && realpathSync(exclude);
  } catch {}
  const files: SkillFile[] = [];
  let bytes = 0;
  /** `above` holds the real folders this one is in, so a link back up to one of them is not walked again and again. */
  const walk = (current: string, above: string[]) => {
    // The skill folder and eight levels below it.
    if (above.length > 9) return;
    for (const name of readdirSync(current).sort()) {
      if (skipped.has(name)) continue;
      const path = join(current, name);
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (!inside(real, root) || (excluded && inside(real, excluded))) continue;
      const info = statSync(real, { throwIfNoEntry: false });
      if (info?.isDirectory()) {
        if (!above.includes(real)) walk(path, [...above, real]);
      } else if (info?.isFile()) {
        bytes += info.size;
        if (bytes > maxBytes) throw new SkillError(`${tildify(dir)} is larger than 5 MB.`);
        const data = readFileSync(real).toString("base64");
        files.push({ path: relative(root, path).split(sep).join("/"), data, ...(info.mode & 0o111 ? { executable: true } : {}) });
      }
    }
  };
  walk(root, [root]);
  if (!files.some((file) => file.path === "SKILL.md")) throw new SkillError(`${tildify(dir)} has no SKILL.md.`);
  return files;
}

/**
 * Skills and instructions files on the machine Bun runs VM Bridge on. `dataDir` (VM Bridge's own folder) is never read
 * as part of a skill. `roots` replaces the skill folders, for tests.
 */
export function bunMachine(dataDir?: string, roots = localRoots): Machine {
  return {
    skills() {
      const seen = new Set<string>();
      const found: ReturnType<Machine["skills"]> = [];
      for (const root of roots()) {
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
    },
    readSkill: (dir) => readSkillFolder(dir, dataDir),
    hasSkill: (dir) => existsSync(join(dir, "SKILL.md")),
    resolve(path) {
      try {
        return realpathSync(untildify(path));
      } catch {
        return undefined;
      }
    },
    tildify,
    instructions(agent) {
      const path = instructionPath[agent]();
      try {
        return { path: tildify(path), text: readFileSync(path, "utf8") };
      } catch {
        return undefined;
      }
    },
  };
}
