import type { Usage, VmStats } from "@vmbridge/contracts";
import type { Fleet } from "../fleet.ts";
import { checkoutRoot } from "./runtime.ts";

/**
 * One read-only round trip that works on every provider. Each part prints under its own `@name` line,
 * and a part the VM lacks (PSI, cgroup files) prints nothing. Containers see the host in /proc/meminfo,
 * so their cgroup v2 limits are read too. CPU is measured over one second from the cgroup's
 * `usage_usec` when there is one, else from /proc/stat: /proc/loadavg would show a container's host.
 */
export const statsCommand = `exec 2>/dev/null
cg=/sys/fs/cgroup
cpu() { echo "@cpu$1"; cat /proc/uptime; grep '^usage_usec ' $cg/cpu.stat; grep '^cpu ' /proc/stat; }
cpu 0
echo @meminfo; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
echo @memory.max; cat $cg/memory.max
echo @memory.current; cat $cg/memory.current
echo @memory.stat; grep '^inactive_file ' $cg/memory.stat
echo @psi; cat $cg/memory.pressure || cat /proc/pressure/memory
echo @cpu.max; cat $cg/cpu.max
echo @nproc; nproc || getconf _NPROCESSORS_ONLN
echo @df; df -Pk ${checkoutRoot}
sleep 1
cpu 1
`;

/**
 * High memory: under 10% of memory left, or some task stalled on memory for 10% or more of the last 10 s.
 * Used memory leaves out what the kernel can reclaim (MemAvailable, or a cgroup's inactive page cache),
 * so 90% is close to the OOM killer. PSI catches thrashing before that: an idle or healthy VM stays near 0.
 */
export const highMemory = (memory: Usage | null, pressure: number | null) =>
  (memory !== null && memory.used >= memory.total * 0.9) || (pressure !== null && pressure >= 10);

const number = (text: string | undefined) => {
  const value = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(value) ? value : null;
};

function sections(output: string) {
  const parts = new Map<string, string>();
  let name = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("@")) name = line.slice(1).trim();
    else if (name && line.trim()) parts.set(name, `${parts.get(name) ?? ""}${line}\n`);
  }
  return parts;
}

function memory(parts: Map<string, string>): Usage | null {
  const meminfo = parts.get("meminfo") ?? "";
  const kb = (key: string) => number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))?.[1]);
  const memTotal = kb("MemTotal");
  const memAvailable = kb("MemAvailable");
  const limit = number(parts.get("memory.max"));
  const current = number(parts.get("memory.current"));
  // A container's limit, when it is below what /proc/meminfo reports. "max" means no limit.
  if (limit !== null && current !== null && limit > 0 && (memTotal === null || limit < memTotal * 1024)) {
    // Like `docker stats`: inactive page cache is reclaimable, so it does not count as used.
    const inactive = number(parts.get("memory.stat")?.split(/\s+/)[1]) ?? 0;
    return { used: Math.max(0, current - inactive), total: limit };
  }
  if (memTotal === null || memAvailable === null || memTotal === 0) return null;
  return { used: (memTotal - memAvailable) * 1024, total: memTotal * 1024 };
}

function cores(parts: Map<string, string>) {
  const online = number(parts.get("nproc"));
  const [quota, period] = (parts.get("cpu.max") ?? "").trim().split(/\s+/).map(Number);
  const limit = quota !== undefined && period ? quota / period : NaN;
  if (Number.isFinite(limit) && limit > 0) return online ? Math.min(online, limit) : limit;
  return online && online > 0 ? online : null;
}

function cpuReading(text: string | undefined) {
  if (!text) return null;
  const uptime = number(text.split(/\s+/)[0]);
  const usage = number(text.match(/^usage_usec (\d+)/m)?.[1]);
  // user nice system idle iowait irq softirq steal: guest time is already inside user and nice.
  const fields = text.match(/^cpu\s+(.+)$/m)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number) ?? [];
  const total = fields.every(Number.isFinite) ? fields.reduce((sum, value) => sum + value, 0) : 0;
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { uptime, usage, total, idle };
}

function cpu(parts: Map<string, string>): VmStats["cpu"] {
  const count = cores(parts);
  const before = cpuReading(parts.get("cpu0"));
  const after = cpuReading(parts.get("cpu1"));
  if (count === null || !before || !after) return null;
  let usage: number | null = null;
  if (before.usage !== null && after.usage !== null && before.uptime !== null && after.uptime !== null && after.uptime > before.uptime) {
    usage = (after.usage - before.usage) / ((after.uptime - before.uptime) * 1e6) / count;
  } else if (after.total > before.total) {
    usage = 1 - (after.idle - before.idle) / (after.total - before.total);
  }
  if (usage === null || !Number.isFinite(usage)) return null;
  return { usage: Math.min(1, Math.max(0, usage)), cores: Math.round(count * 100) / 100 };
}

function disk(parts: Map<string, string>): Usage | null {
  // POSIX `df -P`: a header, then one line ending in size, used, available, capacity and mount point.
  const line = parts.get("df")?.trim().split("\n").at(-1) ?? "";
  const match = line.match(/\s(\d+)\s+\d+\s+(\d+)\s+\d+%\s/);
  const size = number(match?.[1]);
  const available = number(match?.[2]);
  if (size === null || available === null || size === 0) return null;
  // Reserved blocks count as used, so the bar is full exactly when writes start failing.
  return { used: (size - available) * 1024, total: size * 1024 };
}

export function parseStats(output: string, at: number): VmStats {
  const parts = sections(output);
  const mem = memory(parts);
  const pressure = number(parts.get("psi")?.match(/^some avg10=([\d.]+)/m)?.[1]);
  return { at, memory: mem, memoryPressure: pressure, cpu: cpu(parts), disk: disk(parts), highMemory: highMemory(mem, pressure) };
}

/**
 * The latest reading of each awake VM. Only connected VMs are read, so a reading never wakes one, and
 * a slow or failed reading keeps the last good one. Readings go when a VM sleeps or disconnects.
 */
export class Stats {
  private readonly latest = new Map<string, VmStats>();
  /** Disk survives sleep, so its last reading still tells whether a sleeping VM has room for more work. */
  private readonly disks = new Map<string, Usage>();
  private readonly reading = new Map<string, Promise<VmStats | null>>();

  constructor(private readonly fleet: Fleet) {
    fleet.on("awake", (vmId) => void this.sample(vmId));
    fleet.on("offline", (vmId) => this.latest.delete(vmId));
  }

  get(vmId: string) {
    return this.latest.get(vmId) ?? null;
  }

  /** The VM's disk when it was last read, awake or not. */
  lastDisk(vmId: string) {
    return this.disks.get(vmId) ?? null;
  }

  /** Reads a VM now, sharing a reading already under way. A VM that is not connected keeps what it has. */
  sample(vmId: string): Promise<VmStats | null> {
    const box = this.fleet.box(vmId);
    if (!box) return Promise.resolve(this.get(vmId));
    let flight = this.reading.get(vmId);
    if (!flight) {
      flight = (async () => {
        // The signal bounds the provider call itself, which `timeoutMs` (killing the command) does not.
        const result = await box.run(statsCommand, { timeoutMs: 10_000, maxOutputBytes: 16_384, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        // Asleep or gone since the reading started: keep nothing.
        if (!this.fleet.box(vmId)) return null;
        // A killed or aborted command has no exit code, and its output may stop partway.
        if (!result || result.exitCode === null || !result.stdout) return this.get(vmId);
        const stats = parseStats(result.stdout, Date.now());
        this.latest.set(vmId, stats);
        if (stats.disk) this.disks.set(vmId, stats.disk);
        this.fleet.emit("changed");
        return stats;
      })().finally(() => this.reading.delete(vmId));
      this.reading.set(vmId, flight);
    }
    return flight;
  }

  async sampleAll() {
    await Promise.all(this.fleet.connected().map((vmId) => this.sample(vmId)));
  }
}
