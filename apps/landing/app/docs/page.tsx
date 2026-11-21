import type { Metadata } from "next";
import { Footer, Nav } from "@/components/Chrome";
import { ProviderLogo } from "@/components/brand";
import { Command, CopyButton } from "@/components/CopyButton";
import { DocsNav, type DocsSection } from "@/components/DocsNav";
import { Topology } from "@/components/Topology";
import { commands, install, providers } from "@/lib/data";
import { frame } from "@/lib/styles";

export const metadata: Metadata = { title: "Docs" };

const sections: DocsSection[] = [
  { id: "overview", title: "Overview" },
  { id: "install", title: "Install" },
  { id: "run", title: "Run" },
  { id: "setup", title: "Set up the dashboard" },
  { id: "pair", title: "Pair T3 Code" },
  { id: "flow", title: "How a request flows" },
  { id: "sleep", title: "Sleep and wake" },
  { id: "providers", title: "Providers" },
  { id: "sign-in", title: "Agent sign-ins and GitHub" },
  { id: "network", title: "Addresses and Tailscale" },
  { id: "security", title: "Data and security" },
  { id: "troubleshooting", title: "Troubleshooting" },
  { id: "develop", title: "Develop" },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-b py-10 first:pt-0 last:border-b-0">
      <h2 className="text-2xl font-semibold tracking-tight">
        <a href={`#${id}`} className="hover:underline hover:decoration-faint hover:underline-offset-4">
          {title}
        </a>
      </h2>
      <div className="mt-4 space-y-4 leading-7 text-pretty text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>;
}

function Block({ children }: { children: string }) {
  return (
    <div className="relative rounded-md bg-card">
      <pre className="overflow-x-auto p-4 pr-12 font-mono text-[13px] leading-6 text-foreground">{children}</pre>
      <CopyButton text={children} className="absolute top-2 right-2" />
    </div>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-[11px] size-1 shrink-0 rounded-full bg-faint" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Table({ head, rows }: { head: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="bg-card text-foreground">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="px-4 py-2.5 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={`px-4 py-2.5 align-top ${j === 0 ? "text-foreground" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Docs() {
  return (
    <>
      <Nav />
      <div className={`${frame} flex gap-12 px-6 sm:px-8`}>
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-52 shrink-0 overflow-y-auto py-10 lg:block">
          <DocsNav sections={sections} />
        </aside>

        <main className="min-w-0 flex-1 py-10 lg:max-w-3xl">
          <h1 className="title">How VM Bridge works</h1>

          <details className="mt-6 rounded-md border bg-card lg:hidden">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">On this page</summary>
            <div className="border-t px-2 py-2">
              <DocsNav sections={sections} />
            </div>
          </details>

          <div className="mt-10">
            <Section id="overview" title="Overview">
              <p>
                VM Bridge runs <strong>T3 Code</strong> agents on cloud VMs. You pair an unchanged T3 Code app with VM Bridge once. After that, VM
                Bridge creates, wakes and sleeps VMs on your sandbox provider, and sends each project and thread to the right one.
              </p>
              <List
                items={[
                  "One project per VM. Projects never share a disk, a process list or a shell.",
                  "A VM sleeps after it has been idle for a set time, and wakes when you send a message.",
                  "One provider at a time: boxd, Instabox, Daytona, Boat or Railway.",
                  "Everything is set up from a web dashboard behind one key: provider keys, GitHub, agent sign-ins and device pairing.",
                  "T3 Code needs no changes. To the app, VM Bridge looks like a single T3 server.",
                ]}
              />
            </Section>

            <Section id="install" title="Install">
              <p>
                VM Bridge runs on macOS and Linux. You need an account with one of the supported providers, and T3 Code on the devices you want to
                pair. One command installs the server, the dashboard and the command line, as one file in <Code>~/.local/bin</Code>:
              </p>
              <Block>{install}</Block>
              <p>
                Then run <Code>vmbridge</Code>. It asks for a dashboard key on first run. Run the same command again to update.
              </p>
              <p>To build from source instead, with Bun 1.4.4 or newer:</p>
              <Block>{`git clone https://github.com/vkpdeveloper/vmbridge
cd vmbridge
bun install
bun run build          # dist/vmbridge
./dist/vmbridge`}</Block>
            </Section>

            <Section id="run" title="Run">
              <Table
                head={["Command", "What it does"]}
                rows={commands.map((c) => [
                  <code key="c" className="font-mono text-[13px] whitespace-nowrap">
                    {c.command} <span className="text-faint">{c.args}</span>
                  </code>,
                  c.does,
                ])}
              />
              <p>
                On first start, VM Bridge asks for a <strong>dashboard key</strong> of at least 8 characters. On a machine with no terminal, set{" "}
                <Code>VMBRIDGE_DASHBOARD_KEY</Code> for the first start instead.
              </p>
              <p>
                Data lives in <Code>~/.vmbridge</Code>. Set <Code>VMBRIDGE_HOME</Code> to move it. The background service uses launchd on macOS and
                systemd on Linux, and writes its log to <Code>~/.vmbridge/vmbridge.log</Code>.
              </p>
              <Command text="vmbridge service install --port 3774" />
            </Section>

            <Section id="setup" title="Set up the dashboard">
              <p>
                Open <Code>/dashboard</Code> on any address VM Bridge printed and log in with your key. Setup has three tabs.
              </p>
              <List
                items={[
                  <>
                    <strong>Provider.</strong> Pick a provider and paste its key. VM Bridge checks the key before saving it.
                  </>,
                  <>
                    <strong>GitHub.</strong> A personal access token so agents can clone, push and open pull requests.
                  </>,
                  <>
                    <strong>Agent sign-in.</strong> Sign in to Codex with ChatGPT and to Claude with your Claude account, or add a token or an OpenCode key.
                  </>,
                ]}
              />
              <p>
                Under <strong>Settings</strong> you choose the VM size, how many idle minutes before a VM sleeps (5 by default), and the T3 version
                to install on VMs.
              </p>
            </Section>

            <Section id="pair" title="Pair T3 Code">
              <p>
                Under <strong>Devices</strong>, name the device and create a pairing link. In T3 Code, add a remote environment and paste the link.
              </p>
              <List
                items={[
                  "Each link works once and expires after 15 minutes.",
                  "Pairing swaps the link for a token that only that device holds. VM Bridge stores a hash of it.",
                  "Remove a device under Devices to sign it out right away.",
                ]}
              />
            </Section>

            <Section id="flow" title="How a request flows">
              <p>
                T3 Code keeps one connection to VM Bridge. VM Bridge keeps one connection to the T3 server on each awake VM, and routes each request
                by its project or thread.
              </p>
              <div className="not-prose my-6 border">
                <Topology stacked />
              </div>
              <List
                items={[
                  <>
                    <strong>Answered by the bridge.</strong> Config, the project list and threads on sleeping VMs come from VM Bridge in about 1 ms.
                  </>,
                  <>
                    <strong>Forwarded to a VM.</strong> Messages, file browsing and Git status go to the project&apos;s VM, about 150 to 230 ms away
                    depending on the provider.
                  </>,
                  <>
                    <strong>New projects.</strong> Opening a repository creates a VM, installs Node, T3 and the agent CLIs, starts T3 and clones the
                    repository. A fresh VM is ready in 16 to 24 seconds, or about a minute on Railway.
                  </>,
                ]}
              />
            </Section>

            <Section id="sleep" title="Sleep and wake">
              <p>
                A VM counts as idle when no device has used it and nothing is waiting on it: no running agent turn, queued work, pending approval
                or enabled automation. After the idle minutes you set, VM Bridge saves each thread on that VM and puts it to sleep. The threads stay
                readable in T3 Code while it sleeps.
              </p>
              <p>
                Send a message in a sleeping thread and T3 Code shows <Code>Waking the boxd VM...</Code> until the VM answers. Then the message goes
                through as usual.
              </p>
              <Table
                head={["Provider", "Sleep", "Wake", "Measured wake"]}
                rows={providers.map((p) => [
                  p.name,
                  p.sleep,
                  p.wake,
                  p.measured ? `${p.measured.wakeSeconds[0]}${p.measured.wakeSeconds[1] !== p.measured.wakeSeconds[0] ? ` to ${p.measured.wakeSeconds[1]}` : ""} s` : "Not measured yet",
                ])}
              />
              <p>
                Each provider also has its own idle limit as a safety net in case VM Bridge is offline. Railway has none, so VM Bridge never sets
                one there.
              </p>
            </Section>

            <Section id="providers" title="Providers">
              <div className="grid gap-2 sm:grid-cols-2">
                {providers.map((p) => (
                  <div key={p.id} className="flex items-start gap-3 rounded-md border bg-card p-3">
                    <ProviderLogo provider={p} className="size-9 rounded-md ring-white/10" />
                    <div className="min-w-0 text-sm">
                      <div className="font-medium text-foreground">{p.name}</div>
                      <div>{p.sizes.join(" · ")}</div>
                      <div className="text-faint">Reached through: {p.reach}</div>
                    </div>
                  </div>
                ))}
              </div>
              <List
                items={[
                  <>
                    <strong>boxd</strong> wakes a paused VM on any traffic, so VM Bridge closes its connection before it pauses one.
                  </>,
                  <>
                    <strong>Daytona</strong> uses container sandboxes, which stop rather than pause. Files stay, and T3 starts fresh on wake.
                  </>,
                  <>
                    <strong>Boat</strong> VMs start in the Boat environment you choose.
                  </>,
                  <>
                    <strong>Railway</strong> has no pause. Sleep saves a checkpoint and removes the VM. Wake creates a new VM from it. Railway needs
                    an account or workspace API token and an environment ID.
                  </>,
                  <>
                    <strong>Instabox</strong> uses the agent-browser template.
                  </>,
                ]}
              />
            </Section>

            <Section id="sign-in" title="Agent sign-ins and GitHub">
              <p>
                Agents and git sign in only with what you add in Setup, never with sign-ins from the VM provider. Each agent sign-in is a profile saved under{" "}
                <Code>~/.vmbridge/auths</Code>, readable only by you. Each agent uses one profile at a time, and VMs get it when they start.
              </p>
              <Table
                head={["Sign-in", "Set on the VM as"]}
                rows={[
                  ["Codex, signed in with ChatGPT", "auth.json in a private CODEX_HOME"],
                  ["Claude account or subscription token", <Code key="c">CLAUDE_CODE_OAUTH_TOKEN</Code>],
                  ["Claude auth token", <Code key="a">ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL</Code>],
                  ["OpenCode API key", <Code key="o">OPENCODE_API_KEY</Code>],
                  ["GitHub token", <Code key="g">GH_TOKEN, GITHUB_TOKEN</Code>],
                ]}
              />
              <p>
                Git on each VM signs in to GitHub with the token and commits as your GitHub account, using GitHub&apos;s private noreply email.
                SSH remotes such as <Code>git@github.com:you/app.git</Code> go over HTTPS with the token. The GitHub CLI, <Code>gh</Code>, is
                installed and signed in, so agents can open pull requests.
              </p>
              <p>
                VM Bridge refreshes the Codex sign-in before it expires and gives the new tokens to every awake VM, so VMs never sign each
                other out.
              </p>
              <p>
                Signing in with your Claude account makes the same one-year token as <Code>claude setup-token</Code>. Approve on claude.ai, then
                paste the code it shows into the dashboard.
              </p>
            </Section>

            <Section id="network" title="Addresses and Tailscale">
              <p>
                VM Bridge listens on <Code>0.0.0.0</Code> by default, so phones and laptops on your network can reach it. Pass{" "}
                <Code>--host 127.0.0.1</Code> to keep it on this machine.
              </p>
              <Table
                head={["Address", "Example"]}
                rows={[
                  ["This machine", <Code key="1">http://127.0.0.1:3774</Code>],
                  ["Local network", <Code key="2">http://192.168.1.20:3774</Code>],
                  ["Tailscale IP", <Code key="3">http://100.101.102.103:3774</Code>],
                  ["Tailscale name", <Code key="4">http://mac-mini.tail.ts.net:3774</Code>],
                  ["Tailscale HTTPS", <Code key="5">https://mac-mini.tail.ts.net</Code>],
                ]}
              />
              <p>Turn on Tailscale HTTPS under Settings to reach VM Bridge from anywhere on your tailnet with a certificate.</p>
            </Section>

            <Section id="security" title="Data and security">
              <List
                items={[
                  <>
                    Everything is in <Code>~/.vmbridge/main.db</Code>, readable only by your user.
                  </>,
                  "The dashboard API never returns a saved secret. You can replace a key, not read it back.",
                  "Logs record which call went where and how long it took. They never hold message contents or tokens.",
                  "Each T3 server on a VM requires its own session token on every request, and only VM Bridge holds it. Public preview URLs show nothing without it.",
                  "Requests to VMs refuse redirects, so a token can never be sent to another site.",
                ]}
              />
            </Section>

            <Section id="troubleshooting" title="Troubleshooting">
              <Table
                head={["What you see", "What to do"]}
                rows={[
                  ["An agent shows as signed out on a VM", "Add its sign-in under Setup, or in your provider's dashboard if it supplies them."],
                  ["The pairing link does not work", "Links work once and expire after 15 minutes. Create a new one."],
                  ["The T3 server on a VM did not answer", "The VM may be busy or the provider slow. Check the VM on the dashboard canvas, then retry."],
                  ["Waking takes longer than usual", "Stopped VMs (Daytona, Boat) start T3 cold, which adds a few seconds over a paused VM."],
                  ["The dashboard asks for a key you forgot", <>Run <Code key="k">vmbridge key</Code> on the machine to set a new one.</>],
                ]}
              />
            </Section>

            <Section id="develop" title="Develop">
              <Block>{`bun run dev        # server and dashboard, restarted on change
bun run check      # typecheck and tests`}</Block>
              <List
                items={[
                  <>
                    <Code>apps/server</Code>: the T3 gateway, the fleet of VMs, providers and the dashboard API.
                  </>,
                  <>
                    <Code>apps/web</Code>: the dashboard.
                  </>,
                  <>
                    <Code>apps/cli</Code>: the <Code>vmbridge</Code> command.
                  </>,
                  <>
                    <Code>apps/landing</Code>: this site.
                  </>,
                  <>
                    <Code>packages/contracts</Code>: types shared by the server and the dashboard.
                  </>,
                ]}
              />
            </Section>
          </div>
        </main>
      </div>
      <Footer />
    </>
  );
}
