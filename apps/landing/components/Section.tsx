/**
 * One ruled section: a tall hatch spacer above it, a lighter header band, then flush bordered content.
 * The spacer and the section's top border use the strong `rule` line on purpose — they mark section
 * boundaries, while every border between cells inside a section stays the fainter default.
 */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <>
      <div aria-hidden className="hatch h-20 border-t border-rule sm:h-28" />
      <section id={id} className="scroll-mt-14 border-t border-rule">
        <div className="grid grid-cols-[minmax(0,1fr)] border-b bg-card lg:grid-cols-12">
          <h2 className="title px-6 py-10 sm:px-8 sm:py-14 lg:col-span-5">{title}</h2>
          <p className="text-pretty px-6 pt-0 pb-10 text-base text-muted-foreground sm:px-8 sm:pb-14 lg:border-l lg:py-14 lg:col-span-7">
            {body}
          </p>
        </div>
        {children}
      </section>
    </>
  );
}
