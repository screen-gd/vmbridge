import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github, heroScript, install } from "@/lib/data";
import { primaryButton, secondaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { TerminalBody } from "./TerminalWindow";
import { Topology } from "./Topology";
import { Panel } from "./Window";

/** The landing header: pitch and install command on the left, a live terminal on the right, wiring below. */
export function Hero() {
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] border-b lg:grid-cols-12 lg:min-h-[30rem]">
        <div className="flex flex-col justify-center p-6 sm:p-10 lg:col-span-7 lg:py-16">
          <h1 className="display">{copy.hero.title}</h1>
          <p className="mt-5 max-w-[34rem] text-pretty text-[17px] text-muted-foreground">{copy.hero.body}</p>
          <div className="mt-8">
            <Command text={install} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/docs" className={primaryButton}>
              {copy.hero.docs}
              <HugeiconsIcon icon={ArrowRight01Icon} size={15} />
            </Link>
            <a href={github} className={secondaryButton}>
              <HugeiconsIcon icon={GithubIcon} size={15} />
              {copy.nav.github}
            </a>
          </div>
        </div>
        <div className="flex flex-col border-t bg-card lg:col-span-5 lg:border-t-0 lg:border-l">
          <Panel label="zsh" className="flex h-full flex-col">
            <TerminalBody script={heroScript} className="flex-1" />
          </Panel>
        </div>
      </div>
      <Topology />
    </>
  );
}
