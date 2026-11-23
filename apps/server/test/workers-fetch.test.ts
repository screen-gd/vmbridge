import { afterEach, beforeEach, expect, test } from "bun:test";
import { workersFetchCompat } from "../src/providers/workers-fetch.ts";

const original = globalThis.fetch;
let calls: { receiver: unknown; redirect: RequestInit["redirect"] }[] = [];
let status = 200;

beforeEach(() => {
  calls = [];
  status = 200;
  // Stands in for Workers' fetch: it records the receiver it was called with and refuses `redirect: "error"`.
  globalThis.fetch = Object.assign(
    async function (this: unknown, _input: Parameters<typeof fetch>[0], init?: RequestInit) {
      calls.push({ receiver: this, redirect: init?.redirect });
      if (init?.redirect === "error") throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      return new Response(null, { status });
    },
    { preconnect: original.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = original;
});

test("a fetch that must not redirect goes out as manual, and still fails on a redirect", async () => {
  workersFetchCompat();
  expect((await fetch("https://example.test", { redirect: "error" })).status).toBe(200);
  expect(calls.at(-1)?.redirect).toBe("manual");

  status = 302;
  await expect(fetch("https://example.test", { redirect: "error" })).rejects.toThrow("redirected (302)");
  // Other requests pass through as they are, redirects included.
  expect((await fetch("https://example.test", { redirect: "manual" })).status).toBe(302);
  expect(calls.at(-1)?.redirect).toBe("manual");
});

test("a fetch saved and called as a method reaches the native fetch without that receiver", async () => {
  workersFetchCompat();
  const config = { fetch: globalThis.fetch };
  await config.fetch("https://example.test");
  expect(calls.at(-1)?.receiver).toBeUndefined();
});

test("installing twice wraps once", async () => {
  workersFetchCompat();
  const first = globalThis.fetch;
  workersFetchCompat();
  expect(globalThis.fetch).toBe(first);
});
