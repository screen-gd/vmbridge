"use client";

import Image from "next/image";
import { useState } from "react";
import { copy } from "@/lib/copy";
import { useMedia } from "@/lib/hooks";
import { Section } from "./Section";
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "./ui/tabs";

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

const isShotId = (value: unknown): value is ShotId => shots.some((shot) => shot.id === value);

const tabs = copy.dashboard.tabs;

/**
 * Dashboard screenshots behind Base UI tabs: a vertical list in the section's left
 * column at lg, a horizontal pill row below it. The active tab's caption rides under
 * its label at lg and under the pill row below lg. The tab root wraps the whole
 * section so the list in the left column and the panels in the right share state.
 * Every panel keeps the same desktop frame, so the section height never moves.
 * Phones get the phone shot when one exists, else a side-scrolling look at the
 * desktop shot.
 */
export function Screens() {
  const [active, setActive] = useState<ShotId>("canvas");
  const vertical = useMedia("(min-width: 1024px)");
  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (isShotId(value)) setActive(value);
      }}
      orientation={vertical ? "vertical" : "horizontal"}
    >
      <Section
        id="dashboard"
        title={copy.dashboard.title}
        body={copy.dashboard.body}
        splitAt="lg"
        side={
          <>
            <TabsList
              aria-label={copy.dashboard.title}
              className="max-w-full flex-row flex-wrap data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[orientation=vertical]:gap-0.5"
            >
              <TabsIndicator renderBeforeHydration />
              {shots.map((shot) => (
                <TabsTrigger
                  key={shot.id}
                  value={shot.id}
                  className="data-[orientation=vertical]:w-full data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-start data-[orientation=vertical]:px-4 data-[orientation=vertical]:py-2.5"
                >
                  <span>{tabs[shot.id].label}</span>
                  {/* Fixed three-line box: the section height must not move between tabs. */}
                  <span className="mt-1 hidden h-[4.75rem] text-left font-sans text-[15px] leading-relaxed font-normal whitespace-normal text-muted-foreground lg:group-data-active/tab:block">
                    {tabs[shot.id].caption}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="mt-4 min-h-[3.25rem] text-base leading-relaxed text-muted-foreground lg:hidden">{tabs[active].caption}</div>
          </>
        }
      >
        {shots.map((shot) => {
          const phone = phoneShots[shot.id];
          return (
            <TabsContent key={shot.id} value={shot.id} keepMounted>
              {/* sm and up: the desktop shot inside its card frame, capped so it fits one screen. */}
              <div className="mx-auto hidden w-full max-w-[min(100%,calc((100svh-12rem)*1.6))] rounded-xl bg-card p-1.5 sm:block">
                <div className="relative aspect-[16/10] overflow-hidden rounded-lg">
                  <Image
                    src={shot.src}
                    alt={tabs[shot.id].caption}
                    fill
                    sizes="(min-width: 1280px) 912px, 100vw"
                    className="object-contain"
                    priority={shot.id === "canvas"}
                  />
                </div>
              </div>
              {/* Below sm: one portrait box for every tab so the section height stays
                  fixed — the phone shot fills it, the desktop shot scrolls sideways. */}
              <div className="sm:hidden">
                <div className="mx-auto max-w-80 rounded-xl bg-card p-1.5">
                  {phone ? (
                    <div className="aspect-[780/1688] overflow-hidden rounded-lg">
                      <Image
                        src={phone}
                        alt={tabs[shot.id].caption}
                        width={780}
                        height={1688}
                        className="h-auto w-full"
                        priority={shot.id === "canvas"}
                      />
                    </div>
                  ) : (
                    <div className="aspect-[780/1688] overflow-x-auto rounded-lg">
                      <Image
                        src={shot.src}
                        alt={tabs[shot.id].caption}
                        width={2880}
                        height={1800}
                        className="h-full w-auto max-w-none"
                        priority={shot.id === "canvas"}
                      />
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
          );
        })}
      </Section>
    </Tabs>
  );
}
