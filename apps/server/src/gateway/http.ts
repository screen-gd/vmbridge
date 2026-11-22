import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Clients } from "../auth/clients.ts";
import { clientSessionMs } from "../auth/clients.ts";
import { message } from "../fleet.ts";
import type { Frame } from "../vm/backend.ts";
import { bridgeAuth, bridgeScopes, type Hub } from "./hub.ts";
import type { Rpc, RpcClient } from "./rpc.ts";
import type { Projection, Wire } from "./types.ts";

export interface SocketData {
  clientId: string;
  cancels: Map<string, () => void>;
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const unauthenticated = () => json({ code: "auth_invalid", reason: "invalid_credential", traceId: crypto.randomUUID() }, 401);

const tokenExchange = {
  grant: "urn:ietf:params:oauth:grant-type:token-exchange",
  subject: "urn:t3:params:oauth:token-type:environment-bootstrap",
  requested: "urn:ietf:params:oauth:token-type:access_token",
};

/** Paths a T3 client uses. Everything else belongs to the dashboard. */
export const isT3Path = (path: string) => path === "/ws" || path === "/oauth/token" || path.startsWith("/api/") || path.startsWith("/.well-known/t3/");

/**
 * The T3 server surface VM Bridge exposes: pairing, bearer sessions, the RPC WebSocket, and the
 * few HTTP reads T3 makes outside RPC. T3 routes use bearer tokens only, never cookies, so any
 * origin may call them; the hosted and desktop T3 apps come from origins VM Bridge cannot list.
 */
export class T3Gateway {
  private readonly sockets = new Set<ServerWebSocket<SocketData>>();
  private readonly expiry: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: Hub,
    private readonly rpc: Rpc,
    private readonly clients: Clients,
  ) {
    this.expiry = setInterval(() => {
      for (const socket of this.sockets) if (!clients.valid(socket.data.clientId)) socket.close(1008, "Session expired");
    }, 30_000);
  }

  connected(): Set<string> {
    return new Set([...this.sockets].map((socket) => socket.data.clientId));
  }

  /** Ends a revoked device's open connections. */
  disconnect(clientId: string) {
    for (const socket of this.sockets) if (socket.data.clientId === clientId) socket.close(1008, "Device removed");
  }

  async fetch(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const origin = request.headers.get("origin");
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const seen: { clientId?: string } = {};
    const response = await this.route(request, server, seen).catch((error) =>
      json({ error: "bridge_unavailable", message: message(error) }, 503),
    );
    if (!response) return undefined;
    if (origin) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "Origin");
    }
    response.headers.set("cache-control", "no-store");
    if (path !== "/api/auth/session") {
      this.hub.traffic.record({
        kind: "http",
        operation: `${request.method} ${path.replace(/\/threads\/[^/]+/, "/threads/:id")}`,
        clientId: seen.clientId,
        status: response.ok ? "ok" : "error",
        durationMs: Math.round(performance.now() - started),
      });
    }
    return response;
  }

  private async route(request: Request, server: Server<SocketData>, seen: { clientId?: string }): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-t3-orchestration-protocol, b3, traceparent, dpop",
        },
      });
    }
    if (path === "/.well-known/t3/environment" && request.method === "GET") return json(this.hub.descriptor());
    if (path === "/oauth/token" && request.method === "POST") return this.exchange(request);
    if (path === "/ws") {
      if (url.searchParams.get("orchestrationProtocol") !== "2") {
        return json({ code: "orchestration_protocol_incompatible", orchestrationProtocolVersion: 2 }, 426);
      }
      const clientId = this.clients.redeemTicket(url.searchParams.get("wsTicket") ?? "");
      if (!clientId) return unauthenticated();
      if (server.upgrade(request, { data: { clientId, cancels: new Map() } })) return undefined;
      return json({ error: "websocket_required" }, 400);
    }

    const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const client = bearer ? this.clients.authenticate(bearer) : null;
    if (path === "/api/auth/session") {
      return json({
        authenticated: Boolean(client),
        auth: bridgeAuth,
        ...(client
          ? {
              scopes: bridgeScopes,
              permissions: bridgeScopes,
              sessionMethod: "bearer-access-token",
              expiresAt: new Date(client.expiresAt).toISOString(),
            }
          : {}),
      });
    }
    if (!client) return unauthenticated();
    seen.clientId = client.id;

    if (/^\/api\/auth\/websocket-ticket(?:\/rpc)?$/.test(path) && request.method === "POST") {
      const { ticket, expiresAt } = this.clients.ticket(client.id);
      return json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (path === "/api/orchestration/shell" && request.method === "GET") return json(this.hub.shell());
    if (path === "/api/projects" && request.method === "GET") {
      const projects = (this.hub.shell().projects ?? []).map((project) => ({ ...project, deletedAt: null }));
      return json({ projects, updatedAt: new Date().toISOString() });
    }
    const thread = /^\/api\/orchestration\/threads\/([^/]+)(?:\/(bounded|history|transcript))?$/.exec(path);
    if (thread && request.method === "GET") return this.thread(decodeURIComponent(thread[1]!), thread[2], url);
    return json({ error: "unsupported_bridge_route" }, 404);
  }

  private async exchange(request: Request) {
    const body = new URLSearchParams(await request.text());
    if (
      body.get("grant_type") !== tokenExchange.grant ||
      body.get("subject_token_type") !== tokenExchange.subject ||
      body.get("requested_token_type") !== tokenExchange.requested
    ) {
      return json({ error: "unsupported_grant_type" }, 400);
    }
    const access = this.clients.exchange(body.get("subject_token") ?? "");
    if (!access) return json({ error: "invalid_grant" }, 400);
    this.hub.traffic.record({ kind: "system", operation: "Device paired" });
    // The dashboard's device list follows fleet changes.
    this.hub.fleet.emit("changed");
    return json({
      access_token: access,
      issued_token_type: tokenExchange.requested,
      token_type: "Bearer",
      expires_in: clientSessionMs / 1000,
      scope: bridgeScopes.join(" "),
    });
  }

  /** Thread reads: from the VM when it is awake, from the cached transcript while it sleeps. */
  private async thread(threadId: string, view: string | undefined, url: URL) {
    const vmId = await this.hub.routeSoon({ threadId });
    const backend = this.hub.fleet.backend(vmId);
    if (!backend) {
      const cached = this.hub.sleepingProjection(threadId);
      if (!cached) return json({ error: "vm_sleeping_no_snapshot" }, 503);
      const projection = this.hub.out(cached, vmId) as Projection;
      const snapshotSequence = this.hub.shellSequence(vmId);
      if (view === "transcript") {
        return json({ threadId, title: projection.thread?.title, updatedAt: projection.updatedAt, items: projection.visibleTurnItems ?? [] });
      }
      if (view === "history") return json({ snapshotSequence, items: [], nextCursor: null, hasMoreHistory: false });
      const ordinals = ((projection.runs ?? []) as Wire[]).map((run) => Number(run.ordinal) || 0);
      return json({ projection, snapshotSequence, historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: Math.max(0, ...ordinals) });
    }
    // VM Bridge caches plain projections, so ask the VM for the uncompacted form.
    const query = new URLSearchParams(url.search);
    for (const key of ["compactIds", "compactTurnItems", "dedupeBodies"]) query.delete(key);
    const upstream = await backend.http(`${url.pathname}?${query}`);
    const value = (await upstream.json()) as Wire;
    if (upstream.ok && !view && !value.hasMoreHistory && value.projection) this.hub.cacheProjection(threadId, vmId, value.projection);
    return json(this.hub.out(value, vmId), upstream.status);
  }

  readonly websocket: WebSocketHandler<SocketData> = {
    maxPayloadLength: 16 * 1024 * 1024,
    open: (socket) => {
      this.sockets.add(socket);
      this.hub.traffic.record({ kind: "system", operation: "Device connected", clientId: socket.data.clientId });
      this.hub.fleet.emit("changed");
    },
    message: (socket, raw) => {
      if (!this.clients.valid(socket.data.clientId)) return socket.close(1008, "Session expired");
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(raw));
      } catch {
        return socket.close(1008, "Invalid JSON");
      }
      const client: RpcClient = {
        clientId: socket.data.clientId,
        cancels: socket.data.cancels,
        send: (frame) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
        },
        open: () => socket.readyState === WebSocket.OPEN && this.clients.valid(socket.data.clientId),
      };
      for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
        this.rpc.handle(client, frame as Frame).catch(() => socket.close(1008, "Invalid RPC message"));
      }
    },
    close: (socket) => {
      this.sockets.delete(socket);
      for (const cancel of socket.data.cancels.values()) cancel();
      socket.data.cancels.clear();
      this.hub.fleet.emit("changed");
    },
  };

  close() {
    clearInterval(this.expiry);
    for (const socket of this.sockets) socket.close(1001, "VM Bridge stopped");
  }
}
