"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { stepLogs } from "@/lib/data";
import { Section } from "./Section";
import { TerminalWindow } from "./TerminalWindow";
import { Window } from "./Window";

const tabs = copy.dashboard.tabs;

/** One dashboard screenshot inside a window, shown whole since the area matches the image ratio. */
function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <Window title="localhost:3774/dashboard" className="h-full">
      <div className="relative aspect-[16/10]">
        <Image src={src} alt={alt} fill sizes="(min-width: 1024px) 60vw, 100vw" className="object-contain" />
      </div>
    </Window>
  );
}

const visuals = [
  <TerminalWindow key="run" script={stepLogs[0]} className="h-full" />,
  <Shot key="provider" src="/shots/desktop-setup-provider.png" alt={tabs.setup.caption} />,
  <Shot key="devices" src="/shots/desktop-devices.png" alt={tabs.devices.caption} />,
  <TerminalWindow key="project" script={stepLogs[3]} className="h-full" />,
];

/** The four setup steps: a clickable list on the left, the matching screen or terminal on the right. */
export function Steps() {
  const [selected, setSelected] = useState(0);
  return (
    <Section id="how" title={copy.steps.title} body={copy.steps.body}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] lg:items-start">
        <div className="grid gap-1">
          {copy.steps.items.map((step, i) => {
            const current = i === selected;
            return (
              <button
                key={step.title}
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => setSelected(i)}
                className={`w-full rounded-xl px-4 py-4 text-left transition-colors duration-150 active:scale-[0.99] ${
                  current ? "bg-card" : "hover:bg-white/[0.03]"
                }`}
              >
                <span className="flex gap-4">
                  <span className={`font-mono text-sm ${current ? "text-primary" : "text-faint"}`}>{String(i + 1).padStart(2, "0")}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{step.title}</span>
                    <span
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                        current ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                      }`}
                    >
                      <span className="overflow-hidden">
                        <span className="mt-2 block text-pretty text-sm text-muted-foreground">{step.body}</span>
                      </span>
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative">
          <div aria-hidden className="invisible">
            <Window title="localhost:3774/dashboard">
              <div className="aspect-[16/10]" />
            </Window>
          </div>
          <div key={selected} className="absolute inset-0" style={{ animation: "rise 200ms both" }}>
            {visuals[selected]}
          </div>
        </div>
      </div>
    </Section>
  );
}
