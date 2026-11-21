"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";

/**
 * Fades children up once as they first enter the viewport (latched, so they never
 * slide back out). `delay` staggers siblings. Reduced motion renders them visible.
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
    <div
      ref={ref}
      className={`${className} transition-[opacity,transform] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
    >
      {children}
    </div>
  );
}
