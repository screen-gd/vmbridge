import { useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { Overview } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { Section } from "./Page.tsx";

/** Environment variables every VM gets. Values are write-only: the server never sends them back. */
export function Environment({ overview }: { overview: Overview }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const valueInput = useRef<HTMLTextAreaElement>(null);
  const action = useAction();
  const key = name.trim();
  const exists = overview.env.includes(key);
  const pending = overview.vms.filter((vm) => vm.updatePending).length;

  const remove = (target: string) =>
    void action.run(() => api(`/env/${encodeURIComponent(target)}`, { method: "DELETE" })).then((ok) => ok && toast.success(`${target} removed. If it was a secret, revoke it at its source too.`));

  return (
    <Section title="Environment variables" actions={overview.env.length > 0 && <Badge variant="secondary">{overview.env.length}</Badge>}>
      <div className="flex flex-col gap-3">
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {overview.env.map((entry) => (
            <div key={entry} className="flex items-center gap-3 py-2 pr-2 pl-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{entry}</code>
              <span className="text-sm tracking-widest text-faint select-none">••••••</span>
              <div className="flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Change ${entry}`}
                      className="text-muted-foreground"
                      disabled={action.busy}
                      onClick={() => {
                        setName(entry);
                        setValue("");
                        valueInput.current?.focus();
                      }}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.75} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Change</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${entry}`}
                      className="text-muted-foreground hover:text-destructive"
                      disabled={action.busy}
                      onClick={() => remove(entry)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ))}
          <form
            className="flex flex-col gap-2 bg-muted/30 p-3 sm:flex-row sm:items-start"
            // The fields stay read-only while a save is pending, so clearing them after it cannot drop a newer draft.
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(() => api(`/env/${encodeURIComponent(key)}`, { method: "PUT", body: { value } })).then((ok) => {
                if (!ok) return;
                toast.success(`${key} saved. VMs get it as soon as nothing is running on them.`);
                setName("");
                setValue("");
              });
            }}
          >
            <Input
              aria-label="Name"
              placeholder="NAME"
              className="h-8 font-mono sm:w-52"
              autoComplete="off"
              spellCheck={false}
              value={name}
              readOnly={action.busy}
              onChange={(event) => setName(event.target.value)}
            />
            <Textarea
              ref={valueInput}
              aria-label="Value"
              placeholder={exists ? "New value" : "Value"}
              rows={1}
              className="min-h-8 flex-1 resize-none py-1.5 font-mono"
              autoComplete="off"
              spellCheck={false}
              value={value}
              readOnly={action.busy}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button type="submit" size="sm" className="h-8 px-3" disabled={action.busy || !key}>
              {!exists && <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />}
              {exists ? "Save" : "Add"}
            </Button>
          </form>
        </div>
        {action.error && <FieldError>{action.error}</FieldError>}
        <p className="text-[13px] text-muted-foreground">
          Agents and shells on every VM get these. A VM applies changes once nothing runs on it, or when it wakes.
          {pending > 0 && ` Not applied yet on ${pending} ${pending === 1 ? "VM" : "VMs"}.`}
        </p>
      </div>
    </Section>
  );
}
