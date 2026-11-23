import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { toast } from "sonner";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Add01Icon,
  ComputerIcon,
  Delete02Icon,
  DocumentCodeIcon,
  FolderUploadIcon,
  LinkSquare02Icon,
  MagicWand01Icon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import {
  agentKinds,
  instructionFor,
  instructionNames,
  type InstructionName,
  type LocalSkill,
  type Overview,
  type SkillInfo,
  type SkillSearchResult,
} from "@vmbridge/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { skillFromFile, skillFromFolderPick, skillsFromDrop, type SkillUpload } from "@/lib/skill-upload";
import { api } from "./api.ts";
import { Page, Section, type Tab } from "./Page.tsx";
import { agentNames } from "./Setup.tsx";

type SkillsTab = "installed" | "machine" | "instructions";

const tabs: Tab<SkillsTab>[] = [
  { id: "installed", label: "Installed", icon: MagicWand01Icon },
  { id: "machine", label: "This machine", icon: ComputerIcon },
  { id: "instructions", label: "Instructions", icon: DocumentCodeIcon },
];

/** Past this many installed skills, a filter box helps find one. */
const filterFrom = 6;

const installs = new Intl.NumberFormat(undefined, { notation: "compact" });

/** A skill's page on skills.sh, from its `owner/repo` and skill id. */
function SkillsShLink({ repo, skill }: { repo: string; skill: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" aria-label={`Open ${skill} on skills.sh`}>
          <a href={`https://skills.sh/${repo}/${encodeURIComponent(skill)}`} target="_blank" rel="noopener noreferrer">
            <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.75} />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open on skills.sh</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({ icon = MagicWand01Icon, title, children }: { icon?: IconSvgElement; title: string; children: string }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={icon} strokeWidth={1.75} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function Skills({ overview }: { overview: Overview }) {
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(tabs.map((entry) => entry.id)).withDefault("installed"));
  // Without files of its own (on Cloudflare Workers), VM Bridge has no machine to bring skills from.
  const shown = overview.machine ? tabs : tabs.filter((entry) => entry.id !== "machine");
  const current = shown.some((entry) => entry.id === tab) ? tab : "installed";
  return (
    <Page title="Skills" actions={<SyncState overview={overview} />} tabs={shown} tab={current} onTab={setTab}>
      {current === "installed" && <InstalledSkills skills={overview.skills} />}
      {current === "machine" && <LocalSkills overview={overview} />}
      {current === "instructions" && <Instructions overview={overview} />}
    </Page>
  );
}

/** Whether every VM has the installed skills and synced instructions yet, once there is anything to sync. */
function SyncState({ overview }: { overview: Overview }) {
  if (overview.skills.length === 0 && overview.savedInstructions.length === 0 && !overview.instructions.some((file) => file.sync)) return null;
  const pending = overview.vms.filter((vm) => vm.skillsPending).length;
  return <Badge variant="secondary">{pending ? `${pending} VM${pending === 1 ? "" : "s"} pending` : "On every VM"}</Badge>;
}

function InstalledSkills({ skills }: { skills: SkillInfo[] }) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shown = query ? skills.filter((skill) => [skill.name, skill.description ?? "", skill.ref].some((text) => text.toLowerCase().includes(query))) : skills;
  return (
    <Section
      title="Installed"
      actions={
        <div className="flex items-center gap-2">
          {skills.length > 0 && <Badge variant="secondary">{skills.length}</Badge>}
          <AddSkill installed={new Set(skills.map((skill) => skill.name))} />
        </div>
      }
    >
      {skills.length === 0 ? (
        <UploadSkills empty />
      ) : (
        <>
          {(skills.length >= filterFrom || filter) && (
            <InputGroup className="h-9">
              <InputGroupAddon>
                <HugeiconsIcon icon={Search01Icon} strokeWidth={1.75} />
              </InputGroupAddon>
              <InputGroupInput placeholder="Filter skills" aria-label="Filter installed skills" value={filter} onChange={(event) => setFilter(event.target.value)} />
            </InputGroup>
          )}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills match.</p>
          ) : (
            <ItemGroup className="gap-2">
              {shown.map((skill) => (
                <Installed key={skill.name} skill={skill} />
              ))}
            </ItemGroup>
          )}
          <UploadSkills />
        </>
      )}
    </Section>
  );
}

const sourceLabels: Record<SkillInfo["source"], string> = { "skills.sh": "skills.sh", local: "This machine", upload: "Uploaded" };

/**
 * Takes skills dropped on it or picked: each folder, SKILL.md or .zip is one skill. Read and checked in the browser,
 * then checked again by the server. With `empty`, it is the empty list's placeholder too.
 */
function UploadSkills({ empty = false }: { empty?: boolean }) {
  const action = useAction();
  const [over, setOver] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = (read: () => Promise<SkillUpload[]>) =>
    void action.run(async () => {
      const skills = await read();
      for (const skill of skills) await api("/skills", { body: { source: "upload", ...skill } });
      const [first] = skills;
      if (first) toast.success(skills.length === 1 ? `${first.name} installed. Every VM gets it.` : `${skills.length} skills installed. Every VM gets them.`);
    });
  const dragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  const dragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    // Read now: the browser empties the drop's items once this handler returns.
    const reading = skillsFromDrop(event.dataTransfer.items);
    upload(() => reading);
  };
  const picked = (read: (files: FileList) => Promise<SkillUpload>) => (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    if (files?.length) upload(async () => [await read(files)]);
    // So picking the same skill again, after fixing it, still counts as a change.
    event.target.value = "";
  };

  const pickers: ReactNode = (
    <div className="flex gap-2">
      <input
        ref={(input) => {
          // React has no prop for it: it makes the picker choose a folder.
          input?.setAttribute("webkitdirectory", "");
          folderInput.current = input;
        }}
        hidden type="file" onChange={picked(skillFromFolderPick)} />
      <input ref={fileInput} hidden type="file" accept=".md,.zip,.skill" onChange={picked((files) => skillFromFile(files[0]!))} />
      <Button variant="outline" disabled={action.busy} onClick={() => folderInput.current?.click()}>
        Choose folder
      </Button>
      <Button variant="outline" disabled={action.busy} onClick={() => fileInput.current?.click()}>
        Choose file
      </Button>
    </div>
  );
  const drag = { onDragOver: dragOver, onDragEnter: dragOver, onDragLeave: dragLeave, onDrop: drop };
  const highlight = over && "border-primary bg-primary/5";

  return (
    <div className="flex flex-col gap-2">
      {empty ? (
        <Empty {...drag} className={cn("border border-dashed transition-colors", highlight)}>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={FolderUploadIcon} strokeWidth={1.75} />
            </EmptyMedia>
            <EmptyTitle>No skills yet</EmptyTitle>
            <EmptyDescription>Drop a skill folder, SKILL.md or .zip here, or add one from skills.sh. Every VM gets it.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{pickers}</EmptyContent>
        </Empty>
      ) : (
        <div {...drag} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-4 py-3 transition-colors", highlight)}>
          <HugeiconsIcon icon={FolderUploadIcon} className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-48 flex-1 text-sm text-muted-foreground">Drop a skill folder, SKILL.md or .zip</span>
          {pickers}
        </div>
      )}
      {action.error && <FieldError>{action.error}</FieldError>}
    </div>
  );
}

function Installed({ skill }: { skill: SkillInfo }) {
  const action = useAction();
  const update = () =>
    void action.run(async () => {
      const { changed } = await api<{ changed: boolean }>(`/skills/${encodeURIComponent(skill.name)}/update`, { body: {} });
      toast.success(changed ? `${skill.name} updated.` : `${skill.name} is up to date.`);
    });
  return (
    <Item variant="outline" size="sm">
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full">
          <span className="min-w-0 truncate">{skill.name}</span>
          <Badge variant="secondary" className="gap-1.5">
            {skill.source === "local" && <HugeiconsIcon icon={ComputerIcon} className="size-3" strokeWidth={2} />}
            {sourceLabels[skill.source]}
          </Badge>
        </ItemTitle>
        {skill.description && <ItemDescription className="line-clamp-1">{skill.description}</ItemDescription>}
        {skill.ref && <ItemDescription className="truncate font-mono text-xs">{skill.ref}</ItemDescription>}
        {action.error && <FieldError>{action.error}</FieldError>}
      </ItemContent>
      <ItemActions className="gap-0.5">
        {skill.source === "skills.sh" && (
          <>
            <SkillsShLink repo={skill.ref} skill={skill.name} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Update ${skill.name}`} disabled={action.busy} onClick={update}>
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.75} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Update</TooltipContent>
            </Tooltip>
          </>
        )}
        <AlertDialog>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Remove ${skill.name}`} className="text-muted-foreground hover:text-destructive" disabled={action.busy}>
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
                </Button>
              </AlertDialogTrigger>
            </TooltipTrigger>
            <TooltipContent>Remove</TooltipContent>
          </Tooltip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {skill.name}?</AlertDialogTitle>
              <AlertDialogDescription>It comes off every VM. Skills put on a VM some other way stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void action.run(() => api(`/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" }))}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
}

/** Searches skills.sh in a dialog. It stays open after an install, so several can be added in a row. */
function AddSkill({ installed }: { installed: Set<string> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[] | null>(null);
  const search = useAction();
  const install = useAction();
  const add = (result: SkillSearchResult) =>
    void install
      .run(() => api("/skills", { body: { source: "skills.sh", repo: result.source, skill: result.skillId } }))
      .then((ok) => ok && toast.success(`${result.name} installed. Every VM gets it.`));
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="lg" className="h-9 px-3">
          <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
          Add skill
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from skills.sh</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search.run(async () => setResults(await api<SkillSearchResult[]>(`/skills/search?${new URLSearchParams({ q: query })}`)));
          }}
        >
          <InputGroup className="h-9">
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={1.75} />
            </InputGroupAddon>
            <InputGroupInput autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" aria-label="Search skills.sh" />
          </InputGroup>
          <Button type="submit" variant="outline" size="lg" className="h-9 px-3" disabled={search.busy || !query.trim()}>
            Search
          </Button>
        </form>
        <div className="-mx-4 -mb-4 flex min-h-0 flex-col gap-2 overflow-y-auto px-4 pb-4">
          {search.error && <FieldError>{search.error}</FieldError>}
          {install.error && <FieldError>{install.error}</FieldError>}
          {results?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing found.</p>}
          {results?.map((result) => (
            <Item key={`${result.source}/${result.skillId}`} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle className="max-w-full">
                  <span className="min-w-0 truncate">{result.name}</span>
                </ItemTitle>
                {/* The repository gives way first, so the install count always shows. */}
                <ItemDescription className="flex">
                  <span className="truncate">{result.source},</span>
                  <span className="shrink-0 whitespace-pre"> {installs.format(result.installs)} installs</span>
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <SkillsShLink repo={result.source} skill={result.skillId} />
                {installed.has(result.skillId) ? (
                  <Badge variant="secondary">Installed</Badge>
                ) : (
                  <Button variant="outline" disabled={install.busy} onClick={() => add(result)}>
                    Install
                  </Button>
                )}
              </ItemActions>
            </Item>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LocalSkills({ overview }: { overview: Overview }) {
  const [local, setLocal] = useState<LocalSkill[] | null>(null);
  const action = useAction();

  // Again whenever the installed set changes, so each skill shows whether it is installed.
  useEffect(() => void api<LocalSkill[]>("/skills/local").then(setLocal, () => setLocal([])), [overview.skills.length]);

  const install = (skill: LocalSkill) =>
    void action.run(() => api("/skills", { body: { source: "local", path: skill.path } })).then((ok) => ok && toast.success(`${skill.name} installed. Every VM gets it.`));

  return (
    <Section title="This machine">
      <Item variant="muted" size="sm">
        <ItemContent>
          <ItemTitle>
            <label htmlFor="sync-local-skills">Sync all skills on this machine</label>
          </ItemTitle>
          <ItemDescription>Installs every skill below, new ones too, and removes ones you delete.</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            id="sync-local-skills"
            checked={overview.syncLocalSkills}
            disabled={action.busy}
            onCheckedChange={(sync) => void action.run(async () => setLocal(await api<LocalSkill[]>("/skills/local", { method: "PUT", body: { sync } })))}
          />
        </ItemActions>
      </Item>
      {action.error && <FieldError>{action.error}</FieldError>}
      {local?.length === 0 && <EmptyState title="No skills on this machine">None in ~/.claude/skills, ~/.agents/skills or ~/.codex/skills.</EmptyState>}
      {local && local.length > 0 && (
        <ItemGroup className="gap-2">
          {local.map((skill) => (
            <Item key={skill.path} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle className="max-w-full">
                  <span className="min-w-0 truncate">{skill.name}</span>
                </ItemTitle>
                <ItemDescription className="truncate font-mono text-xs">{skill.path}</ItemDescription>
              </ItemContent>
              <ItemActions>
                {skill.installed ? (
                  <Badge variant="secondary">Installed</Badge>
                ) : (
                  <Button variant="outline" disabled={action.busy} onClick={() => install(skill)}>
                    Install
                  </Button>
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </Section>
  );
}

function Instructions({ overview }: { overview: Overview }) {
  const [saved, setSaved] = useState<Partial<Record<InstructionName, string>> | null>(null);
  // A failed load must not look like nothing saved, or saving would overwrite files the user could not see.
  const [loadFailed, setLoadFailed] = useState(false);
  const load = () => {
    setLoadFailed(false);
    void api<Partial<Record<InstructionName, string>>>("/instructions").then(setSaved, () => setLoadFailed(true));
  };
  useEffect(load, []);
  return (
    <>
      {loadFailed && (
        <Section title="Pasted files">
          <FieldError>Could not load your pasted files.</FieldError>
          <div className="flex justify-end">
            <Button variant="outline" onClick={load}>
              Try again
            </Button>
          </div>
        </Section>
      )}
      {saved &&
        instructionNames.map((name) => <PastedFile key={name} name={name} saved={saved[name] ?? ""} onSaved={setSaved} />)}
      {overview.machine && <MachineInstructions overview={overview} />}
    </>
  );
}

/** A pasted AGENTS.md or CLAUDE.md. Saving it blank removes it. */
function PastedFile({ name, saved, onSaved }: { name: InstructionName; saved: string; onSaved: (saved: Partial<Record<InstructionName, string>>) => void }) {
  const [draft, setDraft] = useState(saved);
  const action = useAction();
  const readers = agentKinds.filter((agent) => instructionFor[agent] === name).map((agent) => agentNames[agent]);
  const save = (text: string) =>
    void action
      .run(async () => onSaved(await api(`/instructions/${name}`, { method: "PUT", body: { text } })))
      .then((ok) => {
        if (!ok) return;
        if (!text.trim()) setDraft("");
        toast.success(text.trim() ? `${name} saved. Every VM gets it.` : `${name} removed.`);
      });
  return (
    <Section
      title={name}
      actions={
        <div className="flex gap-1.5">
          {readers.map((reader) => (
            <Badge key={reader} variant="secondary">
              {reader}
            </Badge>
          ))}
        </div>
      }
    >
      <Textarea
        aria-label={name}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={action.busy}
        placeholder={`Paste your ${name}`}
        spellCheck={false}
        className="max-h-[60vh] min-h-40 font-mono text-xs md:text-xs"
      />
      {action.error && <FieldError>{action.error}</FieldError>}
      <div className="flex justify-end gap-2">
        {saved && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={action.busy}>
                Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
                <AlertDialogDescription>It comes off every VM, unless it was edited there.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => save("")}>
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button disabled={action.busy || draft === saved} onClick={() => save(draft)}>
          Save
        </Button>
      </div>
    </Section>
  );
}

/** The agents' own files on the machine VM Bridge runs on. A pasted file wins over them. */
function MachineInstructions({ overview }: { overview: Overview }) {
  const action = useAction();
  const files = overview.instructions;
  const toggle = (agent: string, sync: boolean) => void action.run(() => api(`/instructions/${agent}`, { method: "PUT", body: { sync } }));
  return (
    <Section title="This machine">
      {files.length === 0 ? (
        <EmptyState icon={DocumentCodeIcon} title="No instructions files">No CLAUDE.md or AGENTS.md in ~/.claude, ~/.codex or ~/.config/opencode.</EmptyState>
      ) : (
        <ItemGroup className="gap-2">
          {files.map((file) => {
            const pasted = overview.savedInstructions.includes(instructionFor[file.agent]);
            return (
              <Item key={file.agent} variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    <label htmlFor={`instructions-${file.agent}`}>{agentNames[file.agent]}</label>
                  </ItemTitle>
                  <ItemDescription className="truncate font-mono text-xs">{file.path}</ItemDescription>
                  {pasted && file.sync && <ItemDescription>Using the pasted {instructionFor[file.agent]} instead.</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <Switch id={`instructions-${file.agent}`} checked={file.sync} disabled={action.busy} onCheckedChange={(sync) => toggle(file.agent, sync)} />
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {action.error && <FieldError>{action.error}</FieldError>}
    </Section>
  );
}
