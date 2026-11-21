import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { install } from "@/lib/data";
import { primaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";

/** The closing install block: heading, the command and a docs button on the plane. */
export function Install() {
  return (
    <section id="install" className="scroll-mt-14 py-20 sm:py-28">
      <h2 className="title">{copy.install.title}</h2>
      <p className="mt-4 max-w-[38rem] text-pretty text-[17px] text-muted-foreground">{copy.install.body}</p>
      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Command text={install} />
        <Link href="/docs" className={primaryButton}>
          {copy.install.docs}
          <HugeiconsIcon icon={ArrowRight01Icon} size={15} />
        </Link>
      </div>
    </section>
  );
}
