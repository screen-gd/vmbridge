import type { Agent, Provider } from "@/lib/data";

/** The VM Bridge mark: a bridge between your device and a VM. Same drawing as the dashboard logo. */
export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-label="VM Bridge">
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

/** A provider's mark on its brand tile. Callers own the radius and ring colour via className. */
export function ProviderLogo({ provider, className = "size-8 rounded-lg ring-white/10" }: { provider: Provider; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden ring-1 ${className}`}
      style={{ background: provider.tile }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static marks */}
      <img src={provider.logo} alt="" className="size-full object-contain grayscale" style={{ padding: provider.inset }} draggable={false} />
    </span>
  );
}

/** The real T3 Code app icon, from the T3 Code repository. */
export function T3Logo({ className = "size-8" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- tiny static mark
  return <img src="/t3code.svg" alt="T3 Code" className={`shrink-0 rounded-[22%] ring-1 ring-white/10 grayscale ${className}`} draggable={false} />;
}

/** An agent's mark on a dark tile, like the provider logos. */
export function AgentLogo({ agent, className = "size-8" }: { agent: Agent; className?: string }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-lg bg-muted p-[18%] ring-1 ring-white/10 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static marks */}
      <img src={agent.logo} alt={agent.name} className="size-full object-contain grayscale" draggable={false} />
    </span>
  );
}
