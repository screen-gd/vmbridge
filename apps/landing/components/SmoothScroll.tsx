"use client";

import Lenis from "lenis";
import { useEffect } from "react";

/**
 * Lenis smooth wheel scrolling for the whole site, mounted once in the root layout:
 * a gentle lerp, native scrolling on touch devices, and `anchors` so same-page links
 * (including `/#id` links while already on `/`) glide to the section — Lenis reads
 * each target's own `scroll-margin`, which the sections already set to the 56px nav
 * offset. Nested scrollers opt out with `data-lenis-prevent`. Never mounts under
 * prefers-reduced-motion, so scrolling stays native there.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ lerp: 0.1, anchors: true });
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
  return null;
}
