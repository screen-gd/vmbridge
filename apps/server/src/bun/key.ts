import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EncryptionKeyError, keyBytes, keyFromText, keyVariable, type KeySource } from "../encryption.ts";

export const keyPath = (dir: string) => join(dir, "encryption.key");

/**
 * This machine's key: `VMBRIDGE_ENCRYPTION_KEY` (a base64 key or a long passphrase) when set, otherwise
 * `<dir>/encryption.key`, made on first start when `create` allows it. The file is written whole under a temporary
 * name and linked into place, so a crash never leaves half a key and two starts at once end up with the same one.
 */
export function localKey(dir: string, create: boolean): KeySource {
  const fromEnv = process.env[keyVariable];
  if (fromEnv) return { key: keyFromText(fromEnv, keyVariable), location: keyVariable, created: false };
  const path = keyPath(dir);
  if (existsSync(path)) return { key: keyFromText(readFileSync(path, "utf8"), path), location: path, created: false };
  if (!create) throw new EncryptionKeyError(`VM Bridge's saved secrets are encrypted, but the key is missing. Put ${path} back or set ${keyVariable}.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${randomBytes(keyBytes).toString("base64")}\n`, { mode: 0o600 });
  let created = true;
  try {
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  } finally {
    rmSync(temp, { force: true });
  }
  return { key: keyFromText(readFileSync(path, "utf8"), path), location: path, created };
}
