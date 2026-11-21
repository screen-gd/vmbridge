import Image from "next/image";

/** A surface panel: a labelled strip on top, content below. Callers pad their own content. */
export function Panel({
  label,
  aside,
  children,
  className = "",
}: {
  label: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-xl bg-card ${className}`}>
      <div className="flex h-11 items-center justify-between gap-3 px-5 font-mono text-[13px] text-faint">
        <span className="min-w-0 truncate">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** A phone frame around a screenshot. Not used on the current landing. */
export function Phone({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`rounded-[26px] bg-black p-1.5 shadow-2xl shadow-black/70 ring-1 ring-white/12 ${className}`}>
      <Image src={src} alt={alt} width={780} height={1688} className="h-auto w-full rounded-[20px]" />
    </div>
  );
}
