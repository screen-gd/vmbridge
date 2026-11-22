import type { ProviderPreference } from "../settings.ts";
import type { ProviderEntry, Wire } from "./types.ts";

const names: Record<string, string> = { codex: "Codex", claudeAgent: "Claude", opencode: "OpenCode", pi: "Pi" };

/** An agent's display name from its T3 driver or instance ID. */
export const agentName = (id: string) => names[id] ?? id;

/** Agents every VM gets installed, so T3 lists them before any VM has reported. */
export const defaultAgents = ["codex", "claudeAgent"];

const forwarded = [
  "workspaceSnapshots",
  "workspaceRescannedAt",
  "catalogDigest",
  "showInteractionModeToggle",
  "reportsContextWindow",
  "supportedRuntimeModes",
  "supportsConversationRollback",
  "supportsTextGeneration",
  "subProviders",
];

export type AgentReport = Wire & { instanceId: string; driver: string; displayName: string; enabled: boolean };

/**
 * How one VM agent appears to T3 clients. VM Bridge manages installs and sign-in, so the
 * client cannot run setup; it can only switch an agent off or rename it.
 */
export function presentAgent(provider: ProviderEntry, preference: ProviderPreference | undefined, badge: string): AgentReport {
  const enabled = provider.enabled === true && preference?.enabled !== false;
  const auth = (provider.auth ?? {}) as Wire;
  const authenticated = auth.status === "authenticated";
  const report: AgentReport = {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: preference?.displayName ?? agentName(provider.driver),
    badgeLabel: badge,
    enabled,
    installed: provider.installed === true,
    version: provider.version ?? null,
    status: enabled ? (provider.status ?? "warning") : "disabled",
    auth: { status: auth.status ?? "unknown", ...(authenticated ? { label: "VM Bridge" } : {}) },
    checkedAt: provider.checkedAt ?? new Date().toISOString(),
    availability: enabled ? provider.availability : "unavailable",
    models: enabled ? (provider.models ?? []) : [],
    setup: { canAuthenticate: false, canInstall: false },
    nativeSessions: { canList: false, canLoad: false, canResume: false },
    configurableProviders: false,
    slashCommands: enabled ? (provider.slashCommands ?? []) : [],
    skills: enabled ? (provider.skills ?? []) : [],
  };
  if (enabled) for (const field of forwarded) if (provider[field] !== undefined) report[field] = provider[field];
  if (preference?.enabled === false) report.message = "Switched off for new sessions in VM Bridge.";
  else if (!enabled) report.message = "This agent is not available on the VM.";
  else if (!authenticated) report.message = "Add this agent's sign-in in the VM Bridge dashboard.";
  else if (report.status !== "ready") report.message = "The VM reported a problem with this agent.";
  return report;
}

/** A placeholder for an agent no VM has reported yet. */
export const pendingAgent = (driver: string): ProviderEntry => ({
  instanceId: driver,
  driver,
  enabled: true,
  installed: false,
  status: "warning",
  auth: { status: "unknown" },
  models: [],
  version: null,
  checkedAt: new Date().toISOString(),
});
