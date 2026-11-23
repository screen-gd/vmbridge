import { workersFetchCompat } from "../../src/providers/workers-fetch.ts";
import { runChecks } from "./checks.ts";

/** `?shim=0` skips the fetch shim, to show what it fixes. Request it before any request with the shim. */
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.searchParams.get("shim") !== "0") workersFetchCompat();
    return Response.json({ userAgent: navigator.userAgent, results: await runChecks() });
  },
};
