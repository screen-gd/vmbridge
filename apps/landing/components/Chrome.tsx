import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { github } from "@/lib/data";
import { site } from "@/lib/site";
import { innerPad, railShell, rails } from "@/lib/styles";
import { Logo } from "./brand";

const linkClass = "font-mono text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground";
/** A 1px underline that grows in from the left on hover, for the text nav links. */
const underline = "relative after:absolute after:-bottom-0.5 after:left-0 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-200 hover:after:scale-x-100";

/** The site header: a solid bar, brand on the left, mono links and GitHub on the right. The page rails run through it. */
export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background">
      {/* A soft fade so scrolling content does not cut hard against the bar. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-5 bg-gradient-to-b from-background to-transparent" />
      <div className={`${rails} flex h-14 items-center gap-6`}>
        <Link href="/" className="flex items-center gap-2.5 font-medium">
          <Logo className="size-6" />
          VM Bridge
        </Link>
        <nav className="ml-auto flex items-center gap-5">
          <Link href="/#how" className={`hidden sm:block ${linkClass} ${underline}`}>
            {copy.nav.how}
          </Link>
          <Link href="/#providers" className={`hidden sm:block ${linkClass} ${underline}`}>
            {copy.nav.providers}
          </Link>
          <Link href="/docs" className={`${linkClass} ${underline}`}>
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

/** One footer link column: a small label over a stack of mono links. */
function FooterColumn({ label, links }: { label: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <div className="text-sm font-medium text-foreground">{label}</div>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            {link.href.startsWith("/") ? (
              <Link href={link.href} className={linkClass}>
                {link.label}
              </Link>
            ) : (
              <a href={link.href} className={linkClass}>
                {link.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The site footer inside the page rails: brand, line and license beside the Site and
 * Project link columns, then the giant clipped wordmark. Ends 2rem above the viewport
 * bottom so the fixed status line never covers it.
 */
export function Footer() {
  const siteLinks = [
    { label: copy.footer.links.setup, href: "/#how" },
    { label: copy.footer.links.sleepWake, href: "/#lifecycle" },
    { label: copy.footer.links.providers, href: "/#providers" },
    { label: copy.footer.links.dashboard, href: "/#dashboard" },
    { label: copy.footer.links.commands, href: "/#cli" },
    { label: copy.footer.links.faq, href: "/#faq" },
  ];
  const projectLinks = [
    { label: copy.footer.links.docs, href: "/docs" },
    { label: copy.footer.links.install, href: "/docs#install" },
    { label: copy.footer.links.github, href: github },
    { label: copy.footer.links.releases, href: `${github}/releases/latest` },
    { label: copy.footer.links.license, href: `${github}/blob/main/LICENSE` },
  ];
  return (
    <footer className={`${railShell} border-t border-white/10 pb-8`}>
      <div className={`flex flex-col gap-10 ${innerPad} py-12 sm:flex-row sm:items-start sm:justify-between`}>
        <div>
          <Link href="/" className="flex items-center gap-2.5 font-medium">
            <Logo className="size-6" />
            VM Bridge
          </Link>
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">{copy.footer.line}</p>
          <p className="mt-2 font-mono text-[13px] text-faint">
            {copy.footer.license} · v{site.version}
          </p>
        </div>
        <div className="flex gap-16 sm:gap-20">
          <FooterColumn label={copy.footer.site} links={siteLinks} />
          <FooterColumn label={copy.footer.project} links={projectLinks} />
        </div>
      </div>
      <div aria-hidden className={`overflow-hidden border-t border-white/10 ${innerPad}`}>
        <div className="translate-y-[0.14em] text-center font-medium text-[clamp(4rem,12vw,11rem)] leading-none tracking-tight text-white/[0.06] select-none">
          VM Bridge
        </div>
      </div>
    </footer>
  );
}
