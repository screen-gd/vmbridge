/** The page container: centred, inset 16px from the viewport edge from sm up. */
export const container = "mx-auto w-full sm:w-[calc(100%-2rem)] max-w-[1648px] px-6 lg:px-12";

/** Alias of `container` kept for the chrome wrappers; there is no ruled frame anymore. */
export const frame = container;

/** The frame plus the two vertical hairlines bounding the page, drawn from sm up. */
export const rails = `${container} sm:border-x sm:border-white/10`;

/**
 * The frame's width and rails without its padding: children carry the horizontal
 * padding themselves so the hairline dividers between them span rail to rail.
 */
export const railShell = "mx-auto w-full sm:w-[calc(100%-2rem)] max-w-[1648px] sm:border-x sm:border-white/10";

/** The frame's horizontal padding on its own, for children of `railShell`. */
export const innerPad = "px-6 lg:px-12";

/** The two button looks: flat mono pills, colour changes only. */
export const primaryButton =
  "inline-flex h-10 items-center gap-2 rounded-md bg-white px-4 font-mono text-[13px] text-black transition-[color,background-color,transform] duration-150 hover:bg-white/85 active:bg-white/70 active:scale-[0.97]";
export const secondaryButton =
  "inline-flex h-10 items-center gap-2 rounded-md bg-muted px-4 font-mono text-[13px] text-foreground transition-[color,background-color,transform] duration-150 hover:bg-white/10 active:scale-[0.97]";

/** Shared pill for the sliding-indicator tab rows (dashboard shots, CLI commands). */
export const pill =
  "rounded-md px-3 py-1.5 font-mono text-[13px] text-muted-foreground transition-[color,background-color,transform] duration-150 hover:text-foreground active:scale-[0.97]";
/** The active pill's own classes; its background comes from PillTabs' sliding indicator. */
export const pillActive = "text-foreground";
