import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { ProviderId } from "@vmbridge/contracts";
import { providers } from "../../src/providers/index.ts";

/** One cheap authenticated call per provider driver, opened the way VM Bridge opens it, with a fake key. */

const fakeValues: Record<ProviderId, Record<string, string>> = {
  boat: { apiKey: "boat_fake" },
  boxd: { apiKey: "bxd_fake" },
  daytona: { apiKey: "dtn_fake" },
  e2b: { apiKey: "e2b_fake" },
  freestyle: { apiKey: "fs_fake" },
  instabox: { apiKey: "ib_fake" },
  railway: { token: "00000000-0000-0000-0000-000000000000", environmentId: "00000000-0000-0000-0000-000000000000" },
  superserve: { apiKey: "ss_live_fake" },
};

export interface Result {
  name: string;
  refused: boolean;
  code?: string;
  message?: string;
}

function checks() {
  const open = (id: ProviderId) => providers[id].open({ values: fakeValues[id] });
  const verify = Object.keys(providers).map((id) => ({ name: id, call: () => open(id as ProviderId).verify() }));
  return [
    ...verify,
    // Railway's verify uses the SDK adapter's own fetch. These two go through the `railway` package.
    { name: "railway connect", call: () => open("railway").connect("00000000-0000-0000-0000-000000000000") },
    { name: "railway checkpoints", call: () => open("railway").deleteCheckpoint("fake-checkpoint") },
  ];
}

async function run(check: { name: string; call: () => Promise<unknown> }): Promise<Result> {
  try {
    await Promise.race([check.call(), new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 30 s")), 30_000))]);
    return { name: check.name, refused: false };
  } catch (error) {
    const code = error instanceof SandboxError ? error.code : error instanceof Error ? error.name : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    return { name: check.name, refused: true, code, message: message.slice(0, 160) };
  }
}

export const runChecks = () => Promise.all(checks().map(run));
