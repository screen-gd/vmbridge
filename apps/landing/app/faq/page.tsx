import type { Metadata } from "next";
import { Footer, Nav } from "@/components/Chrome";
import { Text } from "@/components/Faq";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { faq } from "@/lib/data";
import { openGraph, site } from "@/lib/site";
import { rails } from "@/lib/styles";

const title = "VM Bridge FAQ";
const description =
  "Thirteen questions and answers about VM Bridge: what it does, which providers and agents it supports, cost, sleep and wake, and where your data and keys live.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/faq" },
  openGraph: { ...openGraph, url: "/faq", title, description },
};

// The questions answered on this page, for search and answer engines.
const structuredData = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${site.url}/faq#faq`,
  mainEntity: faq.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: { "@type": "Answer", text: answer.replaceAll("`", "") },
  })),
};

/**
 * The full question list, as a single accordion where several entries may be
 * open at once. `keepMounted` keeps every answer in the server HTML, and the
 * panel's no-JS rule shows them all when JavaScript is off.
 */
export default function FaqPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // Escapes < so the JSON can never close the script tag early.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c") }}
      />
      <Nav />
      <main className={`${rails} py-14 lg:py-16`}>
        <div className="mx-auto max-w-[52rem]">
          <h1 className="title">Questions</h1>
          <Accordion multiple keepMounted className="mt-8">
            {faq.map(({ question, answer }) => (
              <AccordionItem key={question} value={question}>
                <AccordionTrigger>{question}</AccordionTrigger>
                <AccordionContent>
                  <Text text={answer} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </main>
      <Footer />
    </>
  );
}
