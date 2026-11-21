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
    <div className="flex items-center lg:min-h-[calc(100svh-3.5rem-2rem)]">
      <div className="grid w-full grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-12 lg:items-center">
        <div className="lg:col-span-7">
          <h1 className="display" style={{ animation: "rise 500ms both" }}>
            {copy.hero.title}
          </h1>
          <p className="mt-6 max-w-[34rem] text-pretty text-[18px] text-muted-foreground" style={{ animation: "rise 500ms 60ms both" }}>
            {copy.hero.body}
          </p>
          <div className="mt-10" style={{ animation: "rise 500ms 120ms both" }}>
            <Command text={install} className="lg:text-[12px]" />
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
        <div className="lg:col-span-5" style={{ animation: "rise 500ms 240ms both" }}>
          <Panel label="zsh" aside={<span>{copy.terminal.hint}</span>}>
            <HeroTerminal />
          </Panel>
        </div>
      </div>
    </div>
  );
}
