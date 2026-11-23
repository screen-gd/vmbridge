import type { Job } from "../jobs.ts";

/** Runs each job every `everyMs`, skipping a turn while its last run is still going. Returns a function that stops them all. */
export function runJobs(jobs: Job[]): () => void {
  const timers = jobs.map((job) => {
    let running = false;
    return setInterval(() => {
      if (running) return;
      running = true;
      job
        .run()
        .catch((error) => console.error(`[error] ${job.name}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => (running = false));
    }, job.everyMs);
  });
  return () => timers.forEach((timer) => clearInterval(timer));
}
