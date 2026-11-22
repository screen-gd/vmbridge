"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/hooks";
import { railShell } from "@/lib/styles";

type SitePhase = "awake" | "idle" | "asleep" | "waking";

interface SiteState {
  phase: SitePhase;
  countdown: number;
  sleep: () => void;
  wake: () => void;
}

const SiteStateContext = createContext<SiteState>({ phase: "awake", countdown: 0, sleep: () => {}, wake: () => {} });

/** The page's sleep state; components outside the provider (like the docs diagram) read the awake default. */
export function useSiteState() {
  return useContext(SiteStateContext);
}

const AWAKE_AFTER_MS = 20_000;
const IDLE_SECONDS = 5;
const WAKING_MS = 700;
const IGNORE_INPUT_MS = 1500;
const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"];

/**
 * Puts the landing page to sleep like a VM going idle: 20 s without input starts a 5 s countdown,
 * then the page sleeps until the next input wakes it. The automatic timer is off under reduced motion.
 */
export function SiteStateProvider({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<SitePhase>("awake");
  const [countdown, setCountdown] = useState(IDLE_SECONDS);
  const phaseRef = useRef<SitePhase>("awake");
  phaseRef.current = phase;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ignoreUntil = useRef(0);
  const lastInput = useRef(Date.now());

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const wake = useCallback(() => {
    if (phaseRef.current !== "asleep") return;
    setPhase("waking");
    timers.current.push(setTimeout(() => setPhase("awake"), WAKING_MS));
  }, []);

  const sleep = useCallback(() => {
    clearTimers();
    ignoreUntil.current = Date.now() + IGNORE_INPUT_MS;
    setPhase("asleep");
  }, []);

  useEffect(() => () => clearTimers(), []);

  // The automatic clock: 20 s of quiet starts the countdown, 5 s of idle ends in asleep.
  // The awake timeout re-arms itself from `lastInput`, so activity keeps the page awake
  // instead of racing a deadline fixed at the last phase change.
  useEffect(() => {
    if (reduced) return;
    if (phase === "awake") {
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        timer = setTimeout(() => {
          if (Date.now() - lastInput.current >= AWAKE_AFTER_MS) {
            setPhase("idle");
            setCountdown(IDLE_SECONDS);
          } else {
            arm();
          }
        }, Math.max(0, lastInput.current + AWAKE_AFTER_MS - Date.now()));
      };
      arm();
      return () => clearTimeout(timer);
    }
    if (phase === "idle") {
      const timer = setInterval(() => {
        setCountdown((current) => {
          if (current <= 1) {
            setPhase("asleep");
            return 0;
          }
          return current - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [phase, reduced]);

  // Input stays live in every phase so an asleep page can wake; only the timers are phase-scoped.
  useEffect(() => {
    const onInput = () => {
      if (Date.now() < ignoreUntil.current) return;
      lastInput.current = Date.now();
      if (phaseRef.current === "asleep") {
        wake();
        return;
      }
      if (reduced) return;
      setPhase("awake");
      setCountdown(IDLE_SECONDS);
    };
    INPUT_EVENTS.forEach((event) => window.addEventListener(event, onInput, { passive: true }));
    return () => INPUT_EVENTS.forEach((event) => window.removeEventListener(event, onInput));
  }, [reduced, wake]);

  return <SiteStateContext.Provider value={{ phase, countdown, sleep, wake }}>{children}</SiteStateContext.Provider>;
}

/**
 * <main> wrapper that dims the page's content while the site is asleep; the dim applies
 * to an inner wrapper. `railShell` draws the two page rails without padding so each
 * section's own `SectionDivider` hairline spans rail to rail; sections pad themselves.
 */
export function LandingMain({ children }: { children: React.ReactNode }) {
  const { phase } = useSiteState();
  return (
    <main className={railShell}>
      <div className={`transition-opacity ${phase === "asleep" ? "opacity-60 duration-700" : "duration-300"}`}>{children}</div>
    </main>
  );
}
