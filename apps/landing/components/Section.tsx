import { Reveal } from "./Reveal";

/**
 * One landing section: title and body on the left, an optional `aside` (tabs, race
 * controls, a state chip) bottom-aligned on the right at lg, then the content below.
 * Sections sit on one plane, separated by whitespace alone; header and content
 * reveal themselves as they enter the viewport.
 */
export function Section({
  id,
  title,
  body,
  aside,
  children,
}: {
  id: string;
  title: string;
  body: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-14 py-20 sm:py-28">
      <Reveal>
        <div className="lg:flex lg:items-end lg:justify-between lg:gap-10">
          <div className="min-w-0">
            <h2 className="title">{title}</h2>
            <p className="mt-4 max-w-[40rem] text-pretty text-[17px] text-muted-foreground">{body}</p>
          </div>
          {aside ? <div className="mt-6 shrink-0 lg:mt-0">{aside}</div> : null}
        </div>
      </Reveal>
      <Reveal delay={80}>
        <div className="mt-12 sm:mt-14">{children}</div>
      </Reveal>
    </section>
  );
}
