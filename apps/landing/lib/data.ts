export type ProviderId = "boxd" | "instabox" | "daytona" | "boat" | "railway";

export interface Provider {
  id: ProviderId;
  name: string;
  logo: string;
  /** Tile behind the logo, matching the dashboard. */
  tile: string;
  inset: string;
  /** Accent used in the 3D scene and charts. */
  color: string;
  sleep: string;
  wake: string;
  sizes: [string, string, string];
  reach: string;
  safetyNet: string;
  /** Measured on fresh VMs in live runs. Missing when not measured yet. */
  measured?: { ready: string; wakeSeconds: [number, number]; browseMs: number };
}

export const providers: Provider[] = [
  {
    id: "boxd",
    name: "boxd",
    logo: "/providers/boxd.svg",
    tile: "#000",
    inset: "24%",
    color: "#f4f4f5",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["1 vCPU, 4 GB", "2 vCPU, 8 GB", "4 vCPU, 16 GB"],
    reach: "Public proxy",
    safetyNet: "Suspends after 60 min idle",
    measured: { ready: "22 to 24 s", wakeSeconds: [6, 11], browseMs: 160 },
  },
  {
    id: "instabox",
    name: "Instabox",
    logo: "/providers/instabox.svg",
    tile: "#000",
    inset: "0%",
    color: "#38bdf8",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["2 vCPU, 4 GB", "4 vCPU, 8 GB", "8 vCPU, 16 GB"],
    reach: "Published port",
    safetyNet: "Suspends after 30 min idle",
    measured: { ready: "21 s", wakeSeconds: [8, 8], browseMs: 229 },
  },
  {
    id: "daytona",
    name: "Daytona",
    logo: "/providers/daytona.png",
    tile: "#000",
    inset: "0%",
    color: "#3ecf8e",
    sleep: "Stop, files kept",
    wake: "Start",
    sizes: ["1 vCPU, 1 GB", "2 vCPU, 4 GB", "4 vCPU, 8 GB"],
    reach: "Private preview with a token header",
    safetyNet: "Stops after 60 min without traffic",
    measured: { ready: "16 to 19 s", wakeSeconds: [10, 11], browseMs: 156 },
  },
  {
    id: "boat",
    name: "Boat",
    logo: "/providers/boat.svg",
    tile: "#fff",
    inset: "18%",
    color: "#5b7cfa",
    sleep: "Stop, disk kept",
    wake: "Resume",
    sizes: ["2 vCPU, 4 GB", "4 vCPU, 8 GB", "8 vCPU, 16 GB"],
    reach: "Preview host with a cookie",
    safetyNet: "Stops 12 h after start",
  },
  {
    id: "railway",
    name: "Railway",
    logo: "/providers/railway.svg",
    tile: "#13111c",
    inset: "20%",
    color: "#a78bfa",
    sleep: "Checkpoint, then remove",
    wake: "New VM from the checkpoint",
    sizes: ["1 vCPU, 2 GB", "2 vCPU, 4 GB", "4 vCPU, 8 GB"],
    reach: "Public domain",
    safetyNet: "None",
    measured: { ready: "57 s", wakeSeconds: [45, 45], browseMs: 211 },
  },
];

export const github = "https://github.com/vkpdeveloper/vmbridge";
export const install = `curl -fsSL https://raw.githubusercontent.com/vkpdeveloper/vmbridge/main/install.sh | sh`;

export const commands = [
  { command: "vmbridge", args: "[run] [--host 0.0.0.0] [--port 3774]", does: "Start in this terminal" },
  { command: "vmbridge stop", args: "", does: "Stop, including the background service" },
  { command: "vmbridge service install", args: "[--host] [--port]", does: "Run in the background at login (launchd or systemd)" },
  { command: "vmbridge service uninstall", args: "", does: "Remove the background service" },
  { command: "vmbridge key", args: "", does: "Set a new dashboard key" },
];

/** The agent CLIs VM Bridge installs on every VM. */
export const agents = [
  { id: "codex", name: "Codex", logo: "/agents/codex.svg" },
  { id: "claude", name: "Claude", logo: "/agents/claude.svg" },
] as const;
export type Agent = (typeof agents)[number];

/** Real terminal output beside each step, index-matched to copy.steps.items. */
export const stepLogs: string[][] = [
  ["$ vmbridge", "VM Bridge 0.2.0 is running.", "  This machine         http://127.0.0.1:3774/dashboard"],
  ["Provider boxd connected", "Size: 2 vCPU, 8 GB", "Sleep after 5 idle minutes"],
  ['Pairing link "MacBook" created', "MacBook paired", "iPhone paired"],
  ["Creating a VM for Hello-World", "Installing T3, Codex and Claude", "vm-df9bca ready on boxd", "Cloned Hello-World"],
];

/**
 * The startup output of `vmbridge run`, as printed by apps/cli/src/index.ts: each address line is
 * `  ${label.padEnd(20)} ${url}/dashboard` with the labels from apps/server/src/network.ts.
 */
export const heroScript: string[] = [
  "$ vmbridge",
  "VM Bridge 0.2.0 is running.",
  "",
  "  This machine         http://127.0.0.1:3774/dashboard",
  "  Local network (en0)  http://192.168.1.20:3774/dashboard",
  "  Tailscale IP         http://100.101.102.103:3774/dashboard",
];

/**
 * What each command in `commands` really prints, index-matched. Every output line is copied from
 * apps/cli/src/index.ts and apps/cli/src/service.ts, on macOS with home /Users/you.
 */
export const cliScripts: string[][] = [
  [
    "$ vmbridge",
    "VM Bridge 0.2.0 is running.",
    "",
    "  This machine         http://127.0.0.1:3774/dashboard",
    "  Local network (en0)  http://192.168.1.20:3774/dashboard",
    "  Tailscale IP         http://100.101.102.103:3774/dashboard",
    "  Tailscale name       http://your-mac.your-tailnet.ts.net:3774/dashboard",
    "",
    "  Turn on Tailscale HTTPS in the dashboard settings for an https:// address.",
    "",
    "Open the dashboard to set up providers and pair devices. Press Ctrl+C to stop.",
  ],
  [
    "$ vmbridge stop",
    "VM Bridge stopped.",
    "The background service starts again at next login, or now with `vmbridge service install`.",
  ],
  ["$ vmbridge service install", "VM Bridge now runs in the background on port 3774. Logs: /Users/you/.vmbridge/vmbridge.log"],
  ["$ vmbridge service uninstall", "Background service removed."],
  [
    "$ vmbridge key",
    "Choose a dashboard key (at least 8 characters): ********",
    "Type it again: ********",
    "Dashboard key saved.",
  ],
];

export interface Route {
  /** Real RPC names from apps/server/src/gateway/rpc.ts. */
  call: string;
  target: string;
  time: string;
  kind: "bridge" | "vm";
}

/** A short request log showing what the bridge answers itself and what goes to a VM. */
export const routes: Route[] = [
  { call: "server.getConfig", target: "bridge", time: "1 ms", kind: "bridge" },
  { call: "orchestration.getThreadProjection", target: "bridge, saved copy", time: "< 1 ms", kind: "bridge" },
  { call: "filesystem.browse", target: "vm-df9bca", time: "160 ms", kind: "vm" },
  { call: "orchestration.dispatchCommand", target: "vm-df9bca", time: "streaming", kind: "vm" },
];
