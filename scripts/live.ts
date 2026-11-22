// Live test against a running VM Bridge and a real provider. It creates a VM and deletes it at the end.
// It talks to VM Bridge the way T3 Code does: a pairing link, a bearer token and the RPC WebSocket.
//
//   bun scripts/live.ts <provider> [--agent] [--keep] [--base http://127.0.0.1:3790]
//
// Reads the dashboard key from VMBRIDGE_KEY_FILE. --agent also runs one agent turn, which uses inference.
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "http://127.0.0.1:3790" },
    agent: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    environment: { type: "string" },
    repo: { type: "string", default: "https://github.com/octocat/Hello-World.git" },
  },
});
const provider = positionals[0];
if (!provider) throw new Error("Name a provider.");
const base = values.base!;
const keyFile = process.env.VMBRIDGE_KEY_FILE;
if (!keyFile) throw new Error("Set VMBRIDGE_KEY_FILE to the dashboard key file.");

type Json = Record<string, any>;
const started = Date.now();
const log = (text: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${text}`);
const timings: Record<string, number> = {};
const latencies: Record<string, number[]> = {};

// Dashboard API.
let cookie = "";
async function admin<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  if (!cookie) {
    const login = await fetch(`${base}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: (await Bun.file(keyFile!).text()).trim() }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  }
  const response = await fetch(`${base}/admin/api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${value.error}`);
  return value;
}

// T3 client.
class Client {
  private socket!: WebSocket;
  private next = 0;
  private readonly pending = new Map<string, { chunk?: (values: unknown[]) => void; exit: (frame: Json) => void }>();

  constructor(readonly token: string) {}

  async connect() {
    const { ticket } = await this.http<{ ticket: string }>("/api/auth/websocket-ticket/rpc", { method: "POST" });
    this.socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${ticket}`);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Json;
      const entry = this.pending.get(String(frame.requestId));
      if (!entry) return;
      if (frame._tag === "Chunk") {
        this.socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
        entry.chunk?.(frame.values);
      } else if (frame._tag === "Exit") {
        this.pending.delete(String(frame.requestId));
        entry.exit(frame);
      }
    };
  }

  async http<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  call<T = Json>(tag: string, payload: Json = {}): Promise<T> {
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        exit: (frame) => {
          if (frame.exit._tag === "Success") resolve(frame.exit.value as T);
          else reject(new Error(`${tag}: ${JSON.stringify(frame.exit.cause).slice(0, 400)}`));
        },
      });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  /** Resolves with the first chunk value that matches. */
  until<T = Json>(tag: string, payload: Json, match: (value: Json) => T | undefined, timeoutMs: number): Promise<T> {
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${tag} timed out`)), timeoutMs);
      const finish = (error: Error | null, value?: T) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
        if (error) reject(error);
        else resolve(value!);
      };
      this.pending.set(id, {
        chunk: (values) => {
          for (const value of values) {
            const matched = match(value as Json);
            if (matched !== undefined) return finish(null, matched);
          }
        },
        exit: (frame) => finish(new Error(`${tag} ended: ${JSON.stringify(frame.exit).slice(0, 400)}`)),
      });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function time<T>(label: string, action: () => Promise<T>): Promise<T> {
  const at = performance.now();
  const value = await action();
  timings[label] = Math.round(performance.now() - at);
  log(`${label}: ${(timings[label]! / 1000).toFixed(1)}s`);
  return value;
}

async function bench(label: string, runs: number, action: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const at = performance.now();
    await action();
    samples.push(performance.now() - at);
  }
  latencies[label] = samples.sort((a, b) => a - b);
}

const percentile = (samples: number[], p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!.toFixed(1);

async function poll<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(1000);
  }
  throw new Error(`${what} timed out`);
}

let vmId: string | undefined;
let client: Client | undefined;
try {
  // Provider.
  if (values.environment) await admin("PUT", `/providers/${provider}`, { values: { environment: values.environment } });
  await time("add provider", async () => {
    await admin("POST", `/providers/${provider}/add`, {});
    await admin("POST", `/providers/${provider}/default`, {});
  });

  // Pair like T3 does.
  const pairing = await admin<{ urls: { url: string }[] }>("POST", "/pairing", { name: `Live test (${provider})` });
  const pairingToken = new URL(pairing.urls[0]!.url).hash.replace("#token=", "");
  const exchange = await fetch(`${base}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: pairingToken,
    }),
  });
  const { access_token } = (await exchange.json()) as { access_token: string };
  client = new Client(access_token);
  await client.connect();
  log("paired and connected");

  // A fresh VM on this provider. Cached config or VMs from an earlier provider would hide the real numbers.
  vmId = (await admin<{ id: string }>("POST", "/vms", {})).id;
  await time("first VM ready (create, install, start T3)", async () => {
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const vm = (await admin<{ vms: Json[] }>("GET", "/overview")).vms.find((entry) => entry.id === vmId);
      if (vm?.state === "ready" || vm?.state === "busy") return;
      if (!vm || vm.state === "error") throw new Error(`VM failed: ${vm?.error ?? "deleted"}`);
      if (Date.now() > deadline) throw new Error("VM did not start within 20 minutes.");
      await Bun.sleep(1000);
    }
  });
  // Agents as this VM reports them, so sign-ins the provider supplies show up here.
  const config = (await client.call("server.refreshProviders", {})) as { providers: Json[] };
  for (const agent of config.providers) {
    log(`agent ${agent.instanceId}: installed=${agent.installed} auth=${agent.auth?.status} status=${agent.status} models=${agent.models?.length ?? 0}`);
  }

  // Clone.
  const clone = await client.call("projectClone.start", { provider: "github", remoteUrl: values.repo });
  const projectId = clone.projectId as string;
  await time("clone and register project", () =>
    client!.until(
      "subscribeProjectClones",
      {},
      (snapshots) => {
        const list = (Array.isArray(snapshots) ? snapshots : [snapshots]) as Json[];
        const mine = list.find((snapshot) => snapshot.projectId === projectId);
        if (mine?.phase === "failed") throw new Error(`clone failed: ${mine.error}`);
        return mine?.phase === "done" ? mine : undefined;
      },
      10 * 60_000,
    ),
  );
  const project = (await admin<{ projects: Json[] }>("GET", "/overview")).projects.find((entry) => entry.id === projectId)!;
  vmId = project.vmIds[0];
  const cwd = clone.cwd as string;
  log(`project ${projectId} on VM ${vmId} at ${cwd}`);

  // Latency while awake.
  await bench("bridge: server.getConfig", 40, () => client!.call("server.getConfig"));
  await bench("bridge: GET /api/orchestration/shell", 40, () => client!.http("/api/orchestration/shell"));
  await bench("VM: vcs.refreshStatus", 30, () => client!.call("vcs.refreshStatus", { cwd }));
  await bench("VM: filesystem.browse", 30, () => client!.call("filesystem.browse", { partialPath: `${cwd}/` }));

  let threadId: string | undefined;
  if (values.agent) {
    const agent = (config.providers as Json[]).find((entry) => entry.enabled && entry.auth?.status === "authenticated" && entry.models?.length);
    if (!agent) throw new Error("No signed-in agent on the VM.");
    log(`agent turn with ${agent.instanceId} ${agent.models[0].slug}`);
    const launch = {
      commandId: crypto.randomUUID(),
      projectId,
      title: "VM Bridge live test",
      modelSelection: { instanceId: agent.instanceId, model: agent.models[0].slug },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: crypto.randomUUID(), attachments: [], text: "Live test. Reply with the single word ready. Do not run tools or edit files." },
    };
    const launched = await time("launch thread", () => client!.call("orchestration.launchThread", launch));
    threadId = launched.threadId as string;
    await time("first agent turn", () =>
      poll("agent turn", 5 * 60_000, async () => {
        const projection = await client!.call("orchestration.getThreadProjection", { threadId });
        const run = (projection.runs as Json[]).find((entry) => entry.ordinal === 1);
        if (run && ["failed", "interrupted"].includes(run.status)) throw new Error(`turn ${run.status}`);
        return run?.status === "completed" ? run : undefined;
      }),
    );
    await bench("VM: orchestration.getThreadProjection", 30, () => client!.call("orchestration.getThreadProjection", { threadId }));
  }

  // Sleep.
  await time("sleep VM", () => admin("POST", `/vms/${vmId}/sleep`, {}));
  const asleep = (await admin<{ vms: Json[] }>("GET", "/overview")).vms.find((vm) => vm.id === vmId);
  log(`state after sleep: ${asleep?.state}`);
  if (threadId) {
    await bench("asleep: getThreadProjection from cache", 20, () => client!.call("orchestration.getThreadProjection", { threadId }));
    const still = (await admin<{ vms: Json[] }>("GET", "/overview")).vms.find((vm) => vm.id === vmId);
    log(`reads while asleep left the VM ${still?.state}`);
  }
  await bench("asleep: vcs.refreshStatus fallback", 10, () => client!.call("vcs.refreshStatus", { cwd }));

  // Wake.
  if (threadId) {
    // VM Bridge holds the message until the VM is awake and T3 has taken it, so this times the wake.
    await time("wake on message (until T3 took it)", () =>
      client!.call("orchestration.dispatchCommand", {
        type: "message.dispatch",
        commandId: crypto.randomUUID(),
        threadId,
        createdBy: "user",
        creationSource: "web",
        messageId: crypto.randomUUID(),
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        text: "Reply with the single word again.",
      }),
    );
    await time("second agent turn", () =>
      poll("second turn", 10 * 60_000, async () => {
        const projection = await client!.call("orchestration.getThreadProjection", { threadId });
        const run = (projection.runs as Json[]).find((entry) => entry.ordinal === 2);
        if (run && ["failed", "interrupted"].includes(run.status)) throw new Error(`turn ${run.status}`);
        return run?.status === "completed" ? run : undefined;
      }),
    );
  } else {
    await time("wake", async () => {
      await admin("POST", `/vms/${vmId}/wake`, {});
      await poll("wake", 10 * 60_000, async () => {
        const vm = (await admin<{ vms: Json[] }>("GET", "/overview")).vms.find((entry) => entry.id === vmId);
        if (vm?.state === "error") throw new Error(`wake failed: ${vm.error}`);
        return vm?.state === "ready" || vm?.state === "busy" ? vm : undefined;
      });
    });
  }
  const status = await client.call("vcs.refreshStatus", { cwd });
  log(`checkout after wake: isRepo=${status.isRepo} branch=${status.refName}`);
  await bench("VM after wake: vcs.refreshStatus", 20, () => client!.call("vcs.refreshStatus", { cwd }));

  console.log("\nTimings");
  for (const [label, ms] of Object.entries(timings)) console.log(`  ${label.padEnd(46)} ${(ms / 1000).toFixed(1)}s`);
  console.log("\nLatency (ms)                                      p50     p95     max");
  for (const [label, samples] of Object.entries(latencies)) {
    console.log(`  ${label.padEnd(46)} ${percentile(samples, 0.5).padStart(6)}  ${percentile(samples, 0.95).padStart(6)}  ${samples.at(-1)!.toFixed(1).padStart(6)}`);
  }
} finally {
  client?.close();
  if (vmId && !values.keep) {
    // Every VM the project ended up on, in case a new thread went to an extra VM.
    const project = (await admin<{ projects: Json[] }>("GET", "/overview")).projects.find((entry) => (entry.vmIds as string[]).includes(vmId!));
    for (const id of new Set([vmId, ...((project?.vmIds as string[] | undefined) ?? [])])) {
      await admin("DELETE", `/vms/${id}`).then(
        () => log(`deleted VM ${id}`),
        (error) => log(`could not delete VM ${id}: ${error}`),
      );
    }
  }
  // Unpair this run's device so test devices don't pile up in the dashboard.
  const { clients } = await admin<{ clients: { id: string; name: string }[] }>("GET", "/overview");
  for (const entry of clients.filter((entry) => entry.name === `Live test (${provider})`)) await admin("DELETE", `/clients/${entry.id}`);
}
