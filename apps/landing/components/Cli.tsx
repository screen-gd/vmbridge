"use client";

import { useState } from "react";
import { copy } from "@/lib/copy";
import { cliScripts, commands } from "@/lib/data";
import { Section } from "./Section";
import { TerminalBody } from "./TerminalWindow";
import { Panel } from "./Window";

const rows = Math.max(...cliScripts.map((script) => script.length));

/** Splits args into their bracketed groups so each token wraps whole, never mid-token. */
const argsOf = (args: string) => args.match(/<[^>]*>|\[[^\]]*\]|\S+/g) ?? [];

/** The vmbridge command reference: pick a command cell, its real output plays on the right. */
export function Cli() {
  const [selected, setSelected] = useState(0);
  return (
    <Section id="cli" title={copy.cli.title} body={copy.cli.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-12 lg:gap-16">
        <div className="flex flex-col gap-1 lg:col-span-5">
          {commands.map((c, i) => {
            const current = i === selected;
            return (
              <button
                key={c.command}
                type="button"
                aria-current={current || undefined}
                onClick={() => setSelected(i)}
                className={`block w-full rounded-lg px-4 py-4 text-left transition-colors duration-150 ${current ? "bg-card" : ""}`}
              >
                <code className="font-mono text-[13px]">
                  {current ? <span className="text-primary">{"> "}</span> : null}
                  {c.command}
                  {argsOf(c.args).map((arg, j) => (
                    <span key={j} className="ml-[1ch] inline-block text-faint">
                      {arg}
                    </span>
                  ))}
                </code>
                <span className="mt-2 block text-base leading-relaxed text-muted-foreground">{c.does}</span>
              </button>
            );
          })}
        </div>
        <div className="lg:col-span-7">
          <Panel label="zsh">
            <TerminalBody script={cliScripts[selected]} rows={rows} />
          </Panel>
        </div>
      </div>
    </Section>
  );
}
