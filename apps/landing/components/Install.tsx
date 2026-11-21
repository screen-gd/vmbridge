import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { install } from "@/lib/data";
import { cell, primaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";

/** The closing install strip: the command and a docs button inside the ruled grid. */
export function Install() {
  return (
    <>
      <div aria-hidden className="hatch h-10 border-t" />
      <section id="install" className="grid scroll-mt-14 grid-cols-[minmax(0,1fr)] border-t lg:grid-cols-12">
        <div className={`${cell} lg:col-span-5`}>
          <h2 className="title">{copy.install.title}</h2>
          <p className="mt-3 text-sm text-muted-foreground">{copy.install.body}</p>
        </div>
        <div className={`${cell} flex flex-wrap content-center items-center gap-3 border-t lg:col-span-7 lg:border-t-0 lg:border-l`}>
          <Command text={install} />
          <Link href="/docs" className={primaryButton}>
            {copy.install.docs}
            <HugeiconsIcon icon={ArrowRight01Icon} size={15} />
          </Link>
        </div>
      </section>
    </>
  );
}
