// Types shared by the VM Bridge server and its web dashboard. The admin API returns these shapes.

export const providerIds = ["boat", "boxd", "daytona", "e2b", "freestyle", "instabox", "railway", "superserve"] as const;
export type ProviderId = (typeof providerIds)[number];

export const vmSizes = ["small", "medium", "large"] as const;
export type VmSize = (typeof vmSizes)[number];

export interface ProviderField {
  key: string;
  label: string;
  kind: "secret" | "text" | "select";
  required: boolean;
  help?: string;
  placeholder?: string;
}

/** How a provider keeps a VM between bursts of work. */
export type SleepMode = "pause" | "stop" | "checkpoint";

export interface ProviderFeatures {
  sleep: SleepMode;
  /** VM disk and agent sessions survive sleep. */
  keepsDisk: boolean;
  /** Memory and running processes survive sleep. */
  keepsMemory: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  website: string;
  fields: ProviderField[];
  features: ProviderFeatures;
  sizes: Record<VmSize, string>;
  /** The size new VMs get when no setting or rule picks one. */
  defaultSize: VmSize;
  /** Non-secret field values. Secret fields report only whether they are set. */
  values: Record<string, string>;
  secretsSet: string[];
  configured: boolean;
  /** Added in Setup, so VM Bridge can create VMs on it. */
  added: boolean;
  /** New VMs go here unless a repository rule picks another provider. */
  isDefault: boolean;
}

/** Where new VMs for one GitHub repository go. Null fields fall back to the defaults. */
export interface RepoRule {
  /** `owner/name` */
  repo: string;
  provider: ProviderId | null;
  size: VmSize | null;
}

export interface SelectOption {
  value: string;
  label: string;
  detail?: string;
}

export type AddressKind = "local" | "lan" | "tailscale" | "tailscale-dns" | "tailscale-https";

export interface Address {
  kind: AddressKind;
  label: string;
  url: string;
}

export interface NetworkInfo {
  port: number;
  host: string;
  addresses: Address[];
  tailscale: {
    installed: boolean;
    running: boolean;
    dnsName: string | null;
    httpsUrl: string | null;
  };
}

export interface PairingLink {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

/** A device paired with VM Bridge through a pairing link. */
export interface ClientInfo {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

export type VmState = "provisioning" | "starting" | "ready" | "busy" | "sleeping" | "error" | "gone";

export interface VmSession {
  threadId: string;
  title: string;
  projectId: string | null;
  model: string | null;
  provider: string | null;
  status: string;
  /** A turn is running, queued, or waiting on an approval. */
  working: boolean;
  updatedAt: string | null;
}

/** Used and total, in bytes. */
export interface Usage {
  used: number;
  total: number;
}

/** One reading of an awake VM's resources. A part the VM could not report is null. */
export interface VmStats {
  /** When VM Bridge took the reading. */
  at: number;
  /** The VM's own memory, or its container's limit when it has one. */
  memory: Usage | null;
  /** Share of the last 10 s some task waited on memory (PSI `some avg10`), 0 to 100. Null without PSI. */
  memoryPressure: number | null;
  /** CPU use over one second as a share of all cores, 0 to 1. */
  cpu: { usage: number; cores: number } | null;
  /** The filesystem holding /workspace. */
  disk: Usage | null;
  /** Memory is nearly full or tasks often wait on it. */
  highMemory: boolean;
}

export interface VmInfo {
  id: string;
  name: string;
  provider: ProviderId;
  providerLabel: string;
  sandboxId: string | null;
  size: VmSize;
  sizeLabel: string;
  state: VmState;
  error: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  lastConnectedAt: number | null;
  lastSleptAt: number | null;
  /** When the idle timer will put the VM to sleep, if it is awake and idle. */
  sleepsAt: number | null;
  projects: string[];
  sessions: VmSession[];
  t3Version: string | null;
  /** T3 on the VM has not started with the current sign-ins and environment variables yet. */
  updatePending: boolean;
  /** The latest resource reading while the VM is awake. */
  stats: VmStats | null;
  /** The VM has not got the installed skills or synced instructions yet. A sleeping VM gets them when it wakes. */
  skillsPending: boolean;
}

/** Where an installed skill comes from: skills.sh, or a folder on the machine running VM Bridge. */
export type SkillSource = "skills.sh" | "local";

/** A skill VM Bridge installs on every VM. */
export interface SkillInfo {
  /** Its folder name on the VMs. */
  name: string;
  source: SkillSource;
  /** `owner/repo` for skills.sh, the folder for a local skill. */
  ref: string;
  description: string | null;
  updatedAt: number;
}

/** A skill found in this machine's Claude Code or Codex skill folders. */
export interface LocalSkill {
  name: string;
  path: string;
  description: string | null;
  installed: boolean;
}

/** An agent's global instructions file found on the machine running VM Bridge. */
export interface InstructionFile {
  agent: AgentKind;
  path: string;
  /** Every VM gets it, at the path that agent reads. */
  sync: boolean;
}

export interface SkillSearchResult {
  /** `owner/repo` */
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

export interface ProjectInfo {
  id: string;
  title: string;
  url: string;
  branch: string | null;
  /** VMs holding the project, primary first. */
  vmIds: string[];
  createdAt: number;
}

export interface Setup {
  provider: boolean;
  github: boolean;
  agents: boolean;
}

export const agentKinds = ["codex", "claude", "opencode"] as const;
export type AgentKind = (typeof agentKinds)[number];

/**
 * How a profile signs its agent in. `chatgpt`: Codex device sign-in. `setup-token`: `claude setup-token`.
 * `auth-token`: ANTHROPIC_AUTH_TOKEN, optionally sent to an Anthropic-compatible base URL. `api-key`: OpenCode key.
 */
export type AgentAuthMethod = "chatgpt" | "setup-token" | "auth-token" | "api-key";

/** An agent sign-in saved in VM Bridge. Each agent uses one profile at a time on every VM. */
export interface AgentProfile {
  id: string;
  agent: AgentKind;
  method: AgentAuthMethod;
  name: string;
  /** The ChatGPT account email, or the base URL an Anthropic token goes to. */
  detail: string | null;
  createdAt: number;
  inUse: boolean;
  /** Set when the sign-in stopped working, such as a Codex sign-in that can no longer refresh. */
  error: string | null;
}

/** A Claude sign-in waiting for the code claude.ai shows after approval. */
export interface ClaudeLogin {
  id: string;
  url: string;
}

/** A Codex device sign-in in progress. */
export interface CodexLogin {
  id: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  status: "pending" | "done" | "failed";
  error: string | null;
}

/** The GitHub account VM Bridge's personal access token belongs to. */
export interface GitHubAccount {
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
  /** The address VMs commit with: GitHub's private noreply address for the account. */
  email: string;
  /** A classic token's scopes. Null for fine-grained tokens, which have no scope list. */
  scopes: string[] | null;
  expiresAt: number | null;
  checkedAt: number;
}

export interface BridgeSettings {
  /** Null: each provider's default size. */
  vmSize: VmSize | null;
  idleMinutes: number;
  t3Version: string | null;
}

export interface Overview {
  bridge: { id: string; version: string; startedAt: number };
  setup: Setup;
  /** Added providers, in the order they were added. */
  providers: ProviderInfo[];
  defaultProvider: ProviderId | null;
  repoRules: RepoRule[];
  github: GitHubAccount | null;
  agents: AgentProfile[];
  /** Names of the environment variables every VM gets. Their values never leave VM Bridge's server. */
  env: string[];
  settings: BridgeSettings;
  clients: ClientInfo[];
  vms: VmInfo[];
  projects: ProjectInfo[];
  skills: SkillInfo[];
  /** Every skill on this machine is installed and kept in sync, not only the ones picked. */
  syncLocalSkills: boolean;
  instructions: InstructionFile[];
}

export interface TrafficEvent {
  id: number;
  at: number;
  kind: "rpc" | "http" | "provider" | "system";
  operation: string;
  clientId?: string;
  vmId?: string;
  status?: "ok" | "error";
  durationMs?: number;
}

export type LiveMessage =
  | { type: "traffic"; event: TrafficEvent }
  | { type: "overview"; overview: Overview };

export interface PairingUrl {
  kind: AddressKind;
  label: string;
  url: string;
}

export interface CreatedPairing {
  link: PairingLink;
  urls: PairingUrl[];
}

export interface ApiError {
  error: string;
}
