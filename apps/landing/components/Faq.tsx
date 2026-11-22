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

/** The questions from data.faq in two independent columns from lg; every item starts closed. */
export function Faq() {
  const left = faq.slice(0, 7);
  const right = faq.slice(7);
  return (
    <Section id="faq" title={copy.faq.title} split={false}>
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-16">
        <div>
          {left.map(({ question, answer }, i) => (
            <FaqItem key={question} number={i + 1} question={question}>
              <Text text={answer} />
            </FaqItem>
          ))}
        </div>
        <div>
          {right.map(({ question, answer }, i) => (
            <FaqItem key={question} number={i + 8} question={question}>
              <Text text={answer} />
            </FaqItem>
          ))}
        </div>
      </div>
    </Section>
  );
}
