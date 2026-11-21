import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { install } from "@/lib/data";
import { primaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { Topology } from "./Topology";

/** The landing header: headline, install command and the wiring diagram. */
export function Hero() {
  return (
    <div className="mx-auto max-w-[1120px] px-5 pt-20 pb-20 sm:px-8 sm:pt-28">
      <h1 className="display max-w-3xl">{copy.hero.title}</h1>
      <p className="mt-6 max-w-xl text-lg text-pretty text-muted-foreground">{copy.hero.body}</p>
      <div className="mt-9 flex flex-wrap items-center gap-3">
        <div className="min-w-0 max-w-xl flex-1 basis-80">
          <Command text={install} />
        </div>
        <Link href="/docs" className={primaryButton}>
          {copy.hero.docs}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
        </Link>
      </div>
      <div className="mt-16">
        <Topology />
      </div>
      <p className="mt-4 font-mono text-xs text-faint">{copy.hero.hint}</p>
    </div>
  );
}
