"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/lib/hooks";
import { useSiteState } from "./SiteState";

const GRID = 40;
const TRAIL = 90;
const HEAD_RADIUS = 1.5;
const DOT_RADIUS = 1;
const AWAKE_HEAD_ALPHA = 0.4;
const ASLEEP_HEAD_ALPHA = 0.15;

interface Packet {
  x: number;
  y: number;
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  /** Pixels per second while awake. */
  speed: number;
  /** Distance since the last turn or spawn; caps the trail so it never bends wrongly. */
  since: number;
}

/** Packets sit in the background like requests being routed along the grid lines. */
const packetCount = (w: number, h: number) => Math.min(8, Math.max(6, Math.round((w * h) / 160000)));

/** Spawn a packet just off one edge, moving along a random grid line. */
function spawn(w: number, h: number): Packet {
  const horizontal = Math.random() < 0.5;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const speed = 40 + Math.random() * 50;
  if (horizontal) {
    const row = Math.floor(Math.random() * (Math.ceil(h / GRID) + 1));
    return { x: dir > 0 ? -TRAIL : w + TRAIL, y: row * GRID, dx: dir as 1 | -1, dy: 0, speed, since: 0 };
  }
  const col = Math.floor(Math.random() * (Math.ceil(w / GRID) + 1));
  return { x: col * GRID, y: dir > 0 ? -TRAIL : h + TRAIL, dx: 0, dy: dir as 1 | -1, speed, since: 0 };
}

const offscreen = (p: Packet, w: number, h: number) => p.x < -TRAIL - 10 || p.x > w + TRAIL + 10 || p.y < -TRAIL - 10 || p.y > h + TRAIL + 10;

/**
 * Advance one packet along its grid line; at each crossed intersection it turns 90
 * degrees with a 20% chance, snapping onto the crossing so the corner is exact.
 */
function advance(p: Packet, dt: number, w: number, h: number): Packet {
  const step = p.speed * dt;
  const axis = p.dx !== 0 ? "x" : "y";
  const dir = p.dx !== 0 ? p.dx : p.dy;
  const from = p[axis];
  const to = from + step * dir;
  const crossed = dir > 0 ? Math.floor(to / GRID) > Math.floor(from / GRID) : Math.ceil(to / GRID) < Math.ceil(from / GRID);
  if (crossed && Math.random() < 0.2) {
    const boundary = dir > 0 ? Math.floor(to / GRID) * GRID : Math.ceil(to / GRID) * GRID;
    const turned = { ...p, since: 0 };
    turned[axis] = boundary;
    if (axis === "x") {
      turned.dx = 0;
      turned.dy = (Math.random() < 0.5 ? 1 : -1) as 1 | -1;
    } else {
      turned.dx = (Math.random() < 0.5 ? 1 : -1) as 1 | -1;
      turned.dy = 0;
    }
    return turned;
  }
  const next = { ...p, since: p.since + Math.abs(step) };
  next[axis] = to;
  if (offscreen(next, w, h)) return spawn(w, h);
  return next;
}

/** Paints the faint dot field onto an offscreen canvas, blitted each frame. */
function paintDots(w: number, h: number, dpr: number) {
  const field = document.createElement("canvas");
  field.width = Math.max(1, Math.round(w * dpr));
  field.height = Math.max(1, Math.round(h * dpr));
  const ctx = field.getContext("2d");
  if (!ctx) return field;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "rgb(255 255 255 / 0.08)";
  for (let y = 0; y < h; y += GRID) {
    for (let x = 0; x < w; x += GRID) {
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return field;
}

/**
 * A fixed canvas behind the landing page: a faint dot grid with small violet packets
 * travelling along its lines — the product's "requests being routed" as wallpaper.
 * While the page sleeps the packets coast to a stop and fade; under reduced motion
 * only the static dot field is drawn. Pauses when the tab is hidden.
 */
export function Backdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const asleep = useRef(phase === "asleep");
  asleep.current = phase === "asleep";
  /** Restarts the rAF loop when the page wakes, without rebuilding the whole effect. */
  const startLoop = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (phase !== "asleep") startLoop.current?.();
  }, [phase]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#8b5cf6";
    let width = 0;
    let height = 0;
    let dots: HTMLCanvasElement | null = null;
    let packets: Packet[] = [];
    /** 1 while awake, eases toward 0 while the page sleeps; scales speed and head alpha. */
    const energy = { current: asleep.current ? 0 : 1, target: asleep.current ? 0 : 1 };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      el.width = Math.max(1, Math.round(width * dpr));
      el.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = paintDots(width, height, dpr);
      const count = packetCount(width, height);
      packets = packets.filter((p) => p.x > -TRAIL && p.x < width + TRAIL && p.y > -TRAIL && p.y < height + TRAIL).slice(0, count);
      while (packets.length < count) packets.push(spawn(width, height));
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(dots, 0, 0, width, height);
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };

    resize();
    window.addEventListener("resize", onResize);

    if (reduced) {
      return () => {
        window.removeEventListener("resize", onResize);
        if (resizeTimer) clearTimeout(resizeTimer);
      };
    }

    let raf = 0;
    let last = performance.now();
    let running = false;

    const tick = (now: number) => {
      if (!running) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      energy.target = asleep.current ? 0 : 1;
      energy.current += (energy.target - energy.current) * (1 - Math.exp(-dt / 0.35));

      ctx.clearRect(0, 0, width, height);
      if (dots) ctx.drawImage(dots, 0, 0, width, height);
      const headAlpha = ASLEEP_HEAD_ALPHA + (AWAKE_HEAD_ALPHA - ASLEEP_HEAD_ALPHA) * energy.current;
      for (let i = 0; i < packets.length; i++) {
        const p = advance(packets[i], dt * energy.current, width, height);
        packets[i] = p;
        if (p.since <= 0 && energy.current < 0.02) continue;
        const trail = Math.min(TRAIL, p.since);
        if (trail > 0) {
          const gx = p.x - p.dx * trail;
          const gy = p.y - p.dy * trail;
          const gradient = ctx.createLinearGradient(p.x, p.y, gx, gy);
          gradient.addColorStop(0, primary);
          gradient.addColorStop(1, "rgb(139 92 246 / 0)");
          ctx.globalAlpha = headAlpha * 0.7;
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(gx, gy);
          ctx.stroke();
        }
        ctx.globalAlpha = headAlpha;
        ctx.fillStyle = primary;
        ctx.beginPath();
        ctx.arc(p.x, p.y, HEAD_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Fully asleep: the frame just drawn is the last one until the page wakes.
      if (asleep.current && energy.current < 0.01) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || document.hidden) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    startLoop.current = start;
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      startLoop.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, [reduced]);

  return <canvas ref={canvas} aria-hidden className="pointer-events-none fixed inset-0 -z-10 size-full opacity-70" />;
}
