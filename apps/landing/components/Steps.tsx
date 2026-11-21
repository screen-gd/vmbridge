import { copy } from "@/lib/copy";
import { Section } from "./Section";

/** The four setup steps on the plane: number, title and body, separated by whitespace only. */
export function Steps() {
  return (
    <Section id="how" title={copy.steps.title} body={copy.steps.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
        {copy.steps.items.map((step, i) => (
          <div key={step.title}>
            <div className="font-mono text-[13px] text-primary">{String(i + 1).padStart(2, "0")}</div>
            <div className="mt-5 text-[17px] font-medium">{step.title}</div>
            <p className="mt-3 text-pretty text-base leading-relaxed text-muted-foreground">{step.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
