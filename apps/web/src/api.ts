import { useEffect, useState } from "react";
import type { LiveMessage, Overview, TrafficEvent } from "@vmbridge/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Listeners told when the session ends, so the app can show the login screen. */
const loggedOut = new Set<() => void>();
export const onLoggedOut = (listener: () => void) => {
  loggedOut.add(listener);
  return () => void loggedOut.delete(listener);
};

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/admin/api${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    // A wrong password or setup link is not a lost session.
    if (response.status === 401 && path !== "/login" && path !== "/setup") for (const listener of loggedOut) listener();
    throw new ApiError(value.error ?? `Request failed (${response.status}).`, response.status);
  }
  return value;
}

const trafficLimit = 300;

/** The live overview and recent traffic, from the server's event stream. */
export function useLive() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [traffic, setTraffic] = useState<TrafficEvent[]>([]);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let streaming = false;
    // Cloudflare's quick tunnels hold event streams back, so until the stream delivers, read the same data every few seconds.
    const loadTraffic = (onlyWhileWaiting: boolean) =>
      void api<TrafficEvent[]>("/traffic").then((recent) => !cancelled && !(onlyWhileWaiting && streaming) && setTraffic(recent.slice(-trafficLimit)), () => {});
    const loadOverview = () => void api<Overview>("/overview").then((next) => !cancelled && !streaming && setOverview(next), () => {});
    loadTraffic(false);
    loadOverview();
    const polling = setInterval(() => {
      loadTraffic(true);
      loadOverview();
    }, 5_000);
    const source = new EventSource("/admin/api/events");
    source.onopen = () => setOnline(true);
    source.onerror = () => {
      setOnline(false);
      // A closed stream after a failed reconnect usually means the session ended, such as after a password change elsewhere.
      if (source.readyState !== EventSource.CLOSED) return;
      void api<{ authenticated: boolean }>("/auth").then(
        (auth) => {
          if (!auth.authenticated) for (const listener of loggedOut) listener();
        },
        () => {},
      );
    };
    source.onmessage = (event) => {
      streaming = true;
      clearInterval(polling);
      const live = JSON.parse(event.data as string) as LiveMessage;
      if (live.type === "overview") setOverview(live.overview);
      else setTraffic((current) => [...current.slice(-(trafficLimit - 1)), live.event]);
    };
    return () => {
      cancelled = true;
      clearInterval(polling);
      source.close();
    };
  }, []);

  return { overview, traffic, online };
}

/** Re-renders every `ms`, for relative times and decaying request rates. */
export function useTick(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Local wall-clock time with milliseconds, for log rows. */
export function clock(at: number) {
  return `${clockFormat.format(at)}.${String(at % 1000).padStart(3, "0")}`;
}

/** A request duration, readable at a glance. */
export function duration(ms: number) {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Time since `at` as a running clock, such as "42s" or "3m 05s". */
export function elapsed(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function ago(at: number | null, now = Date.now()) {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
