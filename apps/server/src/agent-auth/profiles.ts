import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAuthMethod, AgentKind, AgentProfile, ClaudeLogin, CodexLogin } from "@vmbridge/contracts";
import type { Settings } from "../settings.ts";
import { ClaudeCodeRejected, exchangeSetupToken, parsePastedCode, startClaudeSignIn, type ClaudeSignIn } from "./claude.ts";
import {
  codexAccount,
  completeDeviceCode,
  deviceCodeTtlMs,
  parseCodexAuth,
  refreshCodexAuth,
  requestDeviceCode,
  SignInExpired,
  verificationUrl,
  type CodexAuthFile,
} from "./codex.ts";

/** profile.json. Claude and OpenCode keep their token here; Codex keeps its own auth.json next to it. */
interface StoredProfile {
  id: string;
  agent: AgentKind;
  method: AgentAuthMethod;
  name: string;
  detail: string | null;
  createdAt: number;
  error: string | null;
  token?: string;
  baseUrl?: string;
  /** When Codex was last signed in. Token refreshes keep it; signing in again changes it. */
  signedInAt?: number;
}

/** What VM Bridge passes into a VM for its agents. */
export interface AgentSecrets {
  codexAuthJson?: string;
  /** Which Codex sign-in `codexAuthJson` holds. Unlike the file, it stays the same when the tokens refresh. */
  codexSignIn?: string;
  claudeOAuthToken?: string;
  anthropicAuthToken?: string;
  anthropicBaseUrl?: string;
  opencodeApiKey?: string;
}

export type TokenInput =
  | { agent: "claude"; method: "setup-token"; name: string; token: string }
  | { agent: "claude"; method: "auth-token"; name: string; token: string; baseUrl: string | null }
  | { agent: "opencode"; method: "api-key"; name: string; token: string };

export class InvalidSignIn extends Error {}

/** Refresh Codex well before its 10-day access token runs out, so no VM has to refresh it on its own. */
const codexRefreshMarginMs = 2 * 24 * 60 * 60_000;
const profileId = /^[a-z0-9-]+$/;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "default";

/** Asks a service to list models with the token. Only a 401 means the token is wrong. */
async function checkToken(url: string, headers: Record<string, string>, service: string) {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new InvalidSignIn(`Could not reach ${service}.`);
  }
  // 403 means the token is real but may not list models, which is enough for a sign-in check.
  if (response.ok || response.status === 403) return;
  if (response.status === 401) throw new InvalidSignIn(`${service} rejected that token.`);
  throw new InvalidSignIn(`${service} answered ${response.status}.`);
}

const anthropicHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
});

/**
 * Agent sign-ins, one folder per profile under `<data dir>/auths`. Folders are 0700 and files 0600.
 * Every VM gets the profile each agent uses, never sign-ins from the VM provider.
 */
export class AgentAuth {
  private readonly logins = new Map<string, CodexLogin & { abort: AbortController }>();
  private readonly claudeLogins = new Map<string, ClaudeSignIn>();
  /** Codex refreshes one at a time: OpenAI rotates refresh tokens, so two at once would break the sign-in. */
  private codexQueue: Promise<unknown> = Promise.resolve();
  onChange: () => void = () => {};

  constructor(
    private readonly dir: string,
    private readonly settings: Settings,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  list(): AgentProfile[] {
    const inUse = this.settings.get("agentProfiles");
    return this.stored()
      .map(({ token: _token, baseUrl: _baseUrl, ...profile }) => ({ ...profile, inUse: inUse[profile.agent] === profile.id }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Checks a Claude or OpenCode token with its service, then saves it. */
  async addToken(input: TokenInput, detail: string | null = null): Promise<AgentProfile> {
    let baseUrl: string | undefined;
    if (input.method === "setup-token") {
      await checkToken("https://api.anthropic.com/v1/models", anthropicHeaders(input.token), "Anthropic");
    } else if (input.method === "auth-token") {
      baseUrl = input.baseUrl ? this.parseBaseUrl(input.baseUrl) : undefined;
      await checkToken(`${baseUrl ?? "https://api.anthropic.com"}/v1/models`, anthropicHeaders(input.token), baseUrl ? new URL(baseUrl).host : "Anthropic");
    } else {
      await checkToken("https://opencode.ai/inference/v1/models", { authorization: `Bearer ${input.token}` }, "OpenCode");
    }
    const fallback = { "setup-token": "Claude subscription", "auth-token": "Anthropic token", "api-key": "OpenCode" }[input.method];
    return this.save({
      id: this.newId(input.agent, input.name || fallback),
      agent: input.agent,
      method: input.method,
      name: input.name || fallback,
      detail: baseUrl ?? detail,
      createdAt: Date.now(),
      error: null,
      token: input.token,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  /** Starts a Codex device sign-in. The person enters the code at OpenAI; the sign-in saves itself once approved. */
  async startCodexLogin(name: string): Promise<CodexLogin> {
    const code = await requestDeviceCode();
    const login = {
      id: crypto.randomUUID(),
      userCode: code.userCode,
      verificationUrl,
      expiresAt: Date.now() + deviceCodeTtlMs,
      status: "pending" as CodexLogin["status"],
      error: null as string | null,
      abort: new AbortController(),
    };
    this.logins.set(login.id, login);
    void completeDeviceCode(code, login.abort.signal)
      .then((file) => {
        this.saveCodex(file, name);
        login.status = "done";
      })
      .catch((error: unknown) => {
        login.status = "failed";
        login.error = login.abort.signal.aborted ? "Cancelled." : error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.onChange();
        setTimeout(() => this.logins.delete(login.id), 10 * 60_000).unref();
      });
    return this.codexLogin(login.id)!;
  }

  codexLogin(id: string): CodexLogin | undefined {
    const login = this.logins.get(id);
    if (!login) return undefined;
    const { abort: _abort, ...view } = login;
    return view;
  }

  cancelCodexLogin(id: string) {
    this.logins.get(id)?.abort.abort();
  }

  /** Starts a Claude sign-in. The person approves at claude.ai and pastes back the code it shows. */
  startClaudeLogin(): ClaudeLogin {
    const id = crypto.randomUUID();
    const signIn = startClaudeSignIn();
    this.claudeLogins.set(id, signIn);
    setTimeout(() => this.claudeLogins.delete(id), 15 * 60_000).unref();
    return { id, url: signIn.url };
  }

  async finishClaudeLogin(id: string, pasted: string, name: string): Promise<AgentProfile> {
    const signIn = this.claudeLogins.get(id);
    if (!signIn) throw new InvalidSignIn("That sign-in expired. Start again.");
    const { code, state } = parsePastedCode(pasted);
    if (!code) throw new InvalidSignIn("Paste the code Claude showed.");
    if (state && state !== signIn.state) throw new InvalidSignIn("That code is from a different sign-in. Start again.");
    // A code works once, so this sign-in is over whatever Claude answers.
    this.claudeLogins.delete(id);
    try {
      const { token, email } = await exchangeSetupToken(signIn, code);
      return await this.addToken({ agent: "claude", method: "setup-token", name, token }, email);
    } catch (error) {
      throw error instanceof ClaudeCodeRejected ? new InvalidSignIn(error.message) : error;
    }
  }

  use(id: string) {
    const profile = this.read(id);
    this.settings.set("agentProfiles", { ...this.settings.get("agentProfiles"), [profile.agent]: profile.id });
    this.onChange();
  }

  remove(id: string) {
    const profile = this.read(id);
    rmSync(join(this.dir, profile.id), { recursive: true, force: true });
    const inUse = { ...this.settings.get("agentProfiles") };
    if (inUse[profile.agent] === profile.id) {
      // Another profile for the same agent takes over, so removing one does not sign the agent out.
      const next = this.stored().find((other) => other.agent === profile.agent);
      if (next) inUse[profile.agent] = next.id;
      else delete inUse[profile.agent];
      this.settings.set("agentProfiles", inUse);
    }
    this.onChange();
  }

  /** The sign-ins every VM gets. Refreshes Codex first when it is close to expiring. */
  async vmSecrets(): Promise<AgentSecrets> {
    const inUse = this.settings.get("agentProfiles");
    const secrets: AgentSecrets = {};
    const claude = inUse.claude ? this.find(inUse.claude) : undefined;
    if (claude?.method === "setup-token") secrets.claudeOAuthToken = claude.token;
    if (claude?.method === "auth-token") {
      secrets.anthropicAuthToken = claude.token;
      secrets.anthropicBaseUrl = claude.baseUrl;
    }
    const opencode = inUse.opencode ? this.find(inUse.opencode) : undefined;
    if (opencode) secrets.opencodeApiKey = opencode.token;
    const codex = await this.refreshCodex(false);
    const signedIn = this.codexInUse()?.profile;
    if (codex && signedIn) {
      secrets.codexAuthJson = codex;
      secrets.codexSignIn = `${signedIn.id}@${signedIn.signedInAt ?? signedIn.createdAt}`;
    }
    return secrets;
  }

  /** True when the Codex sign-in in use should be refreshed now. */
  codexDue(): boolean {
    const current = this.codexInUse();
    return Boolean(current && !current.profile.error && this.due(current.file));
  }

  /**
   * Refreshes the Codex sign-in in use when it is due. Returns the auth.json VMs should have:
   * with `onlyChanged`, only when a refresh happened.
   */
  refreshCodex(onlyChanged: boolean): Promise<string | undefined> {
    const run = async () => {
      const current = this.codexInUse();
      if (!current) return undefined;
      if (current.profile.error || !this.due(current.file)) return onlyChanged ? undefined : JSON.stringify(current.file, null, 2);
      try {
        const fresh = await refreshCodexAuth(current.file);
        this.writeCodex(current.profile.id, fresh);
        return JSON.stringify(fresh, null, 2);
      } catch (error) {
        if (error instanceof SignInExpired) {
          this.save({ ...current.profile, error: error.message });
          this.onChange();
        }
        // A failed refresh leaves the current tokens, which still work until they expire.
        return onlyChanged ? undefined : JSON.stringify(current.file, null, 2);
      }
    };
    const next = this.codexQueue.then(run, run);
    this.codexQueue = next;
    return next;
  }

  /**
   * Takes a VM's auth.json when Codex on that VM refreshed the tokens itself, which retires the
   * refresh token VM Bridge holds. Only for the same ChatGPT account, and only when newer.
   */
  adoptCodex(text: string) {
    const current = this.codexInUse();
    const theirs = parseCodexAuth(text);
    if (!current || !theirs) return;
    if (codexAccount(theirs).accountId !== codexAccount(current.file).accountId) return;
    if (Date.parse(theirs.last_refresh) <= Date.parse(current.file.last_refresh)) return;
    if (theirs.tokens.refresh_token === current.file.tokens.refresh_token) return;
    this.writeCodex(current.profile.id, theirs);
    if (current.profile.error) this.save({ ...current.profile, error: null });
  }

  private due(file: CodexAuthFile) {
    const { expiresAt } = codexAccount(file);
    if (expiresAt) return expiresAt - Date.now() < codexRefreshMarginMs;
    return Date.now() - Date.parse(file.last_refresh) > 5 * 24 * 60 * 60_000;
  }

  private codexInUse() {
    const id = this.settings.get("agentProfiles").codex;
    const profile = id ? this.find(id) : undefined;
    if (!profile) return undefined;
    const path = join(this.dir, profile.id, "auth.json");
    const file = existsSync(path) ? parseCodexAuth(readFileSync(path, "utf8")) : null;
    return file ? { profile, file } : undefined;
  }

  private saveCodex(file: CodexAuthFile, name: string) {
    const { email, accountId } = codexAccount(file);
    // Signing in to the same ChatGPT account again replaces that profile's tokens.
    const existing = this.stored().find((profile) => {
      if (profile.agent !== "codex") return false;
      const path = join(this.dir, profile.id, "auth.json");
      const saved = existsSync(path) ? parseCodexAuth(readFileSync(path, "utf8")) : null;
      return saved !== null && codexAccount(saved).accountId === accountId;
    });
    // Never named after the email: names show unblurred in the dashboard and in folder names.
    const label = name || "ChatGPT account";
    const profile = existing
      ? { ...existing, error: null, name: name || existing.name, signedInAt: Date.now() }
      : { id: this.newId("codex", label), agent: "codex" as const, method: "chatgpt" as const, name: label, detail: email, createdAt: Date.now(), error: null };
    // Tokens first: saving the profile can put it in use straight away.
    mkdirSync(join(this.dir, profile.id), { recursive: true, mode: 0o700 });
    this.writeCodex(profile.id, file);
    this.save(profile);
  }

  private writeCodex(id: string, file: CodexAuthFile) {
    this.writeSecret(join(this.dir, id, "auth.json"), JSON.stringify(file, null, 2));
  }

  private save(profile: StoredProfile): AgentProfile {
    const folder = join(this.dir, profile.id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.writeSecret(join(folder, "profile.json"), JSON.stringify(profile, null, 2));
    // The first profile for an agent is the one VMs use.
    const inUse = this.settings.get("agentProfiles");
    if (!inUse[profile.agent]) this.settings.set("agentProfiles", { ...inUse, [profile.agent]: profile.id });
    this.onChange();
    return this.list().find((entry) => entry.id === profile.id)!;
  }

  /** Writes through a temporary file, so a crash never leaves half a token on disk. */
  private writeSecret(path: string, text: string) {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  }

  private stored(): StoredProfile[] {
    return readdirSync(this.dir, { withFileTypes: true }).flatMap((entry) => {
      const profile = entry.isDirectory() ? this.find(entry.name) : undefined;
      return profile ? [profile] : [];
    });
  }

  private find(id: string): StoredProfile | undefined {
    if (!profileId.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.dir, id, "profile.json"), "utf8")) as StoredProfile;
    } catch {
      return undefined;
    }
  }

  private read(id: string): StoredProfile {
    const profile = this.find(id);
    if (!profile) throw new InvalidSignIn("No such sign-in.");
    return profile;
  }

  private newId(agent: AgentKind, name: string) {
    const base = `${agent}-${slug(name)}`;
    let id = base;
    for (let n = 2; existsSync(join(this.dir, id)); n++) id = `${base}-${n}`;
    return id;
  }

  private parseBaseUrl(text: string) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new InvalidSignIn("The base URL is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidSignIn("The base URL must start with https:// or http://.");
    return url.toString().replace(/\/+$/, "");
  }
}
