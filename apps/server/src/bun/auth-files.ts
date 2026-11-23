import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexAuthContext, profileContext } from "../agent-auth/profiles.ts";
import { Encryption } from "../encryption.ts";
import type { Sql } from "../sql.ts";

/**
 * Moves agent sign-ins from `<dir>`, one folder per profile with profile.json and Codex's auth.json, where older
 * versions kept them, into the agent_profiles table. Files from before encryption are sealed on the way. Folders are
 * deleted only once the rows are committed, and a profile already in the table is kept, so a start cut short
 * finishes the move next time. Returns how many profiles moved.
 */
export function importAuthFiles(dir: string, db: Sql, encryption: Encryption): number {
  if (!existsSync(dir)) return 0;
  const sealed = (id: string, file: string, context: string) => {
    const path = join(dir, id, file);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    return Encryption.isSealed(text) ? text : encryption.seal(text, context);
  };
  const profiles = readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) return [];
    const profile = sealed(entry.name, "profile.json", profileContext(entry.name));
    return profile ? [{ id: entry.name, profile, codexAuth: sealed(entry.name, "auth.json", codexAuthContext(entry.name)) }] : [];
  });
  db.transaction(() => {
    for (const { id, profile, codexAuth } of profiles) {
      db.run("INSERT OR IGNORE INTO agent_profiles (id, profile, codex_auth) VALUES (?, ?, ?)", id, profile, codexAuth);
    }
  });
  for (const { id } of profiles) rmSync(join(dir, id), { recursive: true, force: true });
  try {
    rmdirSync(dir);
  } catch {
    // Something else is still in there. Leave it.
  }
  return profiles.length;
}
