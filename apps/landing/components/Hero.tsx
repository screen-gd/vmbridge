import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Image from "next/image";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { heroScript, install } from "@/lib/data";
import { primaryButton } from "@/lib/styles";
import { Command } from "./CopyButton";
import { TerminalWindow } from "./TerminalWindow";
import { Phone, Window } from "./Window";

/** The landing header: headline, install command and a layered shot of the product. */
export function Hero() {
  return (
    <div className="mx-auto max-w-[1120px] px-5 pt-20 pb-20 sm:px-8 sm:pt-28 md:pb-32">
      <h1 className="display max-w-3xl">{copy.hero.title}</h1>
      <p className="mt-6 max-w-xl text-lg text-pretty text-muted-foreground">{copy.hero.body}</p>
      <div className="mt-9 flex flex-wrap items-center gap-3">
        <div className="min-w-0 max-w-xl flex-1 basis-80">
          <Command text={install} />
        </div>
        <Link href="/docs" className={primaryButton}>
          {copy.hero.docs}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
        </Link>
      </div>
      <div className="relative mt-16">
        <Window title="localhost:3774/dashboard">
          <Image
            src="/shots/desktop-canvas.png"
            alt={copy.dashboard.tabs.canvas.caption}
            width={2880}
            height={1800}
            className="h-auto w-full"
            priority
            sizes="(min-width: 1120px) 1056px, 100vw"
          />
        </Window>
        <div className="absolute -bottom-10 left-6 hidden w-[min(34rem,62%)] shadow-2xl shadow-black/70 md:block">
          <TerminalWindow script={heroScript} />
        </div>
        <div className="absolute -bottom-14 right-8 hidden w-[150px] lg:block">
          <Phone src="/shots/phone-canvas.png" alt="" />
        </div>
        <div className="mt-4 md:hidden">
          <TerminalWindow script={heroScript} />
        </div>
      </div>
    </div>
  );
}
