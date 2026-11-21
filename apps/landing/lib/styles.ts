/** The page container: centred, full width, capped at 1560px. Cells own their padding. */
export const container = "mx-auto w-full max-w-[1560px]";

/** The outer frame: the container plus the two vertical hairlines that rule the whole page. */
export const frame = `${container} sm:border-x`;

/** The padding of one grid cell. */
export const cell = "p-5 sm:p-7";

/** The two button looks: flat mono pills, colour changes only. */
export const primaryButton =
  "inline-flex h-9 items-center gap-2 rounded-md bg-white px-3.5 font-mono text-[13px] text-black transition-colors duration-150 hover:bg-white/85 active:bg-white/70";
export const secondaryButton =
  "inline-flex h-9 items-center gap-2 rounded-md bg-muted px-3.5 font-mono text-[13px] text-foreground transition-colors duration-150 hover:bg-white/10";
