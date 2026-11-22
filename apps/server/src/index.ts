import { homedir } from "node:os";
import { join } from "node:path";
import dashboard from "@vmbridge/web/index.html";
import { version } from "../../../package.json" with { type: "json" };
import { Admin } from "./admin.ts";
import { AgentAuth } from "./agent-auth/profiles.ts";
import { Clients } from "./auth/clients.ts";
import { DashboardAuth } from "./auth/dashboard.ts";
import { openDatabase } from "./db.ts";
import { Fleet } from "./fleet.ts";
import { fetchGitHubAccount } from "./github.ts";
import { Clones } from "./gateway/clones.ts";
import { isT3Path, T3Gateway, type SocketData } from "./gateway/http.ts";
import { Hub } from "./gateway/hub.ts";
import { RemoteBranches } from "./gateway/repos.ts";
import { Rpc } from "./gateway/rpc.ts";
import { networkInfo } from "./network.ts";
import { Secrets, Settings } from "./settings.ts";
import { Skills } from "./skills.ts";
import { Store } from "./store.ts";
import { Traffic } from "./traffic.ts";
import { Usage } from "./usage.ts";
import { Stats } from "./vm/stats.ts";

export { version };
export const defaultPort = 3774;
export const defaultHost = "0.0.0.0";
export const dataDir = () => process.env.VMBRIDGE_HOME || join(homedir(), ".vmbridge");
export const databasePath = (dir = dataDir()) => join(dir, "main.db");

/** Dashboard password setup, for the CLI to run before the server starts. */
export function dashboardKey(dir = dataDir()) {
  const db = openDatabase(databasePath(dir));
  const auth = new DashboardAuth(db, new Settings(db));
  return {
    isSet: () => auth.hasKey(),
    set: (key: string) => auth.setKey(key),
    close: () => db.close(),
  };
}

export interface StartOptions {
  dir?: string;
  host?: string;
  port?: number;
}

export async function start(options: StartOptions = {}) {
  const host = options.host ?? defaultHost;
  const port = options.port ?? defaultPort;
  const dir = options.dir ?? dataDir();
  const db = openDatabase(databasePath(dir));
  const settings = new Settings(db);
  const secrets = new Secrets(db);
  const store = new Store(db);
  const traffic = new Traffic(db);

  const agents = new AgentAuth(join(dir, "auths"), settings);
  const skills = new Skills(db);
  const fleet = new Fleet(store, settings, secrets, traffic, agents, skills);
  skills.on("changed", () => {
    fleet.emit("changed");
    void fleet.shareSkills();
  });
  const stats = new Stats(fleet);
  const usage = new Usage(store, () => fleet.connected());
  for (const event of ["changed", "awake", "offline"] as const) fleet.on(event, () => usage.sync());
  usage.start();
  const hub = new Hub(store, settings, fleet, traffic, stats);
  agents.onChange = () => {
    fleet.emit("changed");
    void hub.credentialsChanged().catch(() => {});
  };
  const clones = new Clones(hub);
  const branches = new RemoteBranches(() => secrets.get("github.token"));
  const clients = new Clients(db);
  const rpc = new Rpc(hub, clones, branches, traffic, () => secrets.has("github.token"));
  const gateway = new T3Gateway(hub, rpc, clients);
  const auth = new DashboardAuth(db, settings);
  const admin = new Admin({ version, startedAt: Date.now(), host, port, settings, secrets, store, fleet, hub, traffic, clients, auth, gateway, agents, stats, skills, usage });

  const server = Bun.serve<SocketData>({
    hostname: host,
    port,
    maxRequestBodySize: 2 * 1024 * 1024,
    // Long enough for the dashboard's event stream between heartbeats.
    idleTimeout: 60,
    development: process.env.VMBRIDGE_DEV === "1",
    // The dashboard lives under /dashboard, a path T3 clients never request.
    routes: {
      "/dashboard": dashboard,
      "/dashboard/onboarding": dashboard,
      "/": new Response(null, { status: 302, headers: { location: "/dashboard" } }),
    },
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/admin/api/")) return admin.fetch(request, server);
      if (isT3Path(path)) return gateway.fetch(request, server);
      return new Response("Not found", { status: 404 });
    },
    websocket: gateway.websocket,
  });

  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    hub
      .sweep()
      .catch((error) => traffic.record({ kind: "system", operation: "idle sweep", status: "error", reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => (sweeping = false));
  }, 15_000);
  const codexSync = setInterval(() => void fleet.syncCodexAuth().catch(() => {}), 60 * 60_000);
  // Often enough for the dashboard's high memory warning; opening a VM's details reads it right away.
  const statsTimer = setInterval(() => void stats.sampleAll().catch(() => {}), 30_000);
  // Installed local skills and instructions files follow edits on this machine. Reading a few small files is cheaper than watching them reliably.
  skills.instructions.refresh();
  const skillWatch = setInterval(() => {
    try {
      skills.refreshLocal();
      skills.instructions.refresh();
    } catch {}
  }, 5_000);
  void fleet.resume();
  // Accounts saved by older versions lack the details the dashboard shows.
  const githubToken = secrets.get("github.token");
  if (githubToken && !settings.get("github")?.checkedAt) {
    void fetchGitHubAccount(githubToken).then((account) => settings.set("github", account), () => {});
  }
  traffic.record({ kind: "system", operation: "VM Bridge started" });

  return {
    port: server.port ?? port,
    host,
    /** Opens first password setup in the dashboard. Null when a password exists. Show it only to whoever started VM Bridge. */
    setupCode: auth.createSetupCode(),
    network: () => networkInfo(host, server.port ?? port),
    async stop() {
      clearInterval(sweep);
      clearInterval(codexSync);
      clearInterval(statsTimer);
      clearInterval(skillWatch);
      gateway.close();
      await server.stop(true);
      // Some providers have no idle timeout of their own: a VM left awake here would run until VM Bridge starts again.
      await hub.sleepIdle(15_000);
      hub.close();
      fleet.close();
      usage.close();
      db.close();
    },
  };
}
