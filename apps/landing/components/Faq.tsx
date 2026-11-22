import { copy } from "@/lib/copy";
import { faq } from "@/lib/data";
import { FaqItem } from "./FaqItem";
import { Section } from "./Section";

/** Plain text with `backticks` shown as code. */
function Text({ text }: { text: string }) {
  return text.split("`").map((part, i) =>
    i % 2 ? (
      <code key={i} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** The questions from data.faq, each opening in place; the first starts open. */
export function Faq() {
  return (
    <Section id="faq" title={copy.faq.title}>
      <div className="max-w-[60rem]">
        {faq.map(({ question, answer }, i) => (
          <FaqItem key={question} number={i + 1} question={question} defaultOpen={i === 0}>
            <Text text={answer} />
          </FaqItem>
        ))}
      </div>
    </Section>
  );
}
