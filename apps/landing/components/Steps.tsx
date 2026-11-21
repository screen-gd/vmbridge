import { copy } from "@/lib/copy";
import { stepLogs } from "@/lib/data";
import { cell } from "@/lib/styles";
import { Section } from "./Section";

/** The four setup steps as one ruled row: copy on top, a static log strip pinned to each cell's bottom. */
export function Steps() {
  return (
    <Section id="how" title={copy.steps.title} body={copy.steps.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {copy.steps.items.map((step, i) => (
          <div key={step.title} className="flex flex-col bg-background">
            <div className={cell}>
              <div className="font-mono text-[12px] text-primary">{String(i + 1).padStart(2, "0")}</div>
              <div className="mt-3 font-medium">{step.title}</div>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">{step.body}</p>
            </div>
            <div className="mt-auto h-[7.5rem] overflow-hidden border-t bg-card px-3 py-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap">
              {stepLogs[i].map((line, j) => (
                <div key={j} className={line.startsWith("$ ") ? "text-foreground" : "text-muted-foreground"}>
                  {line}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
