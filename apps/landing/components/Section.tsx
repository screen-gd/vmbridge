import { innerPad } from "@/lib/styles";
import { Reveal } from "./Reveal";

/**
 * One landing section. Stacked below the split point: title, body, `side`, then content.
 * `splitAt="xl"` (default) splits at xl; `splitAt="lg"` already splits at lg with a
 * narrower 1fr/2fr grid, widening to the normal 12-column split at xl. The left column
 * holds title, body and `side`; the right column holds the demo, vertically centred.
 * With `sticky` the left column sticks while a long right column scrolls. Sections sit
 * on one plane inside the page rails, separated by hairline dividers; each section pads
 * itself so the dividers span rail to rail. Header and content reveal as they enter the
 * viewport. On short screens (xl and viewport height <= 700px) the padding shrinks so a
 * split section still fits one screen.
 */
export function Section({
  id,
  title,
  body,
  side,
  sideClassName = "",
  split = true,
  splitAt = "xl",
  sticky = false,
  children,
}: {
  id: string;
  title: string;
  body?: string;
  side?: React.ReactNode;
  sideClassName?: string;
  split?: boolean;
  splitAt?: "lg" | "xl";
  sticky?: boolean;
  children: React.ReactNode;
}) {
  const early = split && splitAt === "lg";
  const grid = early
    ? "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-x-8 lg:items-center xl:grid-cols-12 xl:gap-x-16"
    : split
      ? `xl:grid xl:grid-cols-12 xl:gap-x-16 ${sticky ? "xl:items-start" : "xl:items-center"}`
      : "";
  return (
    <section id={id} className={`scroll-mt-14 ${innerPad} py-14 lg:py-16 xl:short:py-6`}>
      <div className={grid}>
        <Reveal className={split ? `min-w-0 xl:col-span-4 ${sticky ? "xl:sticky xl:top-20" : ""}` : ""}>
          <h2 className="title">{title}</h2>
          {body ? <p className="mt-3 max-w-[40rem] text-pretty text-[17px] text-muted-foreground">{body}</p> : null}
          {side ? <div className={`mt-6 ${early ? "lg:mt-8" : "xl:mt-8"} xl:short:mt-4 ${sideClassName}`}>{side}</div> : null}
        </Reveal>
        <Reveal delay={80} className={`mt-8 min-w-0 ${split ? "xl:col-span-8" : ""} ${early ? "lg:mt-0" : split ? "xl:mt-0" : ""}`}>
          {children}
        </Reveal>
      </div>
    </section>
  );
}
