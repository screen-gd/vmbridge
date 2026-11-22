"use client";

import { useId, useState } from "react";

/**
 * One question that opens in place. The answer is always in the HTML, so search engines read it.
 * A closed answer is inert, which keeps its links and text out of the tab order and the accessibility tree.
 */
export function FaqItem({ number, question, defaultOpen = false, children }: { number: number; question: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={`rounded-xl px-5 transition-colors duration-300 ${open ? "bg-card" : ""}`}>
      <h3>
        <button
          type="button"
          id={`${id}-q`}
          aria-expanded={open}
          aria-controls={`${id}-a`}
          onClick={() => setOpen((value) => !value)}
          className="group flex w-full items-start gap-4 rounded-md py-5 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary sm:gap-6"
        >
          <span className={`w-6 shrink-0 pt-0.5 font-mono text-[13px] leading-6 transition-colors ${open ? "text-primary" : "text-faint"}`}>
            {String(number).padStart(2, "0")}
          </span>
          <span
            className={`flex-1 text-[17px] leading-7 font-medium text-pretty transition-colors ${open ? "text-foreground" : "text-foreground/85 group-hover:text-foreground"}`}
          >
            {question}
          </span>
          {/* A plus whose upright bar turns flat, leaving a minus. */}
          <span aria-hidden className="relative mt-1 grid size-5 shrink-0 place-items-center text-muted-foreground transition-colors group-hover:text-foreground">
            <span className="absolute h-px w-3 bg-current" />
            <span className={`absolute h-3 w-px bg-current transition-transform duration-300 ease-out ${open ? "rotate-90" : ""}`} />
          </span>
        </button>
      </h3>
      <div
        id={`${id}-a`}
        role="region"
        aria-labelledby={`${id}-q`}
        inert={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <p className="pr-9 pb-6 pl-10 text-base leading-relaxed text-pretty text-muted-foreground [overflow-wrap:anywhere] sm:pr-11 sm:pl-12">{children}</p>
        </div>
      </div>
    </div>
  );
}
