/**
 * One ruled section: a Rule hairline on top, an open header with breathing room, another Rule,
 * then flush bordered content. Section boundaries are told apart by the ticks on the frame and
 * the open space around headings, not by brighter or thicker lines.
 */
import { Rule } from "./Rule";

export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-14">
      <Rule />
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12 lg:items-end">
        <h2 className="title px-6 pt-16 pb-10 sm:px-8 sm:pt-24 sm:pb-12 lg:col-span-5">{title}</h2>
        <p className="text-pretty px-6 pt-0 pb-10 text-base text-muted-foreground sm:px-8 lg:pt-24 lg:pb-12 lg:col-span-7">{body}</p>
      </div>
      <Rule />
      {children}
    </section>
  );
}
