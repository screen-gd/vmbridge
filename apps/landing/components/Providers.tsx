"use client";

import { useRef } from "react";
import { copy } from "@/lib/copy";
import { providers } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { Logo, ProviderLogo } from "./brand";
import { Section } from "./Section";
import { useSiteState } from "./SiteState";

/** Each provider's seat on the ring: its percent position and the spoke path back to the centre. */
const spots = providers.map((provider, i) => {
  const angle = ((-90 + i * (360 / providers.length)) * Math.PI) / 180;
  const x = Math.round((50 + 38 * Math.cos(angle)) * 100) / 100;
  const y = Math.round((50 + 38 * Math.sin(angle)) * 100) / 100;
  return { provider, x, y, spoke: `M50 50 L ${x} ${y}` };
});

/**
 * The eight providers on a ring around the bridge mark: the ring is the whole demo.
 * Title and body sit in the left column at xl; the ring fills the right and stays
 * visible, centred, at every width. Nodes are sized so neighbours never overlap.
 */
export function Providers() {
  const orbit = useRef<HTMLDivElement>(null);
  const inView = useInView(orbit);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const packets = inView && !reduced && phase !== "asleep";

  return (
    <Section id="providers" title={copy.providers.title} body={copy.providers.body}>
      <div ref={orbit} data-provider-ring className="relative mx-auto aspect-square w-full max-w-[19rem] sm:max-w-[24rem] xl:max-w-[30rem] xl:short:max-w-[26rem]">
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
          {spots.map((spot) => (
            <path
              key={spot.provider.id}
              d={spot.spoke}
              fill="none"
              stroke="rgb(255 255 255 / 0.16)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {packets
            ? spots.map((spot, i) => (
                <path
                  key={spot.provider.id}
                  d="M0 0h0.01"
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={7}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                >
                  <animateMotion dur="1.6s" begin={`-${(i * 1.6) / spots.length}s`} repeatCount="indefinite" path={spot.spoke} />
                </path>
              ))
            : null}
        </svg>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-background p-3">
          <Logo className="size-12 sm:size-14" />
        </div>
        {spots.map((spot) => (
          <div
            key={spot.provider.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-background"
            style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
          >
            <div className="flex flex-col items-center gap-1 p-1.5">
              <span className="bg-background transition-transform duration-150 hover:scale-[1.06]">
                <ProviderLogo provider={spot.provider} className="size-9 rounded-md ring-white/10 sm:size-11" />
              </span>
              <span className="text-[12px] font-medium sm:text-[13px]">{spot.provider.name}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
