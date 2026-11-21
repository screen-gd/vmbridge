"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { providers } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { Logo, ProviderLogo } from "./brand";
import { Section } from "./Section";
import { useSiteState } from "./SiteState";

const RACE_EVENT = "vmbridge:race";

/** The wake time each race lane runs, from the first measured value; null for unmeasured providers. */
const lanes = providers.map((p) => (p.measured ? p.measured.wakeSeconds[0] : null));

/** The winner's lane index: the fastest measured wake time. */
const winner = lanes.reduce<number>(
  (best, seconds, i) => (seconds !== null && seconds < (lanes[best] ?? Infinity) ? i : best),
  -1,
);

/** The race runs at 2x when the slowest lane would take over ten real seconds. */
const speed = Math.max(...lanes.map((s) => s ?? 0)) > 10 ? 2 : 1;

/** Each provider's seat on the ring: its percent position and the spoke path back to the centre. */
const spots = providers.map((provider, i) => {
  const angle = ((-90 + i * 72) * Math.PI) / 180;
  const x = Math.round((50 + 38 * Math.cos(angle)) * 100) / 100;
  const y = Math.round((50 + 38 * Math.sin(angle)) * 100) / 100;
  return { provider, x, y, spoke: `M50 50 L ${x} ${y}` };
});

/** One static wake-time string per provider, the range or "Not measured". */
const staticTimes = providers.map((p) =>
  p.measured
    ? p.measured.wakeSeconds[0] === p.measured.wakeSeconds[1]
      ? `${p.measured.wakeSeconds[0]} s`
      : `${p.measured.wakeSeconds[0]} to ${p.measured.wakeSeconds[1]} s`
    : null,
);

/** The five providers on a ring around the bridge mark, with the wake race beside it as the provider list. */
export function Providers() {
  const orbit = useRef<HTMLDivElement>(null);
  const inView = useInView(orbit);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const packets = inView && !reduced && phase !== "asleep";
  const [raced, setRaced] = useState(false);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number[]>(() => providers.map(() => 0));
  const raf = useRef(0);
  const racing = useRef(false);

  /** Start the wake race; ignored while a race is already running. Fired by the button or `vmbridge:race`. */
  const start = useCallback(() => {
    if (racing.current) return;
    racing.current = true;
    setElapsed(providers.map(() => 0));
    setRaced(true);
    setStartAt(performance.now());
  }, []);

  useEffect(() => {
    window.addEventListener(RACE_EVENT, start);
    return () => window.removeEventListener(RACE_EVENT, start);
  }, [start]);

  useEffect(() => {
    if (startAt === null) return;
    if (reduced) {
      setElapsed(lanes.map((s) => s ?? 0));
      racing.current = false;
      return;
    }
    const tick = (now: number) => {
      const t = ((now - startAt) / 1000) * speed;
      const done = lanes.every((s) => s === null || t >= s);
      setElapsed(lanes.map((s) => (s === null ? 0 : Math.min(t, s))));
      if (done) {
        racing.current = false;
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [startAt, reduced]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <Section id="providers" title={copy.providers.title} body={copy.providers.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-12 lg:items-center lg:gap-16">
        <div className="lg:col-span-5">
          <div ref={orbit} className="relative mx-auto aspect-square w-full max-w-[30rem]">
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
              <Logo className="size-16 sm:size-20" />
            </div>
            {spots.map((spot) => (
              <div
                key={spot.provider.id}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-background"
                style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
              >
                <div className="flex flex-col items-center gap-2 p-2">
                  <span className="bg-background">
                    <ProviderLogo provider={spot.provider} className="size-12 rounded-md ring-white/10 sm:size-14" />
                  </span>
                  <span className="text-[13px] font-medium">{spot.provider.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-7">
          <div className="flex h-8 items-center justify-between font-mono text-[13px] text-faint">
            <span>{copy.providers.race.label}</span>
            <span className="flex items-center gap-3">
              {speed > 1 ? <span>{copy.providers.race.speed}</span> : null}
              <button
                type="button"
                onClick={start}
                className="inline-flex h-7 items-center rounded-md bg-muted px-2.5 font-mono text-[13px] text-foreground transition-colors duration-150 hover:bg-white/10"
              >
                {raced ? copy.providers.race.again : copy.providers.race.start}
              </button>
            </span>
          </div>
          {providers.map((p, i) => {
            const seconds = lanes[i];
            const t = seconds === null ? 0 : Math.min(elapsed[i], seconds);
            const fill = seconds === null ? 0 : Math.min(1, t / seconds);
            return (
              <div key={p.id} className="flex items-center gap-4 py-3.5">
                <ProviderLogo provider={p} className="size-7 shrink-0 rounded-md ring-white/10" />
                <div className="w-32 shrink-0 sm:w-44">
                  <div className="text-[15px] font-medium">{p.name}</div>
                  <div className="text-[13px] leading-snug text-muted-foreground">{p.sleep}</div>
                </div>
                <span className="relative h-px min-w-0 flex-1 bg-white/10">
                  <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${fill * 100}%` }} />
                </span>
                <span
                  className={`w-28 shrink-0 text-right font-mono text-[13px] tabular-nums ${
                    raced && seconds !== null && elapsed[i] >= seconds && i === winner ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {seconds === null ? <span className="text-faint">{copy.providers.unmeasured}</span> : raced ? `${t.toFixed(1)} s` : staticTimes[i]}
                </span>
              </div>
            );
          })}
          <div className="mt-6 text-[13px] text-muted-foreground">{copy.providers.note}</div>
        </div>
      </div>
    </Section>
  );
}
