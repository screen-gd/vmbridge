import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAuth, codexAuthContext, profileContext } from "../src/agent-auth/profiles.ts";
import { importAuthFiles } from "../src/bun/auth-files.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Encryption } from "../src/encryption.ts";
import { Settings } from "../src/settings.ts";
import { testEncryption } from "./key.ts";

const profile = (id: string, agent: string, token?: string) =>
  JSON.stringify({ id, agent, method: agent === "codex" ? "chatgpt" : "api-key", name: id, detail: null, createdAt: 0, error: null, ...(token ? { token } : {}) });

test("sign-in files from older versions move into the database once, then the files go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-auth-files-"));
  try {
    const auths = join(dir, "auths");
    // An encrypted Codex profile with its auth.json, a plain-text one from before encryption, and a write cut short.
    mkdirSync(join(auths, "codex-work"), { recursive: true });
    writeFileSync(join(auths, "codex-work", "profile.json"), testEncryption.seal(profile("codex-work", "codex"), profileContext("codex-work")));
    writeFileSync(join(auths, "codex-work", "auth.json"), testEncryption.seal('{"tokens":"codex-secret"}', codexAuthContext("codex-work")));
    mkdirSync(join(auths, "opencode-old"));
    writeFileSync(join(auths, "opencode-old", "profile.json"), profile("opencode-old", "opencode", "oc-plain"));
    writeFileSync(join(auths, "opencode-old", "profile.json.123.tmp"), "half");

    const db = openDatabase(":memory:");
    const settings = new Settings(db);
    settings.set("agentProfiles", { opencode: "opencode-old" });
    expect(importAuthFiles(auths, db, testEncryption)).toBe(2);
    expect(existsSync(auths)).toBe(false);
    expect(importAuthFiles(auths, db, testEncryption)).toBe(0);

    const rows = db.all<{ id: string; profile: string; codexAuth: string | null }>("SELECT id, profile, codex_auth AS codexAuth FROM agent_profiles ORDER BY id");
    expect(rows.map((row) => row.id)).toEqual(["codex-work", "opencode-old"]);
    expect(rows.every((row) => Encryption.isSealed(row.profile))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("oc-plain");
    expect(testEncryption.open(rows[0]!.codexAuth!, codexAuthContext("codex-work"))).toBe('{"tokens":"codex-secret"}');

    const agents = new AgentAuth(db, settings, testEncryption);
    expect(agents.list().map((entry) => [entry.id, entry.inUse])).toEqual([
      ["codex-work", false],
      ["opencode-old", true],
    ]);
    expect(await agents.vmSecrets()).toEqual({ opencodeApiKey: "oc-plain" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a profile already in the database is kept when its files are still there", () => {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-auth-files-"));
  try {
    const auths = join(dir, "auths");
    mkdirSync(join(auths, "opencode-work"), { recursive: true });
    writeFileSync(join(auths, "opencode-work", "profile.json"), profile("opencode-work", "opencode", "from-file"));
    const db = openDatabase(":memory:");
    // As if a start moved it, then stopped before deleting the files.
    db.run("INSERT INTO agent_profiles (id, profile) VALUES (?, ?)", "opencode-work", testEncryption.seal(profile("opencode-work", "opencode", "in-db"), profileContext("opencode-work")));
    importAuthFiles(auths, db, testEncryption);
    const row = db.one<{ profile: string }>("SELECT profile FROM agent_profiles WHERE id = 'opencode-work'")!;
    expect(testEncryption.open(row.profile, profileContext("opencode-work"))).toContain("in-db");
    expect(existsSync(auths)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
