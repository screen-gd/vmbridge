import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { localKey, keyPath } from "../src/bun/key.ts";
import { Encryption, EncryptionKeyError, keyFromText, keyVariable, openEncryption } from "../src/encryption.ts";
import { Secrets } from "../src/settings.ts";
import { Skills } from "../src/skills.ts";
import { Store } from "../src/store.ts";
import { credentialsFingerprint } from "../src/vm/runtime.ts";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const tempDir = () => mkdtempSync(join(tmpdir(), "vmbridge-encryption-"));

afterEach(() => {
  delete process.env[keyVariable];
});

describe("sealing values", () => {
  const encryption = new Encryption(key(1));

  test("round trips, with a fresh IV each time", () => {
    const sealed = encryption.seal("sk-live-123", "secret:provider.e2b.apiKey");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("sk-live-123");
    expect(encryption.seal("sk-live-123", "secret:provider.e2b.apiKey")).not.toBe(sealed);
    expect(encryption.open(sealed, "secret:provider.e2b.apiKey")).toBe("sk-live-123");
  });

  test("refuses a changed value, another key, and another record", () => {
    const sealed = encryption.seal("sk-live-123", "secret:a");
    const bytes = Buffer.from(sealed.slice(3), "base64");
    bytes[14]! ^= 1;
    expect(() => encryption.open(`v1:${bytes.toString("base64")}`, "secret:a")).toThrow(EncryptionKeyError);
    expect(() => new Encryption(key(2)).open(sealed, "secret:a")).toThrow(EncryptionKeyError);
    expect(() => encryption.open(sealed, "secret:b")).toThrow(EncryptionKeyError);
    expect(() => encryption.open("sk-live-123", "secret:a")).toThrow(EncryptionKeyError);
  });

  test("uses the same format as WebCrypto AES-GCM", async () => {
    const webKey = await crypto.subtle.importKey("raw", key(1), "AES-GCM", false, ["encrypt", "decrypt"]);
    const additionalData = new TextEncoder().encode("secret:a");

    const sealed = Buffer.from(encryption.seal("from node", "secret:a").slice(3), "base64");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12), additionalData }, webKey, sealed.subarray(12));
    expect(new TextDecoder().decode(plain)).toBe("from node");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, webKey, new TextEncoder().encode("from webcrypto"));
    expect(encryption.open(`v1:${Buffer.concat([iv, new Uint8Array(body)]).toString("base64")}`, "secret:a")).toBe("from webcrypto");
  });
});

test("the sign-ins fingerprint needs the key, so a copy of the database cannot confirm a guessed secret", () => {
  const credentials = { env: { PASSWORD: "hunter2" } };
  const fingerprint = credentialsFingerprint(credentials, new Encryption(key(1)));
  expect(fingerprint).not.toBe(createHash("sha256").update(JSON.stringify(credentials)).digest("hex"));
  expect(credentialsFingerprint(credentials, new Encryption(key(2)))).not.toBe(fingerprint);
  expect(credentialsFingerprint(credentials, new Encryption(key(1)))).toBe(fingerprint);
});

describe("the local key", () => {
  test("is made once, private, and reused", () => {
    const dir = tempDir();
    const first = localKey(dir, true);
    expect(first.created).toBe(true);
    expect(first.location).toBe(keyPath(dir));
    expect(statSync(keyPath(dir)).mode & 0o777).toBe(0o600);
    const second = localKey(dir, true);
    expect(second.created).toBe(false);
    expect(Buffer.from(second.key).equals(Buffer.from(first.key))).toBe(true);
  });

  test("comes from the environment variable when set", () => {
    const dir = tempDir();
    process.env[keyVariable] = Buffer.from(key(3)).toString("base64");
    expect(localKey(dir, true)).toMatchObject({ location: keyVariable, created: false });
    expect(existsSync(keyPath(dir))).toBe(false);
    process.env[keyVariable] = "too-short";
    expect(() => localKey(dir, true)).toThrow(EncryptionKeyError);
  });

  test("is never made again for data that was encrypted", () => {
    const dir = tempDir();
    const db = openDatabase(join(dir, "main.db"));
    openEncryption(db, (create) => localKey(dir, create));
    expect(() => openEncryption(db, (create) => localKey(dir, create))).not.toThrow();

    writeFileSync(keyPath(dir), `${Buffer.from(key(4)).toString("base64")}\n`);
    expect(() => openEncryption(db, (create) => localKey(dir, create))).toThrow(/not the one/);

    process.env[keyVariable] = Buffer.from(key(5)).toString("base64");
    expect(() => openEncryption(db, (create) => localKey(dir, create))).toThrow(/not the one/);
    delete process.env[keyVariable];

    rmSync(keyPath(dir));
    expect(() => openEncryption(db, (create) => localKey(dir, create))).toThrow(/key is missing/);
    expect(existsSync(keyPath(dir))).toBe(false);
  });
});

describe("encrypting data saved in plain text", () => {
  test("happens on the first start with a new key only, and the record of it cannot be reset without the key", () => {
    const dir = tempDir();
    const db = openDatabase(join(dir, "main.db"));
    const first = openEncryption(db, (create) => localKey(dir, create));
    expect(first.migrated).toBe(false);
    first.markMigrated();
    expect(openEncryption(db, (create) => localKey(dir, create)).migrated).toBe(true);

    // Removing the check while the key stays does not bring sealing back.
    db.run("DELETE FROM secrets WHERE name = 'encryption.check'");
    expect(openEncryption(db, (create) => localKey(dir, create)).migrated).toBe(true);

    // Neither does a check sealed with another key.
    db.run("UPDATE secrets SET value = ? WHERE name = 'encryption.check'", new Encryption(key(9)).seal("encryption.check", "encryption.check"));
    expect(() => openEncryption(db, (create) => localKey(dir, create))).toThrow(/not the one/);
  });

  test("drops values stored unencrypted once sealing ran", () => {
    const db = openDatabase(":memory:");
    const encryption = new Encryption(key(8));
    const secrets = new Secrets(db, encryption);
    secrets.set("provider.e2b.apiKey", "kept");
    db.run("INSERT INTO secrets (name, value) VALUES ('github.token', 'planted')");
    expect(secrets.plaintext("drop")).toEqual(["secret github.token"]);
    expect(secrets.has("github.token")).toBe(false);
    expect(secrets.get("provider.e2b.apiKey")).toBe("kept");
  });

  test("seals every kind once, and reads it back", () => {
    const db = openDatabase(":memory:");
    const encryption = new Encryption(key(6));
    db.run("INSERT INTO secrets (name, value) VALUES ('provider.e2b.apiKey', 'e2b-plain'), ('env', '{\"FOO\":\"env-plain\"}')");
    db.run("INSERT INTO vms (id, provider, name, size, state, created_at, t3_token) VALUES ('vm1', 'e2b', 'one', 'medium', 'ready', 0, 't3-plain')");
    const files = JSON.stringify([{ path: "SKILL.md", data: Buffer.from("skill-plain").toString("base64") }]);
    db.run("INSERT INTO skills (name, source, ref, hash, files, installed_at, updated_at) VALUES ('mine', 'local', '/x', 'h', ?, 0, 0)", files);
    db.run("INSERT INTO instructions (name, text, updated_at) VALUES ('AGENTS.md', 'agents-plain', 0)");

    const secrets = new Secrets(db, encryption);
    const store = new Store(db, encryption);
    const skills = new Skills(db, encryption);
    const seal = () => [...secrets.plaintext("seal"), ...store.plaintext("seal"), ...skills.plaintext("seal")].length;
    expect(seal()).toBe(5);
    expect(seal()).toBe(0);

    const raw = db
      .all<{ value: string }>("SELECT value FROM secrets UNION ALL SELECT t3_token FROM vms UNION ALL SELECT files FROM skills UNION ALL SELECT text FROM instructions")
      .map((row) => row.value)
      .join("\n");
    for (const plain of ["e2b-plain", "env-plain", "t3-plain", "agents-plain", Buffer.from("skill-plain").toString("base64")]) expect(raw).not.toContain(plain);

    expect(secrets.get("provider.e2b.apiKey")).toBe("e2b-plain");
    expect(secrets.get("env")).toBe('{"FOO":"env-plain"}');
    expect(store.vm("vm1")?.t3Token).toBe("t3-plain");
    expect(skills.files("mine")).toEqual(JSON.parse(files));
    expect(skills.instructions.saved()).toEqual({ "AGENTS.md": "agents-plain" });
  });

  test("a value moved to another record does not open", () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, new Encryption(key(7)));
    secrets.set("github.token", "gh-token");
    db.run("UPDATE secrets SET name = 'provider.e2b.apiKey' WHERE name = 'github.token'");
    expect(() => secrets.get("provider.e2b.apiKey")).toThrow(EncryptionKeyError);
  });
});

describe("encryption key text", () => {
  test("a base64 key is used as is and a passphrase is stretched the same way every time", () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    expect(Buffer.from(keyFromText(` ${Buffer.from(raw).toString("base64")}\n`, "key"))).toEqual(Buffer.from(raw));
    // A key wrapped across lines read as the same key before passphrases existed, so it still must.
    const encoded = Buffer.from(raw).toString("base64");
    expect(Buffer.from(keyFromText(`${encoded.slice(0, 20)}\n${encoded.slice(20)}`, "key"))).toEqual(Buffer.from(raw));
    const passphrase = "correct horse battery staple and a few more words";
    const derived = keyFromText(passphrase, "key");
    expect(derived.length).toBe(32);
    expect(Buffer.from(keyFromText(passphrase, "key"))).toEqual(Buffer.from(derived));
    expect(Buffer.from(keyFromText(`${passphrase}!`, "key"))).not.toEqual(Buffer.from(derived));
  });

  test("a short passphrase is refused without showing it", () => {
    let thrown: unknown;
    try {
      keyFromText("short secret words", keyVariable);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EncryptionKeyError);
    expect(String(thrown)).toContain(`${keyVariable} must hold`);
    expect(String(thrown)).not.toContain("short secret words");
  });

  test("a passphrase in the key file opens the same data", () => {
    const dir = tempDir();
    try {
      writeFileSync(keyPath(dir), "a long passphrase kept in the key file, not base64", { mode: 0o600 });
      expect(Buffer.from(localKey(dir, false).key)).toEqual(Buffer.from(keyFromText("a long passphrase kept in the key file, not base64", "key")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
