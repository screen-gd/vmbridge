"use client";

import { useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { providers } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { cell } from "@/lib/styles";
import { Logo, ProviderLogo } from "./brand";
import { Section } from "./Section";

/** Each provider's seat on the ring: its percent position and the spoke path back to the centre. */
const spots = providers.map((provider, i) => {
  const angle = ((-90 + i * 72) * Math.PI) / 180;
  const x = Math.round((50 + 38 * Math.cos(angle)) * 100) / 100;
  const y = Math.round((50 + 38 * Math.sin(angle)) * 100) / 100;
  return { provider, x, y, spoke: `M50 50 L ${x} ${y}` };
});

/** One label/value line inside the provider detail column. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-t px-5 py-3.5 sm:px-7">
      <dt className="text-sm text-faint">{label}</dt>
      <dd className="text-right font-mono text-[13px] text-foreground">{value}</dd>
    </div>
  );
}

/** The five providers on a ring around the bridge mark; picking one fills the detail column. */
export function Providers() {
  const [selected, setSelected] = useState(0);
  const orbit = useRef<HTMLDivElement>(null);
  const inView = useInView(orbit);
  const reduced = useReducedMotion();
  const packets = inView && !reduced;
  const p = providers[selected];
  const measured = p.measured;
  const wake = measured
    ? measured.wakeSeconds[0] === measured.wakeSeconds[1]
      ? `${measured.wakeSeconds[0]} s`
      : `${measured.wakeSeconds[0]} to ${measured.wakeSeconds[1]} s`
    : null;
  const missing = <span className="text-faint">{copy.providers.unmeasured}</span>;

  return (
    <Section id="providers" title={copy.providers.title} body={copy.providers.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12">
        <div className={`${cell} lg:col-span-7`}>
          <div ref={orbit} className="relative mx-auto aspect-square w-full max-w-[26rem]">
            <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden>
              <circle
                cx={50}
                cy={50}
                r={38}
                fill="none"
                stroke="rgb(255 255 255 / 0.22)"
                strokeDasharray="0.6 1.6"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {spots.map((spot, i) => (
                <path
                  key={spot.provider.id}
                  d={spot.spoke}
                  fill="none"
                  stroke={i === selected ? "var(--primary)" : "rgb(255 255 255 / 0.16)"}
                  strokeOpacity={i === selected ? 0.7 : 1}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {packets ? (
                <path
                  key={spots[selected].provider.id}
                  d="M0 0h0.01"
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={7}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                >
                  <animateMotion dur="1.6s" repeatCount="indefinite" path={spots[selected].spoke} />
                </path>
              ) : null}
            </svg>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-background p-3">
              <Logo className="size-16 sm:size-20" />
            </div>
            {spots.map((spot, i) => {
              const current = i === selected;
              return (
                <div
                  key={spot.provider.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-background"
                  style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
                >
                  <button
                    type="button"
                    aria-pressed={current}
                    onClick={() => setSelected(i)}
                    className={`flex flex-col items-center gap-2 p-2 transition-opacity duration-150 ${
                      current ? "opacity-100" : "opacity-60 hover:opacity-100"
                    }`}
                  >
                    <span className="bg-background">
                      <ProviderLogo
                        provider={spot.provider}
                        className={`size-12 rounded-md sm:size-14 ${current ? "ring-primary" : "ring-white/10"}`}
                      />
                    </span>
                    <span className="text-xs font-medium">{spot.provider.name}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col border-t lg:col-span-5 lg:border-t-0 lg:border-l">
          <div key={p.id} className="flex flex-1 flex-col" style={{ animation: "rise 200ms both" }}>
            <div className={`${cell} flex items-center gap-3`}>
              <ProviderLogo provider={p} className="size-9 rounded-md ring-white/10" />
              <span className="text-lg font-medium">{p.name}</span>
            </div>
            <dl>
              <Row label={copy.providers.columns.sleep} value={p.sleep} />
              <Row label={copy.providers.columns.ready} value={measured ? measured.ready : missing} />
              <Row label={copy.providers.columns.wake} value={wake ?? missing} />
              <Row label={copy.providers.columns.latency} value={measured ? `${measured.browseMs} ms` : missing} />
            </dl>
            <div className="mt-auto border-t px-5 py-4 text-[13px] text-faint sm:px-7">{copy.providers.note}</div>
          </div>
        </div>
      </div>
    </Section>
  );
}
