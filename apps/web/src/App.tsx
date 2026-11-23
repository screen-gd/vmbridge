import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Analytics01Icon, Coins01Icon, File01Icon, FlowConnectionIcon, LaptopIcon, Logout01Icon, MagicWand01Icon, Plug01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { api, onLoggedOut, useLive } from "./api.ts";
import { Logo } from "./brand.tsx";
import { Analytics } from "./Analytics.tsx";
import { Canvas } from "./Canvas.tsx";
import { Costs } from "./Costs.tsx";
import { Devices } from "./Devices.tsx";
import { Logs } from "./Logs.tsx";
import { boxStyle, NavIndicator, useSlidingNav } from "./nav.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { Settings } from "./Settings.tsx";
import { Setup } from "./Setup.tsx";
import { Skills } from "./Skills.tsx";

const views = [
  { id: "canvas", label: "Canvas", icon: FlowConnectionIcon },
  { id: "logs", label: "Logs", icon: File01Icon },
  { id: "costs", label: "Costs", icon: Coins01Icon },
  { id: "analytics", label: "Analytics", icon: Analytics01Icon },
  { id: "setup", label: "Setup", icon: Plug01Icon },
  { id: "skills", label: "Skills", icon: MagicWand01Icon },
  { id: "devices", label: "Devices", icon: LaptopIcon },
  { id: "settings", label: "Settings", icon: Settings01Icon },
] as const satisfies readonly { id: string; label: string; icon: IconSvgElement }[];

type View = (typeof views)[number]["id"];

/** The view and its page's tab live in the URL so a reload keeps your place. A new view starts on its first tab. */
function useView() {
  const [{ view }, setUrl] = useQueryStates({ view: parseAsStringLiteral(views.map((entry) => entry.id)), tab: parseAsString });
  return [view, (next: View) => void setUrl({ view: next, tab: null })] as const;
}

interface AuthState {
  authenticated: boolean;
  hasPassword: boolean;
  onboarded: boolean;
}

const onboardingPath = "/dashboard/onboarding";

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  // Committed synchronously, so a view transition around it (finishing onboarding) captures the new screen.
  const refresh = () => api<AuthState>("/auth").then((next) => flushSync(() => setAuth(next)));
  useEffect(() => {
    void refresh();
    return onLoggedOut(() => void refresh());
  }, []);

  // A fresh bridge, or a logged in one that never finished onboarding, goes there. Once finished, onboarding goes to the dashboard.
  const screen = !auth ? null : !auth.hasPassword || (auth.authenticated && !auth.onboarded) ? "onboarding" : auth.authenticated ? "dashboard" : "login";
  useEffect(() => {
    // The setup code rides in the fragment, so moving to onboarding keeps it.
    if (screen === "onboarding" && location.pathname !== onboardingPath) history.replaceState(null, "", `${onboardingPath}${location.hash}`);
    if (screen === "dashboard" && location.pathname === onboardingPath) history.replaceState(null, "", "/dashboard");
  }, [screen]);

  return (
    <TooltipProvider delayDuration={300}>
      {auth && screen === "onboarding" && <Onboarding hasPassword={auth.hasPassword} onChanged={refresh} />}
      {screen === "dashboard" && <Dashboard onLoggedOut={() => void refresh()} />}
      {screen === "login" && <Login onLoggedIn={() => void refresh()} />}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

// Loopback traffic never leaves the machine, so plain HTTP is only a concern from other addresses.
const unencrypted = location.protocol === "http:" && !/^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [key, setKey] = useState("");
  const action = useAction();
  return (
    <main className="grid min-h-full place-items-center px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/login", { body: { key } })).then((ok) => ok && onLoggedIn());
        }}
      >
        <div className="flex flex-col items-center gap-4">
          <Logo className="size-12" />
          <h1 className="text-xl font-semibold tracking-tight">VM Bridge</h1>
        </div>
        <FieldGroup>
          <Field data-invalid={Boolean(action.error)}>
            <FieldLabel htmlFor="key">Password</FieldLabel>
            <Input id="key" type="password" className="h-10" autoFocus autoComplete="current-password" value={key} onChange={(event) => setKey(event.target.value)} />
            {action.error && <FieldError>{action.error}</FieldError>}
          </Field>
          <Button type="submit" size="lg" className="h-10" disabled={action.busy || !key}>
            Log in
          </Button>
          {unencrypted && <p className="text-center text-sm text-muted-foreground">This connection is not encrypted. For HTTPS, turn on Tailscale HTTPS or Cloudflare Tunnel in Settings.</p>}
        </FieldGroup>
      </form>
    </main>
  );
}

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { overview, traffic, online } = useLive();
  const [chosen, go] = useView();
  const view: View = chosen ?? (overview && !overview.setup.provider ? "setup" : "canvas");
  const setupDone = overview && overview.setup.provider && overview.setup.github && overview.setup.agents;
  const current = views.find((entry) => entry.id === view)!;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 px-3 sm:px-4">
        <Logo className="size-7" />
        <span className="text-lg text-faint">/</span>
        <nav className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate font-medium">{current.label}</span>
        </nav>
        <div className={cn("ml-auto flex items-center gap-2 text-xs", online ? "text-muted-foreground" : "text-warning")}>
          <span className={cn("size-2 rounded-full", online ? "bg-success" : "bg-warning")} />
          {online ? "Live" : "Reconnecting"}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <Sidebar
          view={overview ? view : undefined}
          setupPending={Boolean(overview && !setupDone)}
          onView={go}
          onLogOut={() => void api("/logout", { body: {} }).finally(onLoggedOut)}
        />

        <main className="relative mx-2 min-h-0 flex-1 overflow-hidden rounded-xl border bg-background [view-transition-name:panel] sm:mr-3 sm:mb-3 sm:ml-0">
          {overview && view === "canvas" && <Canvas overview={overview} traffic={traffic} onPair={() => go("devices")} />}
          {overview && view === "logs" && <Logs overview={overview} traffic={traffic} />}
          {overview && view === "costs" && <Costs overview={overview} />}
          {overview && view === "analytics" && <Analytics overview={overview} />}
          {overview && view === "setup" && <Setup overview={overview} />}
          {overview && view === "skills" && <Skills overview={overview} />}
          {overview && view === "devices" && <Devices overview={overview} />}
          {overview && view === "settings" && <Settings overview={overview} onLoggedOut={onLoggedOut} />}
        </main>
      </div>
    </div>
  );
}

/**
 * The icon rail on the left, a bottom bar on phones. One tooltip follows the pointer from icon to icon.
 * `view` waits for the overview, since that can change the default view; the highlight then starts in place instead of sliding there.
 */
function Sidebar({ view, setupPending, onView, onLogOut }: { view?: View; setupPending: boolean; onView: (view: View) => void; onLogOut: () => void }) {
  const { hover, current, navProps, itemProps } = useSlidingNav(view);
  // Like the tooltip provider's delay: the first tooltip waits, then it follows the pointer at once. Keyboard focus shows it right away.
  const [tipReady, setTipReady] = useState(false);
  const shown = hover?.shown ?? false;
  const focused = hover?.focused ?? false;
  useEffect(() => {
    setTipReady(shown && focused);
    if (!shown || focused) return;
    const timer = setTimeout(() => setTipReady(true), 300);
    return () => clearTimeout(timer);
  }, [shown, focused]);
  const item = "relative size-10 rounded-lg text-muted-foreground hover:bg-transparent dark:hover:bg-transparent";

  return (
    <nav
      {...navProps}
      className="relative order-last flex shrink-0 items-center justify-around gap-1 px-2 py-1.5 sm:order-none sm:w-14 sm:flex-col sm:justify-start sm:px-0 sm:py-2"
    >
      {hover && <NavIndicator box={hover.box} shown={hover.shown} slide={hover.slide} className="rounded-lg bg-muted/50" />}
      {current && <NavIndicator box={current.box} slide={current.slide} className="rounded-lg bg-accent" />}
      {views.map((entry) => (
        <Button
          key={entry.id}
          {...itemProps(entry.id, entry.label)}
          variant="ghost"
          size="icon-lg"
          aria-label={entry.label}
          aria-current={view === entry.id ? "page" : undefined}
          onClick={() => onView(entry.id)}
          className={cn(item, view === entry.id && "text-foreground")}
        >
          <HugeiconsIcon icon={entry.icon} className="size-5" strokeWidth={1.75} />
          {entry.id === "setup" && setupPending && <span className="absolute top-2 right-2 size-1.5 rounded-full bg-warning" />}
        </Button>
      ))}
      <Button {...itemProps("logout", "Log out")} variant="ghost" size="icon-lg" aria-label="Log out" className={cn(item, "max-sm:hidden sm:mt-auto")} onClick={onLogOut}>
        <HugeiconsIcon icon={Logout01Icon} className="size-5" strokeWidth={1.75} />
      </Button>
      {hover && (
        // The buttons carry their names, so this label only repeats them for sighted users.
        <span
          aria-hidden
          className={cn("pointer-events-none absolute top-0 left-0 z-50 ease-out motion-reduce:transition-none", hover.slide && tipReady && "transition-transform duration-200")}
          style={boxStyle(hover.box)}
        >
          <span
            className={cn(
              "absolute bottom-full left-1/2 mb-2 w-max -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background transition-opacity duration-150 motion-reduce:transition-none sm:top-1/2 sm:bottom-auto sm:left-full sm:mb-0 sm:ml-2 sm:translate-x-0 sm:-translate-y-1/2",
              !(shown && tipReady) && "opacity-0",
            )}
          >
            {hover.label}
            <span className="absolute bottom-0 left-1/2 size-2.5 -translate-x-1/2 translate-y-1/2 rotate-45 rounded-[2px] bg-foreground sm:top-1/2 sm:bottom-auto sm:left-0 sm:-translate-y-1/2" />
          </span>
        </span>
      )}
    </nav>
  );
}
