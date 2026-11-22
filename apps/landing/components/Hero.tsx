"use client";

import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { copy } from "@/lib/copy";
import { github, install, providers } from "@/lib/data";
import { useMedia } from "@/lib/hooks";
import { innerPad, primaryButton, secondaryButton } from "@/lib/styles";
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
 * The landing header: pitch and install command on the left, the 3D bridge scene on the
 * right. Devices and cloud VMs click (or chip-click) to sleep and wake. Without WebGL or
 * JavaScript the flat topology diagram covers the same slot.
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
    <div className={`flex items-center ${innerPad} pt-10 pb-6 sm:pt-14 xl:min-h-[calc(100svh-3.5rem-2rem)] xl:py-0`}>
      <div className="grid w-full grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:items-center xl:gap-12">
        <div className="min-w-0">
          <h1 className="display" style={{ animation: "rise 500ms both" }}>
            {copy.hero.title}
          </h1>
          <p className="mt-6 max-w-[34rem] text-pretty text-[16px] text-muted-foreground sm:text-[18px]" style={{ animation: "rise 500ms 60ms both" }}>
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
        <div className="min-w-0" style={{ animation: "rise 500ms 240ms both" }}>
          <div className="flex items-baseline justify-between font-mono text-[12px] text-faint">
            <span>{copy.diagram.devices}</span>
            <span>{copy.diagram.bridge}</span>
            <span>{copy.diagram.vms}</span>
          </div>
          {/* With JavaScript the slot keeps the scene's aspect so nothing jumps while
              the chunk loads. Without JavaScript the flat diagram renders in flow at
              its own height; with JavaScript on but no WebGL it fills the same slot. */}
          <div className="relative mt-2 [html.js_&]:aspect-[13/5]">
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
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[13px] text-faint">{copy.hero.hint}</span>
            <div className="flex flex-wrap gap-2">
              {vms.map((vm) => (
                <button
                  key={vm.id}
                  type="button"
                  data-vm-chip={vm.id}
                  onClick={() => toggle(vm.id)}
                  className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] transition-colors duration-150 hover:bg-white/10"
                >
                  <ProviderLogo provider={providerOf(vm.providerId)} className="size-4 rounded-[3px]" />
                  <span className="text-foreground">{vm.name}</span>
                  <span className={stateDot[vm.state]} />
                  <span className="text-muted-foreground">{stateLabel[vm.state]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
