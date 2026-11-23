# VM Bridge on Cloudflare Workers

The **Deploy to Cloudflare** button in the README puts VM Bridge on your own Cloudflare account. You
need no machine of your own, no terminal and no tunnel. It fits the free Workers plan.

## What you see

1. Cloudflare asks you to sign in and to connect GitHub (or GitLab). It copies this repository into
   a new one in your account, so later updates are yours to pull in.
2. It shows the Worker's name, the Durable Object it makes (`BridgeObject`) and two secrets to fill
   in, `VMBRIDGE_PASSWORD` and `VMBRIDGE_ENCRYPTION_KEY`.
3. It builds and deploys (`bun run build`, then `bun run deploy`), which takes a minute or two, and
   shows the Worker's `workers.dev` address.
4. Open that address, log in with your password, add a provider and sign in an agent. Under
   **Devices**, make a pairing link and paste it into T3 Code.

Each push to the new repository's main branch deploys again. The bridge switches to the new code
within five minutes, and T3 reconnects on its own.

If a secret is missing or too weak, every page shows "VM Bridge needs setup" and the API does
nothing until you set it under the Worker's **Settings**, **Variables and Secrets**.

## The secrets

- `VMBRIDGE_PASSWORD`: the dashboard password, at least 12 characters. Changing the secret changes
  the password and logs everyone out. The dashboard cannot change it.
- `VMBRIDGE_ENCRYPTION_KEY`: encrypts provider keys, the GitHub token, agent sign-ins, environment
  variables and the password's hash. Use `openssl rand -base64 32`, or a passphrase of at least 32
  characters, which VM Bridge turns into a key with PBKDF2 (the same on Bun, so a passphrase works
  in both). Keep a copy in a password manager. VM Bridge will not start with a different key, so it
  never overwrites what you saved. If you lose it, delete the Worker and deploy again from scratch.

## What each part does

- **Worker**: the front door. It sends plain HTTP to HTTPS, serves the dashboard's page and hands
  every API and T3 request to the Durable Object. It holds no state.
- **Durable Object with SQLite**: one object is the whole bridge. Its SQLite database holds what
  `~/.vmbridge/main.db` holds on Bun. It keeps the T3 WebSockets and the connections to awake VMs
  open, and starts, sleeps and wakes VMs.
- **Alarms**: every 15 seconds an alarm runs VM Bridge's regular jobs: putting idle VMs to sleep,
  checking usage, trimming the activity log. Alarms survive restarts, so the jobs keep running when
  nobody is connected.
- **Static Assets**: the dashboard's files, served by Cloudflare without running the Worker, with
  the same security headers as the dashboard on Bun.
- **Secrets**: the two values above. Cloudflare keeps them encrypted and never shows them again.
- **Workers Builds**: builds and deploys from your repository on every push.

## Differences from Bun

- One address: the Worker's `workers.dev` address, or a custom domain you add to the Worker. No
  local network, Tailscale or tunnel settings.
- No setup link. The password comes from the secret.
- No machine to read skills or `AGENTS.md` from: upload skills and paste `AGENTS.md` and `CLAUDE.md`
  under **Skills**.
- Passwords are hashed with PBKDF2-SHA256 at 100,000 rounds, the most Workers allows, instead of
  argon2id. A login is limited to a few tries per visitor and per minute overall, as on Bun.
- Branch lookups skip the check that keeps them off private addresses, because a Worker cannot reach
  private addresses at all.

## Limits and cost

Most of the work is waiting on VMs and agents, which costs little. The biggest cost is the Durable
Object staying in memory, and one object is in memory for at most the whole day: 86,400 seconds at
128 MB is 10,800 GB-seconds, under the free plan's 13,000.

Measured on a test deploy with one T3 client connected throughout, then scaled to 24 hours:

| Per day | Busy (chat, new VM) | Quiet (VM asleep) | Free plan |
| --- | --- | --- | --- |
| Durable Object GB-seconds | 10,800 at most | 10,800 | 13,000 |
| Requests (Worker, object, alarms, WebSocket messages / 20) | about 18,000 | about 5,800 | 100,000 |
| SQLite rows written | about 35,000 | about 6,200 | 100,000 |
| SQLite rows read | about 270,000 | about 53,000 | 5,000,000 |
| Worker CPU per request | 0.5 ms median, 1.1 ms P99 | none | 10 ms |

"Busy" assumes a whole day like the busiest half hour of the test, so real use sits well below it.
Storage stays in the megabytes, against 5 GB.

The free plan's Durable Object time is per Cloudflare account, shared with every other Durable Object
on it. VM Bridge alone uses about 10,800 of the 13,000 GB-seconds a day, so put it on an account
whose other Durable Objects use little, or on Workers Paid.

If you outgrow the free plan, Workers Paid is $5 a month and includes far more than one bridge uses.
