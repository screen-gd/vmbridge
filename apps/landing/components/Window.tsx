import Image from "next/image";

/** An app or terminal window: a rounded panel with a macOS-style title bar. */
export function Window({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border bg-card ${className}`}>
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        <div className="flex gap-2">
          <span className="size-2.5 rounded-full bg-white/12" />
          <span className="size-2.5 rounded-full bg-white/12" />
          <span className="size-2.5 rounded-full bg-white/12" />
        </div>
        <span className="flex-1 truncate text-center font-mono text-[11px] text-faint">{title}</span>
        <span className="w-[46px] shrink-0" aria-hidden />
      </div>
      {children}
    </div>
  );
}

/** A phone frame around a screenshot, used overlapping windows in the hero and dashboard sections. */
export function Phone({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`rounded-[26px] bg-black p-1.5 shadow-2xl shadow-black/70 ring-1 ring-white/12 ${className}`}>
      <Image src={src} alt={alt} width={780} height={1688} className="h-auto w-full rounded-[20px]" />
    </div>
  );
}
