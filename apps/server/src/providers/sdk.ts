import {
  connectSandbox,
  createSandbox,
  hasCapability,
  listSandboxes,
  SandboxError,
  type CreateOptions,
} from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import type { ProviderId, SelectOption, VmSize } from "@vmbridge/contracts";
import type { Box, CreateVm, Driver, ProviderState, SleepResult, WakeVm } from "./types.ts";

/** How a provider puts an idle VM to sleep. */
export type SleepStyle = "pause" | "checkpoint";

export interface SdkDriverOptions {
  id: ProviderId;
  provider: Provider;
  /** A provider instance for one size, when the size is fixed per instance (Railway) or per template (E2B). */
  sized?: (size: VmSize) => Provider | Promise<Provider>;
  sleep: SleepStyle;
  /** Extra create options, such as a provider idle timeout used as a safety net. */
  create?: Partial<CreateOptions>;
  /** Lists sleeping sandboxes the SDK listing leaves out (boxd). */
  listSleeping?: () => Promise<{ id: string; state: ProviderState }[]>;
  /** Deletes a checkpoint or base snapshot where the SDK has no delete for this provider. */
  deleteCheckpoint?: (checkpoint: string) => Promise<void>;
}

export const notFound = (error: unknown) => error instanceof SandboxError && error.code === "not_found";

/**
 * Runs a new VM's create again when the provider answered that the machine does not exist. boxd sometimes says so
 * to the SDK's first command on a machine it has only just created; the SDK then deletes that machine and fails,
 * so another attempt under the same key starts clean. Any other failure is final.
 */
export async function retryNotFound<T>(create: () => Promise<T>, tries = 3, delayMs = 2_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await create();
    } catch (error) {
      if (attempt >= tries || !notFound(error)) throw error;
      await Bun.sleep(delayMs * attempt);
    }
  }
}

/** A driver built only from the portable SDK API. */
export function sdkDriver(options: SdkDriverOptions): Driver {
  const { provider } = options;
  // VM Bridge writes its own env file in the VM, so there are no SDK secrets to read back.
  const connect = (sandboxId: string): Promise<Box> =>
    connectSandbox(provider, sandboxId, { recoverSecrets: false });

  const create = async (input: CreateVm, from?: string): Promise<Box> => {
    const sized = await options.sized?.(input.size);
    return createSandbox(sized ?? provider, {
      ...options.create,
      // A checkpoint restore is a new sandbox, so it needs a new key.
      key: from ? `${input.key}-${Date.now().toString(36)}` : input.key,
      // Providers whose image fixes the machine (Freestyle, Superserve) refuse any size, and a snapshot fixes it too.
      size: from || sized || !provider.capabilities.has("size") ? undefined : input.size,
      labels: input.labels,
      ports: input.ports,
      from,
    });
  };

  return {
    id: options.id,

    async verify() {
      await listSandboxes(provider, { labels: { vmbridge: "verify" } });
    },

    async options(): Promise<SelectOption[]> {
      return [];
    },

    create,
    connect,

    snapshot: provider.capabilities.has("snapshot")
      ? async (box) => {
          if (!hasCapability(box, "snapshot")) throw new Error(`${provider.name} cannot snapshot this VM.`);
          return (await box.snapshot()).id;
        }
      : undefined,

    list: (labels) => listSandboxes(provider, { labels }),

    async states(labels) {
      const states = new Map<string, ProviderState>();
      for (const info of await listSandboxes(provider, { labels })) states.set(info.id, info.state);
      for (const sleeping of (await options.listSleeping?.()) ?? []) states.set(sleeping.id, sleeping.state);
      return states;
    },

    async sleep(box): Promise<SleepResult> {
      if (options.sleep === "pause" && hasCapability(box, "pause")) {
        await box.pause();
        return {};
      }
      if (hasCapability(box, "snapshot")) {
        const { id } = await box.snapshot();
        await box.destroy();
        return { checkpoint: id };
      }
      throw new Error(`${provider.name} cannot pause or snapshot this VM.`);
    },

    async wake(vm: WakeVm) {
      if (vm.checkpoint) return create(vm, vm.checkpoint);
      const box = await connect(vm.sandboxId);
      if (!hasCapability(box, "pause")) return box;
      // A VM can wake on its own (boxd resumes on proxy traffic) or still be pausing, and then
      // the provider refuses the resume. Re-read the state until it is running or resumable.
      const deadline = Date.now() + 2 * 60_000;
      for (;;) {
        const { state } = await provider.connect(vm.sandboxId);
        if (state === "running") return box;
        try {
          await box.resume();
          return box;
        } catch (error) {
          const conflict = error instanceof SandboxError && error.code === "invalid_argument";
          if (!conflict || Date.now() > deadline) throw error;
        }
        await Bun.sleep(1_000);
      }
    },

    async keepAlive() {},

    async destroy(sandboxId) {
      try {
        await (await connect(sandboxId)).destroy();
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    async deleteCheckpoint(checkpoint) {
      if (options.deleteCheckpoint) await options.deleteCheckpoint(checkpoint);
      else await provider.deleteSnapshot?.(checkpoint);
    },
  };
}
