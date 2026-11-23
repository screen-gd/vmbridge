import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { bunMachine, readSkillFolder } from "../src/bun/machine.ts";
import { skillDescription, Skills } from "../src/skills.ts";
import type { Box } from "../src/providers/index.ts";
import { root as vmRoot } from "../src/vm/runtime.ts";
import { applyScript, instructionHash, skillHash, syncSkills, type InstructionsState, type SkillFile } from "../src/vm/skills.ts";
import { testEncryption } from "./key.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A VM's file system: VM Bridge's folder, a home folder, and Claude's and Codex's config folders, as the env file sets them. */
function vm() {
  const base = mkdtempSync(join(tmpdir(), "vmbridge-vm-"));
  temps.push(base);
  const root = join(base, "vmbridge");
  const home = join(base, "home");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "skills.mjs"), applyScript);
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, XDG_CONFIG_HOME: "" };
  const apply = (skills: { name: string; files?: SkillFile[] }[], instructions: Partial<Record<InstructionsState[number]["agent"], string>> = {}) => {
    const withHashes = skills.map((skill) => ({ ...skill, hash: skillHash(skill.files ?? []) }));
    const files = Object.entries(instructions).map(([agent, text]) => ({ agent, text, hash: instructionHash(text) }));
    writeFileSync(join(root, "skills-incoming.json"), JSON.stringify({ fingerprint: crypto.randomUUID(), skills: withHashes, instructions: files }));
    const result = Bun.spawnSync(["bun", join(root, "skills.mjs"), root], { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  /** The VM as `syncSkills` sees it: VM Bridge's folder is `root`, and commands run the script with Bun. */
  const local = (path: string) => path.replace(vmRoot, root);
  const box = {
    files: {
      read: async (path: string) => readFileSync(local(path), "utf8"),
      write: async (files: Record<string, string>) => {
        for (const [path, text] of Object.entries(files)) writeFileSync(local(path), text);
      },
    },
    run: async () => {
      const result = Bun.spawnSync(["bun", join(root, "skills.mjs"), root], { env });
      return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout.toString(), output: result.stderr.toString() };
    },
  } as unknown as Box;
  return {
    root,
    apply,
    box,
    claudeSkills: join(claude, "skills"),
    codexSkills: join(home, ".agents", "skills"),
    instructions: { claude: join(claude, "CLAUDE.md"), codex: join(codex, "AGENTS.md"), opencode: join(home, ".config", "opencode", "AGENTS.md") },
  };
}

const file = (path: string, text: string): SkillFile => ({ path, data: Buffer.from(text).toString("base64") });

describe("the skills script on a VM", () => {
  test("links skills for both agents, and removes only what VM Bridge put there", () => {
    const { root, apply, claudeSkills, codexSkills } = vm();
    // Put there by the user or a repository.
    mkdirSync(join(codexSkills, "mine"), { recursive: true });
    mkdirSync(join(codexSkills, "shared"), { recursive: true });
    writeFileSync(join(codexSkills, "shared", "SKILL.md"), "the user's own");
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync("/opt/elsewhere/other", join(claudeSkills, "other"));

    apply([
      { name: "review", files: [file("SKILL.md", "v1"), file("scripts/run.sh", "echo")] },
      { name: "shared", files: [file("SKILL.md", "VM Bridge's")] },
    ]);
    for (const dir of [claudeSkills, codexSkills]) expect(readFileSync(join(dir, "review", "scripts", "run.sh"), "utf8")).toBe("echo");
    expect(readFileSync(join(claudeSkills, "shared", "SKILL.md"), "utf8")).toBe("VM Bridge's");
    // A skill already there under the same name wins.
    expect(readFileSync(join(codexSkills, "shared", "SKILL.md"), "utf8")).toBe("the user's own");

    // An update replaces the whole folder, so a file it dropped goes too. A skill sent without files is kept as it is.
    apply([{ name: "review", files: [file("SKILL.md", "v2")] }, { name: "shared" }]);
    expect(readFileSync(join(codexSkills, "review", "SKILL.md"), "utf8")).toBe("v2");
    expect(existsSync(join(root, "skills", "review", "scripts"))).toBe(false);
    expect(readFileSync(join(claudeSkills, "shared", "SKILL.md"), "utf8")).toBe("VM Bridge's");

    apply([]);
    expect(existsSync(join(root, "skills", "review"))).toBe(false);
    expect(existsSync(join(claudeSkills, "review"))).toBe(false);
    expect(existsSync(join(claudeSkills, "shared"))).toBe(false);
    expect(lstatSync(join(codexSkills, "review"), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(join(codexSkills, "mine"))).toBe(true);
    expect(readFileSync(join(codexSkills, "shared", "SKILL.md"), "utf8")).toBe("the user's own");
    expect(readlinkSync(join(claudeSkills, "other"))).toBe("/opt/elsewhere/other");
  });

  test("refuses a file outside the skill's folder", () => {
    const { root, apply } = vm();
    expect(() => apply([{ name: "evil", files: [file("../../escape", "x")] }])).toThrow("Unsafe path");
    expect(existsSync(join(root, "escape"))).toBe(false);
  });
});

describe("instructions on a VM", () => {
  test("go where each agent reads them, and only the files VM Bridge wrote change", () => {
    const { apply, instructions: paths } = vm();
    apply([], { claude: "claude v1", codex: "codex v1" });
    expect(readFileSync(paths.claude, "utf8")).toBe("claude v1");
    expect(readFileSync(paths.codex, "utf8")).toBe("codex v1");
    expect(existsSync(paths.opencode)).toBe(false);

    // Edited on the VM, so no longer VM Bridge's: an update leaves it, and so does turning it off.
    writeFileSync(paths.codex, "edited on the VM");
    // Put there some other way.
    mkdirSync(join(paths.opencode, ".."), { recursive: true });
    writeFileSync(paths.opencode, "the VM's own");
    apply([], { claude: "claude v2", codex: "codex v2", opencode: "opencode v1" });
    expect(readFileSync(paths.claude, "utf8")).toBe("claude v2");
    expect(readFileSync(paths.codex, "utf8")).toBe("edited on the VM");
    expect(readFileSync(paths.opencode, "utf8")).toBe("the VM's own");

    apply([]);
    expect(existsSync(paths.claude)).toBe(false);
    expect(readFileSync(paths.codex, "utf8")).toBe("edited on the VM");
    expect(readFileSync(paths.opencode, "utf8")).toBe("the VM's own");

    // Once the VM's own file is gone, VM Bridge writes and manages it again.
    rmSync(paths.codex);
    apply([], { codex: "codex v3" });
    expect(readFileSync(paths.codex, "utf8")).toBe("codex v3");
  });
});

test("reads a skill's description in each YAML form", () => {
  expect(skillDescription("---\nname: a\ndescription: Plain words.\n---\n")).toBe("Plain words.");
  expect(skillDescription('---\ndescription: "Quoted: words."\n---\n')).toBe("Quoted: words.");
  expect(skillDescription("---\ndescription: >\n  Folded\n  words.\nname: a\n---\n")).toBe("Folded words.");
  expect(skillDescription("# No front matter")).toBeNull();
});

test("switching sync all says so even when no skill changes, so the dashboard redraws", () => {
  const root = mkdtempSync(join(tmpdir(), "vmbridge-roots-"));
  temps.push(root);
  mkdirSync(join(root, "alpha"));
  writeFileSync(join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  const skills = new Skills(openDatabase(":memory:"), testEncryption, bunMachine(undefined, () => [root]));
  let changes = 0;
  skills.on("changed", () => changes++);

  skills.setSyncAll(true);
  expect(changes).toBe(1);
  // Off installs and removes nothing, and on again finds alpha already installed.
  for (const sync of [false, true]) {
    changes = 0;
    skills.setSyncAll(sync);
    expect(skills.syncAll).toBe(sync);
    expect(changes).toBe(1);
  }
});

describe("local skill folders", () => {
  /** A temp folder holding a skill root (as in ~/.claude/skills), a skill in it, and a secret file outside it. */
  function machine() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "vmbridge-local-")));
    temps.push(base);
    const root = join(base, "skills");
    const skill = join(root, "review");
    mkdirSync(join(skill, "docs"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: review\ndescription: Reviews code.\n---\n");
    writeFileSync(join(skill, "docs", "guide.md"), "the guide");
    const secrets = join(base, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "key"), "SECRET");
    return { base, root, skill, secrets };
  }

  const paths = (files: SkillFile[]) => files.map((entry) => entry.path).sort();
  const texts = (files: SkillFile[]) => files.map((entry) => Buffer.from(entry.data, "base64").toString("utf8"));

  test("links out of the skill are skipped, links inside it are followed", () => {
    const { skill, secrets } = machine();
    symlinkSync(join(secrets, "key"), join(skill, "notes.txt"));
    symlinkSync("../../secrets", join(skill, "outside"));
    symlinkSync("docs/guide.md", join(skill, "guide.md"));
    symlinkSync("docs", join(skill, "more"));
    // A link back up the tree is walked once, not forever.
    symlinkSync("..", join(skill, "docs", "up"));
    Bun.spawnSync(["mkfifo", join(skill, "pipe")]);

    const files = readSkillFolder(skill);
    expect(paths(files)).toEqual(["SKILL.md", "docs/guide.md", "guide.md", "more/guide.md"]);
    expect(texts(files)).not.toContain("SECRET");
  });

  test("a skill folder that is itself a link is read", () => {
    const { base, skill } = machine();
    const link = join(base, "linked");
    symlinkSync(skill, link);
    expect(paths(readSkillFolder(link))).toEqual(["SKILL.md", "docs/guide.md"]);
  });

  test("never reads VM Bridge's data folder", () => {
    const { skill } = machine();
    const data = join(skill, "data");
    mkdirSync(data);
    writeFileSync(join(data, "encryption.key"), "SECRET");
    const files = readSkillFolder(skill, data);
    expect(paths(files)).toEqual(["SKILL.md", "docs/guide.md"]);
    expect(texts(files)).not.toContain("SECRET");
  });

  test("installs only skills found in this machine's skill folders", () => {
    const { base, root, skill } = machine();
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: elsewhere\n---\n");
    // A skill kept in some repository and linked into the skill folder is fine.
    const repo = join(base, "repo", "deploy");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "SKILL.md"), "---\nname: deploy\n---\n");
    symlinkSync(repo, join(root, "deploy"));
    const skills = new Skills(openDatabase(":memory:"), testEncryption, bunMachine(undefined, () => [root]));

    // A folder outside them, and one that does not exist, get the same answer.
    expect(() => skills.installLocal(elsewhere)).toThrow(`${elsewhere} is not a skill in this machine's skill folders.`);
    expect(() => skills.installLocal(join(base, "missing"))).toThrow(`${join(base, "missing")} is not a skill in this machine's skill folders.`);
    expect(skills.list()).toEqual([]);

    skills.installLocal(skill);
    skills.installLocal(join(root, "deploy"));
    expect(skills.list().map((entry) => entry.name)).toEqual(["deploy", "review"]);
  });
});

describe("uploaded skills", () => {
  const upload = (files: { path: string; text: string; executable?: boolean }[]) =>
    files.map(({ path, text, executable }) => ({ path, data: Buffer.from(text).toString("base64"), ...(executable ? { executable } : {}) }));
  const skillMd = { path: "SKILL.md", text: "---\nname: notes\ndescription: Takes notes.\n---\n" };

  test("are stored sealed and listed as uploads, and a new upload replaces the old one", () => {
    const db = openDatabase(":memory:");
    const skills = new Skills(db, testEncryption);
    skills.installUpload("notes", upload([skillMd, { path: "scripts/run.sh", text: "echo secret-script", executable: true }]));
    expect(skills.list()).toEqual([expect.objectContaining({ name: "notes", source: "upload", ref: "", description: "Takes notes." })]);
    const raw = db.one<{ files: string }>("SELECT files FROM skills")?.files ?? "";
    expect(raw).not.toContain(Buffer.from("echo secret-script").toString("base64"));
    expect(skills.files("notes").find((entry) => entry.path === "scripts/run.sh")?.executable).toBe(true);

    skills.installUpload("notes", upload([skillMd]));
    expect(skills.files("notes").map((entry) => entry.path)).toEqual(["SKILL.md"]);
    expect(() => skills.update("notes")).toThrow("Upload it again");
  });

  test("refuses files that escape the folder, clash, or are too many or too big", () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    const refused = (name: string, files: unknown, message: string) => expect(() => skills.installUpload(name, files)).toThrow(message);
    refused("notes", upload([{ path: "README.md", text: "x" }]), "has no SKILL.md");
    // "é" is 2 bytes, so 128 of them pass a character count but not the 255-byte name limit.
    for (const path of ["../escape", "/etc/passwd", "a/../../b", "a//b", "a\\b", "line\nbreak", "é".repeat(128)]) {
      refused("notes", upload([skillMd, { path, text: "x" }]), "outside its folder or with an unusable name");
    }
    refused("notes", upload([skillMd, skillMd]), "SKILL.md twice");
    refused("notes", upload([skillMd, { path: "docs", text: "x" }, { path: "docs/a.md", text: "x" }]), "both a file and a folder");
    refused("notes", upload([skillMd, ...Array.from({ length: 100 }, (_, i) => ({ path: `f${i}`, text: "x" }))]), "more than 100 files");
    refused("notes", upload([skillMd, { path: "big.bin", text: "x".repeat(1024 * 1024) }]), "larger than 1 MB");
    refused("../notes", upload([skillMd]), "not a usable skill name");
    refused("notes", [{ path: "SKILL.md", data: "not base64!" }], "contents in base64");
    refused("notes", "SKILL.md", "Send the skill's files");
    expect(skills.list()).toEqual([]);
  });

  test("do not take over a skill installed another way", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO skills (name, source, ref, hash, files, installed_at, updated_at) VALUES ('notes', 'skills.sh', 'acme/skills', 'h', '[]', 0, 0)");
    expect(() => new Skills(db, testEncryption).installUpload("notes", upload([skillMd]))).toThrow("already installed from acme/skills");
  });
});

describe("pasted instructions", () => {
  test("go to the agents that read them, win over the machine's file, and blank removes them", () => {
    const base = mkdtempSync(join(tmpdir(), "vmbridge-home-"));
    temps.push(base);
    const claudeDir = join(base, "claude");
    mkdirSync(claudeDir);
    writeFileSync(join(claudeDir, "CLAUDE.md"), "from this machine");
    // Only this test's folders, never the real home's files.
    const names = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
    const previous = names.map((name) => process.env[name]);
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CODEX_HOME = join(base, "codex");
    process.env.XDG_CONFIG_HOME = join(base, "config");
    try {
      const skills = new Skills(openDatabase(":memory:"), testEncryption, bunMachine(undefined, () => []));
      const { instructions } = skills;
      instructions.refresh();
      instructions.setSync("claude", true);
      const texts = () => Object.fromEntries(skills.state().instructions.map((file) => [file.agent, file.text]));
      expect(texts()).toEqual({ claude: "from this machine" });

      instructions.save("AGENTS.md", "pasted agents");
      instructions.save("CLAUDE.md", "pasted claude");
      expect(texts()).toEqual({ codex: "pasted agents", claude: "pasted claude", opencode: "pasted agents" });
      expect(instructions.savedNames()).toEqual(["AGENTS.md", "CLAUDE.md"]);

      instructions.save("CLAUDE.md", "  \n");
      expect(texts()).toEqual({ codex: "pasted agents", claude: "from this machine", opencode: "pasted agents" });
      expect(() => instructions.save("AGENTS.md", "x".repeat(256 * 1024 + 1))).toThrow("larger than 256 KB");
    } finally {
      names.forEach((name, i) => {
        if (previous[i] === undefined) delete process.env[name];
        else process.env[name] = previous[i];
      });
    }
  });

  test("work without a machine, as on Workers", () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    expect(skills.instructions.refresh()).toBe(false);
    expect(skills.refreshLocal()).toBe(false);
    expect(skills.discover()).toEqual([]);
    expect(() => skills.installLocal("~/.claude/skills/x")).toThrow("no local skill folders");
    skills.instructions.save("AGENTS.md", "pasted");
    expect(skills.state().instructions.map((file) => file.agent).sort()).toEqual(["codex", "opencode"]);
  });
});

test("an upload and pasted instructions reach a VM, and a file edited on the VM is left alone", async () => {
  const { box, claudeSkills, instructions: paths } = vm();
  const skills = new Skills(openDatabase(":memory:"), testEncryption);
  skills.installUpload("notes", [file("SKILL.md", "---\nname: notes\n---\n"), { ...file("run.sh", "echo hi"), executable: true }]);
  skills.instructions.save("AGENTS.md", "agents v1");
  skills.instructions.save("CLAUDE.md", "claude v1");
  const sync = () => syncSkills(box, skills.state(), (name) => skills.files(name));

  expect(await sync()).toBe(true);
  expect(readFileSync(join(claudeSkills, "notes", "SKILL.md"), "utf8")).toContain("name: notes");
  expect(lstatSync(join(claudeSkills, "notes", "run.sh")).mode & 0o111).not.toBe(0);
  expect(readFileSync(paths.codex, "utf8")).toBe("agents v1");
  expect(readFileSync(paths.opencode, "utf8")).toBe("agents v1");
  expect(readFileSync(paths.claude, "utf8")).toBe("claude v1");
  expect(await sync()).toBe(false);

  writeFileSync(paths.claude, "edited on the VM");
  skills.instructions.save("AGENTS.md", "agents v2");
  skills.instructions.save("CLAUDE.md", "claude v2");
  skills.remove("notes");
  expect(await sync()).toBe(true);
  expect(readFileSync(paths.codex, "utf8")).toBe("agents v2");
  expect(readFileSync(paths.claude, "utf8")).toBe("edited on the VM");
  expect(existsSync(join(claudeSkills, "notes"))).toBe(false);
});
