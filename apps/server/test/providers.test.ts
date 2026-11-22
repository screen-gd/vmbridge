import { describe, expect, test } from "bun:test";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { instaboxError } from "../src/providers/index.ts";
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

describe("Instabox errors", () => {
  // As the SDK throws them: the HTTP status and Instabox's code are only in the cause.
  const quota = (providerCode: string) =>
    new SandboxError("Instabox create failed: a provider limit or billing stopped the request", {
      code: "quota",
      provider: "instabox",
      cause: JSON.stringify({ operation: "create", status: 429, providerCode }),
    });

  test("a full plan says what to do, and stays a quota error", () => {
    const error = instaboxError(quota("quota_exceeded"));
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "quota", message: "Your Instabox plan's machine limit is reached. Delete a machine or upgrade the plan." });
  });

  test("other limits keep the SDK's message", () => {
    const limited = quota("rate_limited");
    expect(instaboxError(limited)).toBe(limited);
  });
});
