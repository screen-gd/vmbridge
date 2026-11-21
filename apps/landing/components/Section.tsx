import { container } from "@/lib/styles";

/** One page section: heading and intro side by side on wide screens, content below at full width. */
export function Section({ id, title, body, children }: { id: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t">
      <div className={`${container} py-24 sm:py-28`}>
        <div className="lg:grid lg:grid-cols-12 lg:items-end lg:gap-10">
          <h2 className="title lg:col-span-6">{title}</h2>
          <p className="mt-4 text-pretty text-muted-foreground lg:col-span-5 lg:col-start-8 lg:mt-0">{body}</p>
        </div>
        <div className="mt-12 lg:mt-16">{children}</div>
      </div>
    </section>
  );
}
