"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pill, pillActive } from "@/lib/styles";

interface PillItem {
  id: string;
  label: string;
  /** Extra content under the label of the active item; vertical lists at `verticalAt` only. */
  detail?: React.ReactNode;
}

/**
 * Pills with one indicator that slides and resizes to the active pill, measuring
 * position and size so it also fits rows that wrap or items that grow. `vertical`
 * stacks full-width items from `verticalAt` up and falls back to the scrollable
 * horizontal row below it; a vertical item may carry `detail`, shown under its
 * label while active. The indicator only renders once measured, so first paint
 * does not animate from zero.
 */
export function PillTabs({
  items,
  active,
  onChange,
  label,
  orientation = "horizontal",
  verticalAt = "xl",
  wrap = false,
  itemClassName = "",
  indicatorClassName = "bg-muted",
}: {
  items: PillItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  orientation?: "horizontal" | "vertical";
  verticalAt?: "lg" | "xl";
  /** Wrap the horizontal row onto extra lines instead of scrolling sideways. */
  wrap?: boolean;
  itemClassName?: string;
  indicatorClassName?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const vertical = orientation === "vertical";
  // Static strings: Tailwind cannot scan dynamically built variants.
  const atList = verticalAt === "lg" ? "lg:flex-col lg:overflow-visible" : "xl:flex-col xl:overflow-visible";
  const atItem = verticalAt === "lg" ? "lg:w-full lg:shrink lg:text-left" : "xl:w-full xl:shrink xl:text-left";
  const atDetail = verticalAt === "lg" ? "lg:block" : "xl:block";

  const measure = useCallback(() => {
    const el = buttons.current.get(active);
    if (el) setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  }, [active]);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (list.current) observer.observe(list.current);
    buttons.current.forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      role="tablist"
      aria-label={label}
      ref={list}
      className={`relative flex gap-1 ${
        wrap ? "flex-wrap overflow-visible" : "flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      } ${vertical ? atList : ""}`}
    >
      {box ? (
        <span
          aria-hidden
          className={`absolute top-0 left-0 rounded-md transition-[transform,width,height] duration-200 ease-out ${indicatorClassName}`}
          style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}
        />
      ) : null}
      {items.map((item) => {
        const current = item.id === active;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) buttons.current.set(item.id, el);
              else buttons.current.delete(item.id);
            }}
            type="button"
            role="tab"
            aria-selected={current}
            onClick={() => onChange(item.id)}
            className={`relative z-10 shrink-0 ${pill} ${current ? pillActive : ""} ${vertical ? atItem : ""} ${itemClassName}`}
          >
            {item.label}
            {vertical && current && item.detail ? <span className={`mt-2 hidden font-sans ${atDetail}`}>{item.detail}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
