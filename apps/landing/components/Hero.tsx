import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github, install } from "@/lib/data";
import { primaryButton, secondaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { HeroTerminal } from "./HeroTerminal";
import { Panel } from "./Window";

/** The landing header: pitch and install command on the left, a terminal you can type in on the right. */
export function Hero() {
  return (
    <div className="flex items-center pt-10 pb-6 sm:pt-14 xl:min-h-[calc(100svh-3.5rem-2rem)] xl:py-0">
      <div className="grid w-full grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:items-center xl:gap-12">
        <div className="min-w-0">
          <h1 className="display" style={{ animation: "rise 500ms both" }}>
            {copy.hero.title}
          </h1>
          <p className="mt-6 max-w-[34rem] text-pretty text-[16px] text-muted-foreground sm:text-[18px]" style={{ animation: "rise 500ms 60ms both" }}>
            {copy.hero.body}
          </p>
          <div className="mt-6 sm:mt-10" style={{ animation: "rise 500ms 120ms both" }}>
            <Command text={install} className="lg:text-[12px] xl:text-[11px] 2xl:text-[12px]" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2" style={{ animation: "rise 500ms 180ms both" }}>
            <Link href="/docs" className={`${primaryButton} group`}>
              {copy.hero.docs}
              <HugeiconsIcon icon={ArrowRight01Icon} size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
            <a href={github} className={secondaryButton}>
              <HugeiconsIcon icon={GithubIcon} size={15} />
              {copy.nav.github}
            </a>
          </div>
        </div>
        <div className="min-w-0" style={{ animation: "rise 500ms 240ms both" }}>
          <Panel label="zsh" aside={<span>{copy.terminal.hint}</span>}>
            <HeroTerminal />
          </Panel>
        </div>
      </div>
    </div>
  );
}
