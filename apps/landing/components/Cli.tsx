"use client";

import { useState } from "react";
import { copy } from "@/lib/copy";
import { cliScripts, commands } from "@/lib/data";
import { PillTabs } from "./PillTabs";
import { Section } from "./Section";
import { TerminalBody } from "./TerminalWindow";
import { Panel } from "./Window";

const rows = Math.max(...cliScripts.map((script) => script.length));

const pillItems = commands.map((c) => ({
  id: c.command,
  label: c.command,
  detail: (
    <>
      <span className="block text-[15px] leading-relaxed font-normal text-muted-foreground">{c.does}</span>
      {c.args ? <span className="mt-1 block font-mono text-[13px] text-faint">{c.args}</span> : null}
    </>
  ),
}));

/** The vmbridge command reference: pick a command, its real output plays beside the list. */
export function Cli() {
  const [selected, setSelected] = useState(0);
  const command = commands[selected];
  return (
    <Section
      id="cli"
      title={copy.cli.title}
      body={copy.cli.body}
      splitAt="lg"
      side={
        <>
          <PillTabs
            label={copy.cli.title}
            orientation="vertical"
            verticalAt="lg"
            wrap
            items={pillItems}
            active={command.command}
            onChange={(id) => setSelected(Math.max(0, commands.findIndex((c) => c.command === id)))}
            itemClassName="rounded-lg px-4 py-3"
            indicatorClassName="rounded-lg bg-card"
          />
          <div className="mt-3 text-[15px] leading-relaxed text-muted-foreground lg:hidden">
            {command.does}
            {command.args ? <span className="ml-3 font-mono text-[13px] text-faint">{command.args}</span> : null}
          </div>
        </>
      }
    >
      <Panel label="zsh">
        <TerminalBody script={cliScripts[selected]} rows={rows} />
      </Panel>
    </Section>
  );
}
