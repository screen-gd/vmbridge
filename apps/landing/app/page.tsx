import { Backdrop } from "@/components/Backdrop";
import { Footer, Nav } from "@/components/Chrome";
import { Cli } from "@/components/Cli";
import { Hero } from "@/components/Hero";
import { Install } from "@/components/Install";
import { Lifecycle } from "@/components/Lifecycle";
import { Providers } from "@/components/Providers";
import { Routing } from "@/components/Routing";
import { Screens } from "@/components/Screens";
import { LandingMain, SiteStateProvider } from "@/components/SiteState";
import { StatusLine } from "@/components/StatusLine";
import { Steps } from "@/components/Steps";

export default function Home() {
  return (
    <SiteStateProvider>
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
        <Install />
      </LandingMain>
      <Footer />
      <StatusLine />
    </SiteStateProvider>
  );
}
