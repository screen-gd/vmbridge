import { copy } from "@/lib/copy";
import { stepLogs } from "@/lib/data";
import { Section } from "./Section";

/** The four setup steps, each beside the matching terminal output. */
export function Steps() {
  return (
    <Section id="how" title={copy.steps.title} body={copy.steps.body}>
      <ol>
        {copy.steps.items.map((step, i) => (
          <li key={step.title} className="grid gap-6 border-t py-8 first:border-t-0 first:pt-0 md:grid-cols-[2.5rem_1fr_1fr]">
            <span className="font-mono text-sm text-faint">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <h3 className="font-medium">{step.title}</h3>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">{step.body}</p>
            </div>
            <div className="overflow-x-auto rounded-lg bg-card p-4 font-mono text-[12.5px] leading-6 whitespace-pre">
              {(stepLogs.at(i) ?? []).map((line, j) => (
                <div key={j} className={line.startsWith("$") ? "text-foreground" : "text-muted-foreground"}>
                  {line}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
