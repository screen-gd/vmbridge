"use client";

import { copy } from "@/lib/copy";
import { rails } from "@/lib/styles";
import { useSiteState } from "./SiteState";
import { stateDot } from "./Topology";

const dots = {
  awake: stateDot.online,
  idle: stateDot.online,
  asleep: stateDot.asleep,
  waking: stateDot.waking,
} as const;

/** The fixed status bar at the bottom of the viewport, reporting the page's own sleep state. */
export function StatusLine() {
  const { phase, countdown } = useSiteState();
  const text = copy.status[phase].replace("{n}", String(countdown));
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-background">
      {/* A soft fade so scrolling content does not cut hard against the bar. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-full h-5 bg-gradient-to-t from-background to-transparent" />
      <div className={`${rails} flex h-8 items-center font-mono text-[12px]`}>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className={dots[phase]} />
          {text}
        </span>
        {phase === "awake" || phase === "idle" ? (
          <a href="#cli" className="ml-auto hidden text-faint transition-colors duration-150 hover:text-foreground sm:block">
            {copy.status.hint}
          </a>
        ) : null}
      </div>
    </div>
  );
}
