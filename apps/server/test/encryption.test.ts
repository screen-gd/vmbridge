import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAuth } from "../src/agent-auth/profiles.ts";
import { openDatabase } from "../src/db.ts";
import { Encryption, EncryptionKeyError, keyPath, keyVariable, localKey, openEncryption } from "../src/encryption.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Skills } from "../src/skills.ts";
import { Store } from "../src/store.ts";

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
  test("seals every kind once, and reads it back", () => {
    const dir = tempDir();
    const db = openDatabase(":memory:");
    const encryption = new Encryption(key(6));
    db.query("INSERT INTO secrets (name, value) VALUES ('provider.e2b.apiKey', 'e2b-plain'), ('env', '{\"FOO\":\"env-plain\"}')").run();
    db.query("INSERT INTO vms (id, provider, name, size, state, created_at, t3_token) VALUES ('vm1', 'e2b', 'one', 'medium', 'ready', 0, 't3-plain')").run();
    const files = JSON.stringify([{ path: "SKILL.md", data: Buffer.from("skill-plain").toString("base64") }]);
    db.query("INSERT INTO skills (name, source, ref, hash, files, installed_at, updated_at) VALUES ('mine', 'local', '/x', 'h', ?, 0, 0)").run(files);
    mkdirSync(join(dir, "auths", "opencode-work"), { recursive: true });
    const profile = { id: "opencode-work", agent: "opencode", method: "api-key", name: "Work", detail: null, createdAt: 0, error: null, token: "oc-plain" };
    writeFileSync(join(dir, "auths", "opencode-work", "profile.json"), JSON.stringify(profile));
    writeFileSync(join(dir, "auths", "opencode-work", "profile.json.123.tmp"), JSON.stringify(profile));

    const secrets = new Secrets(db, encryption);
    const store = new Store(db, encryption);
    const skills = new Skills(db, encryption, () => []);
    const agents = new AgentAuth(join(dir, "auths"), new Settings(db), encryption);
    const seal = () => secrets.sealPlaintext() + store.sealPlaintext() + skills.sealPlaintext() + agents.sealPlaintext();
    expect(seal()).toBe(5);
    expect(seal()).toBe(0);

    const raw = [
      ...db.query<{ value: string }, []>("SELECT value FROM secrets UNION ALL SELECT t3_token FROM vms UNION ALL SELECT files FROM skills").all().map((row) => row.value),
      readFileSync(join(dir, "auths", "opencode-work", "profile.json"), "utf8"),
    ].join("\n");
    for (const plain of ["e2b-plain", "env-plain", "t3-plain", Buffer.from("skill-plain").toString("base64"), "oc-plain"]) expect(raw).not.toContain(plain);
    expect(existsSync(join(dir, "auths", "opencode-work", "profile.json.123.tmp"))).toBe(false);

    expect(secrets.get("provider.e2b.apiKey")).toBe("e2b-plain");
    expect(secrets.get("env")).toBe('{"FOO":"env-plain"}');
    expect(store.vm("vm1")?.t3Token).toBe("t3-plain");
    expect(skills.files("mine")).toEqual(JSON.parse(files));
    expect(agents.list()).toMatchObject([{ id: "opencode-work", name: "Work" }]);
  });

  test("a value moved to another record does not open", () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, new Encryption(key(7)));
    secrets.set("github.token", "gh-token");
    db.query("UPDATE secrets SET name = 'provider.e2b.apiKey' WHERE name = 'github.token'").run();
    expect(() => secrets.get("provider.e2b.apiKey")).toThrow(EncryptionKeyError);
  });
});
