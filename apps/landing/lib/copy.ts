/**
 * Every sentence on the landing page. Components read from here and hold no text of their own.
 * Facts such as commands, provider names and timings live in data.ts.
 * The limit after each slot is the longest it may be, in characters.
 */
export const copy = {
  meta: {
    /** 60 */
    title: "VM Bridge: T3 Code agents on cloud VMs",
    /** 160 */
    description:
      "Pair an unchanged T3 Code client once. VM Bridge runs one cloud VM per project, sleeps idle VMs, and wakes them when you send a message.",
  },

  nav: { how: "Setup", providers: "Providers", docs: "Docs", github: "GitHub" },

  hero: {
    /** 48. One line on desktop, two on a phone. */
    title: "Every T3 Code project gets its own cloud VM",
    /** 150. What it does and why it matters, in one or two sentences. */
    body: "Pair an unchanged T3 Code client once. VM Bridge creates VMs on your provider, sleeps them when idle, and wakes them when you send a message.",
    /** 20 */
    docs: "Read the docs",
    /** 40. Sits under the diagram, which visitors can click. */
    hint: "Click a VM to sleep or wake it",
  },

  /** Labels on the diagram of devices, VM Bridge and VMs. 16 each. */
  diagram: {
    devices: "Devices",
    bridge: "VM Bridge",
    vms: "Cloud VMs",
    online: "Online",
    asleep: "Asleep",
    waking: "Waking",
  },

  /** Four steps from install to a running project. Each step shows a real command or log line beside it. */
  steps: {
    /** 40 */
    title: "Setup takes four steps",
    /** 140 */
    body: "Run one executable on macOS or Linux. After the first command, all configuration happens in the browser.",
    /** Each title 24, each body 150. */
    items: [
      {
        title: "Run VM Bridge",
        body: "First run asks for a dashboard key. VM Bridge stores state in ~/.vmbridge, listens on port 3774, and serves /dashboard.",
      },
      {
        title: "Choose a provider",
        body: "Add a key for boxd, Instabox, Daytona, Boat, or Railway. Then connect GitHub, add agent sign-ins, and set the VM size and idle timeout.",
      },
      {
        title: "Pair T3 Code",
        body: "Create a single-use pairing link under Devices and paste it into T3 Code as a remote environment. Each device gets its own token.",
      },
      {
        title: "Open a project",
        body: "VM Bridge creates a VM for the repository, installs Node, T3, Codex, and Claude, starts the T3 server, and clones the project.",
      },
    ],
  },

  /** The life of one VM, drawn as a timeline with four states. */
  lifecycle: {
    /** 40 */
    title: "Awake only when in use",
    /** 160 */
    body: "VM Bridge tracks open clients, running turns, and pending approvals. When a VM sits idle, it saves the threads and puts the VM to sleep.",
    /** Each name 10, each body 110. */
    states: [
      { name: "Online", body: "The VM is running and connected to VM Bridge. Agents handle turns and stream replies back to T3 Code." },
      { name: "Idle", body: "No device is active and no turn, approval, or automation is waiting. The 5-minute default timer starts." },
      { name: "Asleep", body: "VM Bridge saves each thread and pauses, stops, or checkpoints the VM. Threads stay readable in T3 Code." },
      { name: "Waking", body: "Send a message and VM Bridge brings the VM back with your files intact, then delivers the message." },
    ],
  },

  /** A short request log showing which calls the bridge answers itself and which go to a VM. */
  routing: {
    /** 40 */
    title: "One connection, routed per project",
    /** 170 */
    body: "To T3 Code, VM Bridge looks like a single T3 server. It keeps one connection to each awake VM, routes calls by project or thread, and answers local reads itself.",
    /** Column headings, 12 each. */
    columns: { call: "Request", target: "Answered by", time: "Time" },
    /** Each 90. One line under the log per kind of request. */
    notes: {
      bridge: "Config, the project list, and sleeping threads come from VM Bridge in about 1 ms.",
      vm: "Messages, file browsing, and Git status go to the project's VM, about 150 to 230 ms away.",
    },
  },

  /** A table of the five providers with measured timings. */
  providers: {
    /** 40 */
    title: "Five supported sandbox providers",
    /** 150 */
    body: "Use your own account and API key, one provider at a time. Wake times depend on whether the provider pauses, stops, or checkpoints VMs.",
    /** Column headings, 14 each. */
    columns: { provider: "Provider", sleep: "Sleep", ready: "New VM", wake: "Wake", latency: "Round trip" },
    /** 90. Shown under the table. */
    note: "Measured on fresh VMs in live runs. Round trip is filesystem.browse. Boat is unmeasured.",
    /** 16. Fills a cell with no measurement. */
    unmeasured: "Not measured",
  },

  /** Screenshots of the dashboard behind four tabs. */
  dashboard: {
    /** 40 */
    title: "A web dashboard behind one key",
    /** 150 */
    body: "Inspect VMs, request logs, and devices at /dashboard. The API never returns saved secrets, and logs never store message text or tokens.",
    /** Each label 10, each caption 90. */
    tabs: {
      canvas: { label: "Canvas", caption: "Paired devices, VM Bridge, and each VM with its status, size, and request rate." },
      logs: { label: "Logs", caption: "Filterable stream of every call, its source, and how long it took." },
      setup: { label: "Setup", caption: "Pick the active provider, replace its API key, and manage GitHub and agent sign-ins." },
      devices: { label: "Devices", caption: "Create 15-minute pairing links, see connected devices, and remove any device." },
    },
  },

  /** The command reference, as a table. */
  cli: {
    /** 40 */
    title: "Five commands",
    /** 150 */
    body: "Run VM Bridge in a terminal or as a login service via launchd or systemd. It listens on 0.0.0.0 by default for LAN and Tailscale access.",
  },

  install: {
    /** 40 */
    title: "One executable for macOS and Linux",
    /** 110 */
    body: "One command puts the server, dashboard, and CLI in ~/.local/bin. Run it again to update.",
    /** 20 */
    docs: "Read the docs",
  },

  footer: {
    /** 60 */
    line: "VM Bridge runs T3 Code agents on cloud VMs.",
  },
} as const;
