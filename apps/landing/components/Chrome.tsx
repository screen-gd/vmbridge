import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github } from "@/lib/data";
import { Logo } from "./brand";

const linkClass = "text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground";

/** The site header: brand on the left, section links and GitHub on the right. */
export function Nav() {
  return (
    <header className="sticky top-0 z-40 h-14 bg-background/70 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-full max-w-[1120px] items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 font-medium">
          <Logo className="size-6" />
          VM Bridge
        </Link>
        <nav className="ml-auto flex items-center gap-5">
          <Link href="/#how" className={`hidden sm:block ${linkClass}`}>
            {copy.nav.how}
          </Link>
          <Link href="/#providers" className={`hidden sm:block ${linkClass}`}>
            {copy.nav.providers}
          </Link>
          <Link href="/docs" className={linkClass}>
            {copy.nav.docs}
          </Link>
          <a href={github} aria-label={copy.nav.github} className={linkClass}>
            <HugeiconsIcon icon={GithubIcon} size={18} />
          </a>
        </nav>
      </div>
    </header>
  );
}

/** The site footer: mark, one line, docs and GitHub links. */
export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-4 px-5 py-10 sm:px-8">
        <Logo className="size-5" />
        <span className="text-sm text-muted-foreground">{copy.footer.line}</span>
        <div className="ml-auto flex gap-5">
          <Link href="/docs" className={linkClass}>
            {copy.nav.docs}
          </Link>
          <a href={github} className={linkClass}>
            {copy.nav.github}
          </a>
        </div>
      </div>
    </footer>
  );
}
