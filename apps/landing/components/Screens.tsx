"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { Section } from "./Section";
import { Phone, Window } from "./Window";

const shots = [
  { id: "canvas", src: "/shots/desktop-canvas.png" },
  { id: "logs", src: "/shots/desktop-logs.png" },
  { id: "setup", src: "/shots/desktop-setup-provider.png" },
  { id: "devices", src: "/shots/desktop-devices.png" },
] as const;

type ShotId = (typeof shots)[number]["id"];

const tabs = copy.dashboard.tabs;

/** Dashboard screenshots behind four tabs, in a browser window with a phone overlapping it. */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
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
      <div className="relative mt-6">
        <Window title="localhost:3774/dashboard">
          <div className="relative aspect-[16/10]">
            {shots.map((shot) => (
              <Image
                key={shot.id}
                src={shot.src}
                alt={tabs[shot.id].caption}
                fill
                sizes="(min-width: 1024px) 1056px, 100vw"
                className={`object-cover object-top transition-opacity duration-200 ${shot.id === active ? "opacity-100" : "opacity-0"}`}
                priority={shot.id === "canvas"}
              />
            ))}
          </div>
        </Window>
        <div className="absolute -bottom-8 right-10 hidden w-[160px] lg:block">
          <Phone src="/shots/phone-canvas.png" alt="" />
          <div className={`absolute inset-0 transition-opacity duration-200 ${active === "logs" ? "opacity-100" : "opacity-0"}`}>
            <Phone src="/shots/phone-logs.png" alt="" />
          </div>
        </div>
      </div>
      <p className="mt-12 text-sm text-muted-foreground lg:mt-14">{tabs[active].caption}</p>
    </Section>
  );
}
