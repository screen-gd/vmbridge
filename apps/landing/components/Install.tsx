import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github, install } from "@/lib/data";
import { primaryButton, secondaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { Section } from "./Section";

/** The closing install block: heading and body left, the full-width command and buttons right. */
export function Install() {
  return (
    <Section id="install" title={copy.install.title} body={copy.install.body}>
      <Command text={install} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/docs" className={`${primaryButton} group`}>
          {copy.install.docs}
          <HugeiconsIcon icon={ArrowRight01Icon} size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </Link>
        <a href={github} className={secondaryButton}>
          <HugeiconsIcon icon={GithubIcon} size={15} />
          {copy.nav.github}
        </a>
      </div>
    </Section>
  );
}
