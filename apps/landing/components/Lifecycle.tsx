"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { useReducedMotion } from "@/lib/hooks";
import { Section } from "./Section";
import { stateDot } from "./Topology";
import { Panel } from "./Window";

type Phase = "asleep" | "waking" | "online" | "idle";

type Item =
  | { id: number; kind: "user"; text: string; animate: boolean }
  | { id: number; kind: "agent"; text: string; animate: boolean }
  | { id: number; kind: "notice"; text: string; dot: string; animate: boolean };

const markers = [
  "size-2.5 rounded-full bg-primary",
  "size-2.5 rounded-full ring-1 ring-primary",
  "size-2.5 rounded-full ring-1 ring-white/40",
  "size-2.5 animate-pulse rounded-full bg-primary",
];

const phaseIndex: Record<Phase, number> = { online: 0, idle: 1, asleep: 2, waking: 3 };

const chipDot: Record<Phase, string> = {
  online: stateDot.online,
  waking: stateDot.waking,
  asleep: stateDot.asleep,
  idle: "size-1.5 rounded-full ring-1 ring-primary",
};

const chipLabel = (phase: Phase) => (phase === "idle" ? copy.lifecycle.states[1].name : copy.diagram[phase]);

const exchanges = copy.demo.exchanges;

const initialItems: Item[] = [
  { id: 0, kind: "user", text: exchanges[0].message, animate: false },
  { id: 1, kind: "agent", text: exchanges[0].reply, animate: false },
  { id: 2, kind: "user", text: exchanges[1].message, animate: false },
  { id: 3, kind: "agent", text: exchanges[1].reply, animate: false },
  { id: 4, kind: "notice", text: copy.demo.asleep, dot: stateDot.asleep, animate: false },
];

const rise = { animation: "rise 200ms both" };

/**
 * A small T3 Code thread that demonstrates the VM lifecycle: Send wakes a sleeping VM, the agent
 * streams a reply, and after a few idle seconds the VM sleeps again. Beside it, the four state
 * cells follow the phase the thread is in.
 */
export function Lifecycle() {
  const [phase, setPhase] = useState<Phase>("asleep");
  const [index, setIndex] = useState(2);
  const [streaming, setStreaming] = useState(false);
  const [items, setItems] = useState<Item[]>(initialItems);
  const nextId = useRef(initialItems.length);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = (item: Item) => setItems((list) => [...list, item].slice(-6));

  const streamReply = (reply: string) => {
    setStreaming(true);
    const finish = () => {
      setStreaming(false);
      setPhase("idle");
      idleTimer.current = setTimeout(() => {
        setPhase("asleep");
        push({ id: nextId.current++, kind: "notice", text: copy.demo.asleep, dot: stateDot.asleep, animate: true });
      }, 8000);
      timers.current.push(idleTimer.current);
    };
    if (reduced) {
      push({ id: nextId.current++, kind: "agent", text: reply, animate: true });
      finish();
      return;
    }
    const id = nextId.current++;
    const words = reply.split(" ");
    push({ id, kind: "agent", text: "", animate: true });
    words.forEach((_, w) => {
      timers.current.push(
        setTimeout(() => {
          setItems((list) => list.map((item) => (item.id === id ? { ...item, text: words.slice(0, w + 1).join(" ") } : item)));
        }, (w + 1) * 45),
      );
    });
    timers.current.push(setTimeout(finish, words.length * 45 + 120));
  };

  const send = () => {
    if (phase === "waking" || streaming) return;
    const exchange = exchanges[index % exchanges.length];
    setIndex((index + 1) % exchanges.length);
    push({ id: nextId.current++, kind: "user", text: exchange.message, animate: true });
    const wasAsleep = phase === "asleep";
    if (wasAsleep) {
      setPhase("waking");
      push({ id: nextId.current++, kind: "notice", text: `${copy.demo.waking} vm-df9bca`, dot: stateDot.waking, animate: true });
      timers.current.push(setTimeout(() => setPhase("online"), 1600));
    } else {
      setPhase("online");
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    }
    timers.current.push(setTimeout(() => streamReply(exchange.reply), wasAsleep ? 1800 : 300));
  };

  const message = exchanges[index % exchanges.length].message;
  const current = phaseIndex[phase];

  return (
    <Section id="lifecycle" title={copy.lifecycle.title} body={copy.lifecycle.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Panel
            label="t3 code / Hello-World"
            aside={
              <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                <span className={chipDot[phase]} />
                vm-df9bca
                <span>{chipLabel(phase)}</span>
              </span>
            }
          >
            {phase === "idle" ? (
              <div className="h-px origin-left bg-primary" style={{ animation: "drain 8000ms linear forwards" }} />
            ) : null}
            <div className="flex h-[22rem] flex-col">
              <div className="flex flex-1 flex-col justify-end gap-3 overflow-hidden p-4 [mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]">
                {items.map((item) =>
                  item.kind === "user" ? (
                    <div key={item.id} className="ml-auto max-w-[80%] rounded-md bg-muted px-3.5 py-2 text-sm" style={item.animate ? rise : undefined}>
                      {item.text}
                    </div>
                  ) : item.kind === "agent" ? (
                    <div key={item.id} className="max-w-[85%] text-pretty text-sm text-muted-foreground" style={item.animate ? rise : undefined}>
                      {item.text}
                    </div>
                  ) : (
                    <div key={item.id} className="flex items-center justify-center gap-2 font-mono text-[11px] text-faint" style={item.animate ? rise : undefined}>
                      <span className={item.dot} />
                      {item.text}
                    </div>
                  ),
                )}
              </div>
              <div className="m-3 mt-0 flex h-11 items-center gap-2 rounded-md bg-muted pr-1.5 pl-3.5">
                <span aria-hidden className="flex-1 truncate text-sm text-muted-foreground">
                  {message}
                </span>
                <button
                  type="button"
                  onClick={send}
                  disabled={phase === "waking" || streaming}
                  aria-label={`${copy.demo.send}: ${message}`}
                  className="inline-flex h-8 items-center rounded-md bg-white px-3 font-mono text-[13px] text-black transition-colors duration-150 hover:bg-white/85 active:bg-white/70 disabled:opacity-40"
                >
                  {copy.demo.send}
                </button>
              </div>
            </div>
          </Panel>
        </div>

        <div className="flex flex-col border-t lg:col-span-5 lg:border-t-0 lg:border-l">
          {copy.lifecycle.states.map((state, i) => (
            <div
              key={state.name}
              aria-current={i === current || undefined}
              className={`flex flex-1 gap-3 border-b px-5 py-4 transition-opacity duration-200 last:border-b-0 sm:px-7 ${
                i === current ? "bg-card" : "opacity-60"
              }`}
            >
              <span className={`mt-1.5 shrink-0 ${markers[i]}`} />
              <div>
                <div className="text-sm font-medium">{state.name}</div>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">{state.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
