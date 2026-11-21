"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
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

/** Dashboard screenshots behind a row of pill tabs; the selected tab's caption sits under the pills. */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
  return (
    <Section id="dashboard" title={copy.dashboard.title} body={copy.dashboard.body}>
      <div role="tablist" className="flex flex-wrap gap-2">
        {shots.map((shot) => {
          const current = shot.id === active;
          return (
            <button
              key={shot.id}
              type="button"
              role="tab"
              aria-selected={current}
              onClick={() => setActive(shot.id)}
              className={`rounded-md px-3 py-1.5 font-mono text-[13px] transition-colors duration-150 ${
                current ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tabs[shot.id].label}
            </button>
          );
        })}
      </div>
      <div className="mt-4 min-h-[3.25rem] max-w-[38rem] text-base leading-relaxed text-muted-foreground">{tabs[active].caption}</div>
      <Panel className="mt-6" label="localhost:3774/dashboard">
        <div className="relative m-5 aspect-[16/10] sm:m-6">
          {shots.map((shot) => (
            <Image
              key={shot.id}
              src={shot.src}
              alt={tabs[shot.id].caption}
              fill
              sizes="(min-width: 1200px) 1072px, 100vw"
              className={`object-contain transition-opacity duration-200 ${shot.id === active ? "opacity-100" : "opacity-0"}`}
              priority={shot.id === "canvas"}
            />
          ))}
        </div>
      </Panel>
    </Section>
  );
}
