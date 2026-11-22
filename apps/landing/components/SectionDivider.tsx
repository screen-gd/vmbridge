"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "@/lib/hooks";

/**
 * A rail-to-rail hairline at a section's top edge that draws left to right the first
 * time it enters the viewport. The `.draw` hidden state only applies under `.js`,
 * so the line is already there without JavaScript.
 */
export function SectionDivider() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, "0px 0px -8% 0px");
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (inView) setSeen(true);
  }, [inView]);
  return <div ref={ref} aria-hidden className={`draw absolute inset-x-0 top-0 h-px bg-white/10 ${seen ? "draw-in" : ""}`} />;
}
