import type { AgentKind, ProviderId } from "@vmbridge/contracts";
import { cn } from "@/lib/utils";
import claude from "./assets/agents/claude.svg";
import codex from "./assets/agents/codex.svg";
import opencode from "./assets/agents/opencode.svg";
import boat from "./assets/providers/boat.svg";
import boxd from "./assets/providers/boxd.svg";
import daytona from "./assets/providers/daytona.png";
import e2b from "./assets/providers/e2b.png";
import freestyle from "./assets/providers/freestyle.png";
import instabox from "./assets/providers/instabox.svg";
import railway from "./assets/providers/railway.svg";
import superserve from "./assets/providers/superserve.svg";

/** The VM Bridge mark: a bridge between your device and a VM. Same drawing as assets/logo.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7 shrink-0", className)} aria-label="VM Bridge">
      <rect width="32" height="32" rx="9" fill="#fff" />
      <g fill="none" stroke="#000" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 19Q16 3 26 19" />
        <path d="M4.5 19h23" />
        <path d="M11 13v6M16 11v8M21 13v6" />
        <path d="M9 19v5M23 19v5" />
      </g>
    </svg>
  );
}

/** Each provider's own mark, on the tile color its brand uses. */
const providerLogos: Record<string, { src: string; tile: string; inset: string }> = {
  boat: { src: boat, tile: "bg-white", inset: "p-[18%]" },
  boxd: { src: boxd, tile: "bg-black", inset: "p-[24%]" },
  instabox: { src: instabox, tile: "bg-black", inset: "" },
  railway: { src: railway, tile: "bg-[#13111c]", inset: "p-[20%]" },
  daytona: { src: daytona, tile: "bg-black", inset: "" },
  e2b: { src: e2b, tile: "bg-black", inset: "" },
  freestyle: { src: freestyle, tile: "bg-white", inset: "p-[18%]" },
  superserve: { src: superserve, tile: "bg-[#141414]", inset: "" },
};

export function ProviderLogo({ id, className }: { id: ProviderId | string; className?: string }) {
  const logo = providerLogos[id];
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-white/10", logo?.tile ?? "bg-muted", className)}>
      {logo ? <img src={logo.src} alt="" className={cn("size-full object-contain", logo.inset)} draggable={false} /> : null}
    </span>
  );
}

/** Each agent's own mark: OpenAI for Codex, Anthropic's Claude mark, and OpenCode. */
const agentLogos: Record<AgentKind, { src: string; tile: string; inset: string }> = {
  codex: { src: codex, tile: "bg-black", inset: "p-[18%]" },
  claude: { src: claude, tile: "bg-[#262624]", inset: "p-[20%]" },
  opencode: { src: opencode, tile: "bg-black", inset: "" },
};

export function AgentLogo({ agent, className }: { agent: AgentKind; className?: string }) {
  const logo = agentLogos[agent];
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-white/10", logo.tile, className)}>
      <img src={logo.src} alt="" className={cn("size-full object-contain", logo.inset)} draggable={false} />
    </span>
  );
}
