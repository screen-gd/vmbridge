"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { bridgeLatency, routes, vmLatency } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { Section } from "./Section";

/** The calls each latency figure answers for: bridge-side or VM-side RPC names. */
const callsOf = (kind: "bridge" | "vm") => routes.filter((route) => route.kind === kind).map((route) => route.call);

/** A latency figure that counts its numbers up from zero the first time it enters view. */
function CountUp({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref);
  const reduced = useReducedMotion();
  const [go, setGo] = useState(false);
  // `null` shows the final text until the count starts, so the figure is correct without JS.
  const [progress, setProgress] = useState<number | null>(null);

  // `go` latches, so the count always finishes even if the figure scrolls back out of view.
  useEffect(() => {
    if (inView && !reduced) setGo(true);
  }, [inView, reduced]);

  useEffect(() => {
    if (!go) return;
    const from = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - from) / 600);
      setProgress(1 - Math.pow(1 - t, 3));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [go]);

  const shown =
    progress === null || progress >= 1 || reduced ? text : text.replace(/\d+/g, (n) => String(Math.round(Number(n) * progress)));
  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {shown}
    </span>
  );
}

/** The two latency figures as card panels on the right, title and body on the left. */
export function Routing() {
  return (
    <Section id="routing" title={copy.routing.title} body={copy.routing.body}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg bg-card p-6 sm:p-8">
          {/* 3rem is the largest size that keeps "156 to 320 ms" on one line inside
              a half-width panel at the standard desktop viewports. */}
          <div className="font-mono text-[3rem] leading-none tracking-tight">
            <CountUp text={bridgeLatency} />
          </div>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">{copy.routing.notes.bridge}</p>
          <div className="mt-3 font-mono text-[13px] leading-6 text-faint">
            {callsOf("bridge").map((call) => (
              <div key={call}>{call}</div>
            ))}
          </div>
        </div>
        <div className="rounded-lg bg-card p-6 sm:p-8">
          <div className="font-mono text-[3rem] leading-none tracking-tight text-primary">
            <CountUp text={vmLatency} />
          </div>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">{copy.routing.notes.vm}</p>
          <div className="mt-3 font-mono text-[13px] leading-6 text-faint">
            {callsOf("vm").map((call) => (
              <div key={call}>{call}</div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
