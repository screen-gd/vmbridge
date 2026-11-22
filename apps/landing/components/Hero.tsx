import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github, install } from "@/lib/data";
import { innerPad, primaryButton, secondaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { Topology } from "./Topology";

/**
 * The landing header as one centred column — title, body, install command and
 * buttons — above a full-width stage holding the flat wiring diagram (devices
 * to VM Bridge to cloud VMs). The diagram is plain server-rendered markup that
 * fills every pixel left over so the hint row lands on the fold, so nothing
 * moves while the page loads and it reads identically with JavaScript off.
 * The VM cards themselves are the sleep/wake controls.
 */
export function Hero() {
  return (
    <div className="flex min-h-[calc(100svh-3.5rem-2rem)] flex-col">
      <div className={`${innerPad} pt-12 text-center xl:pt-10`}>
        {/* Sized to hold the ~43-character title on one line from xl up; the max
            width below xl balances it into two or three lines. */}
        <h1
          className="mx-auto max-w-[28rem] text-[clamp(2.4rem,3.4vw,3.6rem)] leading-[1.04] font-medium tracking-[-0.035em] text-balance xl:max-w-none"
          style={{ animation: "rise 500ms both" }}
        >
          {copy.hero.title}
        </h1>
        <p
          className="mx-auto mt-4 max-w-[44rem] text-pretty text-[16px] text-muted-foreground sm:text-[18px]"
          style={{ animation: "rise 500ms 60ms both" }}
        >
          {copy.hero.body}
        </p>
        <div className="mt-7 flex flex-col items-center" style={{ animation: "rise 500ms 120ms both" }}>
          <div className="mx-auto w-full max-w-[46rem]">
            <Command text={install} className="text-left lg:text-[12px] xl:text-[11px] 2xl:text-[12px]" />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Link href="/docs" className={`${primaryButton} group`}>
              {copy.hero.docs}
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={15}
                className="transition-transform duration-150 group-hover:translate-x-0.5"
              />
            </Link>
            <a href={github} className={secondaryButton}>
              <HugeiconsIcon icon={GithubIcon} size={15} />
              {copy.nav.github}
            </a>
          </div>
        </div>
      </div>
      {/* The stage runs rail to rail: the diagram fills its width up to a 72rem
          cap and every pixel of height left over so the hint lands on the fold. */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-[280px] md:flex md:flex-1">
          <Topology hero log={false} />
        </div>
        <div className="flex justify-center px-6 py-4">
          <span className="text-[13px] whitespace-nowrap text-faint">{copy.hero.hint}</span>
        </div>
      </div>
    </div>
  );
}
