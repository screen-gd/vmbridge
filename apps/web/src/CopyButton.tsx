import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [hovered, setHovered] = useState(false);
  const [result, setResult] = useState<"Copied" | "Copy failed" | null>(null);
  return (
    // Stay open while showing the result: the tooltip closes itself on click, which would hide it.
    <Tooltip open={hovered || result !== null} onOpenChange={setHovered}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={async (event) => {
            setResult((await copyText(value, event.currentTarget)) ? "Copied" : "Copy failed");
            setTimeout(() => setResult(null), 1500);
          }}
        >
          <HugeiconsIcon
            icon={result === "Copied" ? Tick02Icon : Copy01Icon}
            strokeWidth={1.75}
            className={result === "Copied" ? "text-success" : undefined}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{result ?? label}</TooltipContent>
    </Tooltip>
  );
}
