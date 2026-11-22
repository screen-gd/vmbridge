import Link from "next/link";
import { copy } from "@/lib/copy";
import { faq, featuredFaq } from "@/lib/data";
import { secondaryButton } from "@/lib/styles";
import { Reveal } from "./Reveal";
import { Section } from "./Section";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";

/** Plain text with `backticks` shown as code. Shared by the home FAQ and /faq. */
export function Text({ text }: { text: string }) {
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

/**
 * The five featured questions, one open at a time with the first open. `keepMounted`
 * keeps closed answers in the server HTML for search engines, and the accordion
 * panel's no-JS rule shows them all when JavaScript is off.
 */
export function Faq() {
  return (
    <Section
      id="faq"
      title={copy.faq.title}
      splitAt="lg"
      side={
        <Link href="/faq" className={secondaryButton}>
          {copy.faq.all.replace("{n}", String(faq.length))}
        </Link>
      }
    >
      <Accordion defaultValue={[featuredFaq[0].question]} keepMounted>
        {featuredFaq.map(({ question, answer }, i) => (
          <Reveal key={question} delay={Math.min(i, 8) * 60}>
            <AccordionItem value={question}>
              <AccordionTrigger>{question}</AccordionTrigger>
              <AccordionContent>
                <Text text={answer} />
              </AccordionContent>
            </AccordionItem>
          </Reveal>
        ))}
      </Accordion>
    </Section>
  );
}
