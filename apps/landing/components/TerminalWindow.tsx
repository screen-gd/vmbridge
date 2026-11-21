"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";

const cursor = (blink: boolean) => (
  <span
    className="inline-block h-[1.1em] w-[0.55em] bg-primary align-text-bottom"
    style={blink ? { animation: "blink 1s steps(1) infinite" } : undefined}
  />
);

/**
 * The body of a terminal: plays a script once it scrolls into view. `$ ` commands type character by
 * character, the other lines print one by one, and a cursor waits on a fresh prompt at the end.
 * Callers wrap it in a `Panel`. `rows` pins the height to the longest script in a set so switching
 * scripts does not jump.
 */
export function TerminalBody({ script, rows, className = "" }: { script: string[]; rows?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Latched, so a script that has started keeps its place when it scrolls out and back in.
  const [inView, setInView] = useState(false);
  const onScreen = useInView(ref);
  useEffect(() => {
    if (onScreen) setInView(true);
  }, [onScreen]);
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(0);
  const [typed, setTyped] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setVisible(0);
    setTyped(0);
    setDone(false);
    if (reduced) {
      setVisible(script.length);
      setDone(true);
      return;
    }
    if (!inView) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    script.forEach((line, index) => {
      if (line.startsWith("$ ")) {
        const length = line.length - 2;
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
  }, [script, inView, reduced]);

  const lineCount = (rows ?? script.length) + 1;
  const line = "min-h-5 sm:min-h-7";
  return (
    <div
      ref={ref}
      className={`p-6 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap sm:p-10 sm:text-[13px] sm:leading-7 ${className}`}
      style={{ minHeight: `${Math.max(11, lineCount * 1.75 + 5)}rem` }}
    >
      {script.slice(0, visible).map((text, i) =>
        text.startsWith("$ ") ? (
          <div key={i} className={line}>
            <span className="text-faint">$</span> {text.slice(2)}
          </div>
        ) : (
          <div key={i} className={`${line} text-muted-foreground`}>
            {text}
          </div>
        ),
      )}
      {!done && visible < script.length && script[visible].startsWith("$ ") ? (
        <div className={line}>
          <span className="text-faint">$</span> {script[visible].slice(2, 2 + typed)}
          {cursor(true)}
        </div>
      ) : null}
      {done ? (
        <div className={line}>
          <span className="text-faint">$</span> {cursor(!reduced)}
        </div>
      ) : null}
    </div>
  );
}
