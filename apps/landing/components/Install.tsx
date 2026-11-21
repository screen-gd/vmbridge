import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { install } from "@/lib/data";
import { primaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { Section } from "./Section";

/** The closing install block: one command and a docs link. */
export function Install() {
  return (
    <Section id="install" title={copy.install.title} body={copy.install.body}>
      <Command text={install} />
      <div className="mt-4">
        <Link href="/docs" className={primaryButton}>
          {copy.install.docs}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
        </Link>
      </div>
    </Section>
  );
}
