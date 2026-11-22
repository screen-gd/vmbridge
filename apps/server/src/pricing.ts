import { vmSizes, type Currency, type Estimate, type ProviderId, type ProviderPricing, type VmSize } from "@vmbridge/contracts";
import { providers } from "./providers/index.ts";

/**
 * Each provider's published prices for the machines VM Bridge creates, read from its pricing page on `asOf`.
 * A price the provider does not publish is null and shows as unknown, never as a guess. Update `asOf` with any change.
 */
interface Published {
  currency: Currency;
  source: string;
  asOf: string;
  /** Per hour while running. `perSize` for flat machine prices, else per vCPU and GiB of memory of the size's machine. */
  running: { vcpuHour: number; gibHour: number; diskGibHour?: number; diskGib?: Record<VmSize, number> } | { perSize: Record<VmSize, number> };
  /** Per hour while VM Bridge has it asleep, before storage billed per GiB. Null: not published. */
  asleep: { gibHour: number } | { diskGibHour: number; diskGib: Record<VmSize, number> } | 0 | null;
  storageGibMonth: number | null;
  sleeping: string;
  snapshots: string;
  plans: string;
  caveat?: string;
}

const asOf = "2026-11-23";

/** Estimates are in US dollars, so euro prices (boxd's) convert at this ECB reference rate. Update it with the prices. */
export const eurUsd = {
  rate: 1.099,
  source: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html",
  asOf: "2026-11-20",
};
const hoursPerMonth = 730;

// Daytona's built-in snapshots VM Bridge creates from (see providers/daytona.ts) fix the reserved disk.
const daytonaDisk = { small: 3, medium: 8, large: 10 };

const published: Record<ProviderId, Published> = {
  boat: {
    currency: "USD",
    source: "https://docs.boat.dev/pricing",
    asOf,
    running: { perSize: { small: 0.018, medium: 0.036, large: 0.072 } },
    asleep: 0,
    storageGibMonth: null,
    sleeping: "Free. A stopped VM keeps its disk for free for at least 14 days.",
    snapshots: "Automatic snapshots are free. Saved snapshots: 10 included per $20 of plan, then $0.056 a day each.",
    plans: "From $20 a month, all of it paid back as VM time. 7 day trial with a card.",
  },
  boxd: {
    currency: "EUR",
    source: "https://boxd.sh/pricing",
    asOf,
    running: { vcpuHour: 0.039, gibHour: 0.012 },
    // VM Bridge pauses boxd VMs, which is standby: memory in use and disk written are billed.
    asleep: { gibHour: 0.012 },
    storageGibMonth: 0.058,
    sleeping: "Paused VMs pay for memory in use and disk written, not CPU.",
    snapshots: "Not published.",
    plans: "Pay as you go, €30 credit when a card is added. Up to 100 VMs.",
    caveat: "boxd bills only busy vCPUs and memory in use, so the estimate is the most it could cost.",
  },
  daytona: {
    currency: "USD",
    source: "https://www.daytona.io/pricing",
    asOf,
    running: { vcpuHour: 0.0504, gibHour: 0.0162, diskGibHour: 0.000108, diskGib: daytonaDisk },
    asleep: { diskGibHour: 0.000108, diskGib: daytonaDisk },
    storageGibMonth: 0.0788,
    sleeping: "Stopped sandboxes pay for their reserved disk only.",
    snapshots: "Billed for storage, rate not published.",
    plans: "$200 free credit, no card. First 5 GiB of disk free.",
    caveat: "The estimate leaves out Daytona's first 5 GiB of free disk.",
  },
  e2b: {
    currency: "USD",
    source: "https://e2b.dev/pricing",
    asOf,
    running: { vcpuHour: 0.0504, gibHour: 0.0162 },
    asleep: null,
    storageGibMonth: null,
    sleeping: "No CPU or memory charge. Storage of paused sandboxes is not published.",
    snapshots: "Not published.",
    plans: "Hobby: $100 one-time credit, 10 sandboxes, 1 hour sessions. Pro: $150 a month plus usage.",
  },
  freestyle: {
    currency: "USD",
    source: "https://www.freestyle.sh/pricing",
    asOf,
    running: { vcpuHour: 0.04032, gibHour: 0.0129 },
    asleep: 0,
    storageGibMonth: 0.000086 * hoursPerMonth,
    sleeping: "Paused VMs pay for allocated storage only.",
    snapshots: "No separate price. Free plan: 10 snapshots.",
    plans: "Every plan includes 200 vCPU hours and 400 GiB hours a month. Free stops at the allowance; Hobby is $50 a month.",
  },
  instabox: {
    currency: "USD",
    source: "https://instabox.sh/docs/pricing.md",
    asOf,
    running: { vcpuHour: 0.004, gibHour: 0.00225 },
    asleep: 0,
    storageGibMonth: 0.08,
    sleeping: "Paused VMs pay for disk only, and only above the plan's included disk.",
    snapshots: "Free. Free plan: 5 snapshots.",
    plans: "Free: 1 VM at a time, 4 vCPU, 8 GiB, disk included. Pro: $20 a month, credits included, 200 GiB disk.",
  },
  railway: {
    currency: "USD",
    source: "https://railway.com/pricing",
    asOf,
    running: { vcpuHour: 0.00001929 * 3600, gibHour: 0.00001929 * 3600 },
    // Asleep is a checkpoint and the sandbox is destroyed: no compute. Checkpoint storage is not published.
    asleep: null,
    storageGibMonth: null,
    sleeping: "The sandbox is destroyed, so no compute. Checkpoint storage is not published.",
    snapshots: "Checkpoints: price not published. 10 to 100 per environment by plan.",
    plans: "Hobby $5 a month with $5 usage included, Pro $20. Trial: $5 credit, 2 vCPU and 2 GB at most.",
    caveat: "Railway bills CPU actually used, so the estimate is the most it could cost.",
  },
  superserve: {
    currency: "USD",
    source: "https://superserve.ai/pricing",
    asOf,
    running: { vcpuHour: 0.0504, gibHour: 0.0162 },
    asleep: 0,
    storageGibMonth: 0.000108 * hoursPerMonth,
    sleeping: "Paused sandboxes pay for storage: the template plus their saved changes.",
    snapshots: "No separate price; saved changes bill as storage.",
    plans: "Developer: $20 a month, all of it usage. Pro: $250.",
  },
};

/** "2 vCPU, 4 GB" from a provider's size labels. Memory is taken as GiB, as the pricing pages bill it. */
export function machine(provider: ProviderId, size: VmSize) {
  const match = /^(\d+) vCPU, (\d+) GB$/.exec(providers[provider].sizes[size]);
  if (!match) throw new Error(`Unreadable size label for ${provider} ${size}.`);
  return { vcpu: Number(match[1]), gib: Number(match[2]) };
}

function runningHourly(provider: ProviderId, size: VmSize) {
  const { running } = published[provider];
  if ("perSize" in running) return running.perSize[size];
  const { vcpu, gib } = machine(provider, size);
  return vcpu * running.vcpuHour + gib * running.gibHour + (running.diskGibHour ?? 0) * (running.diskGib?.[size] ?? 0);
}

function asleepHourly(provider: ProviderId, size: VmSize) {
  const { asleep } = published[provider];
  if (asleep === null || asleep === 0) return asleep;
  if ("gibHour" in asleep) return machine(provider, size).gib * asleep.gibHour;
  return asleep.diskGibHour * asleep.diskGib[size];
}

const perSize = <T>(value: (size: VmSize) => T) => Object.fromEntries(vmSizes.map((size) => [size, value(size)])) as Record<VmSize, T>;

export function pricing(provider: ProviderId): ProviderPricing {
  const { running, asleep, ...rest } = published[provider];
  return {
    ...rest,
    provider,
    label: providers[provider].label,
    machines: providers[provider].sizes,
    runningHourly: perSize((size) => runningHourly(provider, size)),
    asleepHourly: perSize((size) => asleepHourly(provider, size)),
  };
}

const hourMs = 3_600_000;

/**
 * Estimated cost of time awake and asleep on one provider and size, in US dollars. Storage billed per GiB
 * is left out: VM Bridge does not know how much each VM or snapshot holds. `partial` when time asleep has no
 * published price.
 */
export function estimate(provider: ProviderId, size: VmSize, awakeMs: number, asleepMs: number): Estimate {
  const asleep = asleepHourly(provider, size);
  const toUsd = published[provider].currency === "EUR" ? eurUsd.rate : 1;
  return {
    amount: ((awakeMs / hourMs) * runningHourly(provider, size) + (asleepMs / hourMs) * (asleep ?? 0)) * toUsd,
    partial: asleep === null && asleepMs > 0,
  };
}
