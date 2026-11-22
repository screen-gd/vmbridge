"use client";

import { useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { commands } from "@/lib/data";
import { LiveTerminal } from "./LiveTerminal";
import { PillTabs } from "./PillTabs";
import { Section } from "./Section";
import { Panel } from "./Window";

const pillItems = commands.map((c) => ({
  id: c.command,
  label: c.command,
  detail: <span className="mt-1 block text-[14px] leading-snug font-normal text-muted-foreground">{c.does}</span>,
}));

/**
 * The vmbridge command reference: a static list of the five commands on the left and
 * one fixed-height live terminal on the right. Picking a row runs that command in the
 * terminal; typing a known command there marks its row active. Nothing expands, so the
 * section height never changes between selections.
 */
export function Cli() {
  const [selected, setSelected] = useState(commands[0].command);
  const runRef = useRef<((command: string) => void) | null>(null);
  return (
    <Section
      id="cli"
      title={copy.cli.title}
      body={copy.cli.body}
      splitAt="lg"
      side={
        <PillTabs
          label={copy.cli.title}
          orientation="vertical"
          verticalAt="always"
          showAllDetail
          stagger
          items={pillItems}
          active={selected}
          onChange={(id) => runRef.current?.(id)}
          itemClassName="rounded-lg px-4 py-2.5 short:py-1.5"
          indicatorClassName="rounded-lg bg-card"
        />
      }
    >
      <Panel label="zsh" aside={<span>{copy.terminal.hint}</span>}>
        <LiveTerminal onCommand={setSelected} runRef={runRef} />
      </Panel>
    </Section>
  );
}
