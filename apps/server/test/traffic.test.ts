import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { keptErrors, problemMs, Traffic } from "../src/traffic.ts";

let quiet: ReturnType<typeof spyOn>;
beforeEach(() => (quiet = spyOn(console, "error").mockImplementation(() => {})));
afterEach(() => quiet.mockRestore());

describe("background failures", () => {
  test("survive a restart and flag their VM or provider until the same operation works again", () => {
    const db = openDatabase(":memory:");
    const traffic = new Traffic(db);
    traffic.record({ kind: "provider", operation: "sleep VM", vmId: "vm1", provider: "boxd", status: "error", reason: "boxd is down.\nstack trace" });
    traffic.record({ kind: "provider", operation: "delete untracked VM", provider: "railway", status: "error", reason: "Timed out." });
    traffic.record({ kind: "rpc", operation: "orchestration.dispatchCommand", status: "error" });
    expect(quiet).toHaveBeenCalledWith("[error] sleep VM: boxd is down. (VM vm1)");

    const restarted = new Traffic(db);
    expect(restarted.recent.map((event) => event.operation)).toEqual(["sleep VM", "delete untracked VM"]);
    expect(restarted.problems()).toEqual({
      vms: new Map([["vm1", "Sleep VM failed: boxd is down."]]),
      providers: new Map([["railway", "Delete untracked VM failed: Timed out."]]),
    });

    restarted.record({ kind: "provider", operation: "sleep VM", vmId: "vm1", status: "ok" });
    restarted.record({ kind: "provider", operation: "delete untracked VM", provider: "railway", status: "ok" });
    expect(restarted.problems()).toEqual({ vms: new Map(), providers: new Map() });
    // Still in the log.
    expect(new Traffic(db).recent).toHaveLength(2);
  });

  test("a failed base snapshot build does not flag its provider, since Setup shows it", () => {
    const traffic = new Traffic(openDatabase(":memory:"));
    traffic.record({ kind: "provider", operation: "look for untracked VMs", provider: "boat", status: "error", reason: "HTTP 401" });
    traffic.record({ kind: "provider", operation: "build medium base snapshot", provider: "boat", status: "error", reason: "HTTP 401" });
    expect(traffic.problems().providers).toEqual(new Map([["boat", "Look for untracked VMs failed: HTTP 401"]]));
  });

  test("stop flagging after a day, and only the latest ones are kept", () => {
    const db = openDatabase(":memory:");
    const traffic = new Traffic(db);
    for (let i = 0; i < keptErrors + 5; i++) traffic.record({ kind: "provider", operation: `wake VM ${i}`, vmId: "vm1", status: "error" });
    expect(new Traffic(db).recent).toHaveLength(keptErrors);
    expect(traffic.problems().vms.get("vm1")).toBe(`Wake VM ${keptErrors + 4} failed`);
    expect(traffic.problems(Date.now() + problemMs + 1).vms.size).toBe(0);
  });
});
