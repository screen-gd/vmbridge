import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSecurityHeaders } from "../src/security-headers.ts";
import { start } from "../src/index.ts";

let dir: string;
let bridge: Awaited<ReturnType<typeof start>>;
const get = (path: string) => fetch(`http://127.0.0.1:${bridge.port}${path}`, { redirect: "manual" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-dashboard-"));
  bridge = await start({ dir, host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a trailing slash on a dashboard page redirects to the page, keeping the query", async () => {
  const redirects = {
    "/dashboard/": "/dashboard",
    "/dashboard/onboarding/": "/dashboard/onboarding",
    "/dashboard/?view=settings": "/dashboard?view=settings",
  };
  for (const [from, to] of Object.entries(redirects)) {
    const response = await get(from);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(to);
  }
  expect((await get("/dashboard")).status).toBe(200);
  expect((await get("/dashboard/onboarding")).status).toBe(200);
});

test("other paths are left alone", async () => {
  expect((await get("/admin/api/")).status).not.toBe(302);
  expect((await get("/nothing/")).status).toBe(404);
});

test("the dashboard, its files and its API are sent with security headers", async () => {
  const page = await get("/dashboard");
  const script = [...(await page.text()).matchAll(/src="(\/[^"]+\.js)"/g)][0]?.[1];
  expect(script).toBeDefined();
  // A production bundle: the development one has an inline script the policy blocks.
  expect(script).not.toContain("/_bun/");
  for (const path of ["/dashboard", "/dashboard/onboarding", script!, "/admin/api/auth"]) {
    const headers = (await get(path)).headers;
    expect({ path, csp: headers.get("content-security-policy") }).toEqual({ path, csp: expect.stringContaining("frame-ancestors 'none'") });
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  }
  // Conditional requests still work through the headers.
  const etag = page.headers.get("etag");
  expect(etag).toBeTruthy();
  const again = await fetch(`http://127.0.0.1:${bridge.port}/dashboard`, { headers: { "if-none-match": etag! } });
  expect(again.status).toBe(304);
});

test("adding the security headers keeps every cookie a response sets", () => {
  const headers = new Headers();
  headers.append("set-cookie", "a=; Max-Age=0");
  headers.append("set-cookie", "b=; Max-Age=0");
  expect(withSecurityHeaders(new Response(null, { headers })).headers.getSetCookie()).toEqual(["a=; Max-Age=0", "b=; Max-Age=0"]);
});
