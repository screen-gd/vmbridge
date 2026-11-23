import type { Job } from "../jobs.ts";

/** The alarm's cadence: the shortest job interval, so every job runs within a tick of when it is due. */
export const tickMs = 15_000;

/**
 * Runs VM Bridge's jobs from Durable Object alarms, which survive the object being evicted, as Bun runs them from
 * timers. Each alarm schedules the next one first, then starts the jobs that are due without waiting for them, and
 * skips a job whose last run is still going, so a slow one never holds up the others.
 */
export class AlarmJobs {
  private readonly nextRun = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(
    private readonly storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
    private readonly jobs: Job[],
  ) {}

  /** Sets the first alarm, for an object that has none yet. Each alarm sets the next. */
  async start(now = Date.now()) {
    if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(now + tickMs);
  }

  /** Returns the jobs it started, for tests to wait on. */
  async alarm(now = Date.now()): Promise<Promise<void>[]> {
    await this.storage.setAlarm(now + tickMs);
    const started: Promise<void>[] = [];
    for (const job of this.jobs) {
      // A fresh object runs every job on its first alarm, as Bun's timers do soon after a start.
      if (this.running.has(job.name) || (this.nextRun.get(job.name) ?? 0) > now) continue;
      this.nextRun.set(job.name, now + job.everyMs);
      this.running.add(job.name);
      const run = job
        .run()
        .catch((error) => console.error(`[error] ${job.name}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.running.delete(job.name));
      started.push(run);
    }
    return started;
  }
}
