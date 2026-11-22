import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { ProviderId, ProviderSetup, VmSize } from "@vmbridge/contracts";
import { providers, type Driver } from "../providers/index.ts";
import type { BaseSnapshot, Store } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import { prepareBase, setupStamp, t3Port } from "./runtime.ts";

/** A base snapshot this old is rebuilt, so new VMs get recent agent CLIs, which setup installs at their latest. */
export const baseMaxAgeMs = 7 * 24 * 60 * 60_000;
/** How long to wait after a failed build before trying again, when an older snapshot is still on record. */
export const baseRetryMs = 10 * 60_000;
/**
 * A build running longer than this is given up: its VM is deleted and it counts as failed, so a hung provider call
 * cannot hold its provider back, and Retry or a new key can start another.
 */
export const baseSetupLimitMs = 15 * 60_000;

/**
 * The snapshot a new VM starts from: the saved one when it holds what setup installs now (same stamp) and is
 * recent. Otherwise the VM is created the plain way and a new snapshot is built.
 */
export function chooseBase(base: BaseSnapshot | null, stamp: string, now: number): { from: string | null; rebuild: boolean } {
  if (!base?.snapshot || base.stamp !== stamp || now - (base.createdAt ?? 0) >= baseMaxAgeMs) return { from: null, rebuild: true };
  return { from: base.snapshot, rebuild: false };
}

/**
 * Base snapshots: per provider and size, a VM with the tools installed and nothing of anyone's, so a new VM only
 * needs its own sign-ins and a T3 start. Built when a provider is added, on start, and in the background when a VM is
 * created without a current one.
 */
export class Bases {
  private readonly building = new Map<string, { startedAt: number; done: Promise<void>; abort: AbortController }>();
  private readonly failures = new Map<string, { at: number; reason: string }>();

  constructor(
    private readonly store: Store,
    private readonly driver: (provider: ProviderId) => Driver,
    private readonly traffic: Traffic,
    private readonly labels: () => Record<string, string>,
    private readonly added: (provider: ProviderId) => boolean,
    /** Called when a build starts, ends, or is given up. */
    private readonly changed: () => void,
  ) {}

  /** A rebuild of a snapshot on record runs in the background, so the provider stays ready meanwhile. */
  status(provider: ProviderId, size: VmSize, now = Date.now()): ProviderSetup {
    const key = `${provider}:${size}`;
    if (this.store.base(provider, size)?.snapshot) return { state: "ready" };
    const build = this.building.get(key);
    if (build && now - build.startedAt < baseSetupLimitMs) return { state: "building", startedAt: build.startedAt };
    if (build) return { state: "failed", reason: tookTooLong };
    const failure = this.failures.get(key);
    if (failure) return { state: "failed", reason: failure.reason };
    return this.supported(provider) ? { state: "none" } : { state: "unsupported" };
  }

  /** False too for a provider missing its credentials, which cannot build anything. */
  supported(provider: ProviderId) {
    try {
      return Boolean(this.driver(provider).snapshot);
    } catch {
      return false;
    }
  }

  /**
   * The snapshot a new VM starts from (null: create it the plain way), and whether to build a new one. The caller builds
   * once its VM exists, so the build cannot take the last VM the provider allows from it.
   */
  choose(provider: ProviderId, size: VmSize, t3Version: string): { from: string | null; rebuild: boolean } {
    if (!this.driver(provider).snapshot) return { from: null, rebuild: false };
    return chooseBase(this.store.base(provider, size), setupStamp(t3Version), Date.now());
  }

  /** Forgets a snapshot a VM could not start from, which may be gone or belong to another account. */
  failed(provider: ProviderId, size: VmSize, snapshot: string) {
    if (this.store.base(provider, size)?.snapshot !== snapshot) return;
    this.store.saveBase(provider, size, { snapshot: null, stamp: null, createdAt: null });
    this.store.retireSnapshot(provider, snapshot);
    void this.sweep(provider).catch(() => {});
  }

  /**
   * Deletes replaced snapshots. A provider can refuse while VMs made from one still exist (E2B), so each stays on
   * record until its delete goes through: on the next build, or once a VM of the provider is deleted.
   */
  async sweep(provider: ProviderId) {
    const retired = this.store.retiredSnapshots(provider);
    if (!retired.length) return;
    const driver = this.driver(provider);
    for (const snapshot of retired) {
      try {
        await driver.deleteCheckpoint(snapshot);
        this.store.forgetRetired(provider, snapshot);
        this.record(provider, "delete snapshot", "ok");
      } catch {
        // Tried again later.
      }
    }
  }

  /** Deletes every base snapshot of a provider that is no longer added. Builds still running finish first. */
  async drop(provider: ProviderId) {
    await Promise.allSettled([...this.building].filter(([key]) => key.startsWith(`${provider}:`)).map(([, build]) => build.done));
    for (const key of this.failures.keys()) if (key.startsWith(`${provider}:`)) this.failures.delete(key);
    const driver = this.driver(provider);
    for (const { size, snapshot, builder } of this.store.bases(provider)) {
      if (snapshot) this.store.retireSnapshot(provider, snapshot);
      try {
        if (builder) await driver.destroy(builder);
        this.store.deleteBase(provider, size);
      } catch (error) {
        // The build VM stays on record so `reap` deletes it on the next start.
        this.store.saveBase(provider, size, { snapshot: null, stamp: null, createdAt: null });
        this.record(provider, "delete base snapshot VM", "error", undefined, error);
      }
    }
    await this.sweep(provider);
  }

  /**
   * Deletes build VMs on record with no build running: left by a restart mid build or a failed delete. One can hold
   * the last VM a provider allows, so this runs before a VM is created there, and on start for every provider.
   */
  async reap(provider?: ProviderId) {
    for (const base of this.store.builders(provider)) {
      if (this.building.has(`${base.provider}:${base.size}`)) continue;
      try {
        await this.driver(base.provider).destroy(base.builder);
        this.store.saveBase(base.provider, base.size, { builder: null });
        this.record(base.provider, "delete base snapshot VM", "ok");
      } catch (error) {
        this.record(base.provider, "delete base snapshot VM", "error", undefined, error);
      }
    }
  }

  /**
   * Starts building a new snapshot in the background, unless one is building or the last attempt failed. After a
   * failure only `retry` builds again while there is no snapshot, so a build that keeps failing (such as on a plan with
   * no VM to spare) does not keep holding its provider back. With an older snapshot on record it is tried again later.
   */
  rebuild(provider: ProviderId, size: VmSize, t3Version: string | Promise<string>, retry = false) {
    const key = `${provider}:${size}`;
    if (this.building.has(key)) return;
    const failure = this.failures.get(key);
    if (failure && !retry && (!this.store.base(provider, size)?.snapshot || Date.now() - failure.at < baseRetryMs)) return;
    // Logged so a failing provider shows on the console too, not only in the dashboard. Reasons are an error's first
    // line, and a build VM holds none of anyone's sign-ins.
    const startedAt = Date.now();
    const took = () => `${Math.round((Date.now() - startedAt) / 1000)} s`;
    console.log(`[base ${key}] build started`);
    const abort = new AbortController();
    const limit = setTimeout(() => this.giveUp(provider, size, abort), baseSetupLimitMs);
    const done = this.build(provider, size, t3Version, abort.signal)
      .then(
        (built) => {
          this.failures.delete(key);
          console.log(built ? `[base ${key}] ready in ${took()}` : `[base ${key}] build skipped: provider removed`);
        },
        (error) => {
          // Given up already, and a newer build may run under the same key.
          if (abort.signal.aborted) return;
          const reason = failureReason(provider, error);
          this.failures.set(key, { at: Date.now(), reason });
          console.error(`[base ${key}] build failed after ${took()}: ${reason}`);
        },
      )
      .finally(() => {
        clearTimeout(limit);
        if (this.building.get(key)?.abort !== abort) return;
        this.building.delete(key);
        this.changed();
      });
    this.building.set(key, { startedAt, done, abort });
    this.changed();
  }

  /**
   * Stops waiting for a build stuck past `baseSetupLimitMs`: it counts as failed and its VM is deleted. The stuck call
   * may still return later; the build then stops at its next step and deletes whatever it made.
   */
  private giveUp(provider: ProviderId, size: VmSize, abort: AbortController) {
    const key = `${provider}:${size}`;
    if (this.building.get(key)?.abort !== abort) return;
    abort.abort();
    this.building.delete(key);
    this.failures.set(key, { at: Date.now(), reason: tookTooLong });
    console.error(`[base ${key}] build given up after ${baseSetupLimitMs / 60_000} minutes`);
    this.record(provider, `build ${size} base snapshot`, "error", undefined, tookTooLong);
    this.changed();
    // `reap` deletes it now that no build runs, and keeps it on record if the delete fails.
    void this.reap(provider);
  }

  /** True while a build runs on the provider. Its VM is not on record until the provider's create returns. */
  running(provider: ProviderId) {
    return [...this.building.keys()].some((key) => key.startsWith(`${provider}:`));
  }

  /** Every build running now, settled. */
  async settled() {
    await Promise.all([...this.building.values()].map((build) => build.done));
  }

  /** False when the provider was removed before the build began. Stops at its next step once `signal` aborts. */
  private async build(provider: ProviderId, size: VmSize, pending: string | Promise<string>, signal: AbortSignal) {
    const driver = this.driver(provider);
    const started = performance.now();
    try {
      const t3Version = await pending;
      signal.throwIfAborted();
      // Removed while the version resolved.
      if (!this.added(provider)) return false;
      const leftover = this.store.base(provider, size)?.builder;
      if (leftover) {
        await driver.destroy(leftover);
        this.store.saveBase(provider, size, { builder: null });
      }
      const key = `base-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const box = await driver.create({ key, size, labels: this.labels(), ports: [t3Port] });
      if (signal.aborted) {
        await driver.destroy(box.id).catch((error) => this.record(provider, "delete base snapshot VM", "error", undefined, error));
        signal.throwIfAborted();
      }
      this.store.saveBase(provider, size, { builder: box.id });
      let snapshot: string;
      try {
        await prepareBase(box, t3Version);
        signal.throwIfAborted();
        if (!driver.snapshot) throw new Error(`${provider} cannot snapshot a VM.`);
        snapshot = await driver.snapshot(box);
        if (signal.aborted) {
          // Saved too late to use, so it goes the way replaced snapshots go.
          this.store.retireSnapshot(provider, snapshot);
          signal.throwIfAborted();
        }
      } finally {
        // On record until deleted, so the next build deletes it when this delete fails.
        await driver.destroy(box.id).then(
          () => {
            // A newer build may have its own VM on record by now.
            if (this.store.base(provider, size)?.builder === box.id) this.store.saveBase(provider, size, { builder: null });
          },
          (error) => this.record(provider, "delete base snapshot VM", "error", undefined, error),
        );
      }
      const replaced = this.store.base(provider, size)?.snapshot;
      this.store.saveBase(provider, size, { snapshot, stamp: setupStamp(t3Version), createdAt: Date.now() });
      if (replaced && replaced !== snapshot) this.store.retireSnapshot(provider, replaced);
      await this.sweep(provider);
      this.record(provider, `build ${size} base snapshot`, "ok", Math.round(performance.now() - started));
      return true;
    } catch (error) {
      // Recorded when it was given up.
      if (!signal.aborted) this.record(provider, `build ${size} base snapshot`, "error", undefined, error);
      throw error;
    }
  }

  private record(provider: ProviderId, operation: string, status: "ok" | "error", durationMs?: number, error?: unknown) {
    const reason = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    this.traffic.record({ kind: "provider", operation, provider, status, durationMs, ...(reason ? { reason } : {}) });
  }
}

const tookTooLong = `Setup took longer than ${baseSetupLimitMs / 60_000} minutes.`;

/** Why a build failed, short enough to show next to a provider. */
function failureReason(provider: ProviderId, error: unknown) {
  // A key that was rotated or revoked fails every build, and the provider's HTTP error does not say what to do.
  if (error instanceof SandboxError && error.code === "auth") return `${providers[provider].label} refused the API key. Enter a new one in Setup.`;
  const line = (error instanceof Error ? error.message : String(error)).trim().split("\n")[0] ?? "";
  if (!line) return "The build failed.";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
