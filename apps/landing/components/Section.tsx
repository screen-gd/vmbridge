/**
 * One ruled section: a full-bleed rule across the whole viewport on top, an open header with
 * breathing room, then flush bordered content. The separator line is the one border that crosses
 * the frame's side rules — inner cell borders stop at the frame, which is what tells them apart.
 */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section id={id} className="relative scroll-mt-14">
      <div aria-hidden className="pointer-events-none absolute top-0 left-1/2 h-px w-screen -translate-x-1/2 bg-rule" />
      <div className="grid grid-cols-[minmax(0,1fr)] border-b lg:grid-cols-12 lg:items-end">
        <h2 className="title px-6 pt-16 pb-10 sm:px-8 sm:pt-24 sm:pb-12 lg:col-span-5">{title}</h2>
        <p className="text-pretty px-6 pt-0 pb-10 text-base text-muted-foreground sm:px-8 lg:pt-24 lg:pb-12 lg:col-span-7">{body}</p>
      </div>
      {children}
    </section>
  );
}
