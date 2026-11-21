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
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12">
        <div className="lg:col-span-5">
          {commands.map((c, i) => {
            const current = i === selected;
            return (
              <button
                key={c.command}
                type="button"
                aria-current={current || undefined}
                onClick={() => setSelected(i)}
                className={`block w-full border-b px-5 py-3.5 text-left transition-colors duration-150 last:border-b-0 sm:px-7 ${
                  current ? "bg-card" : ""
                }`}
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
                <span className="mt-1 block text-sm text-muted-foreground">{c.does}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t bg-card lg:col-span-7 lg:border-t-0 lg:border-l">
          <Panel label="zsh">
            <TerminalBody script={cliScripts[selected]} rows={rows} />
          </Panel>
        </div>
      </div>
    </Section>
  );
}
