/** One page section: a heading block, then full-width content below it. */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t">
      <div className="mx-auto max-w-[1120px] px-5 py-24 sm:px-8 sm:py-28">
        <div className="max-w-2xl">
          <h2 className="title">{title}</h2>
          <p className="mt-4 text-pretty text-muted-foreground">{body}</p>
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}
