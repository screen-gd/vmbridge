import type { Metadata } from "next";
import { Backdrop } from "@/components/Backdrop";
import { Footer, Nav } from "@/components/Chrome";
import { Cli } from "@/components/Cli";
import { Faq } from "@/components/Faq";
import { Hero } from "@/components/Hero";
import { Install } from "@/components/Install";
import { Lifecycle } from "@/components/Lifecycle";
import { Providers } from "@/components/Providers";
import { Routing } from "@/components/Routing";
import { Screens } from "@/components/Screens";
import { LandingMain, SiteStateProvider } from "@/components/SiteState";
import { StatusLine } from "@/components/StatusLine";
import { Steps } from "@/components/Steps";
import { faq, github } from "@/lib/data";
import { openGraph, site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { ...openGraph, url: "/", title: site.title, description: site.description },
};

const mit = "https://opensource.org/licenses/MIT";

// The app, its source code and the questions answered on this page, for search and answer engines.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${site.url}/#app`,
      name: site.name,
      description: site.description,
      url: site.url,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      softwareVersion: site.version,
      license: mit,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: `${github}/releases/latest`,
      installUrl: `${site.url}/docs#install`,
      softwareHelp: { "@type": "WebPage", url: `${site.url}/docs` },
      sameAs: [github],
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${site.url}/#source`,
      name: site.name,
      codeRepository: github,
      programmingLanguage: "TypeScript",
      license: mit,
      targetProduct: { "@id": `${site.url}/#app` },
    },
    {
      "@type": "FAQPage",
      "@id": `${site.url}/#faq`,
      mainEntity: faq.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer.replaceAll("`", "") },
      })),
    },
  ],
};

export default function Home() {
  return (
    <SiteStateProvider>
      <script
        type="application/ld+json"
        // Escapes < so the JSON can never close the script tag early.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c") }}
      />
      <Backdrop />
      <Nav />
      <LandingMain>
        <Hero />
        <Steps />
        <Lifecycle />
        <Routing />
        <Providers />
        <Screens />
        <Cli />
        <Faq />
        <Install />
      </LandingMain>
      <Footer />
      <StatusLine />
    </SiteStateProvider>
  );
}
