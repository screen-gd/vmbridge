import type { Sql } from "../sql.ts";
import { timingSafeEqual } from "node:crypto";
import { passwordHashSecret, type Secrets } from "../settings.ts";
import type { Passwords } from "./password.ts";
import { hashToken, newToken } from "./tokens.ts";

const sessionMs = 30 * 86_400_000;
const cookieName = "vmbridge_session";
// Over HTTPS the prefix makes browsers refuse the cookie unless it is Secure and host-only, so no other site on the
// domain and no plain HTTP page can set or replace it. Sessions issued before it keep working under the plain name.
const secureCookieName = `__Host-${cookieName}`;
const maxFailures = 5;
/**
 * Failed attempts allowed from every address together, so guesses spread over many addresses (a botnet, or one IPv6
 * block) stay this slow too. Attempts from this machine itself do not count toward it and are never refused by it,
 * so an attack from outside can lock out everyone else for as long as it runs, plus a minute, but never someone at
 * the machine VM Bridge runs on. Loopback keeps its own per-address limit, shared by every loopback address and by
 * anyone `tailscale serve` cannot name (tagged devices, Funnel).
 */
const maxGlobalFailures = 20;
const failureWindowMs = 60_000;
// How often a watched session is checked, which catches one that simply expired.
const watchEveryMs = 30_000;

/**
 * The dashboard has one secret key, chosen in onboarding or from the terminal. Logging in with it
 * issues a cookie session. Failed attempts are throttled per address, and across all of them, because the dashboard
 * listens on the LAN and tailnet and can be put on the internet with Cloudflare Tunnel.
 */
export class DashboardAuth {
  /**
   * Recent attempts per address that failed or are still being checked. Only attempts the limits let through are added
   * and expired ones are swept, so it never holds many more than `maxGlobalFailures` addresses.
   */
  private readonly failures = new Map<string, number[]>();
  /** The same for every address but loopback together, oldest first. */
  private readonly globalFailures: number[] = [];
  private readonly watchers = new Set<() => void>();
  /** Kept only in memory: a restart makes a new one. */
  private setupCode: string | null = null;

  constructor(
    private readonly db: Sql,
    private readonly secrets: Secrets,
    private readonly passwords: Passwords,
  ) {}

  hasKey(): boolean {
    return this.secrets.has(passwordHashSecret);
  }

  async setKey(key: string): Promise<void> {
    checkKey(key);
    this.secrets.set(passwordHashSecret, await this.passwords.hash(key));
    // A new key ends every existing dashboard session.
    this.db.run("DELETE FROM admin_sessions");
    this.checkWatched();
  }

  /** Sets a new key only when `current` is the key in use. Returns false when it is not. Throws when the address is throttled. */
  async changeKey(current: string, next: string, address: string): Promise<boolean> {
    if (!(await this.verify(current, address))) return false;
    await this.setKey(next);
    return true;
  }

  /**
   * A one-time code for choosing the first password in the dashboard. Anyone on the LAN or tailnet can open a fresh
   * bridge, so only the terminal that started it gets the code. Null once a password exists.
   */
  createSetupCode(): string | null {
    this.setupCode = this.hasKey() ? null : newToken();
    return this.setupCode;
  }

  /**
   * Sets the first password when `code` is the setup code, and returns a Set-Cookie value for a new session. Returns
   * null when the code is wrong, used, or a password already exists. Throws when the address is throttled or the
   * password is too short; a short password leaves the code usable.
   */
  async claim(code: string, key: string, address: string, secure: boolean): Promise<string | null> {
    const succeeded = this.throttle(address);
    const expected = this.setupCode;
    if (!expected || this.hasKey() || !timingSafeEqual(Buffer.from(hashToken(code)), Buffer.from(hashToken(expected)))) return null;
    // A right code with a short password is not a guess, so it is not counted.
    succeeded();
    checkKey(key);
    // Spent before hashing the password, so a second request racing this one cannot use it too.
    this.setupCode = null;
    await this.setKey(key);
    return this.session(secure);
  }

  /** Returns a Set-Cookie value, or null when the key is wrong. Throws when the address is throttled. */
  async login(key: string, address: string, secure: boolean): Promise<string | null> {
    if (!(await this.verify(key, address))) return null;
    return this.session(secure);
  }

  private session(secure: boolean): string {
    const now = Date.now();
    const token = newToken();
    this.db.run("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)", hashToken(token), now, now + sessionMs);
    this.db.run("DELETE FROM admin_sessions WHERE expires_at < ?", now);
    return cookie(token, sessionMs / 1000, secure);
  }

  authenticated(request: Request): boolean {
    const now = Date.now();
    return sessionTokens(request).some((token) => {
      const row = this.db.one<{ expires_at: number }>("SELECT expires_at FROM admin_sessions WHERE token_hash = ?", hashToken(token));
      return row !== undefined && row.expires_at > now;
    });
  }

  /** Returns Set-Cookie values that clear the cookie under both names. */
  logout(request: Request): string[] {
    for (const token of sessionTokens(request)) this.db.run("DELETE FROM admin_sessions WHERE token_hash = ?", hashToken(token));
    this.checkWatched();
    return [cookie("", 0, false), cookie("", 0, true)];
  }

  /**
   * Calls `ended` once the request's session is gone: logged out, ended by a new key, or expired.
   * Long-lived responses such as the event stream use it, since they only check the cookie when they open.
   * Returns a function that stops watching.
   */
  watch(request: Request, ended: () => void): () => void {
    const check = () => {
      if (this.authenticated(request)) return;
      stop();
      ended();
    };
    const timer = setInterval(check, watchEveryMs);
    const stop = () => {
      clearInterval(timer);
      this.watchers.delete(check);
    };
    this.watchers.add(check);
    return stop;
  }

  private checkWatched() {
    for (const check of this.watchers) check();
  }

  /**
   * Counts an attempt as failed before its key is checked, with nothing awaited in between, so attempts running at the
   * same time all see each other and the ones past a limit are refused before any hashing. Throws when the address,
   * or every address together, failed too often lately. Returns a function to call once the attempt succeeds, which
   * clears the address's failures and takes this attempt back from the shared count.
   */
  private throttle(address: string): () => void {
    const now = Date.now();
    this.sweep(now);
    const local = isLoopback(address);
    // One bucket for every loopback address, which a local process can otherwise pick from 127.0.0.0/8 at will.
    const bucket = local ? "loopback" : address;
    const recent = this.failures.get(bucket) ?? [];
    if (recent.length >= maxFailures || (!local && this.globalFailures.length >= maxGlobalFailures)) throw new TooManyAttempts();
    recent.push(now);
    this.failures.set(bucket, recent);
    if (!local) this.globalFailures.push(now);
    return () => {
      this.failures.delete(bucket);
      const index = local ? -1 : this.globalFailures.lastIndexOf(now);
      if (index >= 0) this.globalFailures.splice(index, 1);
    };
  }

  /** Forgets attempts older than the window. */
  private sweep(now: number) {
    for (const [bucket, times] of this.failures) {
      const recent = times.filter((at) => now - at < failureWindowMs);
      if (recent.length) this.failures.set(bucket, recent);
      else this.failures.delete(bucket);
    }
    const expired = this.globalFailures.findIndex((at) => now - at < failureWindowMs);
    this.globalFailures.splice(0, expired === -1 ? this.globalFailures.length : expired);
  }

  /** Checks a key against the one in use, throttling failed attempts. */
  private async verify(key: string, address: string): Promise<boolean> {
    const succeeded = this.throttle(address);
    const hash = this.secrets.get(passwordHashSecret);
    const { ok, outdated } = hash ? await this.passwords.verify(key, hash) : { ok: false, outdated: false };
    if (!ok) return false;
    succeeded();
    // Swaps a hash from an older version for the current kind, keeping every session. Checked again after hashing,
    // with no await before the write, so a password changed meanwhile is never put back.
    if (outdated) {
      const replacement = await this.passwords.hash(key);
      if (this.secrets.get(passwordHashSecret) === hash) this.secrets.set(passwordHashSecret, replacement);
    }
    return true;
  }
}

export class InvalidPassword extends Error {}

export const isLoopback = (address: string) => /^(?:127\.|::ffff:127\.)/.test(address) || address === "::1";

function checkKey(key: string) {
  if (key.length < 8) throw new InvalidPassword("The password needs at least 8 characters.");
}

export class TooManyAttempts extends Error {
  constructor() {
    super("Too many attempts. Wait a minute and try again.");
  }
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${secure ? secureCookieName : cookieName}=${value}; Path=/; Max-Age=${maxAge};${secure ? " Secure;" : ""} HttpOnly; SameSite=Strict`;
}

function sessionTokens(request: Request): string[] {
  return [readCookie(request, secureCookieName), readCookie(request, cookieName)].filter((token) => token !== null);
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}
