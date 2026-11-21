"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pill, pillActive } from "@/lib/styles";

interface PillItem {
  id: string;
  label: string;
}

/**
 * A row of mono pills with one indicator that slides and resizes to the active pill.
 * The indicator only renders once measured, so first paint does not animate from zero.
 */
export function PillTabs({ items, active, onChange, label }: { items: PillItem[]; active: string; onChange: (id: string) => void; label: string }) {
  const list = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);

  const measure = useCallback(() => {
    const el = buttons.current.get(active);
    if (el) setBox({ x: el.offsetLeft, w: el.offsetWidth });
  }, [active]);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (list.current) observer.observe(list.current);
    buttons.current.forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div role="tablist" aria-label={label} ref={list} className="relative flex flex-wrap gap-1">
      {box ? (
        <span
          aria-hidden
          className="absolute top-0 left-0 h-full rounded-md bg-muted transition-[transform,width] duration-200 ease-out"
          style={{ transform: `translateX(${box.x}px)`, width: box.w }}
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
            className={`relative z-10 ${pill} ${current ? pillActive : ""}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
