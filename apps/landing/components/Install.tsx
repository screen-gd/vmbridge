import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github, install } from "@/lib/data";
import { primaryButton, secondaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { Reveal } from "./Reveal";

/** The closing install block: heading on the left, the command and buttons beside it at lg. */
export function Install() {
  return (
    <section id="install" className="scroll-mt-14 py-20 sm:py-28">
      <Reveal>
        <div className="lg:flex lg:items-end lg:justify-between lg:gap-10">
          <div className="min-w-0">
            <h2 className="title">{copy.install.title}</h2>
            <p className="mt-4 max-w-[40rem] text-pretty text-[17px] text-muted-foreground">{copy.install.body}</p>
          </div>
          <div className="mt-6 flex shrink-0 flex-wrap items-center gap-2 lg:mt-0">
            <Command text={install} />
            <Link href="/docs" className={`${primaryButton} group`}>
              {copy.install.docs}
              <HugeiconsIcon icon={ArrowRight01Icon} size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
            <a href={github} className={secondaryButton}>
              <HugeiconsIcon icon={GithubIcon} size={15} />
              {copy.nav.github}
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
