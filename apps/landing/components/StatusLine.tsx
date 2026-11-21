"use client";

import { copy } from "@/lib/copy";
import { frame } from "@/lib/styles";
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
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background">
      <div className={`${frame} flex h-8 items-center px-6 font-mono text-[12px] sm:px-8`}>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className={dots[phase]} />
          {text}
        </span>
        <span className="ml-auto hidden text-faint sm:block">{copy.status.hint}</span>
      </div>
    </div>
  );
}
