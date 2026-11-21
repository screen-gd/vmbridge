import { copy } from "@/lib/copy";
import { commands } from "@/lib/data";
import { Section } from "./Section";

/** The vmbridge command reference. */
export function Cli() {
  return (
    <Section id="cli" title={copy.cli.title} body={copy.cli.body}>
      <div>
        {commands.map((c) => (
          <div key={c.command} className="grid gap-2 border-t py-4 first:border-t-0 md:grid-cols-[1.4fr_1fr]">
            <code className="font-mono text-[13px]">
              {c.command} <span className="text-faint">{c.args}</span>
            </code>
            <span className="text-sm text-muted-foreground">{c.does}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
