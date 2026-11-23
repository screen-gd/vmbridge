import { isPbkdf2, webPasswords, type Passwords } from "../auth/password.ts";

// Bun's defaults, spelled out so a change in Bun cannot weaken them: 64 MiB and 2 passes, above OWASP's minimum.
const options = { algorithm: "argon2id", memoryCost: 65_536, timeCost: 2 } as const;

/**
 * argon2id on Bun. Still checks PBKDF2 hashes, which VM Bridge made on every runtime before, and marks them outdated
 * so the next login replaces them.
 */
export const bunPasswords: Passwords = {
  hash: (password) => Bun.password.hash(password, options),

  async verify(password, stored) {
    if (isPbkdf2(stored)) {
      const { ok } = await webPasswords.verify(password, stored);
      return { ok, outdated: ok };
    }
    const ok = await Bun.password.verify(password, stored).catch(() => false);
    return { ok, outdated: ok && !stored.startsWith("$argon2id$") };
  },
};
