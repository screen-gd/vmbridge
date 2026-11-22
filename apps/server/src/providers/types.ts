import type { SandboxBase } from "@opencoredev/sandbox-sdk";
import type { SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { ProviderFeatures, ProviderField, ProviderId, SelectOption, VmSize } from "@vmbridge/contracts";

/** The provider-neutral sandbox handle: commands, files, background processes, previews. */
export type Box = SandboxBase<unknown>;

export type ProviderState = "running" | "paused" | "stopped";

export interface CreateVm {
  /** VM Bridge's own VM ID, used as the provider key so a retried create finds the same sandbox. */
  key: string;
  size: VmSize;
  labels: Record<string, string>;
  /** Ports the T3 server needs reachable from VM Bridge. */
  ports: number[];
}

export interface SleepResult {
  /** Set when sleeping replaced the sandbox with a checkpoint (the sandbox itself is gone). */
  checkpoint?: string;
}

export interface WakeVm extends CreateVm {
  sandboxId: string;
  checkpoint: string | null;
}

export interface Driver {
  readonly id: ProviderId;
  /** Throws a readable error when the credentials are missing or rejected. */
  verify(): Promise<void>;
  /** Choices for a `select` field, such as Boat environments. */
  options(field: string): Promise<SelectOption[]>;
  /** With `from`, starts from a base snapshot `snapshot` made, which fixes the machine size. */
  create(input: CreateVm, from?: string): Promise<Box>;
  /** Saves a VM's disk as a base snapshot new VMs can start from. Absent when the provider cannot. */
  snapshot?(box: Box): Promise<string>;
  connect(sandboxId: string): Promise<Box>;
  /**
   * Every sandbox carrying `labels`, with the key and labels it was created with. Providers that cannot read a sleeping
   * sandbox's labels without waking it (boxd) leave sleeping ones out.
   */
  list(labels: Record<string, string>): Promise<SandboxInfo[]>;
  /** Provider state of every sandbox carrying `labels`. Absent IDs no longer exist. */
  states(labels: Record<string, string>): Promise<Map<string, ProviderState>>;
  sleep(box: Box): Promise<SleepResult>;
  /** Wakes a sleeping VM. The returned box can have a new ID when the provider restores from a checkpoint. */
  wake(vm: WakeVm): Promise<Box>;
  /** Extends provider-side auto-stop timers while agents work. */
  keepAlive(box: Box): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  /** Deletes a checkpoint `sleep` made, or a base snapshot `snapshot` made, once nothing needs it. One already gone is fine. */
  deleteCheckpoint(checkpoint: string): Promise<void>;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  website: string;
  fields: ProviderField[];
  features: ProviderFeatures;
  sizes: Record<VmSize, string>;
  /** The size new VMs get unless a setting or repository rule picks one: the closest to 2 vCPU and 8 GB. */
  defaultSize: VmSize;
  open(config: ProviderConfig): Driver;
}

export interface ProviderConfig {
  /** Field values by key: secrets and plain options together. */
  values: Record<string, string>;
}

export function required(config: ProviderConfig, key: string, label: string): string {
  const value = config.values[key];
  if (!value) throw new Error(`${label} is not set.`);
  return value;
}
