import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { providers } from "../src/providers/index.ts";
import type { CreateVm } from "../src/providers/types.ts";

/**
 * A fake of the Instabox API, answering the way its docs (https://instabox.sh/docs) and live calls on a free plan do:
 * operations, live snapshots that are `pending` then `ready`, snapshot deletes guarded by `X-Confirm-Delete`, and
 * machines that keep running after the snapshot they came from is deleted.
 */
function fakeInstabox() {
  const machines = new Map<string, { id: string; name: string; state: string; metadata: Record<string, string>; createdAt: string }>();
  const snapshots = new Map<string, "pending" | "ready">();
  const requests: { method: string; path: string; body: Record<string, unknown> | null; confirm: string | null }[] = [];
  let next = 0;
  const id = (prefix: string) => `${prefix}${(++next).toString().padStart(26, "a")}`;
  const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
  const done = (machineId: string) => Response.json({ id: id("op_"), machineId, state: "succeeded" }, { status: 202 });

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      const { pathname: path } = url;
      const { method } = request;
      requests.push({ method, path, body, confirm: request.headers.get("X-Confirm-Delete") });

      if (method === "POST" && path === "/v1/machines") {
        const snapshot = body?.snapshotId;
        if (typeof snapshot === "string" && snapshots.get(snapshot) !== "ready") return error(404, "not_found");
        const machine = { id: id("m_"), name: String(body?.name), state: "running", metadata: (body?.metadata ?? {}) as Record<string, string>, createdAt: new Date().toISOString() };
        machines.set(machine.id, machine);
        return done(machine.id);
      }
      if (method === "GET" && path === "/v1/machines") {
        return Response.json({ machines: [...machines.values()], nextCursor: null });
      }
      const machineRoute = path.match(/^\/v1\/machines\/([^/]+)(?:\/(.+))?$/);
      if (machineRoute) {
        const [, machineId = "", action] = machineRoute;
        const machine = machines.get(machineId);
        if (!machine) return error(404, "not_found");
        if (method === "GET" && !action) return Response.json(machine);
        if (method === "DELETE" && !action) {
          machines.delete(machineId);
          return done(machineId);
        }
        if (method === "PUT" && action === "files") return new Response(null, { status: 204 });
        if (method === "POST" && action === "exec") {
          return new Response('event: exit\ndata: {"exitCode":0}\n\n', { headers: { "Content-Type": "text/event-stream" } });
        }
        if (method === "POST" && action === "snapshots") {
          if (machine.state !== "running") return error(409, "machine_not_running");
          const snapshot = id("sn_");
          snapshots.set(snapshot, "pending");
          return Response.json({ id: snapshot, name: body?.name, status: "pending" }, { status: 202 });
        }
        if (method === "POST" && (action === "suspend" || action === "resume")) {
          machine.state = action === "suspend" ? "suspended" : "running";
          return done(machineId);
        }
      }
      const snapshotRoute = path.match(/^\/v1\/snapshots\/([^/]+)$/);
      if (snapshotRoute) {
        const [, snapshot = ""] = snapshotRoute;
        if (!snapshots.has(snapshot)) return error(404, "not_found");
        if (method === "GET") {
          snapshots.set(snapshot, "ready");
          return Response.json({ id: snapshot, status: "ready" });
        }
        if (method === "DELETE") {
          if (request.headers.get("X-Confirm-Delete") !== snapshot) return error(409, "delete_confirmation_required");
          snapshots.delete(snapshot);
          return Response.json({});
        }
      }
      return error(404, "not_found");
    },
  });
  return { server, machines, snapshots, requests };
}

describe("Instabox base snapshots", () => {
  let fake: ReturnType<typeof fakeInstabox>;
  const previousUrl = process.env.INSTABOX_API_URL;

  beforeAll(() => {
    fake = fakeInstabox();
    // The SDK reads this when no base URL is passed, which VM Bridge never does.
    process.env.INSTABOX_API_URL = fake.server.url.origin;
  });
  afterAll(() => {
    fake.server.stop(true);
    if (previousUrl === undefined) delete process.env.INSTABOX_API_URL;
    else process.env.INSTABOX_API_URL = previousUrl;
  });

  test("build, start a VM from the snapshot, delete the replaced snapshot, and sleep and wake that VM", async () => {
    const driver = providers.instabox.open({ values: { apiKey: "test-key" } });
    const input = (key: string): CreateVm => ({ key, size: providers.instabox.defaultSize, labels: { vmbridge: "test" }, ports: [3773] });
    const creates = () => fake.requests.filter((entry) => entry.method === "POST" && entry.path === "/v1/machines").map((entry) => entry.body);

    // Build: a throwaway VM at the default size, which is the only size the free plan allows.
    const builder = await driver.create(input("base-1"));
    expect(creates().at(-1)).toMatchObject({ vcpus: 4, memMiB: 8192, autoSuspendAfterSeconds: 1800 });
    const first = await driver.snapshot!(builder);
    expect(fake.snapshots.get(first)).toBe("ready");
    await driver.destroy(builder.id);
    expect(fake.machines.has(builder.id)).toBe(false);

    // A new VM from it names no size: a snapshot fixes the size to its source's, and another is refused.
    const vm = await driver.create(input("vm-1"), first);
    const fromSnapshot = creates().at(-1);
    expect(fromSnapshot).toMatchObject({ snapshotId: first });
    expect(fromSnapshot).not.toContainKey("vcpus");
    expect(fromSnapshot).not.toContainKey("memMiB");
    expect(fromSnapshot).not.toContainKey("templateId");

    // A rebuild replaces it, and the replaced one is deleted with the confirmation Instabox requires.
    const second = await driver.snapshot!(await driver.create(input("base-2")));
    await driver.deleteCheckpoint(first);
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/snapshots/${first}`, confirm: first });
    expect(fake.snapshots.has(first)).toBe(false);
    expect(fake.snapshots.has(second)).toBe(true);
    // Already gone is fine.
    await driver.deleteCheckpoint(first);

    // A VM can no longer start from it, so VM Bridge falls back to a plain create.
    const refused = await driver.create(input("vm-2"), first).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SandboxError);
    expect((refused as SandboxError).code).toBe("not_found");

    // The VM made from it pauses and resumes without it, and sleeping keeps the same machine.
    expect(await driver.sleep(vm)).toEqual({});
    expect(fake.machines.get(vm.id)?.state).toBe("suspended");
    const woken = await driver.wake({ ...input("vm-1"), sandboxId: vm.id, checkpoint: null });
    expect(woken.id).toBe(vm.id);
    expect(fake.machines.get(vm.id)?.state).toBe("running");
  });
});
