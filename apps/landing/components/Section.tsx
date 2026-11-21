import { cell } from "@/lib/styles";

/** One ruled section: a hatch spacer above it, a two-cell header row, then flush bordered content. */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <>
      <div aria-hidden className="hatch h-10 border-t" />
      <section id={id} className="scroll-mt-14 border-t">
        <div className="grid grid-cols-[minmax(0,1fr)] border-b lg:grid-cols-12">
          <h2 className={`title lg:col-span-5 ${cell}`}>{title}</h2>
          <p className={`text-pretty text-muted-foreground lg:col-span-7 lg:border-l ${cell} pt-0 lg:pt-7`}>{body}</p>
        </div>
        {children}
      </section>
    </>
  );
}
