import type { Sql } from "../sql.ts";
import type { ClientInfo, PairingLink } from "@vmbridge/contracts";
import { hashToken, newToken } from "./tokens.ts";

export const pairingLinkMs = 15 * 60_000;
export const clientSessionMs = 30 * 86_400_000;
const ticketMs = 30_000;
// How often a device in use writes its last-seen time and pushes its session forward.
const touchEveryMs = 60_000;

interface ClientRow {
  id: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
}

/**
 * T3 devices pair with a one-use link, exchange it for a bearer token, and then
 * fetch short-lived single-use tickets to open the RPC WebSocket. Each paired
 * device keeps the name of the link it used.
 */
export class Clients {
  private readonly tickets = new Map<string, { clientId: string; expiresAt: number }>();

  constructor(private readonly db: Sql) {}

  createLink(name: string): { link: PairingLink; token: string } {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) throw new Error("Name the device in 1 to 60 characters.");
    const token = newToken();
    const now = Date.now();
    const link: PairingLink = { id: crypto.randomUUID(), name: trimmed, createdAt: now, expiresAt: now + pairingLinkMs, redeemedAt: null };
    this.db.run(
      "INSERT INTO pairing_links (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      link.id, link.name, hashToken(token), link.createdAt, link.expiresAt,
    );
    return { link, token };
  }

  links(): PairingLink[] {
    return this.db.all<{ id: string; name: string; created_at: number; expires_at: number; redeemed_at: number | null }>(
      "SELECT id, name, created_at, expires_at, redeemed_at FROM pairing_links ORDER BY created_at DESC LIMIT 50",
    )
      .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at, redeemedAt: row.redeemed_at }));
  }

  deleteLink(id: string): void {
    this.db.run("DELETE FROM pairing_links WHERE id = ?", id);
  }

  /** Redeems a pairing token once. Returns a new bearer token for the device, or null. */
  exchange(pairingToken: string): string | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const link = this.db.one<{ id: string; name: string }>(
        "SELECT id, name FROM pairing_links WHERE token_hash = ? AND redeemed_at IS NULL AND expires_at > ?",
        hashToken(pairingToken), now,
      );
      if (!link) return null;
      this.db.run("UPDATE pairing_links SET redeemed_at = ? WHERE id = ?", now, link.id);
      const access = newToken();
      this.db.run(
        "INSERT INTO clients (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        crypto.randomUUID(), link.name, hashToken(access), now, now + clientSessionMs,
      );
      return access;
    });
  }

  /** The client behind a bearer token, if the session is live. Each use keeps the session alive for another 30 days. */
  authenticate(bearer: string): { id: string; name: string; expiresAt: number } | null {
    const row = this.db.one<ClientRow>(
      "SELECT id, name, created_at, expires_at, last_seen_at FROM clients WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      hashToken(bearer), Date.now(),
    );
    return row ? { id: row.id, name: row.name, expiresAt: this.touch(row) } : null;
  }

  valid(clientId: string): boolean {
    return (
      this.db.one("SELECT 1 FROM clients WHERE id = ? AND revoked_at IS NULL AND expires_at > ?", clientId, Date.now()) !== undefined
    );
  }

  /** Marks the device seen and slides its session forward, at most once a minute so requests don't each write. Returns the expiry. */
  private touch(row: ClientRow): number {
    const now = Date.now();
    if (row.last_seen_at !== null && now - row.last_seen_at < touchEveryMs) return row.expires_at;
    const expiresAt = now + clientSessionMs;
    this.db.run("UPDATE clients SET last_seen_at = ?, expires_at = ? WHERE id = ?", now, expiresAt, row.id);
    return expiresAt;
  }

  list(connected: ReadonlySet<string>): ClientInfo[] {
    return this.db.all<ClientRow>(
      "SELECT id, name, created_at, expires_at, last_seen_at FROM clients WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at",
      Date.now(),
    )
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        connected: connected.has(row.id),
      }));
  }

  revoke(clientId: string): void {
    this.db.run("UPDATE clients SET revoked_at = ? WHERE id = ?", Date.now(), clientId);
  }

  ticket(clientId: string): { ticket: string; expiresAt: number } {
    const now = Date.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(key);
    const ticket = newToken();
    const expiresAt = now + ticketMs;
    this.tickets.set(hashToken(ticket), { clientId, expiresAt });
    return { ticket, expiresAt };
  }

  /** Single use: a ticket is consumed whether or not it is still valid. */
  redeemTicket(ticket: string): string | null {
    const key = hashToken(ticket);
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    return entry && entry.expiresAt > Date.now() && this.valid(entry.clientId) ? entry.clientId : null;
  }
}
