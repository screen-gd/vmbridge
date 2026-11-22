import { buildTemplate } from "@opencoredev/sandbox-sdk";
import { e2b, type E2BOptions } from "@opencoredev/sandbox-sdk/e2b";
import type { VmSize } from "@vmbridge/contracts";
import { sdkDriver } from "./sdk.ts";
import { required, type ProviderDefinition } from "./types.ts";

interface E2BTemplate {
  templateID: string;
  names?: string[];
  aliases?: string[];
}

/** E2B's template fixes CPU and memory, and its `base` has 512 MB. VM Bridge builds one template per size from `base`. */
const machines = {
  small: { cpu: 2, memoryMb: 2048 },
  medium: { cpu: 4, memoryMb: 4096 },
  large: { cpu: 8, memoryMb: 8192 },
} as const;

/**
 * E2B pauses a VM this long after it starts or wakes, in case VM Bridge is down. Without `autoPause` the same
 * timeout kills the VM. `keepAlive` pushes it back while agents work.
 */
const timeoutSeconds = 60 * 60;

export const e2bProvider: ProviderDefinition = {
  id: "e2b",
  label: "E2B",
  website: "https://e2b.dev",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "e2b_..." }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  sizes: { small: "2 vCPU, 2 GB", medium: "4 vCPU, 4 GB", large: "8 vCPU, 8 GB" },
  // 2 GB, the only 2 vCPU size, runs out of memory with two turns installing and building.
  defaultSize: "medium",

  open(config) {
    const options: E2BOptions = { apiKey: required(config, "apiKey", "E2B API key"), autoPause: true };
    const provider = e2b(options);
    const templates = new Map<VmSize, Promise<string>>();

    // The name carries the machine, so changing a size above builds a new template instead of reusing the old one.
    async function findOrBuild(size: VmSize) {
      const machine = machines[size];
      const name = `vmbridge-${machine.cpu}cpu-${machine.memoryMb / 1024}gb`;
      const existing = (await provider.api.request<E2BTemplate[]>("GET", "/templates")).find((template) =>
        [...(template.names ?? []), ...(template.aliases ?? [])].some((entry) => entry === name || entry.endsWith(`/${name}`)),
      );
      if (existing) return existing.templateID;
      return (await buildTemplate(provider, { name, fromTemplate: "base", size: machine })).id;
    }

    const template = (size: VmSize) => {
      let pending = templates.get(size);
      if (!pending) {
        pending = findOrBuild(size);
        pending.catch(() => templates.delete(size));
        templates.set(size, pending);
      }
      return pending;
    };

    const setTimeout = (sandboxId: string) =>
      provider.api.request("POST", "/sandboxes/{sandboxId}/timeout", { params: { sandboxId }, body: { timeout: timeoutSeconds } });

    const base = sdkDriver({
      id: "e2b",
      provider,
      sized: async (size) => e2b({ ...options, template: await template(size) }),
      sleep: "pause",
      create: { timeoutMs: timeoutSeconds * 1000 },
    });

    return {
      ...base,

      async wake(vm) {
        const box = await base.wake(vm);
        // Resuming does not reset E2B's timeout, so set it again.
        await setTimeout(box.id);
        return box;
      },

      async keepAlive(box) {
        await setTimeout(box.id);
      },
    };
  },
};
