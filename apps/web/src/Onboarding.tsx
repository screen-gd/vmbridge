import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerTerminal01Icon, GithubIcon, LinkSquare02Icon, Loading03Icon, MagicWand01Icon, Plug01Icon, Robot01Icon, SquareLock02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { GitHubAccount, LocalSkill, Overview } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { api, useLive } from "./api.ts";
import { AgentLogo, Logo, ProviderLogo } from "./brand.tsx";
import { agentNames, AgentSection, githubTokenHint, githubTokenUrl, Providers, ProviderStatus } from "./Setup.tsx";

const steps = [
  { id: "password", label: "Password", icon: SquareLock02Icon },
  { id: "provider", label: "VM provider", icon: Plug01Icon },
  { id: "agents", label: "Agents", icon: Robot01Icon },
  { id: "github", label: "GitHub", icon: GithubIcon },
  { id: "sync", label: "Skills", icon: MagicWand01Icon },
] as const;
type Step = (typeof steps)[number]["id"] | "done";
const order: Step[] = [...steps.map((step) => step.id), "done"];

/**
 * First run: a password, a VM provider, agent sign-ins, GitHub and skill sync, one screen each. The password needs the setup
 * code from the terminal's link; every later step needs the session it starts. `onChanged` reloads the login state.
 */
export function Onboarding({ hasPassword, onChanged }: { hasPassword: boolean; onChanged: () => Promise<void> }) {
  const [step, setStep] = useState<Step>(hasPassword ? "provider" : "password");
  const at = order.indexOf(step);

  // The step's content slides out one way and in from the other; the rest of the page stays put.
  const go = (next: Step) => {
    const swap = () => flushSync(() => setStep(next));
    if (!document.startViewTransition) return swap();
    const root = document.documentElement;
    root.dataset.stepTransition = order.indexOf(next) < at ? "back" : "forward";
    document.startViewTransition(swap).finished.finally(() => delete root.dataset.stepTransition);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 px-3 sm:px-4">
        <Logo className="size-7" />
        <span className="text-lg text-faint">/</span>
        <span className="text-sm font-medium">Setup</span>
        {step !== "done" && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            Step {at + 1} of {steps.length}
          </span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 justify-center px-2 pb-2 sm:px-3 sm:pb-3 lg:items-center">
        <main className="flex h-full w-full max-w-5xl overflow-hidden rounded-xl border bg-background [view-transition-name:panel] lg:h-[min(46rem,100%)]">
          <Rail at={at} />
          <div className="flex min-w-0 flex-1 flex-col">
            <PhoneProgress at={at} />
            {step === "password" ? (
              <PasswordStep
                onDone={() => {
                  go("provider");
                  void onChanged();
                }}
              />
            ) : (
              <LiveSteps step={step} go={go} onFinish={onChanged} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** The step list beside the content: a highlight and a progress line that move as you go. */
function Rail({ at }: { at: number }) {
  const current = Math.min(at, steps.length - 1);
  // Rows are h-11 with a gap-1 between them.
  const row = 48;
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-card px-3 pt-12 md:block lg:w-64">
      <ol className="relative flex flex-col gap-1" aria-label="Setup steps">
        <span
          aria-hidden
          className={cn("absolute inset-x-0 top-0 h-11 rounded-lg bg-accent transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none", at >= steps.length && "opacity-0")}
          style={{ transform: `translateY(${current * row}px)` }}
        />
        <span aria-hidden className="absolute top-[22px] bottom-[22px] left-6 w-px -translate-x-1/2 bg-border" />
        <span
          aria-hidden
          className="absolute top-[22px] bottom-[22px] left-6 w-px origin-top -translate-x-1/2 bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${current / (steps.length - 1)})` }}
        />
        {steps.map((step, index) => {
          const state = index < at ? "done" : index === at ? "current" : "todo";
          return (
            <li key={step.id} className="relative flex h-11 items-center gap-3 px-2.5" aria-current={state === "current" ? "step" : undefined}>
              <StepDot state={state} icon={step.icon} />
              <span className={cn("text-sm transition-colors duration-300", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>{step.label}</span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function StepDot({ state, icon }: { state: "done" | "current" | "todo"; icon: (typeof steps)[number]["icon"] }) {
  return (
    <span
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full ring-1 transition-colors duration-300",
        state === "done" && "bg-[color-mix(in_oklch,var(--primary)_18%,var(--card))] text-primary ring-primary/40",
        state === "current" && "bg-primary text-primary-foreground ring-primary",
        state === "todo" && "bg-card text-muted-foreground ring-border",
      )}
    >
      {state === "done" ? (
        <HugeiconsIcon key="done" icon={Tick02Icon} className="pop-in size-4" strokeWidth={2.25} />
      ) : (
        <HugeiconsIcon key="step" icon={icon} className="size-4" strokeWidth={1.75} />
      )}
    </span>
  );
}

function PhoneProgress({ at }: { at: number }) {
  return (
    <div aria-hidden className="flex gap-1.5 px-5 pt-5 md:hidden">
      {steps.map((step, index) => (
        <span key={step.id} className="h-1 flex-1 overflow-hidden rounded-full bg-accent">
          <span
            className="block h-full origin-left bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${index <= at ? 1 : 0})` }}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * One step: its content scrolls, its actions stay at the bottom. With `onSubmit` the whole step is a form, so Enter
 * advances; steps that hold their own forms (providers, sign-ins) leave it out. Direct children enter one after another.
 */
function StepFrame({
  title,
  lead,
  actions,
  onSubmit,
  centered,
  children,
}: {
  title: string;
  /** Shown above the title. */
  lead?: ReactNode;
  actions?: ReactNode;
  onSubmit?: () => void;
  centered?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto [view-transition-name:step]">
        <div className={cn("stagger mx-auto flex w-full max-w-xl flex-col gap-8 px-5 py-8 sm:px-10 sm:py-12", centered && "items-center text-center")}>
          {lead}
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {children}
        </div>
      </div>
      {actions && (
        <footer className="shrink-0 border-t">
          <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-end gap-2 px-5 py-3 sm:px-10">{actions}</div>
        </footer>
      )}
    </>
  );
  if (!onSubmit) return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {body}
    </form>
  );
}

/** A footer button that presses in, and shows a spinner only while its request runs. */
function ActionButton({ busy = false, disabled, className, children, ...props }: ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button size="lg" className={cn("h-10 px-5 active:scale-[0.97]", className)} disabled={disabled || busy} {...props}>
      {busy && <HugeiconsIcon icon={Loading03Icon} className="animate-spin" strokeWidth={2} />}
      {children}
    </Button>
  );
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A short shake for a refused form. */
function shake(element: HTMLElement | null) {
  if (!element || reducedMotion()) return;
  element.animate({ transform: ["translateX(0)", "translateX(-6px)", "translateX(5px)", "translateX(-3px)", "translateX(0)"] }, { duration: 320, easing: "ease-out" });
}

// The setup code rides in the fragment, which never reaches the server or its logs. It is read once as the page loads
// and taken out of the address right away, so a setup that fails or is left unfinished does not keep it in history.
// A reload then asks for the terminal's link again, which works until the password is set.
const setupCode = new URLSearchParams(location.hash.slice(1)).get("code");
if (setupCode) history.replaceState(null, "", `${location.pathname}${location.search}`);

function PasswordStep({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [again, setAgain] = useState("");
  const fields = useRef<HTMLDivElement>(null);
  const action = useAction();

  if (!setupCode) {
    return (
      <StepFrame title="Open your setup link">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
            <HugeiconsIcon icon={ComputerTerminal01Icon} className="size-4" strokeWidth={1.75} />
            Terminal
          </div>
          <div className="flex flex-col gap-2 p-4 font-mono text-[13px] leading-relaxed">
            <p>
              <span className="text-faint">$ </span>vmbridge run
            </p>
            <p className="break-all text-primary">{location.origin}/dashboard/onboarding#code=…</p>
          </div>
        </div>
        <p className="text-muted-foreground">Only the link printed where VM Bridge is running can set the password.</p>
      </StepFrame>
    );
  }

  const long = key.length >= 8;
  const matches = long && again === key;
  const submit = () => {
    if (key !== again) {
      action.setError("The passwords do not match.");
      return shake(fields.current);
    }
    void action.run(() => api("/setup", { body: { code: setupCode, key } })).then((ok) => {
      if (!ok) return shake(fields.current);
      onDone();
    });
  };

  return (
    <StepFrame
      title="Choose a password"
      onSubmit={submit}
      actions={
        <ActionButton type="submit" busy={action.busy} disabled={!long || !again}>
          Continue
        </ActionButton>
      }
    >
      <FieldGroup ref={fields}>
        <Field>
          <FieldLabel htmlFor="new-password">Password</FieldLabel>
          <Input id="new-password" type="password" className="h-10" autoFocus autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} />
          <p className={cn("flex items-center gap-2 text-sm transition-colors duration-200", long ? "text-success" : "text-muted-foreground")}>
            <span className="grid size-4 place-items-center">
              {long ? <HugeiconsIcon icon={Tick02Icon} className="pop-in size-4" strokeWidth={2.25} /> : <span className="size-1.5 rounded-full bg-faint" />}
            </span>
            At least 8 characters
          </p>
        </Field>
        <Field data-invalid={Boolean(action.error)}>
          <FieldLabel htmlFor="new-password-again">Type it again</FieldLabel>
          <div className="relative">
            <Input
              id="new-password-again"
              type="password"
              className="h-10 pr-10"
              autoComplete="new-password"
              aria-invalid={Boolean(action.error) || undefined}
              value={again}
              onChange={(event) => {
                setAgain(event.target.value);
                action.setError(null);
              }}
            />
            {matches && (
              <HugeiconsIcon icon={Tick02Icon} className="pop-in pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-success" strokeWidth={2.25} aria-label="Passwords match" />
            )}
          </div>
          {action.error && <FieldError>{action.error}</FieldError>}
        </Field>
      </FieldGroup>
    </StepFrame>
  );
}

/** The steps after the password, which need the session it started and the live overview. */
function LiveSteps({ step, go, onFinish }: { step: Exclude<Step, "password">; go: (step: Step) => void; onFinish: () => Promise<void> }) {
  const { overview } = useLive();
  const [sync, setSync] = useState(true);
  if (step === "provider") return <ProviderStep overview={overview} onNext={() => go("agents")} />;
  // Later steps are only reachable once the overview has loaded.
  if (!overview) return null;
  const back = (to: Step) => (
    <ActionButton type="button" variant="ghost" className="mr-auto px-3" onClick={() => go(to)}>
      Back
    </ActionButton>
  );
  if (step === "agents") return <AgentsStep overview={overview} back={back("provider")} onNext={() => go("github")} />;
  if (step === "github") return <GitHubStep account={overview.github} back={back("agents")} onNext={() => go("sync")} />;
  if (step === "sync") {
    if (!overview.machine) return <UploadLaterStep back={back("github")} onNext={() => go("done")} />;
    return <SyncStep overview={overview} sync={sync} onSync={setSync} back={back("github")} onNext={() => go("done")} />;
  }
  return <Done overview={overview} sync={sync} onOpen={onFinish} />;
}

function ProviderStep({ overview, onNext }: { overview: Overview | null; onNext: () => void }) {
  const ready = Boolean(overview?.setup.provider);
  const added = overview?.providers.find((entry) => entry.isDefault) ?? overview?.providers[0];
  const next = useRef<HTMLButtonElement>(null);
  // Once a provider is added, Enter moves on, unless you are still typing in a field.
  useEffect(() => {
    if (ready && !(document.activeElement instanceof HTMLInputElement)) next.current?.focus();
  }, [ready]);

  return (
    <StepFrame
      title="Where should VMs run?"
      actions={
        <>
          {added ? (
            <p key="added" className="pop-in mr-auto flex min-w-0 items-center gap-2 text-sm text-success">
              <HugeiconsIcon icon={Tick02Icon} className="size-4 shrink-0" strokeWidth={2.25} />
              <span className="truncate">{added.label} added</span>
            </p>
          ) : (
            <p className="mr-auto text-sm text-muted-foreground">Add one to continue</p>
          )}
          <ActionButton ref={next} disabled={!ready} onClick={onNext}>
            Continue
          </ActionButton>
        </>
      }
    >
      {overview && <Providers overview={overview} bare />}
    </StepFrame>
  );
}

function AgentsStep({ overview, back, onNext }: { overview: Overview; back: ReactNode; onNext: () => void }) {
  const signedIn = overview.agents.some((profile) => profile.inUse);
  return (
    <StepFrame
      title="Sign in to your agents"
      actions={
        <>
          {back}
          <ActionButton variant={signedIn ? "default" : "outline"} autoFocus onClick={onNext}>
            {signedIn ? "Continue" : "Skip"}
          </ActionButton>
        </>
      }
    >
      {(["claude", "codex"] as const).map((agent) => (
        <div key={agent} className="rounded-xl border p-4 sm:p-5">
          <AgentSection agent={agent} profiles={overview.agents.filter((profile) => profile.agent === agent)} collapsed />
        </div>
      ))}
    </StepFrame>
  );
}

/** Saved through the same route as Setup's GitHub tab, which checks the token with GitHub before keeping it. */
function GitHubStep({ account, back, onNext }: { account: GitHubAccount | null; back: ReactNode; onNext: () => void }) {
  const [token, setToken] = useState("");
  // The saved account shows at once, before the live overview catches up.
  const [saved, setSaved] = useState<GitHubAccount | null>(null);
  const connected = saved ?? account;
  const field = useRef<HTMLDivElement>(null);
  const action = useAction();
  const submit = () => {
    if (connected) return onNext();
    void action.run(() => api<GitHubAccount>("/github", { method: "PUT", body: { token } }).then(setSaved)).then((ok) => {
      if (!ok) return shake(field.current);
      setToken("");
    });
  };

  return (
    <StepFrame
      title="Connect GitHub"
      onSubmit={submit}
      actions={
        <>
          {back}
          {connected ? (
            <ActionButton key="continue" type="submit" autoFocus>
              Continue
            </ActionButton>
          ) : (
            <>
              <ActionButton type="button" variant="outline" onClick={onNext}>
                Skip
              </ActionButton>
              <ActionButton type="submit" busy={action.busy} disabled={!token.trim()}>
                Connect
              </ActionButton>
            </>
          )}
        </>
      }
    >
      {connected ? (
        <div key="account" className="pop-in flex items-center gap-4 rounded-xl border p-4 sm:p-5">
          <img src={connected.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-10 shrink-0 rounded-full bg-accent" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium">{connected.name ?? connected.login}</span>
            <span className="truncate text-muted-foreground">@{connected.login}</span>
          </span>
          <HugeiconsIcon icon={Tick02Icon} className="size-5 shrink-0 text-success" strokeWidth={2.25} aria-label="Connected" />
        </div>
      ) : (
        <>
          <Field ref={field} data-invalid={Boolean(action.error)}>
            <FieldLabel htmlFor="onboarding-github-token">Personal access token</FieldLabel>
            <Input
              id="onboarding-github-token"
              type="password"
              className="h-10"
              autoFocus
              autoComplete="off"
              placeholder="github_pat_..."
              aria-invalid={Boolean(action.error) || undefined}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                action.setError(null);
              }}
            />
            {action.error ? <FieldError>{action.error}</FieldError> : <FieldDescription>{githubTokenHint}</FieldDescription>}
          </Field>
          <Button asChild variant="outline" size="lg" className="h-10 self-start px-4">
            <a href={githubTokenUrl} target="_blank" rel="noreferrer">
              Create a token on GitHub
              <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" strokeWidth={1.75} />
            </a>
          </Button>
          <p className="text-muted-foreground">VMs use it to clone, push and open pull requests. You can add it later in Setup.</p>
        </>
      )}
    </StepFrame>
  );
}

/** Where VM Bridge has no machine to read from, such as on Cloudflare Workers, skills and instructions are added later. */
function UploadLaterStep({ back, onNext }: { back: ReactNode; onNext: () => void }) {
  const finish = useAction();
  return (
    <StepFrame
      title="Skills and instructions"
      onSubmit={() => void finish.run(() => api("/onboarding", { body: { sync: false } })).then((ok) => ok && onNext())}
      actions={
        <>
          {back}
          <ActionButton type="submit" busy={finish.busy}>
            Finish
          </ActionButton>
        </>
      }
    >
      <p className="text-muted-foreground">Upload skills and paste your AGENTS.md or CLAUDE.md under Skills. Every VM gets them.</p>
      {finish.error && <FieldError>{finish.error}</FieldError>}
    </StepFrame>
  );
}

function SyncStep({
  overview,
  sync,
  onSync,
  back,
  onNext,
}: {
  overview: Overview;
  sync: boolean;
  onSync: (sync: boolean) => void;
  back: ReactNode;
  onNext: () => void;
}) {
  const [skills, setSkills] = useState<LocalSkill[] | null>(null);
  const finish = useAction();
  useEffect(() => void api<LocalSkill[]>("/skills/local").then(setSkills, () => setSkills([])), []);
  const found = [
    ...(skills?.length ? [{ key: "skills", icon: <SkillsIcon />, label: `${skills.length} ${skills.length === 1 ? "skill" : "skills"}` }] : []),
    ...overview.instructions.map((file) => ({ key: file.path, icon: <AgentLogo agent={file.agent} className="size-7" />, label: file.path.split("/").pop() ?? file.path, detail: agentNames[file.agent] })),
  ];

  return (
    <StepFrame
      title="Skills and instructions"
      onSubmit={() => void finish.run(() => api("/onboarding", { body: { sync } })).then((ok) => ok && onNext())}
      actions={
        <>
          {back}
          <ActionButton type="submit" busy={finish.busy}>
            Finish
          </ActionButton>
        </>
      }
    >
      <div className="overflow-hidden rounded-xl border">
        <label htmlFor="sync" className="flex cursor-pointer items-center gap-4 p-4 transition-colors hover:bg-muted/50 sm:p-5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">Sync to every VM</span>
            <span className="text-muted-foreground">Kept up to date as they change on this machine.</span>
          </span>
          <Switch id="sync" checked={sync} onCheckedChange={onSync} />
        </label>
        {skills !== null && (
          <ul className={cn("divide-y border-t transition-opacity duration-300", !sync && "opacity-40")}>
            {found.length === 0 && <li className="rise p-4 text-muted-foreground sm:px-5">Nothing on this machine yet. Ones you add later sync too.</li>}
            {found.map((item, index) => (
              <li key={item.key} className="rise flex items-center gap-3 px-4 py-3 sm:px-5" style={{ animationDelay: `${index * 60}ms` }}>
                {item.icon}
                <span className={cn("min-w-0 truncate", item.key !== "skills" && "font-mono text-[13px]")}>{item.label}</span>
                {"detail" in item && <span className="ml-auto shrink-0 text-muted-foreground">{item.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {finish.error && <FieldError>{finish.error}</FieldError>}
    </StepFrame>
  );
}

function SkillsIcon() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-muted-foreground ring-1 ring-white/10">
      <HugeiconsIcon icon={MagicWand01Icon} className="size-4" strokeWidth={1.75} />
    </span>
  );
}

function Done({ overview, sync, onOpen }: { overview: Overview; sync: boolean; onOpen: () => Promise<void> }) {
  const provider = overview.providers.find((entry) => entry.isDefault) ?? overview.providers[0];
  const agents = overview.agents.filter((profile) => profile.inUse);
  // The setup panel turns into the dashboard's.
  const open = () => {
    if (!document.startViewTransition) return void onOpen();
    document.startViewTransition(onOpen);
  };
  const rows = [
    {
      label: "VMs run on",
      value: provider && (
        <>
          <ProviderLogo id={provider.id} className="size-5 rounded" />
          <span className="truncate">{provider.label}</span>
          <span className="truncate text-muted-foreground">
            <ProviderStatus provider={provider} />
          </span>
        </>
      ),
    },
    {
      label: "Agents",
      value:
        agents.length === 0 ? (
          <span className="text-muted-foreground">Not signed in yet</span>
        ) : (
          agents.map((profile) => (
            <span key={profile.id} className="flex items-center gap-2">
              <AgentLogo agent={profile.agent} className="size-5 rounded" />
              {agentNames[profile.agent]}
            </span>
          ))
        ),
    },
    {
      label: "GitHub",
      value: overview.github ? (
        <span className="flex min-w-0 items-center gap-2">
          <img src={overview.github.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-5 shrink-0 rounded-full bg-accent" />
          <span className="truncate">@{overview.github.login}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">Not connected</span>
      ),
    },
    { label: "Skills", value: !overview.machine ? <span className="text-muted-foreground">Add them under Skills</span> : sync ? "Synced to every VM" : "Off" },
  ];

  return (
    <StepFrame
      title="You're all set"
      lead={<Celebration />}
      centered
      actions={
        <ActionButton autoFocus onClick={open}>
          Open dashboard
        </ActionButton>
      }
    >
      <dl className="w-full divide-y rounded-xl border text-left">
        {rows.map((row, index) => (
          <div key={row.label} className="rise flex items-center gap-6 px-4 py-3.5 sm:px-5" style={{ animationDelay: `${250 + index * 70}ms` }}>
            <dt className="w-24 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{row.value}</dd>
          </div>
        ))}
      </dl>
    </StepFrame>
  );
}

// Twelve sparks around the check, alternating distance and color. They fly once and stay gone.
const sparks = Array.from({ length: 12 }, (_, index) => ({
  angle: index * 30 + (index % 2) * 12,
  distance: index % 2 ? 52 : 70,
  color: ["var(--primary)", "var(--success)", "var(--foreground)", "var(--warning)"][index % 4],
}));

/** A one-shot finish: the badge springs in, the check draws itself, a ring and some sparks fly out once. */
function Celebration() {
  return (
    <div aria-hidden className="relative grid size-20 place-items-center">
      <span className="celebrate-ring absolute inset-0 rounded-full border border-success/60" />
      {sparks.map((spark) => (
        <span
          key={spark.angle}
          className="celebrate-spark absolute top-1/2 left-1/2 -mt-1 -ml-1 size-2 rounded-full"
          style={{ "--angle": `${spark.angle}deg`, "--distance": `${spark.distance}px`, background: spark.color } as CSSProperties}
        />
      ))}
      <span className="celebrate-badge grid size-16 place-items-center rounded-full bg-success/15 text-success ring-1 ring-success/40">
        <svg viewBox="0 0 24 24" className="size-8">
          <path className="celebrate-check" d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}
