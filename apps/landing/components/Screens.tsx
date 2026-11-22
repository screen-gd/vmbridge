"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { PillTabs } from "./PillTabs";
import { Section } from "./Section";

const shots = [
  { id: "canvas", src: "/shots/desktop-canvas.png" },
  { id: "logs", src: "/shots/desktop-logs.png" },
  { id: "setup", src: "/shots/desktop-setup-provider.png" },
  { id: "devices", src: "/shots/desktop-devices.png" },
] as const;

const phoneShots: Partial<Record<ShotId, string>> = {
  canvas: "/shots/phone-canvas.png",
  logs: "/shots/phone-logs.png",
};

type ShotId = (typeof shots)[number]["id"];

const tabs = copy.dashboard.tabs;

const pillItems = shots.map((shot) => ({
  id: shot.id as string,
  label: tabs[shot.id].label,
  detail: <span className="text-[15px] leading-relaxed font-normal text-muted-foreground">{tabs[shot.id].caption}</span>,
}));

/**
 * Dashboard screenshots behind tabs: a vertical list in the section's left column at lg,
 * a horizontal pill row below it. The active tab's caption rides under its label at lg
 * and under the pill row below lg. Phones get the phone shot when one exists, else a
 * side-scrolling look at the desktop shot.
 */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
  const phone = phoneShots[active];
  const desktop = shots.find((shot) => shot.id === active) ?? shots[0];
  return (
    <Section
      id="dashboard"
      title={copy.dashboard.title}
      body={copy.dashboard.body}
      splitAt="lg"
      side={
        <>
          <PillTabs
            label={copy.dashboard.title}
            orientation="vertical"
            verticalAt="lg"
            wrap
            items={pillItems}
            active={active}
            onChange={(id) => setActive(id as ShotId)}
          />
          <div className="mt-4 min-h-[3.25rem] text-base leading-relaxed text-muted-foreground lg:hidden">{tabs[active].caption}</div>
        </>
      }
    >
      {/* sm and up: the desktop shot inside its card frame, capped so it fits one screen. */}
      <div className="mx-auto hidden w-full max-w-[min(100%,calc((100svh-12rem)*1.6))] rounded-xl bg-card p-1.5 sm:block">
        <div className="relative aspect-[16/10] overflow-hidden rounded-lg">
          {shots.map((shot) => (
            <Image
              key={shot.id}
              src={shot.src}
              alt={tabs[shot.id].caption}
              fill
              sizes="(min-width: 1280px) 912px, 100vw"
              className={`object-contain transition-[opacity,transform] duration-200 ${
                shot.id === active ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
              }`}
              priority={shot.id === "canvas"}
            />
          ))}
        </div>
      </div>
      {/* Below sm: the phone shot if this tab has one, else the desktop shot scrolled at 2x. */}
      <div className="sm:hidden">
        {phone ? (
          <div className="mx-auto max-w-80 rounded-xl bg-card p-1.5">
            <div className="overflow-hidden rounded-lg">
              <Image src={phone} alt={tabs[active].caption} width={780} height={1688} className="h-auto w-full" priority={active === "canvas"} />
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-card p-1.5">
            <div className="w-[200%] overflow-hidden rounded-lg">
              <Image src={desktop.src} alt={tabs[active].caption} width={2880} height={1800} className="h-auto w-full max-w-none" priority={active === "canvas"} />
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
