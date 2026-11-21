/** One page section: a sticky heading on the left, content on the right. */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t">
      <div className="mx-auto grid max-w-[1120px] gap-10 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-12">
        <div className="lg:sticky lg:top-24 lg:col-span-4 lg:self-start">
          <h2 className="title">{title}</h2>
          <p className="mt-4 text-pretty text-muted-foreground">{body}</p>
        </div>
        <div className="lg:col-span-8">{children}</div>
      </div>
    </section>
  );
}
