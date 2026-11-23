import { useEffect, useRef, useState } from "react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Add01Icon, CommandLineIcon, ComputerIcon, Delete02Icon, GitBranchIcon, GithubIcon, GlobalIcon, Key01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { machineNameMaxLength, vmSizes, type BridgeNetworkInfo, type BridgeSettings, type CloudflareInfo, type Overview, type ProviderId, type RepoRule, type VmSize } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { api } from "./api.ts";
import { ProviderLogo } from "./brand.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Environment } from "./Environment.tsx";
import { Page, Section, type Tab } from "./Page.tsx";

type SettingsTab = "vms" | "repos" | "env" | "addresses" | "password";

const tabs: Tab<SettingsTab>[] = [
  { id: "vms", label: "VMs", icon: ComputerIcon },
  { id: "repos", label: "Repositories", icon: GitBranchIcon },
  { id: "env", label: "Environment", icon: CommandLineIcon },
  { id: "addresses", label: "Addresses", icon: GlobalIcon },
  { id: "password", label: "Password", icon: Key01Icon },
];

export function Settings({ overview, onLoggedOut }: { overview: Overview; onLoggedOut: () => void }) {
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(tabs.map((entry) => entry.id)).withDefault("vms"));
  return (
    <Page title="Settings" tabs={tabs} tab={tab} onTab={setTab}>
      {tab === "vms" && <VmSettings overview={overview} />}
      {tab === "repos" && <RepoRules overview={overview} />}
      {tab === "env" && <Environment overview={overview} />}
      {tab === "addresses" && <Addresses />}
      {tab === "password" && <Password source={overview.passwordSource} onLoggedOut={onLoggedOut} />}
    </Page>
  );
}

function VmSettings({ overview }: { overview: Overview }) {
  const [form, setForm] = useState<BridgeSettings>(overview.settings);
  const action = useAction();
  const provider = overview.providers.find((entry) => entry.id === overview.defaultProvider);
  const sizes = provider?.sizes;
  return (
    <Section title="VMs">
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => setForm(await api<BridgeSettings>("/settings", { method: "PUT", body: form }))).then((ok) => ok && toast.success("Settings saved."));
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="machine-name">Machine name</FieldLabel>
            <Input
              id="machine-name"
              className="h-9"
              maxLength={machineNameMaxLength}
              placeholder="VM Bridge"
              value={form.machineName}
              onChange={(event) => setForm({ ...form, machineName: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vm-size">Size for new VMs</FieldLabel>
            <Select value={form.vmSize ?? fallback} onValueChange={(value) => setForm({ ...form, vmSize: value === fallback ? null : (value as VmSize) })}>
              <SelectTrigger id="vm-size" className="w-full data-[size=default]:h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={fallback}>
                  Default
                  {provider && <span className="text-muted-foreground">{provider.sizes[provider.defaultSize]}</span>}
                </SelectItem>
                {vmSizes.map((size) => (
                  <SelectItem key={size} value={size}>
                    <span className="capitalize">{size}</span>
                    {sizes && <span className="text-muted-foreground">{sizes[size]}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="idle-minutes">Sleep after idle (minutes)</FieldLabel>
            <Input
              id="idle-minutes"
              className="h-9"
              type="number"
              min={1}
              max={240}
              value={form.idleMinutes}
              onChange={(event) => setForm({ ...form, idleMinutes: Number(event.target.value) })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="t3-version">T3 version</FieldLabel>
            <Input id="t3-version" className="h-9" value={form.t3Version ?? ""} placeholder="Latest" onChange={(event) => setForm({ ...form, t3Version: event.target.value || null })} />
            <FieldDescription>New VMs install this version.</FieldDescription>
          </Field>
        </FieldGroup>
        {action.error && <FieldError>{action.error}</FieldError>}
        <div>
          <Button type="submit" size="lg" className="px-4" disabled={action.busy}>
            Save
          </Button>
        </div>
      </form>
    </Section>
  );
}

const fallback = "default";

/** Provider and size pickers for one repository rule. "Default" leaves the choice to the VM settings. */
function RuleChoices({ overview, rule, onChange }: { overview: Overview; rule: RepoRule; onChange: (change: Partial<RepoRule>) => void }) {
  const provider = overview.providers.find((entry) => entry.id === (rule.provider ?? overview.defaultProvider));
  return (
    <>
      <Select value={rule.provider ?? fallback} onValueChange={(value) => onChange({ provider: value === fallback ? null : (value as ProviderId) })}>
        <SelectTrigger aria-label="Provider" size="sm" className="w-full sm:w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={fallback}>Default provider</SelectItem>
          {overview.providers.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              <ProviderLogo id={entry.id} className="size-4 rounded" />
              {entry.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={rule.size ?? fallback} onValueChange={(value) => onChange({ size: value === fallback ? null : (value as VmSize) })}>
        <SelectTrigger aria-label="Size" size="sm" className="w-full max-sm:[&_.spec]:hidden sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={fallback}>Default size</SelectItem>
          {vmSizes.map((size) => (
            <SelectItem key={size} value={size}>
              <span className="capitalize">{size}</span>
              {provider && <span className="spec text-muted-foreground">{provider.sizes[size]}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

const repoName = /^[\w.-]+\/[\w.-]+$/;

/** Searchable list of the repositories VM Bridge's GitHub token reaches. A typed `owner/name` works too. */
function RepoPicker({ id, value, repos, onChange }: { id: string; value: string; repos: string[]; onChange: (repo: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const typed = search.trim();
  const custom = repoName.test(typed) && !repos.some((repo) => repo.toLowerCase() === typed.toLowerCase()) ? typed : null;
  const pick = (repo: string) => {
    onChange(repo);
    setSearch("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-1 dark:bg-input/30 dark:hover:bg-input/50"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value || "Choose a repository"}</span>
          <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command>
          <CommandInput placeholder="Search repositories" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{repos.length ? "No match. Type owner/name to add any repository." : "Type owner/name."}</CommandEmpty>
            {custom && (
              <CommandGroup>
                <CommandItem value={custom} onSelect={() => pick(custom)}>
                  Use {custom}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {repos.map((repo) => (
                <CommandItem key={repo} value={repo} data-checked={repo === value} onSelect={() => pick(repo)}>
                  <span className="truncate">{repo}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RepoRules({ overview }: { overview: Overview }) {
  const [rules, setRules] = useState(overview.repoRules);
  const [repos, setRepos] = useState<string[]>([]);
  const [draft, setDraft] = useState<RepoRule>({ repo: "", provider: null, size: null });
  const action = useAction();
  useEffect(() => void api<string[]>("/github/repos").then(setRepos, () => {}), []);
  // Each save sends the whole list, so saves run one at a time, each applied to what the last one saved.
  // Otherwise quick edits (provider, then size) would each start from the same list and the last would win.
  const saved = useRef(rules);
  const queue = useRef(Promise.resolve(true));
  const save = (change: (rules: RepoRule[]) => RepoRule[]) => {
    queue.current = queue.current.then(() =>
      action.run(async () => {
        saved.current = await api<RepoRule[]>("/repo-rules", { method: "PUT", body: { rules: change(saved.current) } });
        setRules(saved.current);
      }),
    );
    return queue.current;
  };
  const listed = new Set(rules.map((rule) => rule.repo.toLowerCase()));
  return (
    <Section title="Repositories">
      <div className="flex flex-col gap-3">
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {rules.map((rule) => {
            const [owner, name] = rule.repo.split("/");
            return (
              <div key={rule.repo} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <HugeiconsIcon icon={GithubIcon} className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{owner}/</span>
                  <span className="font-medium">{name}</span>
                </div>
                <div className="order-last grid w-full grid-cols-2 gap-2 sm:order-none sm:flex sm:w-auto">
                  <RuleChoices overview={overview} rule={rule} onChange={(change) => void save((list) => list.map((entry) => (entry.repo === rule.repo ? { ...entry, ...change } : entry)))} />
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${rule.repo}`}
                      className="text-muted-foreground hover:text-destructive"
                      disabled={action.busy}
                      onClick={() => void save((list) => list.filter((entry) => entry.repo !== rule.repo))}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
          <form
            className="flex flex-col gap-2 bg-muted/30 p-3 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              void save((list) => [...list, { ...draft, repo: draft.repo.trim() }]).then((ok) => ok && setDraft({ repo: "", provider: null, size: null }));
            }}
          >
            <RepoPicker id="rule-repo" value={draft.repo} repos={repos.filter((repo) => !listed.has(repo.toLowerCase()))} onChange={(repo) => setDraft({ ...draft, repo })} />
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <RuleChoices overview={overview} rule={draft} onChange={(change) => setDraft((current) => ({ ...current, ...change }))} />
            </div>
            <Button type="submit" size="sm" className="h-8 px-3" disabled={action.busy || !draft.repo.trim()}>
              <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
              Add
            </Button>
          </form>
        </div>
        {action.error && <FieldError>{action.error}</FieldError>}
        <p className="text-[13px] text-muted-foreground">New VMs for a repository use its provider and size. When it is busy, its extra VMs match its first one.</p>
      </div>
    </Section>
  );
}

function Addresses() {
  const [network, setNetwork] = useState<BridgeNetworkInfo | null>(null);
  const action = useAction();
  useEffect(() => void action.run(async () => setNetwork(await api<BridgeNetworkInfo>("/network"))), []);
  // On Cloudflare Workers the dashboard has only its own address: no local network, Tailscale or tunnel.
  const local = network?.platform === "bun" ? network : null;
  const cloudflare = local?.cloudflare;
  // Until the tunnel works or gives up, check again every few seconds.
  useEffect(() => {
    if (!cloudflare?.enabled || cloudflare.state === "running") return;
    const timer = setTimeout(() => void api<BridgeNetworkInfo>("/network").then(setNetwork, () => {}), 3_000);
    return () => clearTimeout(timer);
  }, [network]);
  const tailscale = local?.tailscale;
  return (
    <>
      <Section title="Addresses">
        <ItemGroup className="gap-2">
          {network?.addresses.map((address) => (
            <Item key={address.url} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>
                  {address.label}
                  {address.kind === "cloudflare" && <TunnelBadge state="running" />}
                </ItemTitle>
                <ItemDescription className="truncate font-mono text-xs">
                  {address.url}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <CopyButton value={address.url} />
              </ItemActions>
            </Item>
          ))}
          {cloudflare?.enabled && !cloudflare.url && cloudflare.state !== "off" && (
            <Item variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>
                  Cloudflare Tunnel
                  <TunnelBadge state={cloudflare.state} />
                </ItemTitle>
                <ItemDescription>{cloudflare.state === "failed" ? cloudflare.error : gettingReady}</ItemDescription>
              </ItemContent>
            </Item>
          )}
        </ItemGroup>
      </Section>
      {local && (
        <Section title="Local network" actions={<Badge variant="secondary">{local.localNetwork.enabled ? "On" : "Off"}</Badge>}>
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>
                <label htmlFor="local-network">Devices on this network</label>
              </ItemTitle>
              <ItemDescription>
                {local.localNetwork.fixed
                  ? "Set by --host when VM Bridge started."
                  : local.localNetwork.enabled
                    ? "They can connect over plain HTTP, which others on this Wi-Fi can read."
                    : "Off, so they can't connect. Tailscale and Cloudflare Tunnel still work."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="local-network"
                checked={local.localNetwork.enabled}
                disabled={action.busy || local.localNetwork.fixed}
                onCheckedChange={(enabled) => void action.run(async () => setNetwork(await api<BridgeNetworkInfo>("/network/local", { body: { enabled } })))}
              />
            </ItemActions>
          </Item>
        </Section>
      )}
      {local && (
        <Section title="Tailscale" actions={<Badge variant="secondary">{tailscale?.running ? "Connected" : tailscale?.installed ? "Not connected" : "Not installed"}</Badge>}>
          {tailscale?.running ? (
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>
                  <label htmlFor="tailscale-https">HTTPS address</label>
                </ItemTitle>
                <ItemDescription>{tailscale.httpsUrl ?? "Serve VM Bridge over HTTPS on your tailnet."}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  id="tailscale-https"
                  checked={Boolean(tailscale.httpsUrl)}
                  disabled={action.busy}
                  onCheckedChange={(enabled) => void action.run(async () => setNetwork(await api<BridgeNetworkInfo>("/network/https", { body: { enabled } })))}
                />
              </ItemActions>
            </Item>
          ) : (
            <FieldDescription>
              {tailscale?.installed ? "Tailscale is installed but not connected." : "Install Tailscale to reach VM Bridge from your other devices."}
            </FieldDescription>
          )}
        </Section>
      )}
      {action.error && <FieldError>{action.error}</FieldError>}
      {local && <CloudflareTunnel info={local.cloudflare} onChange={setNetwork} />}
    </>
  );
}

const gettingReady = "Getting the address ready, this can take up to a minute.";
const tunnelStatus: Record<CloudflareInfo["state"], string> = { off: "Off", starting: "Getting ready", running: "Working", failed: "Not working" };

function TunnelBadge({ state }: { state: CloudflareInfo["state"] }) {
  return (
    <Badge variant={state === "failed" ? "destructive" : "secondary"} className="gap-1.5">
      {state === "running" && <span className="size-1.5 rounded-full bg-success" />}
      {tunnelStatus[state]}
    </Badge>
  );
}

function CloudflareTunnel({ info, onChange }: { info: CloudflareInfo; onChange: (network: BridgeNetworkInfo) => void }) {
  const [hostname, setHostname] = useState(info.hostname ?? "");
  const [token, setToken] = useState("");
  const action = useAction();
  const save = (body: { enabled?: boolean; hostname?: string; token?: string | null }) =>
    void action.run(async () => {
      onChange(await api<BridgeNetworkInfo>("/network/cloudflare", { body }));
      setToken("");
    });

  if (!info.installed) {
    return (
      <Section title="Cloudflare Tunnel" actions={<Badge variant="secondary">Not installed</Badge>}>
        <FieldDescription>
          Install cloudflared for a public HTTPS address: <code className="font-mono text-foreground">brew install cloudflared</code>
        </FieldDescription>
      </Section>
    );
  }

  const status = info.url ?? (info.enabled && info.state === "starting" ? gettingReady : "Opens VM Bridge to the internet, behind your password.");
  return (
    <Section title="Cloudflare Tunnel" actions={<TunnelBadge state={info.enabled ? info.state : "off"} />}>
      <Item variant="outline">
        <ItemContent className="min-w-0">
          <ItemTitle>
            <label htmlFor="cloudflare-tunnel">Public HTTPS address</label>
          </ItemTitle>
          <ItemDescription className={cn(info.url && "truncate font-mono text-xs")}>{status}</ItemDescription>
          {info.url && info.mode === "quick" && <ItemDescription>Changes every time VM Bridge restarts. Use your own domain to keep it.</ItemDescription>}
        </ItemContent>
        <ItemActions>
          <Switch id="cloudflare-tunnel" checked={info.enabled} disabled={action.busy} onCheckedChange={(enabled) => save({ enabled })} />
        </ItemActions>
      </Item>
      {info.enabled && info.error && <FieldError>{info.error}</FieldError>}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save({ hostname, ...(token.trim() ? { token } : {}) });
        }}
      >
        <Field>
          <FieldLabel htmlFor="cloudflare-hostname">Your own domain</FieldLabel>
          <Input id="cloudflare-hostname" className="h-9" value={hostname} placeholder="bridge.example.com" onChange={(event) => setHostname(event.target.value)} />
          <FieldDescription>
            {info.loggedIn || info.hasToken
              ? "Leave empty for a random trycloudflare.com address."
              : "Leave empty for a random trycloudflare.com address. For your own domain, run cloudflared tunnel login on this machine, or paste a tunnel token."}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="cloudflare-token">Tunnel token</FieldLabel>
          <Input
            id="cloudflare-token"
            className="h-9"
            type="password"
            autoComplete="off"
            value={token}
            placeholder={info.hasToken ? "Saved, paste a new one to replace it" : "Optional"}
            onChange={(event) => setToken(event.target.value)}
          />
          {info.hasToken && info.port && <FieldDescription>In Cloudflare, point the hostname at http://localhost:{info.port}</FieldDescription>}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" size="lg" className="px-4" disabled={action.busy || (hostname.trim() === (info.hostname ?? "") && !token.trim())}>
            Save
          </Button>
          {info.hasToken && (
            <Button type="button" variant="outline" size="lg" className="px-4" disabled={action.busy} onClick={() => save({ token: null })}>
              Remove token
            </Button>
          )}
        </div>
        {action.error && <FieldError>{action.error}</FieldError>}
      </form>
    </Section>
  );
}

function Password({ source, onLoggedOut }: { source: string | null; onLoggedOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();
  const logOut = () => void api("/logout", { body: {} }).finally(onLoggedOut);
  if (source) {
    return (
      <Section title="Password">
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-muted-foreground">Change it in {source}. That logs out every browser.</p>
          <div>
            <Button type="button" variant="outline" size="lg" className="px-4" onClick={logOut}>
              Log out
            </Button>
          </div>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Password">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/key", { body: { current, key: password } })).then((ok) => ok && onLoggedOut());
        }}
      >
        <Field>
          <FieldLabel htmlFor="current-password">Current password</FieldLabel>
          <Input id="current-password" className="h-9" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </Field>
        <Field data-invalid={Boolean(action.error)}>
          <FieldLabel htmlFor="new-password">New password</FieldLabel>
          <Input id="new-password" className="h-9" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
          <FieldDescription>At least 8 characters. Changing it logs out every browser.</FieldDescription>
          {action.error && <FieldError>{action.error}</FieldError>}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" size="lg" className="px-4" disabled={action.busy || !current || password.length < 8}>
            Change password
          </Button>
          <Button type="button" variant="outline" size="lg" className="px-4" onClick={logOut}>
            Log out
          </Button>
        </div>
      </form>
    </Section>
  );
}
