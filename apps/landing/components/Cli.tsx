"use client";

import { useState } from "react";
import { copy } from "@/lib/copy";
import { cliScripts, commands } from "@/lib/data";
import { Section } from "./Section";
import { TerminalWindow } from "./TerminalWindow";

const rows = Math.max(...cliScripts.map((script) => script.length));

/** The vmbridge command reference: pick a command, its real output plays in the terminal. */
export function Cli() {
  const [selected, setSelected] = useState(0);
  return (
    <Section id="cli" title={copy.cli.title} body={copy.cli.body}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] lg:items-start">
        <div className="grid gap-1">
          {commands.map((c, i) => (
            <button
              key={c.command}
              type="button"
              aria-current={i === selected || undefined}
              onClick={() => setSelected(i)}
              className={`w-full rounded-xl px-4 py-4 text-left transition-colors duration-150 active:scale-[0.99] ${
                i === selected ? "bg-card" : "hover:bg-white/[0.03]"
              }`}
            >
              <code className="font-mono text-[13px]">
                {c.command} <span className="text-faint">{c.args}</span>
              </code>
              <span className="mt-1 block text-sm text-muted-foreground">{c.does}</span>
            </button>
          ))}
        </div>
        <TerminalWindow script={cliScripts[selected]} rows={rows} />
      </div>
    </Section>
  );
}
