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
  const angle = ((-90 + i * (360 / providers.length)) * Math.PI) / 180;
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

/**
 * The providers on a ring around the bridge mark, with the wake race beside it as the provider
 * list. At xl the ring fills the section's left column; below xl it hides entirely, since the
 * lanes already carry every logo and name.
 */
export function Providers() {
  const orbit = useRef<HTMLDivElement>(null);
  const inView = useInView(orbit);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const packets = inView && !reduced && phase !== "asleep";
  const [raced, setRaced] = useState(false);
  const [running, setRunning] = useState(false);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number[]>(() => providers.map(() => 0));
  const raf = useRef(0);
  const racing = useRef(false);

  /** Start the wake race; ignored while a race is already running. Fired by the button or `vmbridge:race`. */
  const start = useCallback(() => {
    if (racing.current) return;
    racing.current = true;
    setRunning(true);
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
      setRunning(false);
      return;
    }
    const tick = (now: number) => {
      const t = ((now - startAt) / 1000) * speed;
      const done = lanes.every((s) => s === null || t >= s);
      setElapsed(lanes.map((s) => (s === null ? 0 : Math.min(t, s))));
      if (done) {
        racing.current = false;
        setRunning(false);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [startAt, reduced]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const ring = (
    // Smaller still on short screens, so the left column fits one screen at 1280x650;
    // node boxes shrink in step so neighbours on the ring never touch.
    <div ref={orbit} data-provider-ring className="relative mx-auto hidden aspect-square w-full max-w-[22rem] xl:block xl:short:max-w-[19rem]">
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
        <Logo className="size-14" />
      </div>
      {spots.map((spot) => (
        <div
          key={spot.provider.id}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-background"
          style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
        >
          <div className="flex flex-col items-center gap-1 p-1.5">
            <span className="bg-background transition-transform duration-150 hover:scale-[1.06]">
              <ProviderLogo provider={spot.provider} className="size-11 rounded-md ring-white/10 xl:short:size-10" />
            </span>
            <span className="text-[13px] font-medium">{spot.provider.name}</span>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Section id="providers" title={copy.providers.title} body={copy.providers.body} splitAt="lg" side={ring} sideClassName="hidden xl:block">
      <div>
        <div className="flex items-center justify-end gap-3 font-mono text-[13px] text-faint">
          {speed > 1 ? <span>{copy.providers.race.speed}</span> : null}
          <button
            type="button"
            onClick={start}
            disabled={running}
            data-race-button
            className="inline-flex h-8 items-center rounded-md bg-muted px-3 font-mono text-[13px] text-foreground transition-[color,background-color,transform] duration-150 hover:bg-white/10 active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-muted disabled:active:scale-100"
          >
            {raced && !running ? copy.providers.race.again : copy.providers.race.start}
          </button>
        </div>
        <div className="mt-4 lg:short:mt-3 xl:short:mt-3">
          {providers.map((p, i) => {
            const seconds = lanes[i];
            const t = seconds === null ? 0 : Math.min(elapsed[i], seconds);
            const fill = seconds === null ? 0 : Math.min(1, t / seconds);
            const finished = raced && seconds !== null && elapsed[i] >= seconds;
            return (
              <div key={p.id} className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 py-2 sm:flex-nowrap lg:short:min-h-10 lg:short:py-1 xl:short:py-1">
                <ProviderLogo provider={p} className="size-7 shrink-0 rounded-md ring-white/10" />
                <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
                  <div className="text-[15px] font-medium">{p.name}</div>
                  <div className="text-[13px] leading-snug text-muted-foreground">{p.sleep}</div>
                </div>
                <span
                  className={`shrink-0 text-right font-mono text-[13px] tabular-nums transition-colors duration-300 sm:w-28 ${
                    finished && i === winner ? "text-foreground" : "text-muted-foreground"
                  }`}
                  style={finished ? { animation: "finish-flash 300ms ease-out" } : undefined}
                >
                  {seconds === null ? <span className="text-faint">{copy.providers.unmeasured}</span> : raced ? `${t.toFixed(1)} s` : staticTimes[i]}
                </span>
                <span className="relative h-1 min-w-0 basis-full rounded-full bg-white/8 sm:basis-auto sm:flex-1">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${fill * 100}%` }} />
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-6 text-[13px] text-muted-foreground lg:short:mt-4 xl:short:mt-4">{copy.providers.note}</div>
      </div>
    </Section>
  );
}
