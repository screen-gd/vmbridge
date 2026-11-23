import type { OpenSocket } from "../runtime.ts";

/** `OpenSocket` with Bun's WebSocket, which takes request headers as an option. */
export const openSocket: OpenSocket = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const settle = (error?: Error) => {
      clearTimeout(timer);
      socket.onopen = socket.onerror = socket.onclose = null;
      if (!error) return resolve(socket);
      socket.close();
      reject(error);
    };
    const timer = setTimeout(() => settle(new Error("Opening the socket timed out.")), timeoutMs);
    socket.onopen = () => settle();
    socket.onerror = () => settle(new Error("The socket could not open."));
    socket.onclose = () => settle(new Error("The socket closed while opening."));
  });
