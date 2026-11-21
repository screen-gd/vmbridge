"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { PillTabs } from "./PillTabs";
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

const pillItems = shots.map((shot) => ({ id: shot.id as string, label: tabs[shot.id].label }));

/** Dashboard screenshots behind pill tabs in the section header; the selected tab's caption sits above the shot. */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
  return (
    <Section id="dashboard" title={copy.dashboard.title} body={copy.dashboard.body} aside={<PillTabs label={copy.dashboard.title} items={pillItems} active={active} onChange={(id) => setActive(id as ShotId)} />}>
      <div className="min-h-[3.25rem] max-w-[38rem] text-base leading-relaxed text-muted-foreground">{tabs[active].caption}</div>
      <Panel className="mx-auto mt-6 w-full max-w-[1400px]" label="localhost:3774/dashboard">
        <div className="relative m-5 aspect-[16/10] sm:m-6">
          {shots.map((shot) => (
            <Image
              key={shot.id}
              src={shot.src}
              alt={tabs[shot.id].caption}
              fill
              sizes="(min-width: 1400px) 1344px, 100vw"
              className={`object-contain transition-[opacity,transform] duration-200 ${
                shot.id === active ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
              }`}
              priority={shot.id === "canvas"}
            />
          ))}
        </div>
      </Panel>
    </Section>
  );
}
