/** A section hairline: overshoots the frame by 8px each side, with a small cross where it meets each side line. */
export function Rule({ className = "" }: { className?: string }) {
  const tick =
    "absolute top-1/2 hidden size-[9px] -translate-y-1/2 sm:block before:absolute before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-white/35 after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-white/35";
  return (
    <div aria-hidden className={`pointer-events-none relative h-px ${className}`}>
      <div className="absolute inset-0 bg-border sm:-inset-x-2" />
      <span className={`${tick} left-0 -translate-x-1/2`} />
      <span className={`${tick} right-0 translate-x-1/2`} />
    </div>
  );
}
