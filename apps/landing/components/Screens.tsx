"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { Section } from "./Section";

const shots = [
  { id: "canvas", src: "/shots/desktop-canvas.png" },
  { id: "logs", src: "/shots/desktop-logs.png" },
  { id: "setup", src: "/shots/desktop-setup-provider.png" },
  { id: "devices", src: "/shots/desktop-devices.png" },
] as const;

type ShotId = (typeof shots)[number]["id"];

/** Dashboard screenshots behind four tabs, crossfading on switch. */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
  const tabs = copy.dashboard.tabs;
  return (
    <Section id="dashboard" title={copy.dashboard.title} body={copy.dashboard.body}>
      <div className="inline-flex gap-1 rounded-lg bg-card p-1" role="tablist">
        {shots.map((shot) => (
          <button
            key={shot.id}
            type="button"
            role="tab"
            aria-selected={shot.id === active}
            onClick={() => setActive(shot.id)}
            className={`h-8 rounded-md px-3 text-sm transition-colors duration-150 active:scale-[0.97] ${
              shot.id === active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tabs[shot.id].label}
          </button>
        ))}
      </div>
      <div className="relative mt-6 aspect-[16/10] overflow-hidden rounded-xl border bg-black">
        {shots.map((shot) => (
          <Image
            key={shot.id}
            src={shot.src}
            alt={tabs[shot.id].caption}
            fill
            sizes="(min-width: 1024px) 860px, 100vw"
            className={`object-cover object-top transition-opacity duration-200 ${shot.id === active ? "opacity-100" : "opacity-0"}`}
            priority={shot.id === "canvas"}
          />
        ))}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">{tabs[active].caption}</p>
    </Section>
  );
}
