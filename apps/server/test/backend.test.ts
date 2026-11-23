import { expect, test } from "bun:test";
import { Backend } from "../src/vm/backend.ts";

test("the preview URL's own query parameters win over the client's", async () => {
  const seen: URL[] = [];
  // Stands in for the VM's T3 server behind its preview URL.
  using vm = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(new URL(request.url));
      return Response.json({});
    },
  });
  const backend = new Backend("vm1", { url: `${vm.url.origin}/?preview_token=PROVIDER` }, "t3-token", async () => {
    throw new Error("no sockets in this test");
  });

  await backend.http("/api/orchestration/threads/t1?preview_token=CLIENT&preview_token=AGAIN&view=full");
  expect(seen[0]!.searchParams.getAll("preview_token")).toEqual(["PROVIDER"]);
  expect(seen[0]!.searchParams.get("view")).toBe("full");
});
