"use client";

import { useState } from "react";
import { copy } from "@/lib/copy";
import { cliScripts, commands } from "@/lib/data";
import { PillTabs } from "./PillTabs";
import { Section } from "./Section";
import { TerminalBody } from "./TerminalWindow";
import { Panel } from "./Window";

const rows = Math.max(...cliScripts.map((script) => script.length));

const pillItems = commands.map((c) => ({ id: c.command, label: c.command }));

/** The vmbridge command reference: pick a command pill, its real output plays below. */
export function Cli() {
  const [selected, setSelected] = useState(0);
  const command = commands[selected];
  return (
    <Section
      id="cli"
      title={copy.cli.title}
      body={copy.cli.body}
      aside={<PillTabs label={copy.cli.title} items={pillItems} active={command.command} onChange={(id) => setSelected(Math.max(0, commands.findIndex((c) => c.command === id)))} />}
    >
      <div className="mb-6 text-base leading-relaxed text-muted-foreground">
        {command.does}
        {command.args ? <span className="ml-3 font-mono text-[13px] text-faint">{command.args}</span> : null}
      </div>
      <Panel label="zsh">
        <TerminalBody script={cliScripts[selected]} rows={rows} />
      </Panel>
    </Section>
  );
}
