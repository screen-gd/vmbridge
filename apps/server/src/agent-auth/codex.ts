// ChatGPT sign-in for Codex, the same device flow `codex login --device-auth` runs.
// The saved file is a Codex `auth.json`, so VMs use it as is.

import { sleep } from "../runtime.ts";

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
export const verificationUrl = `${issuer}/codex/device`;
/** Codex gives up on a device code after 15 minutes. */
export const deviceCodeTtlMs = 15 * 60_000;

export interface CodexAuthFile {
  auth_mode: "chatgpt";
  OPENAI_API_KEY: null;
  tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string | null };
  last_refresh: string;
}

/** A refresh token that can never work again. The person has to sign in again. */
export class SignInExpired extends Error {}

function claims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function codexAccount(file: CodexAuthFile) {
  const id = claims(file.tokens.id_token);
  const auth = id["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
  const exp = claims(file.tokens.access_token).exp;
  return {
    email: typeof id.email === "string" ? id.email : null,
    accountId: file.tokens.account_id ?? auth?.chatgpt_account_id ?? null,
    expiresAt: typeof exp === "number" ? exp * 1000 : null,
  };
}

/** Parses a Codex auth.json, or returns null when it is not a ChatGPT sign-in. */
export function parseCodexAuth(text: string): CodexAuthFile | null {
  try {
    const file = JSON.parse(text) as Partial<CodexAuthFile>;
    const tokens = file.tokens;
    if (!tokens?.id_token || !tokens.access_token || !tokens.refresh_token || !file.last_refresh) return null;
    return file as CodexAuthFile;
  } catch {
    return null;
  }
}

function authFile(tokens: { id_token: string; access_token: string; refresh_token: string }): CodexAuthFile {
  const file: CodexAuthFile = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { ...tokens, account_id: null },
    last_refresh: new Date().toISOString(),
  };
  file.tokens.account_id = codexAccount(file).accountId;
  return file;
}

async function post(url: string, body: Record<string, string>, form = false) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await post(`${issuer}/api/accounts/deviceauth/usercode`, { client_id: clientId });
  if (!response.ok) throw new Error(`OpenAI answered ${response.status} when starting the sign-in.`);
  const body = (await response.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string };
  const userCode = body.user_code ?? body.usercode;
  if (!body.device_auth_id || !userCode) throw new Error("OpenAI sent an unexpected sign-in code.");
  const seconds = Number(body.interval);
  return { deviceAuthId: body.device_auth_id, userCode, intervalMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000 };
}

/** Waits until the person approves the code in their browser, then trades it for tokens. */
export async function completeDeviceCode(code: DeviceCode, signal: AbortSignal): Promise<CodexAuthFile> {
  const deadline = Date.now() + deviceCodeTtlMs;
  let approved: { authorization_code: string; code_verifier: string } | undefined;
  while (!approved) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error("The code expired. Start again.");
    const response = await post(`${issuer}/api/accounts/deviceauth/token`, { device_auth_id: code.deviceAuthId, user_code: code.userCode });
    // 403 and 404 mean the person has not approved the code yet.
    if (response.status === 403 || response.status === 404) await sleep(code.intervalMs);
    else if (!response.ok) throw new Error(`OpenAI answered ${response.status} while waiting for the sign-in.`);
    else approved = (await response.json()) as typeof approved;
  }
  const response = await post(
    `${issuer}/oauth/token`,
    {
      grant_type: "authorization_code",
      code: approved.authorization_code,
      redirect_uri: `${issuer}/deviceauth/callback`,
      client_id: clientId,
      code_verifier: approved.code_verifier,
    },
    true,
  );
  if (!response.ok) throw new Error(`OpenAI answered ${response.status} when finishing the sign-in.`);
  return authFile((await response.json()) as { id_token: string; access_token: string; refresh_token: string });
}

/**
 * The ChatGPT accounts an access token can use, from the endpoint Codex checks accounts with
 * (`get_accounts_check` in codex-rs/backend-client). It only reads, so unlike a refresh it never rotates
 * tokens someone else holds. Throws when ChatGPT does not accept the token.
 */
export async function codexTokenAccounts(accessToken: string): Promise<string[]> {
  const response = await fetch("https://chatgpt.com/backend-api/wham/accounts/check", {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": "codex-cli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ChatGPT answered ${response.status} when checking the account.`);
  const body = (await response.json()) as { accounts?: { id?: unknown; is_deactivated?: boolean }[] };
  return (body.accounts ?? []).flatMap((account) => (typeof account.id === "string" && !account.is_deactivated ? [account.id] : []));
}

/** Trades the refresh token for new tokens. OpenAI rotates refresh tokens, so the old one stops working. */
export async function refreshCodexAuth(file: CodexAuthFile): Promise<CodexAuthFile> {
  const response = await post(`${issuer}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: file.tokens.refresh_token,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string | { code?: string }; code?: string };
    const code = (typeof body.error === "object" ? body.error.code : body.error) ?? body.code;
    const permanent =
      response.status === 401 ||
      ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"].includes(code ?? "") ||
      (response.status === 400 && code === "invalid_grant");
    if (permanent) throw new SignInExpired("This ChatGPT sign-in expired. Sign in again.");
    throw new Error(`OpenAI answered ${response.status} when refreshing the sign-in.`);
  }
  const fresh = (await response.json()) as Partial<CodexAuthFile["tokens"]>;
  return authFile({
    id_token: fresh.id_token ?? file.tokens.id_token,
    access_token: fresh.access_token ?? file.tokens.access_token,
    refresh_token: fresh.refresh_token ?? file.tokens.refresh_token,
  });
}
