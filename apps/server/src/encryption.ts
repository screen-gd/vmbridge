import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prefix = "v1:";
const ivBytes = 12;
const tagBytes = 16;
const keyBytes = 32;

/** The key is missing, malformed, or not the one the data was encrypted with. Startup stops rather than lose data. */
export class EncryptionKeyError extends Error {}

/**
 * AES-256-GCM for sensitive values at rest. A sealed value is `v1:` + base64(iv | ciphertext | tag), the same bytes
 * WebCrypto's AES-GCM produces, so a runtime without `node:crypto` can read and write it too. `context` names the
 * record (for example `secret:github.token`) and is bound as additional data, so a sealed value copied into
 * another record does not open.
 */
export class Encryption {
  // A KeyObject, not the bytes: logging it shows only its size.
  private readonly key: KeyObject;

  constructor(key: Uint8Array) {
    if (key.length !== keyBytes) throw new EncryptionKeyError(`The encryption key must be ${keyBytes} bytes.`);
    this.key = createSecretKey(key);
  }

  static isSealed(value: string) {
    return value.startsWith(prefix);
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(ivBytes);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv).setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return prefix + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
  }

  /** Throws `EncryptionKeyError` on a wrong key, a changed value, or a value sealed for another record. */
  open(sealed: string, context: string): string {
    if (!Encryption.isSealed(sealed)) throw new EncryptionKeyError(`${context} is not encrypted.`);
    const bytes = Buffer.from(sealed.slice(prefix.length), "base64");
    if (bytes.length < ivBytes + tagBytes) throw new EncryptionKeyError(`${context} is damaged.`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, ivBytes)).setAAD(Buffer.from(context));
      decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
      return Buffer.concat([decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)), decipher.final()]).toString("utf8");
    } catch {
      throw new EncryptionKeyError(`Could not decrypt ${context}: the encryption key is wrong or the data was changed.`);
    }
  }
}

/** Where an install's key comes from. A Cloudflare Worker would read its own secret binding instead of `localKey`. */
export interface KeySource {
  key: Uint8Array;
  /** For people: the variable or file holding the key. Never the key itself. */
  location: string;
  /** True the one time a new key was made. */
  created: boolean;
}

export const keyVariable = "VMBRIDGE_ENCRYPTION_KEY";
export const keyPath = (dir: string) => join(dir, "encryption.key");

function decodeKey(text: string, location: string) {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== keyBytes) throw new EncryptionKeyError(`${location} must hold a base64 ${keyBytes}-byte key.`);
  return key;
}

/**
 * This machine's key: `VMBRIDGE_ENCRYPTION_KEY` (base64) when set, otherwise `<dir>/encryption.key`, made on first
 * start when `create` allows it. The file is written whole under a temporary name and linked into place, so a crash
 * never leaves half a key and two starts at once end up with the same one.
 */
export function localKey(dir: string, create: boolean): KeySource {
  const fromEnv = process.env[keyVariable];
  if (fromEnv) return { key: decodeKey(fromEnv, keyVariable), location: keyVariable, created: false };
  const path = keyPath(dir);
  if (existsSync(path)) return { key: decodeKey(readFileSync(path, "utf8"), path), location: path, created: false };
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
  return { key: decodeKey(readFileSync(path, "utf8"), path), location: path, created };
}

const checkName = "encryption.check";

/**
 * Loads the key and proves it is the one this database was encrypted with, using a known value sealed on first
 * start. A database that has that value never gets a new key, so a lost key stops startup instead of hiding data.
 */
export function openEncryption(db: Database, source: (create: boolean) => KeySource) {
  const check = db.query<{ value: string }, []>(`SELECT value FROM secrets WHERE name = '${checkName}'`).get()?.value;
  const key = source(check === undefined);
  const encryption = new Encryption(key.key);
  if (check === undefined) {
    db.query("INSERT INTO secrets (name, value) VALUES (?, ?)").run(checkName, encryption.seal(checkName, checkName));
  } else {
    try {
      encryption.open(check, checkName);
    } catch {
      throw new EncryptionKeyError(`The encryption key in ${key.location} is not the one VM Bridge's data was encrypted with.`);
    }
  }
  return { encryption, key };
}
