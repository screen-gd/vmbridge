# Providers

VM Bridge runs every VM through `@opencoredev/sandbox-sdk` 1.2.0. You can add several providers and use them at once.

| | Boat | boxd | Daytona | E2B | Freestyle | Instabox | Railway | Superserve |
|---|---|---|---|---|---|---|---|---|
| Sizes (small / medium / large) | 2/4 GB, 4/8 GB, 8/16 GB | 1/4 GB, 2/8 GB, 4/16 GB | 1/1 GB, 2/4 GB, 4/8 GB | 2/2 GB, 4/4 GB, 8/8 GB | 4/8 GB for all three | 2/4 GB, 4/8 GB, 8/16 GB | 1/2 GB, 2/4 GB, 4/8 GB | 2/4 GB for all three |
| Idle sleep | stop (disk kept) | pause (memory kept) | stop (disk kept) | pause (memory kept) | pause (memory kept) | pause (memory kept) | checkpoint, then destroy | pause (memory kept) |
| Wake | resume | resume | start | resume | resume | resume | new VM from checkpoint (new sandbox ID) | resume |
| Snapshot | no (SDK) | yes | yes (files only) | yes, and delete | yes (memory and disk) | yes, and delete | checkpoint (files only) | yes |
| T3 port reachable through | preview host, `_port_auth` cookie | public default proxy | private preview, `X-Daytona-Preview-Token` header | public URL | public `*.style.dev` domain | public published port | public domain declared at create | private preview, token header |
| Agent sign-ins | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| GitHub | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| Provider safety net if VM Bridge is down | auto-stop 12 h after start, pushed back while agents work | auto-suspend after 60 min idle | auto-stop after 60 min without preview or toolbox traffic | auto-pause 60 min after start or wake, pushed back while agents work | auto-pause after 60 min without network traffic | auto-suspend after 30 min idle | none | auto-pause after 12 h awake |
| Extra package | none | `@boxd-sh/sdk` | none | none | none | none | `railway` | none |

Public previews (boxd, E2B, Freestyle, Instabox, Railway) expose the T3 server port. The T3 server requires its own bearer session token on every route, and only VM Bridge holds it.

## Provider notes

- **Boat**: the SDK creates Boat VMs with `noEnv: true`, which drops the Boat environment. VM Bridge creates Boat VMs through Boat's API with the chosen environment and writes the SDK's name encoding so `connectSandbox` still attaches. Stop and resume use Boat's API, since the SDK has no pause for Boat. Agent and GitHub sign-ins a Boat environment passes in are cleared on the VM, like every provider's.
- **boxd**: reading a sleeping machine's labels wakes it, so the fleet listing uses the adapter's `listSleeping` and VM Bridge only connects when it means to wake.
- **Daytona**: VM Bridge uses container sandboxes from Daytona's built-in `daytona-small`, `daytona-medium` and `daytona-large` snapshots. Containers cannot pause (only Daytona VM sandboxes can, and the `daytona-vm-*` snapshots are not offered in this account's regions), so sleep is a stop: files stay, memory and processes go, and T3 cold-starts on wake. VM Bridge creates sandboxes through Daytona's API with the SDK's labels, because the SDK always sends `target: "us"` (refused for orgs without that region) and resizes non-default sizes with an extra stop, resize and start. Leaving the target out uses the org's default region, set in the Daytona dashboard. Start and delete answer 409 while a stop is still running, so wake and delete wait for it. Stopped sandboxes are archived after Daytona's default 7 days; starting an archived one restores its files from object storage first. Daytona secrets only swap API keys into outbound HTTPS headers, so agent sign-ins and GitHub come from VM Bridge.
- **E2B**: a template fixes CPU and memory, and E2B's `base` template has 512 MB, too little for T3 and the agents. The first time a size is used, VM Bridge builds a template for it from `base` in your account (`vmbridge-2cpu-2gb`, `vmbridge-4cpu-4gb`, `vmbridge-8cpu-8gb`), which took 10 to 15 s, and reuses it after that. These sizes fit E2B's default limit of 8 vCPU and 8 GB per sandbox. E2B's timeout kills a sandbox unless auto-pause is on, so VM Bridge turns auto-pause on: E2B then pauses the VM 60 minutes after it starts or wakes. Resuming does not reset that timeout, so VM Bridge sets it back to 60 minutes after every wake, and again on every idle sweep while agents work. E2B also caps how long a sandbox runs without a pause: 1 hour on the Hobby plan, 24 hours on Pro. A longer agent turn is paused there, with memory kept, and continues after the next wake. Paused sandboxes are kept until deleted. E2B's `base` image has Node 20.9, older than T3 needs (20.11), so setup installs its own Node 22 there.
- **Freestyle**: the `freestyle/ubuntu` base snapshot fixes the machine at 4 vCPU, 8 GB and 32 GB of disk, and Freestyle can only grow a VM, never shrink it, so all three sizes are the same VM. Freestyle's plan deletes a VM 30 days after it last ran, so a VM asleep that long is gone and its projects get a new VM. The SDK's default 30 s deadline cut off one delete of a VM that had just run T3 (Freestyle finished the delete anyway), so VM Bridge gives Freestyle calls 2 minutes.
- **Instabox**: the default template is `agent-browser`. Ports must be 1024 or higher (T3 uses 3773).
- **Superserve**: every template has 2 vCPU, 4 GB and 8 GB of disk, so all three sizes are the same VM. The SDK needs Python in the VM and the default `superserve/node-22` template has none, so VM Bridge uses `superserve/python-3.11` and installs Node itself. Superserve has no idle timer, only a cap on time awake that resets on every resume, so the safety net is a pause after 12 hours awake. Superserve's docs only say pause keeps "VM state". A check confirmed it keeps memory: a process started before a pause was still running after resume, and uptime carried on instead of restarting.
- **Railway**: no pause, and Railway's own idle timeout destroys the VM, so VM Bridge sets none. CPU and memory are fixed per client, so VM Bridge opens one client per size. Railway keeps checkpoints until they are deleted and the SDK has no delete, so VM Bridge deletes them with Railway's own SDK (`Sandbox.checkpoints` to find one by key, then `Sandbox.deleteCheckpoint`): after a wake from the checkpoint, and when a VM asleep as a checkpoint is deleted.

## Status

All eight drivers are built and have passed a live run. E2B, Freestyle and Superserve ran `scripts/live.ts <provider> --agent` on 2026-11-21 with the same steps as below. On 2026-11-21, Boat, boxd, Instabox and Railway each ran `scripts/live.ts <provider> --agent` at medium size: create, clone, one short Codex turn, sleep, reads while asleep, a new message that wakes the VM, a second turn, the checkout still there, delete. Daytona was not set up for that round, so its results below are from its own earlier runs without an agent turn.

Verified live:

- Boat accepts `PATCH /sandboxes/{id}` with `ttlSeconds`, and it pushes back auto-stop. After `keepAlive`, Boat's `archiveAfter` (when the VM stops by itself) moved to 12 hours from the call. Boat's API reference says the same: the deadline becomes now plus `ttlSeconds`.
- Railway checkpoints keep the installed T3 runtime under `/workspace/.vmbridge`. After a wake from a checkpoint, the T3 package file still had its modification time from before the sleep, so setup found T3 installed and did not reinstall it.
- Railway checkpoints can be deleted. Over a sleep, wake, sleep, delete cycle, the environment's checkpoints went from 2 to 3, back to 2, to 3, and back to 2.

Still unverified:

- boxd and Instabox safety-net idle timers do not suspend a VM while an agent turn is running. This needs a turn of 30 to 60 minutes.
- The E2B, Freestyle and Superserve safety nets (60 minutes, or 12 hours on Superserve) have not been seen to fire. E2B accepted the timeout update VM Bridge sends on every wake.

### Boat live results (2026-11-21, medium size, `base` environment)

`scripts/live.ts boat --agent`, one run. Everything listed under Status passed. `keepAlive` (the `ttlSeconds` PATCH) took 0.4 to 0.6 s.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 23.1 s |
| Clone and register project | 1.8 s |
| First agent turn | 8.6 s |
| Sleep (stop request) | 0.8 s |
| Wake on a new message (resume, prepare, until T3 took the message) | about 20.7 s |
| Second agent turn | 3.7 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.0 | 2.3 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.2 |
| VM `filesystem.browse` | 189 | 192 |
| VM `vcs.refreshStatus` | 601 | 924 |
| VM `orchestration.getThreadProjection` | 196 | 198 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 1.5 |

### boxd live results (2026-11-21, medium size)

`scripts/live.ts boxd --agent`, one run. Everything listed under Status passed.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 29.1 s |
| Clone and register project | 1.2 s |
| First agent turn | 8.7 s |
| Sleep (pause) | 0.3 s |
| Wake on a new message (resume, prepare, until T3 took the message) | about 8.5 s |
| Second agent turn | 2.8 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.1 | 4.2 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.3 |
| VM `filesystem.browse` | 162 | 207 |
| VM `vcs.refreshStatus` | 827 | 1221 |
| VM `orchestration.getThreadProjection` | 176 | 184 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 3.3 |

### Daytona live results (2026-11-21, `eu` region, medium size)

`scripts/live.ts daytona`, two runs, no agent turn. Create, clone, sleep, a read while asleep, wake, and the checkout survived.

| Step | Time |
|---|---|
| Daytona create (API until `started`) | 1.0 to 1.5 s |
| First VM ready (create, install, start T3) | 16 to 19 s |
| Clone and register project | 1.0 s |
| Sleep (stop request) | 0.3 s (Daytona finishes the stop about 2 s later) |
| Wake (start, prepare, cold-start T3) | 10 to 11 s, of which Daytona start is about 1.8 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 0.8 to 1.0 | 1.4 to 3.8 |
| Bridge-local `GET /api/orchestration/shell` | 0.1 | 0.2 to 0.3 |
| VM `filesystem.browse` | 156 to 158 | 160 to 161 |
| VM `vcs.refreshStatus` | 372 to 504 | 520 to 622 |
| Raw Daytona preview GET | 156 | 159 |
| Raw Daytona toolbox command | 203 | 218 |

### E2B live results (2026-11-21, medium size: 4 vCPU, 4 GB)

`scripts/live.ts e2b --agent`, two runs. The first failed in setup: E2B's `base` image has Node 20.9 and T3 needs 20.11, which setup did not check. After the fix, the second run passed everything listed under Status. The `vmbridge-4cpu-4gb` template was built in the first run, so the ready time below does not include a template build. Most of it is setup downloading Node and installing T3 and the agents.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 95.3 s |
| Clone and register project | 1.6 s |
| First agent turn | 8.8 s |
| Sleep (pause) | 1.2 s |
| Wake on a new message (resume, prepare, until T3 took the message) | 16.0 s |
| Second agent turn | 4.1 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 0.9 | 2.2 |
| Bridge-local `GET /api/orchestration/shell` | 0.1 | 0.2 |
| VM `filesystem.browse` | 278 | 280 |
| VM `vcs.refreshStatus` | 780 | 1066 |
| VM `orchestration.getThreadProjection` | 531 | 550 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 2.1 |

### Freestyle live results (2026-11-21, 4 vCPU, 8 GB)

`scripts/live.ts freestyle --agent`, two runs. Both passed every step up to the delete. In the first run the delete hit the SDK's 30 s deadline, though Freestyle did delete the VM. The second run, with a 2 minute deadline, deleted it cleanly. The step times are from the second run.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 61.2 s (60.2 s in the first run) |
| Clone and register project | 1.9 s |
| First agent turn | 10.3 s |
| Sleep (pause) | 0.9 s |
| Wake on a new message (resume, prepare, until T3 took the message) | 8.3 s (8.1 s in the first run) |
| Second agent turn | 2.7 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.1 | 3.1 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.3 |
| VM `filesystem.browse` | 218 | 233 |
| VM `vcs.refreshStatus` | 965 | 1377 |
| VM `orchestration.getThreadProjection` | 237 | 243 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.4 | 2.0 |

### Superserve live results (2026-11-21, 2 vCPU, 4 GB, `superserve/python-3.11`)

`scripts/live.ts superserve --agent`, one run. Everything listed under Status passed.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 55.2 s |
| Clone and register project | 2.1 s |
| First agent turn | 5.7 s |
| Sleep (pause) | 4.6 s |
| Wake on a new message (resume, prepare, until T3 took the message) | 15.7 s |
| Second agent turn | 3.4 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.0 | 2.0 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.3 |
| VM `filesystem.browse` | 320 | 323 |
| VM `vcs.refreshStatus` | 655 | 821 |
| VM `orchestration.getThreadProjection` | 331 | 565 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.3 | 1.3 |

### Instabox live results (2026-11-21, medium size)

`scripts/live.ts instabox --agent`, two runs. Everything listed under Status passed. The step times below are from the second run, made with the fixed live script. The first run's wake time was estimated from a gap in the log and was wrong. The latencies are from the first run.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 22.1 s |
| Clone and register project | 1.4 s |
| First agent turn | 7.8 s |
| Sleep (pause) | 1.4 s |
| Wake on a new message (resume, prepare, until T3 took the message) | 10.5 s |
| Second agent turn | 1.7 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.3 | 3.7 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.2 |
| VM `filesystem.browse` | 229 | 232 |
| VM `vcs.refreshStatus` | 660 | 880 |
| VM `orchestration.getThreadProjection` | 238 | 244 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.4 | 0.7 |

### Railway live results (2026-11-21, medium size)

`scripts/live.ts railway --agent`, one run, then two sleep, wake, sleep and delete cycles through the dashboard API. Everything listed under Status passed, and every checkpoint those runs made was deleted. In a third cycle the first wake of a new VM failed about 74 s after create. Its error was not captured and it did not happen again in the next two cycles. The failed wake put the VM back to sleep as a checkpoint, and the next wake restored it.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 56 to 80 s (65.2 s in the agent run) |
| Clone and register project | 2.5 s |
| First agent turn | 11.9 s |
| Sleep (checkpoint, then destroy) | 7 to 8.8 s |
| Wake (new VM from the checkpoint, prepare, cold-start T3) | 47 to 65 s (47.4 s in the agent run) |
| Second agent turn | 6.0 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.3 | 4.4 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.2 |
| VM `filesystem.browse` | 225 | 230 |
| VM `vcs.refreshStatus` | 1124 | 1688 |
| VM `orchestration.getThreadProjection` | 245 | 265 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 2.1 |

An earlier Railway run (2026-11-21, small size, no agent turn) took 57.2 s to the first VM, 8.8 s to sleep and 45.1 s to wake.

## Not supported

Agent37 is a hosted agents API, not a VM, so it cannot run T3's server. VM Bridge does not support it.

Sandboxer is not added yet. The SDK supports it (pause that usually keeps memory, an idle pause of up to 7 days, Boat's machine sizes), but the test account refuses every create with `402 payment_method_required`, even a small VM with default options, so it could not be tested live. Its idle pause would be the safety net, and its default auto-stop one hour after start would need turning off, since it stops a VM mid-turn.
