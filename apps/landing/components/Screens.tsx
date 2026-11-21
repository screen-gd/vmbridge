"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { cell } from "@/lib/styles";
import { Section } from "./Section";
import { Panel } from "./Window";

const shots = [
  { id: "canvas", src: "/shots/desktop-canvas.png" },
  { id: "logs", src: "/shots/desktop-logs.png" },
  { id: "setup", src: "/shots/desktop-setup-provider.png" },
  { id: "devices", src: "/shots/desktop-devices.png" },
] as const;

type ShotId = (typeof shots)[number]["id"];

const tabs = copy.dashboard.tabs;

/** Dashboard screenshots behind a column of tabs; on phones the tabs fold into a row above the shot. */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
  return (
    <Section id="dashboard" title={copy.dashboard.title} body={copy.dashboard.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12">
        <div role="tablist" className="hidden lg:col-span-4 lg:flex lg:flex-col">
          {shots.map((shot) => {
            const current = shot.id === active;
            return (
              <button
                key={shot.id}
                type="button"
                role="tab"
                aria-selected={current}
                onClick={() => setActive(shot.id)}
                className={`flex-1 border-b px-5 py-4 text-left transition-colors duration-150 last:border-b-0 sm:px-7 ${
                  current ? "bg-card" : ""
                }`}
              >
                <span className="block font-mono text-[13px]">
                  {current ? <span className="text-primary">{"> "}</span> : null}
                  <span className={current ? "text-foreground" : "text-muted-foreground"}>{tabs[shot.id].label}</span>
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">{tabs[shot.id].caption}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t lg:col-span-8 lg:border-t-0 lg:border-l">
          <div role="tablist" className="flex overflow-x-auto border-b [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden">
            {shots.map((shot) => {
              const current = shot.id === active;
              return (
                <button
                  key={shot.id}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  onClick={() => setActive(shot.id)}
                  className="shrink-0 px-4 py-3 font-mono text-[13px] whitespace-nowrap"
                >
                  {current ? <span className="text-primary">{"> "}</span> : null}
                  <span className={current ? "text-foreground" : "text-muted-foreground"}>{tabs[shot.id].label}</span>
                </button>
              );
            })}
          </div>
          <Panel label="localhost:3774/dashboard">
            <div className="relative aspect-[16/10]">
              {shots.map((shot) => (
                <Image
                  key={shot.id}
                  src={shot.src}
                  alt={tabs[shot.id].caption}
                  fill
                  sizes="(min-width: 1560px) 1020px, (min-width: 1024px) 67vw, 100vw"
                  className={`object-contain transition-opacity duration-200 ${shot.id === active ? "opacity-100" : "opacity-0"}`}
                  priority={shot.id === "canvas"}
                />
              ))}
            </div>
          </Panel>
          <div className={`${cell} border-t text-sm text-muted-foreground lg:hidden`}>{tabs[active].caption}</div>
        </div>
      </div>
    </Section>
  );
}
