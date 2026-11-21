/**
 * One landing section: a stacked left-aligned header, then content, separated from its
 * neighbours by vertical padding alone. Everything sits on one plane — no rules, no cells.
 */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-14 py-20 sm:py-28">
      <h2 className="title">{title}</h2>
      <p className="mt-4 max-w-[38rem] text-pretty text-[17px] text-muted-foreground">{body}</p>
      <div className="mt-12 sm:mt-14">{children}</div>
    </section>
  );
}
