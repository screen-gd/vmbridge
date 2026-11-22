import type { Server } from "bun";
import {
  agentKinds,
  providerIds,
  vmSizes,
  type LiveMessage,
  type Overview,
  type ProviderId,
  type ProviderInfo,
  type RepoRule,
  type VmInfo,
  type VmSize,
} from "@vmbridge/contracts";
import { InvalidSignIn, type AgentAuth, type TokenInput } from "./agent-auth/profiles.ts";
import { TooManyAttempts, type DashboardAuth } from "./auth/dashboard.ts";
import { fetchGitHubAccount, fetchGitHubRepos, GitHubRejected } from "./github.ts";
import type { Clients } from "./auth/clients.ts";
import { message, providerValues, type Fleet } from "./fleet.ts";
import type { Hub } from "./gateway/hub.ts";
import type { T3Gateway } from "./gateway/http.ts";
import { githubName } from "./gateway/repos.ts";
import { isWorking } from "./gateway/types.ts";
import { disableTailscaleHttps, enableTailscaleHttps, networkInfo } from "./network.ts";
import { providers } from "./providers/index.ts";
import { envVars, saveEnvVars, type Secrets, type Settings } from "./settings.ts";
import { SkillError, type Skills } from "./skills.ts";
import type { Store } from "./store.ts";
import type { Traffic } from "./traffic.ts";
import { envNameProblem, envValueProblem } from "./vm/runtime.ts";
import type { Stats } from "./vm/stats.ts";

export interface AdminDeps {
  version: string;
  startedAt: number;
  host: string;
  port: number;
  settings: Settings;
  secrets: Secrets;
  store: Store;
  fleet: Fleet;
  hub: Hub;
  traffic: Traffic;
  clients: Clients;
  auth: DashboardAuth;
  gateway: T3Gateway;
  agents: AgentAuth;
  stats: Stats;
  skills: Skills;
}

class BadRequest extends Error {}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const isProvider = (id: unknown): id is ProviderId => (providerIds as readonly unknown[]).includes(id);
const isSize = (size: unknown): size is VmSize => (vmSizes as readonly unknown[]).includes(size);

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequest("Send a JSON object.");
  return value as Record<string, unknown>;
}

const text = (value: unknown, label: string) => {
  if (typeof value !== "string") throw new BadRequest(`${label} must be text.`);
  return value.trim();
};

/**
 * The dashboard's API under /admin/api. Every route except login needs the dashboard cookie.
 * Secret values go in and never come out: responses only say whether each one is set.
 */
export class Admin {
  constructor(private readonly deps: AdminDeps) {}

  async fetch(request: Request, server: Server<unknown>): Promise<Response> {
    const path = new URL(request.url).pathname.slice("/admin/api".length);
    const { auth } = this.deps;
    // A JSON body forces a CORS preflight, which VM Bridge never answers, so other sites cannot post here.
    if (request.method !== "GET" && !request.headers.get("content-type")?.startsWith("application/json")) {
      return json({ error: "Send JSON." }, 415);
    }
    try {
      if (path === "/auth" && request.method === "GET") return json({ authenticated: auth.authenticated(request) });
      if (path === "/login" && request.method === "POST") {
        const { key } = await body(request);
        const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
        const cookie = await auth.login(typeof key === "string" ? key : "", server.requestIP(request)?.address ?? "unknown", secure);
        if (!cookie) return json({ error: "That key is not right." }, 401);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": cookie } });
      }
      if (!auth.authenticated(request)) return json({ error: "Log in first." }, 401);
      return await this.route(request, path);
    } catch (error) {
      if (error instanceof TooManyAttempts) return json({ error: error.message }, 429);
      if (error instanceof BadRequest || error instanceof InvalidSignIn || error instanceof GitHubRejected || error instanceof SkillError) return json({ error: error.message }, 400);
      return json({ error: message(error) }, 500);
    }
  }

  private async route(request: Request, path: string): Promise<Response> {
    const { settings, secrets, store, fleet, hub, clients, auth, gateway, agents, skills } = this.deps;
    const method = request.method;
    const [, section, id, action] = path.split("/");

    if (path === "/logout" && method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": auth.logout(request) } });
    }
    if (path === "/key" && method === "POST") {
      await auth.setKey(text((await body(request)).key, "The password"));
      return json({ ok: true });
    }
    if (path === "/overview" && method === "GET") return json(this.overview());
    if (path === "/events" && method === "GET") return this.events(request);
    if (path === "/traffic" && method === "GET") return json(this.deps.traffic.recent);

    if (path === "/network" && method === "GET") return json(await networkInfo(this.deps.host, this.deps.port));
    if (path === "/network/https" && method === "POST") {
      const { enabled } = await body(request);
      if (enabled === true) await enableTailscaleHttps(this.deps.port);
      else await disableTailscaleHttps(this.deps.port);
      return json(await networkInfo(this.deps.host, this.deps.port));
    }

    if (section === "providers") {
      if (!id) return json(providerIds.map((provider) => this.providerInfo(provider)));
      if (!isProvider(id)) return json({ error: "Unknown provider." }, 404);
      const definition = providers[id];
      if (!action && method === "PUT") {
        const { values } = await body(request);
        if (!values || typeof values !== "object") throw new BadRequest("Send the provider's values.");
        const options = { ...settings.get("providerOptions")[id] };
        for (const field of definition.fields) {
          const value = (values as Record<string, unknown>)[field.key];
          if (value === undefined) continue;
          if (value !== null && typeof value !== "string") throw new BadRequest(`${field.label} must be text.`);
          const trimmed = value?.trim() ?? "";
          if (field.kind === "secret") {
            // An empty secret field means "leave it as it is"; null clears it.
            if (value === null || trimmed) secrets.set(`provider.${id}.${field.key}`, value === null ? null : trimmed);
          } else if (trimmed) options[field.key] = trimmed;
          else delete options[field.key];
        }
        settings.set("providerOptions", { ...settings.get("providerOptions"), [id]: options });
        fleet.emit("changed");
        return json(this.providerInfo(id));
      }
      if (action === "verify" && method === "POST") {
        await fleet.driver(id).verify();
        return json({ ok: true });
      }
      if (action === "options" && method === "GET") {
        const field = new URL(request.url).searchParams.get("field") ?? "";
        return json(await fleet.driver(id).options(field));
      }
      if (action === "add" && method === "POST") {
        await fleet.driver(id).verify();
        const added = settings.get("providers");
        if (!added.includes(id)) {
          settings.set("providers", [...added, id]);
          // So the first VM there can already start from a base snapshot.
          void fleet.prepareBase(id).catch(() => {});
        }
        // The first provider added becomes the default.
        if (!settings.get("defaultProvider")) settings.set("defaultProvider", id);
        this.providersChanged();
        return json(this.providerInfo(id));
      }
      if (action === "default" && method === "POST") {
        if (!settings.get("providers").includes(id)) throw new BadRequest(`Add ${definition.label} first.`);
        settings.set("defaultProvider", id);
        this.providersChanged();
        return json(this.providerInfo(id));
      }
      // VMs already on the provider keep running. Only new VMs stop going there.
      if (!action && method === "DELETE") {
        const remaining = settings.get("providers").filter((entry) => entry !== id);
        settings.set("providers", remaining);
        void fleet.bases.drop(id).catch(() => {});
        if (settings.get("defaultProvider") === id) settings.set("defaultProvider", remaining[0] ?? null);
        this.providersChanged();
        return json(this.providerInfo(id));
      }
    }

    if (path === "/github/repos" && method === "GET") {
      const token = secrets.get("github.token");
      return json(token ? await fetchGitHubRepos(token) : []);
    }
    if (path === "/repo-rules" && method === "PUT") {
      const { rules } = await body(request);
      if (!Array.isArray(rules)) throw new BadRequest("Send the repository rules.");
      const seen = new Set<string>();
      const parsed = rules.map((rule): RepoRule => {
        const repo = typeof rule?.repo === "string" ? githubName(rule.repo) : undefined;
        if (!repo) throw new BadRequest("Name each repository as owner/name.");
        if (seen.has(repo.toLowerCase())) throw new BadRequest(`${repo} is listed twice.`);
        seen.add(repo.toLowerCase());
        if (rule.provider !== null && !isProvider(rule.provider)) throw new BadRequest("Unknown provider.");
        if (rule.size !== null && !isSize(rule.size)) throw new BadRequest("Pick small, medium or large.");
        return { repo, provider: rule.provider, size: rule.size };
      });
      settings.set("repoRules", parsed);
      fleet.emit("changed");
      return json(parsed);
    }

    if (path === "/github" && method === "PUT") {
      const token = text((await body(request)).token, "The token");
      if (!token) throw new BadRequest("Paste a personal access token.");
      const account = await fetchGitHubAccount(token);
      secrets.set("github.token", token);
      settings.set("github", account);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      hub.emit("config");
      return json(account);
    }
    if (path === "/github/check" && method === "POST") {
      const token = secrets.get("github.token");
      if (!token) throw new BadRequest("Connect GitHub first.");
      const account = await fetchGitHubAccount(token);
      settings.set("github", account);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      hub.emit("config");
      return json(account);
    }
    if (path === "/github" && method === "DELETE") {
      secrets.set("github.token", null);
      settings.set("github", null);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      hub.emit("config");
      return json({ ok: true });
    }

    // Environment variables for every VM. Values go in and never come out.
    if (section === "env" && id) {
      const name = decodeURIComponent(id);
      // Each change reads the saved variables right before writing them, after any await, so overlapping saves keep each other's.
      if (!action && method === "PUT") {
        const problem = envNameProblem(name);
        if (problem) throw new BadRequest(problem);
        const { value } = await body(request);
        if (typeof value !== "string") throw new BadRequest("The value must be text.");
        const invalid = envValueProblem(value);
        if (invalid) throw new BadRequest(invalid);
        saveEnvVars(secrets, { ...envVars(secrets), [name]: value });
      } else if (!action && method === "DELETE") {
        const { [name]: _removed, ...rest } = envVars(secrets);
        saveEnvVars(secrets, rest);
      } else return json({ error: "Not found." }, 404);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      return json(Object.keys(envVars(secrets)));
    }

    if (path === "/agents" && method === "POST") {
      const input = await body(request);
      const name = input.name === undefined ? "" : text(input.name, "The name");
      const token = text(input.token, "The token");
      if (!token) throw new BadRequest("Paste the token.");
      let profile: TokenInput;
      if (input.agent === "claude" && input.method === "setup-token") profile = { agent: "claude", method: "setup-token", name, token };
      else if (input.agent === "claude" && input.method === "auth-token") {
        const baseUrl = input.baseUrl == null ? "" : text(input.baseUrl, "The base URL");
        profile = { agent: "claude", method: "auth-token", name, token, baseUrl: baseUrl || null };
      } else if (input.agent === "opencode" && input.method === "api-key") profile = { agent: "opencode", method: "api-key", name, token };
      else throw new BadRequest("Unknown sign-in method.");
      return json(await agents.addToken(profile));
    }
    if (section === "agents" && id && action === "use" && method === "POST") {
      agents.use(id);
      return json({ ok: true });
    }
    if (section === "agents" && id && !action && method === "DELETE") {
      agents.remove(id);
      return json({ ok: true });
    }
    if (path === "/claude-login" && method === "POST") return json(agents.startClaudeLogin());
    if (section === "claude-login" && id && method === "POST") {
      const input = await body(request);
      const name = input.name === undefined ? "" : text(input.name, "The name");
      return json(await agents.finishClaudeLogin(id, text(input.code, "The code"), name));
    }
    if (path === "/codex-login" && method === "POST") {
      const { name } = await body(request);
      return json(await agents.startCodexLogin(name === undefined ? "" : text(name, "The name")));
    }
    if (section === "codex-login" && id) {
      if (method === "GET") {
        const login = agents.codexLogin(id);
        return login ? json(login) : json({ error: "That sign-in expired. Start again." }, 404);
      }
      if (method === "DELETE") {
        agents.cancelCodexLogin(id);
        return json({ ok: true });
      }
    }

    if (path === "/settings" && method === "PUT") {
      const input = await body(request);
      if (input.vmSize !== undefined) {
        if (input.vmSize !== null && !isSize(input.vmSize)) throw new BadRequest("Pick default, small, medium or large.");
        settings.set("vmSize", input.vmSize);
      }
      if (input.idleMinutes !== undefined) {
        const minutes = Number(input.idleMinutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new BadRequest("Idle minutes must be 1 to 240.");
        settings.set("idleMinutes", minutes);
      }
      if (input.t3Version !== undefined) {
        const version = input.t3Version === null ? "" : text(input.t3Version, "The T3 version");
        if (version && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new BadRequest("Use an exact version, such as 0.1.11.");
        settings.set("t3Version", version || null);
      }
      fleet.emit("changed");
      return json(this.overview().settings);
    }

    if (section === "pairing") {
      if (!id && method === "GET") return json(clients.links());
      if (!id && method === "POST") {
        let link;
        try {
          link = clients.createLink(text((await body(request)).name, "The name"));
        } catch (error) {
          throw new BadRequest(message(error));
        }
        const network = await networkInfo(this.deps.host, this.deps.port);
        const urls = network.addresses.map((address) => {
          const url = `${address.url}/pair#token=${link.token}`;
          return { kind: address.kind, label: address.label, url };
        });
        return json({ link: link.link, urls });
      }
      if (id && method === "DELETE") {
        clients.deleteLink(id);
        return json({ ok: true });
      }
    }
    if (section === "clients" && id && method === "DELETE") {
      clients.revoke(id);
      gateway.disconnect(id);
      fleet.emit("changed");
      return json({ ok: true });
    }

    if (section === "skills") {
      if (id === "local" && !action && method === "GET") return json(skills.discover());
      if (id === "local" && !action && method === "PUT") {
        const input = await body(request);
        if (typeof input.sync !== "boolean") throw new BadRequest("Say whether to sync every local skill.");
        skills.setSyncAll(input.sync);
        return json(skills.discover());
      }
      if (id === "search" && !action && method === "GET") {
        const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
        return json(query ? await skills.search(query) : []);
      }
      if (!id && method === "POST") {
        const input = await body(request);
        if (input.source === "skills.sh") await skills.installFromSkillsSh(text(input.repo, "The repository"), text(input.skill, "The skill"));
        else if (input.source === "local") await skills.installLocal(text(input.path, "The folder"));
        else throw new BadRequest("Pick a skill from skills.sh or this machine.");
        return json(skills.list());
      }
      if (id && action === "update" && method === "POST") return json({ changed: await skills.update(decodeURIComponent(id)) });
      if (id && !action && method === "DELETE") {
        skills.remove(decodeURIComponent(id));
        return json(skills.list());
      }
    }

    if (section === "instructions" && id && !action && method === "PUT") {
      const agent = agentKinds.find((kind) => kind === id);
      if (!agent) return json({ error: "No such agent." }, 404);
      const input = await body(request);
      if (typeof input.sync !== "boolean") throw new BadRequest("Say whether to sync it.");
      skills.instructions.setSync(agent, input.sync);
      return json(skills.instructions.list());
    }

    if (section === "vms" && id) {
      if (!store.vm(id)) return json({ error: "No such VM." }, 404);
      if (action === "wake" && method === "POST") {
        void fleet.ensure(id).catch(() => {});
        return json({ ok: true });
      }
      // A fresh reading for an open details panel. It never wakes the VM.
      if (action === "stats" && method === "GET") return json(await this.deps.stats.sample(id));
      if (action === "sleep" && method === "POST") {
        await fleet.sleep(id);
        return json({ ok: true });
      }
      if (!action && method === "DELETE") {
        await fleet.destroy(id);
        hub.emit("shell");
        return json({ ok: true });
      }
    }
    if (section === "vms" && !id && method === "POST") {
      const { provider, size } = await body(request);
      if (provider !== undefined && !isProvider(provider)) throw new BadRequest("Unknown provider.");
      if (size !== undefined && !isSize(size)) throw new BadRequest("Pick small, medium or large.");
      const vm = await fleet.create({ provider, size });
      void fleet.ensure(vm.id).catch(() => {});
      return json({ id: vm.id });
    }

    return json({ error: "Not found." }, 404);
  }

  private providerInfo(id: ProviderId): ProviderInfo {
    const definition = providers[id];
    const { settings, secrets } = this.deps;
    const values = { ...settings.get("providerOptions")[id] };
    const secretsSet = definition.fields
      .filter((field) => field.kind === "secret" && secrets.has(`provider.${id}.${field.key}`))
      .map((field) => field.key);
    const all = providerValues(settings, secrets, id);
    return {
      id,
      label: definition.label,
      website: definition.website,
      fields: definition.fields,
      features: definition.features,
      sizes: definition.sizes,
      defaultSize: definition.defaultSize,
      values,
      secretsSet,
      configured: definition.fields.every((field) => !field.required || Boolean(all[field.key])),
      added: settings.get("providers").includes(id),
      isDefault: settings.get("defaultProvider") === id,
    };
  }

  private providersChanged() {
    this.deps.fleet.emit("changed");
    // T3's agent list labels agents with the provider when there is only one.
    this.deps.hub.emit("config");
  }

  overview(): Overview {
    const { settings, secrets, store, fleet, hub, clients, gateway } = this.deps;
    const defaultProvider = settings.get("defaultProvider");
    const agents = this.deps.agents.list();
    const projects = store.projects();
    const idleMs = settings.get("idleMinutes") * 60_000;
    const skills = this.deps.skills.state();
    const vms = store
      .vms()
      .filter((vm) => vm.state !== "gone")
      .map((vm): VmInfo => {
        const idle = vm.state === "ready" && !fleet.leased(vm.id);
        return {
          id: vm.id,
          name: vm.name,
          provider: vm.provider,
          providerLabel: providers[vm.provider].label,
          sandboxId: vm.sandboxId,
          size: vm.size,
          sizeLabel: providers[vm.provider].sizes[vm.size],
          state: vm.state,
          error: vm.error,
          createdAt: vm.createdAt,
          lastActivityAt: vm.lastActivityAt,
          lastConnectedAt: vm.lastConnectedAt,
          lastSleptAt: vm.lastSleptAt,
          sleepsAt: idle ? (vm.lastActivityAt ?? vm.createdAt) + idleMs : null,
          projects: projects.filter((project) => project.vms.some((entry) => entry.vmId === vm.id)).map((project) => project.id),
          sessions: hub.vmThreads(vm.id).map((thread) => {
            const model = thread.modelSelection as { model?: unknown } | undefined;
            return {
              threadId: thread.id,
              title: String(thread.title ?? "Untitled"),
              projectId: typeof thread.projectId === "string" ? thread.projectId : null,
              model: typeof model?.model === "string" ? model.model : null,
              provider: typeof thread.providerInstanceId === "string" ? thread.providerInstanceId : null,
              status: String(thread.status ?? "idle"),
              working: isWorking(thread),
              updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : null,
            };
          }),
          t3Version: vm.t3Version,
          updatePending: fleet.behind(vm),
          stats: vm.state === "ready" || vm.state === "busy" ? this.deps.stats.get(vm.id) : null,
          skillsPending:
            vm.sandboxId !== null && vm.skills !== skills.fingerprint && (skills.skills.length > 0 || skills.instructions.length > 0 || vm.skills !== null),
        };
      });
    return {
      bridge: { id: settings.get("bridgeId"), version: this.deps.version, startedAt: this.deps.startedAt },
      setup: {
        provider: Boolean(defaultProvider),
        github: secrets.has("github.token"),
        agents: agents.some((profile) => profile.inUse),
      },
      providers: settings.get("providers").map((id) => this.providerInfo(id)),
      defaultProvider,
      repoRules: settings.get("repoRules"),
      github: secrets.has("github.token") ? settings.get("github") : null,
      agents,
      env: Object.keys(envVars(secrets)),
      settings: { vmSize: settings.get("vmSize"), idleMinutes: settings.get("idleMinutes"), t3Version: settings.get("t3Version") },
      clients: clients.list(gateway.connected()),
      vms,
      projects: projects.map((project) => ({
        id: project.id,
        title: project.title,
        url: project.url,
        branch: project.branch,
        vmIds: project.vms.map((entry) => entry.vmId),
        createdAt: project.createdAt,
      })),
      skills: this.deps.skills.list(),
      syncLocalSkills: this.deps.skills.syncAll,
      instructions: this.deps.skills.instructions.list(),
    };
  }

  /** Server-sent events: every traffic event, and a fresh overview whenever the fleet changes. */
  private events(request: Request) {
    const { traffic, fleet, hub } = this.deps;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (live: LiveMessage) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(live)}\n\n`));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const changed = () => {
          timer ??= setTimeout(() => {
            timer = undefined;
            send({ type: "overview", overview: this.overview() });
          }, 200);
        };
        const unsubscribe = traffic.subscribe((event) => send({ type: "traffic", event }));
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
        fleet.on("changed", changed);
        hub.on("shell", changed);
        send({ type: "overview", overview: this.overview() });
        cleanup = () => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          unsubscribe();
          fleet.off("changed", changed);
          hub.off("shell", changed);
        };
        request.signal.addEventListener("abort", () => {
          cleanup();
          controller.close();
        });
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }
}
