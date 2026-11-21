"use client";

import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

/** A small icon button that copies text and ticks once it has. */
export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      className={`grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-white/5 hover:text-foreground ${className}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={16} className={copied ? "text-primary" : ""} />
    </button>
  );
}

/** A one-line shell command with a copy button. Grows to fit; the text scrolls sideways sooner than it clips. `className` styles the command text. */
export function Command({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className="flex h-10 w-fit max-w-full items-center gap-3 rounded-md bg-card pr-1 pl-4 font-mono text-[13px]">
      <span className="text-faint select-none">$</span>
      <code className={`min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}
