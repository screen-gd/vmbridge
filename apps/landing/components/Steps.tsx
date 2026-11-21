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
              <div className="font-mono text-[13px] text-primary">{String(i + 1).padStart(2, "0")}</div>
              <div className="mt-5 text-[17px] font-medium">{step.title}</div>
              <p className="mt-3 text-pretty text-[15px] leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
            <div className="mt-auto h-[9.5rem] overflow-hidden border-t bg-card px-6 py-5 font-mono text-[12px] leading-6 break-words whitespace-pre-wrap sm:px-10">
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
