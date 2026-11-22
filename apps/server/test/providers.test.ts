import { describe, expect, test } from "bun:test";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { retryNotFound } from "../src/providers/sdk.ts";

describe("creating a boxd VM", () => {
  test("tries again when boxd loses track of the machine it just made, and gives up on anything else", async () => {
    const missing = new SandboxError("boxd request failed: the sandbox does not exist", { code: "not_found", provider: "boxd" });
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(missing) : Promise.resolve("box"));
    expect(await retryNotFound(flaky, 3, 1)).toBe("box");
    expect(calls).toBe(3);

    calls = 0;
    const quota = new SandboxError("Quota exceeded", { code: "quota", provider: "boxd" });
    await expect(retryNotFound(() => (calls++, Promise.reject(quota)), 3, 1)).rejects.toBe(quota);
    expect(calls).toBe(1);

    calls = 0;
    await expect(retryNotFound(() => (calls++, Promise.reject(missing)), 3, 1)).rejects.toBe(missing);
    expect(calls).toBe(3);
  });
});
