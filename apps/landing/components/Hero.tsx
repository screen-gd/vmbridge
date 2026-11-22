"use client";

import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { copy } from "@/lib/copy";
import { github, install, providers } from "@/lib/data";
import { useMedia } from "@/lib/hooks";
import { primaryButton, secondaryButton } from "@/lib/styles";
import { ProviderLogo } from "./brand";
import type { SceneVm, VmState } from "./BridgeScene";
import { Command } from "./CopyButton";
import { stateDot, Topology } from "./Topology";

const BridgeScene = dynamic(() => import("./BridgeScene").then((m) => m.BridgeScene), { ssr: false });

/** The three demo VMs: provider, project name and starting state. */
const initialVms: SceneVm[] = [
  { id: "a", providerId: "boxd", name: "api-server", state: "online" },
  { id: "b", providerId: "instabox", name: "web-app", state: "asleep" },
  { id: "c", providerId: "daytona", name: "docs", state: "online" },
];

const stateLabel: Record<VmState, string> = {
  online: copy.diagram.online,
  asleep: copy.diagram.asleep,
  waking: copy.diagram.waking,
};

let supportsWebgl: boolean | undefined;

/**
 * The landing header as two cells from xl, split by one vertical hairline: pitch and
 * install command in the left cell with the provider strip pinned to its bottom, and
 * the 3D bridge scene staged in the right cell between the labels and chip strips.
 * Below xl the cells stack with rail-to-rail dividers. Devices and cloud VMs click
 * (or chip-click) to sleep and wake. Without WebGL or JavaScript the flat topology
 * diagram covers the canvas slot.
 */
export function Hero() {
  const [vms, setVms] = useState(initialVms);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const narrow = useMedia("(max-width: 639px)");
  const webgl = useSyncExternalStore(
    () => () => {},
    () => (supportsWebgl ??= Boolean(document.createElement("canvas").getContext("webgl2"))),
    () => true,
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  /** Sleep a running VM, or start waking a sleeping one; "waking" settles to online after a beat. */
  const toggle = (id: string) => {
    setVms((prev) =>
      prev.map((vm) => (vm.id !== id ? vm : vm.state === "online" ? { ...vm, state: "asleep" } : { ...vm, state: "waking" })),
    );
    const pending = timers.current.get(id);
    if (pending) clearTimeout(pending);
    timers.current.set(
      id,
      setTimeout(
        () => setVms((prev) => prev.map((vm) => (vm.id === id && vm.state === "waking" ? { ...vm, state: "online" } : vm))),
        1800,
      ),
    );
  };

  const providerOf = (id: string) => providers.find((p) => p.id === id) ?? providers[0];

  return (
    <div className="grid xl:min-h-[calc(100svh-3.5rem-2rem)] xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-1 items-center pt-10 pr-6 pb-8 pl-6 sm:pt-14 lg:px-12 xl:py-10 xl:pr-10">
          <div className="min-w-0">
            <h1 className="display" style={{ animation: "rise 500ms both" }}>
              {copy.hero.title}
            </h1>
            <p
              className="mt-6 max-w-[34rem] text-pretty text-[16px] text-muted-foreground sm:text-[18px]"
              style={{ animation: "rise 500ms 60ms both" }}
            >
              {copy.hero.body}
            </p>
            <div className="mt-6 sm:mt-10" style={{ animation: "rise 500ms 120ms both" }}>
              <Command text={install} className="lg:text-[12px] xl:text-[11px] 2xl:text-[12px]" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2" style={{ animation: "rise 500ms 180ms both" }}>
              <Link href="/docs" className={`${primaryButton} group`}>
                {copy.hero.docs}
                <HugeiconsIcon icon={ArrowRight01Icon} size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
              <a href={github} className={secondaryButton}>
                <HugeiconsIcon icon={GithubIcon} size={15} />
                {copy.nav.github}
              </a>
            </div>
          </div>
        </div>
        {/* The eight supported providers, linking down to the providers section. */}
        <div className="flex h-14 items-center justify-center gap-4 border-t border-white/10 px-6 sm:gap-6">
          {providers.map((provider) => (
            <a
              key={provider.id}
              href="/#providers"
              title={provider.name}
              aria-label={provider.name}
              className="opacity-70 transition-opacity duration-150 hover:opacity-100"
            >
              <ProviderLogo provider={provider} className="size-6 rounded-[4px]" />
            </a>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-col xl:border-l xl:border-white/10">
        <div className="flex h-12 items-center justify-between border-b border-white/10 px-6 font-mono text-[12px] text-faint max-xl:border-t">
          <span>{copy.diagram.devices}</span>
          <span>{copy.diagram.bridge}</span>
          <span>{copy.diagram.vms}</span>
        </div>
        {/* With JavaScript the slot keeps a fixed height so nothing jumps while the
            scene chunk loads, and fills the stage at xl. Without JavaScript the flat
            diagram renders in flow at its own height; with JavaScript on but no
            WebGL it fills the same slot. */}
        <div className="relative xl:min-h-0 xl:flex-1 [html.js_&]:h-[300px] [html.js_&]:sm:h-[380px] [html.js_&]:xl:h-auto">
          <div className="[html.js_&]:hidden">
            <Topology log={false} />
          </div>
          {webgl ? (
            <BridgeScene vms={vms} onToggle={toggle} narrow={narrow} />
          ) : (
            <div className="absolute inset-0 hidden overflow-hidden [html.js_&]:block">
              <Topology log={false} />
            </div>
          )}
        </div>
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/10 px-6 py-2.5 xl:h-14 xl:flex-nowrap xl:justify-between xl:py-0">
          <span className="text-[13px] whitespace-nowrap text-faint xl:text-[12px]">{copy.hero.hint}</span>
          <div className="flex flex-wrap gap-2 xl:flex-nowrap">
            {vms.map((vm) => (
              <button
                key={vm.id}
                type="button"
                data-vm-chip={vm.id}
                onClick={() => toggle(vm.id)}
                className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] transition-colors duration-150 hover:bg-white/10 xl:gap-1.5 xl:px-2 xl:py-1 xl:text-[11px]"
              >
                <ProviderLogo provider={providerOf(vm.providerId)} className="size-4 rounded-[3px] xl:size-3" />
                <span className="text-foreground">{vm.name}</span>
                <span className={stateDot[vm.state]} />
                <span className="text-muted-foreground xl:max-[1599px]:hidden">{stateLabel[vm.state]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
