import { Encryption } from "../src/encryption.ts";

/** A fixed key for tests that need storage but not encryption itself. */
export const testEncryption = new Encryption(new Uint8Array(32).fill(7));
