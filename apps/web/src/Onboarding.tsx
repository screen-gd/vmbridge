import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerTerminal01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { Overview } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { api, useLive } from "./api.ts";
import { AgentLogo, Logo, ProviderLogo } from "./brand.tsx";
import { agentNames, AgentSection, Providers, ProviderStatus } from "./Setup.tsx";

const steps = ["Password", "Provider", "Agents", "Sync"] as const;
type Step = "provider" | "agents" | "sync" | "done";
const stepIndex = { provider: 1, agents: 2, sync: 3 } satisfies Record<Exclude<Step, "done">, number>;

/**
 * First run: a password, a VM provider, agent sign-ins and skill sync, one screen each. The password needs the setup
 * code from the terminal's link; every later step needs the session it starts. `onChanged` reloads the login state.
 */
export function Onboarding({ hasPassword, onChanged }: { hasPassword: boolean; onChanged: () => void }) {
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-8 px-4 pt-8 sm:px-6 sm:pt-14">
        <header className="flex items-center gap-3">
          <Logo className="size-8" />
          <span className="text-lg font-semibold tracking-tight">VM Bridge</span>
        </header>
        {hasPassword ? (
          <Steps onFinish={onChanged} />
        ) : (
          <>
            <Progress at={0} />
            <PasswordStep onDone={onChanged} />
          </>
        )}
      </div>
    </main>
  );
}

function Progress({ at }: { at: number }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Setup steps">
      {steps.map((label, index) => (
        <li key={label} className="flex flex-col gap-2" aria-current={index === at ? "step" : undefined}>
          <span className={cn("h-1 rounded-full bg-accent transition-colors duration-300", index <= at && "bg-primary")} />
          <span className={cn("text-xs text-muted-foreground", index === at && "text-foreground")}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** Each step's content slides in once when the step changes. */
function StepBody({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex animate-in flex-col gap-8 duration-300 fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </section>
  );
}

/** Kept in view at the bottom, since a step like the provider list can be taller than the screen. */
function Footer({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="sticky bottom-0 mt-auto flex flex-wrap items-center justify-end gap-2 border-t bg-background py-4">
      {note && <p className="mr-auto text-sm text-muted-foreground">{note}</p>}
      {children}
    </div>
  );
}

function PasswordStep({ onDone }: { onDone: () => void }) {
  // The fragment never reaches the server or its logs.
  const [code] = useState(() => new URLSearchParams(location.hash.slice(1)).get("code"));
  const [key, setKey] = useState("");
  const [again, setAgain] = useState("");
  const action = useAction();

  if (!code) {
    return (
      <StepBody title="Open your setup link">
        <div className="flex items-start gap-3 rounded-xl border p-4 text-sm">
          <HugeiconsIcon icon={ComputerTerminal01Icon} className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <p>Only the link printed in the terminal where VM Bridge is running can set the password. Open that link to start.</p>
        </div>
      </StepBody>
    );
  }

  return (
    <StepBody title="Choose a password">
      <form
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (key !== again) return action.setError("The passwords do not match.");
          void action.run(() => api("/setup", { body: { code, key } })).then((ok) => {
            if (!ok) return;
            // Used up, so it should not linger in history.
            history.replaceState(null, "", location.pathname);
            onDone();
          });
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-password">Password</FieldLabel>
            <Input id="new-password" type="password" className="h-10" autoFocus autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} />
            <FieldDescription>At least 8 characters. You use it to open this dashboard.</FieldDescription>
          </Field>
          <Field data-invalid={Boolean(action.error)}>
            <FieldLabel htmlFor="new-password-again">Type it again</FieldLabel>
            <Input id="new-password-again" type="password" className="h-10" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
            {action.error && <FieldError>{action.error}</FieldError>}
          </Field>
        </FieldGroup>
        <Footer>
          <Button type="submit" size="lg" className="h-10 px-5" disabled={action.busy || key.length < 8 || !again}>
            Continue
          </Button>
        </Footer>
      </form>
    </StepBody>
  );
}

function Steps({ onFinish }: { onFinish: () => void }) {
  const { overview } = useLive();
  const [step, setStep] = useState<Step>("provider");
  const [sync, setSync] = useState(true);
  const finish = useAction();
  if (!overview) return <Progress at={1} />;

  const back = (to: Step) => (
    <Button variant="ghost" size="lg" className="mr-auto h-10" onClick={() => setStep(to)}>
      Back
    </Button>
  );
  const signedIn = overview.agents.some((profile) => profile.inUse);

  return (
    <>
      {step !== "done" && <Progress at={stepIndex[step]} />}

      {step === "provider" && (
        <StepBody key="provider" title="Where should VMs run?">
          <Providers overview={overview} bare />
          <Footer note={overview.setup.provider ? undefined : "Add a provider to continue."}>
            <Button size="lg" className="h-10 px-5" disabled={!overview.setup.provider} onClick={() => setStep("agents")}>
              Continue
            </Button>
          </Footer>
        </StepBody>
      )}

      {step === "agents" && (
        <StepBody key="agents" title="Sign in to your agents">
          {(["claude", "codex"] as const).map((agent) => (
            <AgentSection key={agent} agent={agent} profiles={overview.agents.filter((profile) => profile.agent === agent)} />
          ))}
          <Footer>
            {back("provider")}
            <Button variant={signedIn ? "default" : "outline"} size="lg" className="h-10 px-5" onClick={() => setStep("sync")}>
              {signedIn ? "Continue" : "Skip"}
            </Button>
          </Footer>
        </StepBody>
      )}

      {step === "sync" && (
        <StepBody key="sync" title="Skills and instructions">
          <FieldLabel htmlFor="sync">
            <Field orientation="horizontal" className="items-center">
              <FieldContent>
                <FieldTitle>Bring my skills and instructions</FieldTitle>
                <FieldDescription>
                  Every VM gets the skills on this machine and your global CLAUDE.md and AGENTS.md files, and keeps them up to date.
                </FieldDescription>
              </FieldContent>
              <Switch id="sync" checked={sync} onCheckedChange={setSync} />
            </Field>
          </FieldLabel>
          {finish.error && <FieldError>{finish.error}</FieldError>}
          <Footer>
            {back("agents")}
            <Button
              size="lg"
              className="h-10 px-5"
              disabled={finish.busy}
              onClick={() => void finish.run(() => api("/onboarding", { body: { sync } })).then((ok) => ok && setStep("done"))}
            >
              Finish
            </Button>
          </Footer>
        </StepBody>
      )}

      {step === "done" && <Done overview={overview} sync={sync} onOpen={onFinish} />}
    </>
  );
}

function Done({ overview, sync, onOpen }: { overview: Overview; sync: boolean; onOpen: () => void }) {
  const provider = overview.providers.find((entry) => entry.isDefault) ?? overview.providers[0];
  const agents = overview.agents.filter((profile) => profile.inUse);
  return (
    <section className="flex animate-in flex-col items-center gap-8 pt-6 text-center duration-500 fade-in zoom-in-95 motion-reduce:animate-none">
      <span className="grid size-16 animate-in place-items-center rounded-full bg-success/15 text-success ring-1 ring-success/30 duration-500 zoom-in-50 motion-reduce:animate-none">
        <HugeiconsIcon icon={Tick02Icon} className="size-8" strokeWidth={2} />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">You're all set</h1>
      <dl className="grid w-full max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-4 rounded-xl border p-5 text-left text-sm">
        <dt className="text-muted-foreground">VMs run on</dt>
        <dd className="flex min-w-0 items-center gap-2">
          {provider && (
            <>
              <ProviderLogo id={provider.id} className="size-5 rounded" />
              <span className="truncate">{provider.label}</span>
              <span className="truncate text-muted-foreground">
                <ProviderStatus provider={provider} />
              </span>
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">Agents</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {agents.length === 0 && <span className="text-muted-foreground">Not signed in yet</span>}
          {agents.map((profile) => (
            <span key={profile.id} className="flex items-center gap-2">
              <AgentLogo agent={profile.agent} className="size-5 rounded" />
              {agentNames[profile.agent]}
            </span>
          ))}
        </dd>
        <dt className="text-muted-foreground">Skills</dt>
        <dd>{sync ? "Synced to every VM" : "Off"}</dd>
      </dl>
      <Button size="lg" className="h-10 px-6" autoFocus onClick={onOpen}>
        Open dashboard
      </Button>
    </section>
  );
}
