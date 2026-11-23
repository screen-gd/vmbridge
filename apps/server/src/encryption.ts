import type { Sql } from "./sql.ts";
import { createCipheriv, createDecipheriv, createHmac, createSecretKey, hkdfSync, pbkdf2Sync, randomBytes, type KeyObject } from "node:crypto";

const prefix = "v1:";
const ivBytes = 12;
const tagBytes = 16;
export const keyBytes = 32;

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
  /** Derived from the key with HKDF, so fingerprints never use the encryption key itself. */
  private readonly fingerprintKey: KeyObject;

  constructor(key: Uint8Array) {
    if (key.length !== keyBytes) throw new EncryptionKeyError(`The encryption key must be ${keyBytes} bytes.`);
    this.key = createSecretKey(key);
    this.fingerprintKey = createSecretKey(Buffer.from(hkdfSync("sha256", key, new Uint8Array(0), "vmbridge fingerprint", keyBytes)));
  }

  /**
   * An HMAC of `text`, for telling when secret values changed without storing them. Unlike a plain hash, someone
   * without the key cannot check a guessed value against it.
   */
  fingerprint(text: string): string {
    return createHmac("sha256", this.fingerprintKey).update(text).digest("hex");
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

/** Where an install's key comes from: a file or variable on Bun (bun/key.ts), a secret on Cloudflare Workers. */
export interface KeySource {
  key: Uint8Array;
  /** For people: the variable or file holding the key. Never the key itself. */
  location: string;
  /** True the one time a new key was made. */
  created: boolean;
}

export const keyVariable = "VMBRIDGE_ENCRYPTION_KEY";
/** The shortest passphrase taken instead of a generated key. */
export const minPassphraseLength = 32;
// Fixed, so the same passphrase gives the same key on every runtime. Each install has its own passphrase, and the
// salt still keeps tables made for other programs from fitting. 100,000 is the most PBKDF2 Workers allow.
const passphraseSalt = "vmbridge encryption key v1";
const passphraseIterations = 100_000;

/**
 * The key `text` holds when it is base64 (or base64url) for exactly 32 bytes, otherwise null. Whitespace inside is
 * ignored, as Node's base64 decoding always did, so a key file wrapped across lines still reads as the same key.
 */
export function base64Key(text: string): Uint8Array | null {
  const compact = text.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  const key = Buffer.from(compact, "base64");
  return key.length === keyBytes ? key : null;
}

/**
 * Reads a key as people write it: a base64 32-byte key (`openssl rand -base64 32`), or a passphrase of at least
 * `minPassphraseLength` characters, stretched to a key with PBKDF2-SHA256. Text that decodes to exactly 32 bytes of
 * base64 is always taken as a key, so keys that worked before still do.
 */
export function keyFromText(text: string, location: string): Uint8Array {
  const trimmed = text.trim();
  const key = base64Key(trimmed);
  if (key) return key;
  if (trimmed.length < minPassphraseLength) {
    throw new EncryptionKeyError(`${location} must hold a base64 ${keyBytes}-byte key or a passphrase of at least ${minPassphraseLength} characters.`);
  }
  return pbkdf2Sync(trimmed, passphraseSalt, passphraseIterations, keyBytes, "sha256");
}

const checkName = "encryption.check";
/**
 * The check's text once values saved before encryption were sealed. It is sealed like the check, so someone who can
 * write the database without the key cannot set it back to make VM Bridge seal, and then trust, values they planted.
 */
const migratedCheck = `${checkName}:migrated`;

/**
 * Loads the key and proves it is the one this database was encrypted with, using a known value sealed on first
 * start. A database that has that value never gets a new key, so a lost key stops startup instead of hiding data.
 * `migrated` says whether values saved before encryption were sealed already, after which `markMigrated` records it.
 */
export function openEncryption(db: Sql, source: (create: boolean) => KeySource) {
  const check = db.one<{ value: string }>(`SELECT value FROM secrets WHERE name = '${checkName}'`)?.value;
  const key = source(check === undefined);
  const encryption = new Encryption(key.key);
  let migrated: boolean;
  if (check === undefined) {
    // Data from before encryption gets its key made on that first start. A key that already existed means the
    // database was new (nothing to seal) or its check was removed, and then nothing unencrypted is trusted.
    migrated = !key.created;
    db.run("INSERT INTO secrets (name, value) VALUES (?, ?)", checkName, encryption.seal(migrated ? migratedCheck : checkName, checkName));
  } else {
    try {
      migrated = encryption.open(check, checkName) === migratedCheck;
    } catch {
      throw new EncryptionKeyError(`The encryption key in ${key.location} is not the one VM Bridge's data was encrypted with.`);
    }
  }
  const markMigrated = () => db.run("UPDATE secrets SET value = ? WHERE name = ?", encryption.seal(migratedCheck, checkName), checkName);
  return { encryption, key, migrated, markMigrated };
}
