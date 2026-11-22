"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { cliScripts, heroScript } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { useSiteState } from "./SiteState";
import { labelWidth, TerminalLine, TerminalTranscript } from "./TerminalWindow";

const cursor = (blink: boolean) => (
  <span
    className="inline-block h-[1.1em] w-[0.55em] bg-primary align-text-bottom"
    style={blink ? { animation: "blink 1s steps(1) infinite" } : undefined}
  />
);

const line = "min-h-5 sm:min-h-7";

const RACE_EVENT = "vmbridge:race";

/** Column width for `help` output so the descriptions align. */
const helpWidth = Math.max(...copy.terminal.help.map(([cmd]) => cmd.length)) + 2;

/**
 * The hero terminal: plays the startup script once when it scrolls into view, then the prompt
 * becomes a real input. Typed commands print instantly: the five real CLI commands, help, sleep,
 * wake, race and clear. Up-arrow recalls history; clicking anywhere in the box focuses the input.
 */
export function HeroTerminal() {
  const scroll = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inView, setInView] = useState(false);
  const onScreen = useInView(scroll);
  useEffect(() => {
    if (onScreen) setInView(true);
  }, [onScreen]);
  const reduced = useReducedMotion();
  const { sleep, wake, phase } = useSiteState();
  const [visible, setVisible] = useState(0);
  const [typed, setTyped] = useState(0);
  const [done, setDone] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const [value, setValue] = useState("");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (reduced) {
      setVisible(heroScript.length);
      setDone(true);
      return;
    }
    if (!inView) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    heroScript.forEach((text, index) => {
      if (text.startsWith("$ ")) {
        const length = text.length - 2;
        for (let i = 1; i <= length; i++) {
          at += 28;
          const count = i;
          timers.push(setTimeout(() => setTyped(count), at));
        }
        at += 250;
        timers.push(
          setTimeout(() => {
            setVisible(index + 1);
            setTyped(0);
          }, at),
        );
      } else {
        at += 70;
        timers.push(setTimeout(() => setVisible(index + 1), at));
      }
    });
    timers.push(setTimeout(() => setDone(true), at + 100));
    return () => timers.forEach(clearTimeout);
  }, [inView, reduced]);

  // Only the visitor's own output scrolls; the startup playback leaves the top in
  // view, and `clear` scrolls back to the top of the transcript.
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = lines.length ? el.scrollHeight : 0;
  }, [lines]);

  /** Run one typed command: echo it, print its output, or answer it. */
  const run = (raw: string) => {
    const name = raw.trim().toLowerCase();
    if (!name) {
      setLines((l) => [...l, "$"]);
      return;
    }
    setHistory((h) => [...h, raw.trim()]);
    const echo = `$ ${raw.trim()}`;
    const script = cliScripts.find((s) => s[0] === `$ ${name}`);
    if (script) {
      setLines((l) => [...l, echo, ...script.filter((t) => !t.startsWith("$ "))]);
    } else if (name === "help") {
      setLines((l) => [...l, echo, ...copy.terminal.help.map(([cmd, does]) => `${cmd.padEnd(helpWidth)}${does}`)]);
    } else if (name === "sleep") {
      setLines((l) => [...l, echo, copy.terminal.sleeping]);
      sleep();
    } else if (name === "wake") {
      wake();
      setLines((l) => [...l, echo, copy.terminal.awake]);
    } else if (name === "race") {
      setLines((l) => [...l, echo, copy.terminal.racing]);
      document.querySelector("#providers")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
      window.dispatchEvent(new Event(RACE_EVENT));
    } else if (name === "clear") {
      setLines([]);
    } else {
      setLines((l) => [...l, echo, copy.terminal.notFound.replace("{cmd}", name.split(/\s+/)[0])]);
    }
  };

  /** Walk the command history; past the newest entry the prompt clears. */
  const recall = (delta: number) => {
    if (!history.length) return;
    const next = hIndex < 0 ? history.length - 1 : hIndex + delta;
    if (next >= history.length) {
      setValue("");
      setHIndex(-1);
      return;
    }
    const at = Math.max(0, next);
    setValue(history[at]);
    setHIndex(at);
  };

  // The widest label column in the whole transcript so address and help columns align.
  const labels = labelWidth([...heroScript, ...lines]);

  return (
    // Clicking anywhere in the terminal focuses the prompt input. Below sm the panel
    // keeps a capped 22rem with scroll; from sm it grows with the transcript instead.
    <div
      onClick={() => inputRef.current?.focus()}
      className="flex h-[22rem] cursor-text flex-col px-4 pt-5 pb-6 font-mono text-[11px] leading-5 sm:h-auto sm:pt-6 sm:pb-8 sm:text-[12px] sm:leading-6 min-[1440px]:text-[13px]"
    >
      {/* Output scrolls only vertically; lines wrap instead of clipping. The top fade
          appears only once the area is actually scrolled. */}
      <div
        ref={scroll}
        data-terminal-output
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        className={`relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto sm:min-h-[14rem] sm:max-h-[30rem] sm:flex-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          scrolled ? "[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]" : ""
        }`}
      >
        <noscript>
          <TerminalTranscript script={heroScript} className={line} />
        </noscript>
        {/* The full transcript rendered invisibly reserves the final height from the
            first paint, so the panel never grows while the script plays. */}
        <div aria-hidden className="invisible [html:not(.js)_&]:hidden">
          {heroScript.map((text, i) => (
            <TerminalLine key={`s${i}`} text={text} labels={labels} className={line} />
          ))}
        </div>
        <div className="absolute inset-x-0 top-0 [html:not(.js)_&]:hidden">
          {heroScript.slice(0, visible).map((text, i) => (
            <TerminalLine key={i} text={text} labels={labels} className={line} />
          ))}
          {!done && visible < heroScript.length && heroScript[visible].startsWith("$ ") ? (
            <div className={line}>
              <span className="text-faint">$</span> {heroScript[visible].slice(2, 2 + typed)}
              {cursor(phase !== "asleep")}
            </div>
          ) : null}
          {lines.map((text, i) => (
            <TerminalLine key={`r${i}`} text={text} labels={labels} className={line} />
          ))}
        </div>
      </div>
      {/* The prompt row is always in the layout (invisible until playback finishes)
          so its arrival does not grow the panel either. */}
      <div className={`${line} flex items-baseline pt-1 ${done ? "" : "invisible"}`} aria-hidden={done ? undefined : true}>
        <span className="text-faint select-none">$&nbsp;</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              run(value);
              setValue("");
              setHIndex(-1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              recall(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              recall(1);
            }
          }}
          aria-label={copy.terminal.label}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 font-[inherit] text-foreground caret-primary outline-none"
        />
      </div>
    </div>
  );
}
