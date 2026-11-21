"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { providers, type Provider, type ProviderId } from "@/lib/data";
import { useInView, useMedia, useReducedMotion } from "@/lib/hooks";
import { Logo, ProviderLogo, T3Logo } from "./brand";
import { Panel } from "./Window";

type VmState = "online" | "asleep" | "waking";

interface Vm {
  id: "a" | "b" | "c";
  project: string;
  providerId: ProviderId;
  state: VmState;
}

const initialVms: Vm[] = [
  { id: "a", project: "api-server", providerId: "boxd", state: "online" },
  { id: "b", project: "web-app", providerId: "instabox", state: "asleep" },
  { id: "c", project: "docs", providerId: "daytona", state: "online" },
];

/** The ids cover every provider, so the fallback is never taken. */
const providerOf = (id: ProviderId): Provider => providers.find((p) => p.id === id) ?? providers[0];

type Point = readonly [number, number];

/** Node centers in SVG units. Wide lays out left to right, narrow top to bottom. */
const layouts = {
  wide: {
    w: 1000,
    h: 360,
    devices: { mac: [140, 125], phone: [140, 235] },
    bridge: [500, 180],
    vms: { a: [840, 75], b: [840, 180], c: [840, 285] },
  },
  narrow: {
    w: 1000,
    h: 1400,
    devices: { mac: [270, 110], phone: [730, 110] },
    bridge: [500, 500],
    vms: { a: [500, 850], b: [500, 1070], c: [500, 1290] },
  },
} as const;
type Layout = (typeof layouts)[keyof typeof layouts];

function wire(from: Point, to: Point, wide: boolean) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (wide) {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  }
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

type WireKind = "active" | "asleep" | "waking";

const wireStyle: Record<WireKind, { stroke: string; strokeOpacity: number; dash?: string }> = {
  active: { stroke: "rgb(255 255 255 / 0.2)", strokeOpacity: 1 },
  asleep: { stroke: "rgb(255 255 255 / 0.12)", strokeOpacity: 1, dash: "3 6" },
  waking: { stroke: "var(--primary)", strokeOpacity: 0.6, dash: "3 6" },
};

/**
 * One wire between two nodes, with two packets moving along it while it carries traffic.
 * Packets are round-capped stubs so they stay circular when the SVG stretches non-uniformly.
 */
function Wire({ d, kind, packets }: { d: string; kind: WireKind; packets: boolean }) {
  const style = wireStyle[kind];
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={style.stroke}
        strokeOpacity={style.strokeOpacity}
        strokeWidth={1}
        strokeDasharray={style.dash}
        vectorEffect="non-scaling-stroke"
      />
      {kind === "active" && packets ? (
        <>
          <path d="M0 0h0.01" fill="none" stroke="var(--primary)" strokeWidth={7} strokeLinecap="round" vectorEffect="non-scaling-stroke">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
          </path>
          <path d="M0 0h0.01" fill="none" stroke="rgb(255 255 255 / 0.7)" strokeWidth={7} strokeLinecap="round" vectorEffect="non-scaling-stroke">
            <animateMotion dur="2.1s" begin="-1s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={d} />
          </path>
        </>
      ) : null}
    </>
  );
}

/** Positions a node by its center, in percent of the diagram. */
function At({ point, layout, children }: { point: Point; layout: Layout; children: React.ReactNode }) {
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${(point[0] / layout.w) * 100}%`, top: `${(point[1] / layout.h) * 100}%` }}
    >
      {children}
    </div>
  );
}

/** A paired device, a pill with the T3 Code mark. */
function Device({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-2">
      <T3Logo className="size-6" />
      <span className="text-xs font-medium">{name}</span>
    </div>
  );
}

const stateLabel = (state: VmState) => copy.diagram[state];

/** State dot styles, shared with the lifecycle thread's VM chip and notices. */
export const stateDot: Record<VmState, string> = {
  online: "size-1.5 rounded-full bg-primary",
  asleep: "size-1.5 rounded-full ring-1 ring-white/40",
  waking: "size-1.5 animate-pulse rounded-full bg-primary",
};

/** One project VM. Clicking sleeps an online VM and wakes an asleep one. */
function VmNode({ vm, provider, narrow, onToggle }: { vm: Vm; provider: Provider; narrow: boolean; onToggle: () => void }) {
  const dim = `transition-opacity duration-200 ${vm.state === "asleep" ? "opacity-50" : ""}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${vm.project}: ${stateLabel(vm.state)}`}
      className={`${narrow ? "w-60" : "w-52"} rounded-md bg-muted p-3 text-left`}
    >
      <div className="flex items-center gap-2.5">
        <ProviderLogo provider={provider} className={`size-7 rounded-md ring-white/10 ${dim}`} />
        <div className={`min-w-0 flex-1 leading-tight ${dim}`}>
          <div className="truncate text-sm font-medium">{vm.project}</div>
          <div className="truncate font-mono text-[11px] text-faint">{provider.name}</div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground">
          <span className={stateDot[vm.state]} />
          {stateLabel(vm.state)}
        </div>
      </div>
    </button>
  );
}

interface LogRow {
  id: number;
  project: string;
  state: string;
  detail: string;
  animate: boolean;
}

const seedRows: LogRow[] = [
  { id: 0, project: "api-server", state: "online", detail: "boxd", animate: false },
  { id: 1, project: "web-app", state: "asleep", detail: "Instabox: pause, memory kept", animate: false },
  { id: 2, project: "docs", state: "online", detail: "Daytona", animate: false },
];

/**
 * The wiring diagram row: devices to VM Bridge to the project VMs, with the event log beside it.
 * `stacked` renders the single-column variant used inside the docs page's bordered box.
 */
export function Topology({ stacked = false }: { stacked?: boolean }) {
  const [vms, setVms] = useState(initialVms);
  const [rows, setRows] = useState(seedRows);
  const nextRow = useRef(seedRows.length);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const packets = useInView(panel) && !reduced;
  const narrow = useMedia("(max-width: 767px)");
  const layout = narrow ? layouts.narrow : layouts.wide;
  const shown = stacked ? rows.slice(-3) : rows.slice(-8);

  const pushRow = (project: string, state: string, detail: string) =>
    setRows((list) => [...list, { id: nextRow.current++, project, state, detail, animate: true }].slice(-8));

  const toggle = (id: Vm["id"]) => {
    const vm = vms.find((v) => v.id === id);
    if (!vm || vm.state === "waking") return;
    const provider = providerOf(vm.providerId);
    const setState = (state: VmState) => setVms((list) => list.map((v) => (v.id === id ? { ...v, state } : v)));
    if (vm.state === "online") {
      setState("asleep");
      pushRow(vm.project, "asleep", `${provider.name}: ${provider.sleep.toLowerCase()}`);
      return;
    }
    setState("waking");
    pushRow(vm.project, "waking", `${provider.name}: ${provider.wake.toLowerCase()}`);
    timers.current.push(
      setTimeout(() => {
        setState("online");
        pushRow(vm.project, "online", provider.name);
      }, 1600),
    );
  };

  return (
    <div ref={panel} id="topology" className={`grid grid-cols-[minmax(0,1fr)] ${stacked ? "" : "lg:grid-cols-[minmax(0,1fr)_31rem]"}`}>
      <div className={`relative ${narrow ? "" : "h-[26rem]"}`} style={narrow ? { aspectRatio: `${layout.w} / ${layout.h}` } : undefined}>
        {!narrow ? (
          <>
            <span className="absolute top-3 left-[14%] -translate-x-1/2 font-mono text-[11px] text-faint">{copy.diagram.devices}</span>
            <span className="absolute top-3 left-[50%] -translate-x-1/2 font-mono text-[11px] text-faint">{copy.diagram.bridge}</span>
            <span className="absolute top-3 left-[84%] -translate-x-1/2 font-mono text-[11px] text-faint">{copy.diagram.vms}</span>
          </>
        ) : null}
        <svg viewBox={`0 0 ${layout.w} ${layout.h}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
          <Wire d={wire(layout.devices.mac, layout.bridge, !narrow)} kind="active" packets={packets} />
          <Wire d={wire(layout.devices.phone, layout.bridge, !narrow)} kind="active" packets={packets} />
          {vms.map((vm) => (
            <Wire
              key={vm.id}
              d={wire(layout.bridge, layout.vms[vm.id], !narrow)}
              kind={vm.state === "online" ? "active" : vm.state}
              packets={packets}
            />
          ))}
        </svg>

        <At point={layout.devices.mac} layout={layout}>
          <Device name="MacBook" />
        </At>
        <At point={layout.devices.phone} layout={layout}>
          <Device name="iPhone" />
        </At>
        <At point={layout.bridge} layout={layout}>
          <div className="flex flex-col items-center gap-1.5">
            <Logo className="size-12" />
            <span className="font-mono text-[11px] text-faint">:3774</span>
          </div>
        </At>
        {vms.map((vm) => (
          <At key={vm.id} point={layout.vms[vm.id]} layout={layout}>
            <VmNode vm={vm} provider={providerOf(vm.providerId)} narrow={narrow} onToggle={() => toggle(vm.id)} />
          </At>
        ))}
      </div>

      <div className={stacked ? "border-t" : "border-t lg:border-t-0 lg:border-l"}>
        <Panel label="events" aside={copy.hero.hint}>
          <div aria-live="polite" className="p-6 font-mono text-[13px] leading-7 sm:px-10">
            {shown.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-4"
                style={row.animate ? { animation: "rise 200ms both" } : undefined}
              >
                <span className="whitespace-nowrap">{row.project}</span>
                <span className="whitespace-nowrap text-muted-foreground">{row.state}</span>
                <span className="min-w-0 text-faint">{row.detail}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
