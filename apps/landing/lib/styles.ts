/** The page container: centred, full width, capped at 1200px with horizontal padding. */
export const container = "mx-auto w-full max-w-[1200px] px-6 sm:px-10";

/** Alias of `container` kept for the chrome wrappers; there is no ruled frame anymore. */
export const frame = container;

/** The two button looks: flat mono pills, colour changes only. */
export const primaryButton =
  "inline-flex h-10 items-center gap-2 rounded-md bg-white px-4 font-mono text-[13px] text-black transition-colors duration-150 hover:bg-white/85 active:bg-white/70";
export const secondaryButton =
  "inline-flex h-10 items-center gap-2 rounded-md bg-muted px-4 font-mono text-[13px] text-foreground transition-colors duration-150 hover:bg-white/10";
