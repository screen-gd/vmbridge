"use client";

import { useEffect, useState } from "react";

export interface DocsSection {
  id: string;
  title: string;
}

export interface DocsGroup {
  label: string;
  sections: DocsSection[];
}

/**
 * The docs index: mono group labels over numbered links, the section being read
 * marked with the violet bar. Numbers run across groups and match the section headings.
 */
export function DocsNav({ groups }: { groups: DocsGroup[] }) {
  const sections = groups.flatMap((g) => g.sections);
  const [current, setCurrent] = useState(sections[0].id);

  useEffect(() => {
    // The current section is the last one whose heading has passed the top quarter of the screen.
    const ids = groups.flatMap((g) => g.sections.map((s) => s.id));
    let frame = 0;
    const update = () => {
      frame = 0;
      let id = ids[0];
      for (const sectionId of ids) {
        const top = document.getElementById(sectionId)?.getBoundingClientRect().top;
        if (top !== undefined && top < innerHeight * 0.25) id = sectionId;
      }
      setCurrent(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [groups]);

  let n = 0;
  return (
    <nav className="flex flex-col gap-6" aria-label="On this page">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pl-3 font-mono text-[12px] text-faint">{group.label}</div>
          <ul className="mt-2 flex flex-col">
            {group.sections.map(({ id, title }) => {
              n += 1;
              const active = id === current;
              return (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    aria-current={active ? "location" : undefined}
                    className={`group flex items-baseline gap-3 border-l py-1.5 pl-3 text-sm transition-colors duration-150 ${active ? "border-primary text-foreground" : "border-white/10 text-muted-foreground hover:border-white/30 hover:text-foreground"}`}
                  >
                    <span className={`font-mono text-[11px] tabular-nums ${active ? "text-primary" : "text-faint"}`}>{String(n).padStart(2, "0")}</span>
                    {title}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
