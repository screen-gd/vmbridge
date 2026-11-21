"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { bridgeLatency, routes, vmLatency } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { Section } from "./Section";
import { Topology } from "./Topology";

/** The calls each latency figure answers for: bridge-side or VM-side RPC names. */
const callsOf = (kind: "bridge" | "vm") => routes.filter((route) => route.kind === kind).map((route) => route.call);

/** A latency figure that counts its numbers up from zero the first time it enters view. */
function CountUp({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref);
  const reduced = useReducedMotion();
  const [go, setGo] = useState(false);
  const [progress, setProgress] = useState(0);

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

  const shown = reduced || progress >= 1 ? text : text.replace(/\d+/g, (n) => String(Math.round(Number(n) * progress)));
  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {shown}
    </span>
  );
}

/** The wiring diagram on top, then the two latency figures with the calls they answer. */
export function Routing() {
  return (
    <Section
      id="routing"
      title={copy.routing.title}
      body={copy.routing.body}
      aside={<span className="font-mono text-[13px] text-muted-foreground">{copy.hero.hint}</span>}
    >
      <Topology log={false} />
      <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <div className="font-mono text-[2.75rem] leading-none tracking-tight">
            <CountUp text={bridgeLatency} />
          </div>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">{copy.routing.notes.bridge}</p>
          <div className="mt-5 font-mono text-[13px] leading-7 text-muted-foreground">
            {callsOf("bridge").map((call) => (
              <div key={call}>{call}</div>
            ))}
          </div>
        </div>
        <div>
          <div className="font-mono text-[2.75rem] leading-none tracking-tight text-primary">
            <CountUp text={vmLatency} />
          </div>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">{copy.routing.notes.vm}</p>
          <div className="mt-5 font-mono text-[13px] leading-7 text-muted-foreground">
            {callsOf("vm").map((call) => (
              <div key={call}>{call}</div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
