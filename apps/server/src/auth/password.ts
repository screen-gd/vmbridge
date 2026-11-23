import { timingSafeEqual } from "node:crypto";

/** How the dashboard password is hashed. Bun's is in bun/password.ts; `webPasswords` is for runtimes without one. */
export interface Passwords {
  hash(password: string): Promise<string>;
  /** `outdated` means the password was right and should be hashed again with `hash`. */
  verify(password: string, stored: string): Promise<{ ok: boolean; outdated: boolean }>;
}

// Cloudflare Workers refuse PBKDF2 above 100,000 iterations. The count is stored with each hash, so it can rise later.
const iterations = 100_000;
const scheme = "pbkdf2-sha256";

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, rounds: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return Buffer.from(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256));
}

export const isPbkdf2 = (stored: string) => stored.startsWith(`$${scheme}$`);

/**
 * Salted PBKDF2-SHA256, as `$pbkdf2-sha256$i=<iterations>$<salt>$<hash>` with base64 salt and hash, using only web
 * standards. Weaker than argon2id, so only for runtimes that have nothing better, such as Cloudflare Workers. It
 * cannot check an argon2id hash made on Bun: a data folder moved from Bun to such a runtime needs a new password.
 */
export const webPasswords: Passwords = {
  async hash(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(password, salt, iterations);
    return `$${scheme}$i=${iterations}$${Buffer.from(salt).toString("base64")}$${hash.toString("base64")}`;
  },

  async verify(password, stored) {
    const [, name, rounds, salt, hash] = stored.split("$");
    const count = Number(rounds?.replace(/^i=/, ""));
    if (name !== scheme || !Number.isSafeInteger(count) || count < 1 || !salt || !hash) return { ok: false, outdated: false };
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), count);
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    return { ok, outdated: ok && count < iterations };
  },
};
