import { copy } from "@/lib/copy";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/** The four setup steps on the plane: number, title and body, separated by whitespace only. */
export function Steps() {
  return (
    <Section id="how" title={copy.steps.title} body={copy.steps.body} split={false}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-4">
        {copy.steps.items.map((step, i) => (
          <Reveal key={step.title} delay={i * 70}>
            <div className="group">
              <div className="flex items-baseline gap-3 sm:block">
                <div className="font-mono text-[13px] text-primary transition-transform duration-150 group-hover:translate-x-0.5">{String(i + 1).padStart(2, "0")}</div>
                <div className="text-[17px] font-medium text-foreground/85 transition-colors duration-150 group-hover:text-foreground sm:mt-5">{step.title}</div>
              </div>
              <p className="mt-2 text-pretty text-base leading-relaxed text-muted-foreground sm:mt-3">{step.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
