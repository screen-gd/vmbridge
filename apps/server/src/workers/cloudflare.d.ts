// The few Cloudflare Workers APIs VM Bridge uses, typed by hand: @cloudflare/workers-types redefines web globals
// (Request, Response, WebSocket) differently from Bun's types, which the rest of the code is checked against.

interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  getByName(name: string): DurableObjectStub;
}

interface WorkersFetcher {
  fetch(request: Request | string): Promise<Response>;
}

/** A WebSocket as Workers have it: accepted by the side that keeps it. */
interface WorkersWebSocket extends WebSocket {
  accept(): void;
}

declare const WebSocketPair: { new (): { 0: WorkersWebSocket; 1: WorkersWebSocket } };

/** Workers' Response takes the client end of a WebSocketPair for a 101, and fetch returns the server's socket. */
interface WorkersResponseInit extends ResponseInit {
  webSocket?: WorkersWebSocket;
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
