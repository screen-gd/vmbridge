/** One ruled section: a hatch spacer above it, a two-cell header row, then flush bordered content. */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <>
      <div aria-hidden className="hatch h-12 border-t" />
      <section id={id} className="scroll-mt-14 border-t">
        <div className="grid grid-cols-[minmax(0,1fr)] border-b lg:grid-cols-12">
          <h2 className="title px-6 py-8 sm:px-8 sm:py-10 lg:col-span-5">{title}</h2>
          <p className="text-pretty px-6 pt-0 pb-8 text-base text-muted-foreground sm:px-8 sm:pb-10 lg:border-l lg:py-10 lg:col-span-7">
            {body}
          </p>
        </div>
        {children}
      </section>
    </>
  );
}
