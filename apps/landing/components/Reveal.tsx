"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";

/**
 * Fades children up once as they first enter the viewport (latched, so they never
 * slide back out). `delay` staggers siblings. The `reveal`/`reveal-in` CSS classes do
 * the work so server-rendered content is visible without JS: the inline head script
 * adds `js` to <html>, and only under `.js` do un-revealed blocks start hidden.
 * Reduced motion renders them visible.
 */
export function Reveal({ delay = 0, className = "", children }: { delay?: number; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, "0px 0px -10% 0px");
  const reduced = useReducedMotion();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (inView) setSeen(true);
  }, [inView]);
  const shown = reduced || seen;
  return (
    <div ref={ref} className={`${className} reveal ${shown ? "reveal-in" : ""}`} style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}>
      {children}
    </div>
  );
}
