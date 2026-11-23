import type { ClientSocket, T3Gateway, Upgrade } from "../gateway/http.ts";
import type { OpenSocket } from "../runtime.ts";

/**
 * `OpenSocket` on Workers, whose `new WebSocket` cannot send headers: the upgrade is a `fetch` with them, over
 * http(s). Errors never include the URL, which can hold preview credentials.
 */
export const openSocket: OpenSocket = async (url, headers, timeoutMs) => {
  const target = new URL(url);
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  // A timer, not an AbortSignal: workerd keeps a fetch's signal tied to the socket it upgrades to, so the signal's
  // timeout would close a working socket later.
  const opening = fetch(target, { headers: { ...headers, upgrade: "websocket" } }) as Promise<Response & { webSocket: WorkersWebSocket | null }>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
  let response: Awaited<typeof opening> | null;
  try {
    response = await Promise.race([opening, late]);
  } catch {
    throw new Error("The socket could not open.");
  } finally {
    clearTimeout(timer);
  }
  if (!response) {
    // Closes the socket should it open after all.
    opening.then(
      (opened) => {
        if (!opened.webSocket) return opened.body?.cancel();
        opened.webSocket.accept();
        opened.webSocket.close();
      },
      () => {},
    );
    throw new Error("The socket could not open in time.");
  }
  const socket = response.webSocket;
  if (!socket) {
    await response.body?.cancel();
    throw new Error(`The socket could not open: the VM answered ${response.status}.`);
  }
  socket.accept();
  return socket;
};

/**
 * Accepts T3 clients' sockets in the Durable Object. Plain `accept()`, not the hibernation API: a client's live
 * subscriptions (shell, threads, config) are kept in memory, which hibernation would drop while the client stays
 * connected. Duration billing is no reason to hibernate either, since one object awake all day fits the free plan.
 */
export function upgrader(gateway: T3Gateway): Upgrade {
  return (request, data) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const socket: ClientSocket = {
      data,
      get readyState() {
        return server.readyState;
      },
      send: (message) => server.send(message),
      close: (code, reason) => server.close(code, reason),
    };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      gateway.closed(socket);
    };
    server.addEventListener("message", (event) => gateway.received(socket, typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)));
    server.addEventListener("close", close);
    server.addEventListener("error", close);
    gateway.opened(socket);
    const init: WorkersResponseInit = { status: 101, webSocket: client };
    return new Response(null, init);
  };
}
