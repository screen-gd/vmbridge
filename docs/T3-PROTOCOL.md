# T3 protocol findings

T3's protocol assumes one client talks to one long-lived server on one machine, so most of VM Bridge's gateway code exists to make many sleeping servers look like one. No outright T3 bug was confirmed; below are 12 limitations ordered by how much bridge code or risk they cause, each with a change to T3 that would remove the workaround.

Checked against the T3 Code source at commit `a4eadbcdce` (2026-11-21). VMs run the npm `t3` release VM Bridge pins or resolves, which can differ from that commit. T3 paths below are relative to the T3 Code repository; VM Bridge paths are relative to this one.

## Findings

### 1. The shell stream sends a "snapshot" that is not a snapshot

Limitation. Caused real data loss in VM Bridge.

**What T3 does.** After the first shell snapshot, and at the start of every resume, `orchestration.subscribeShell` sends a second item with `kind: "snapshot"` whose `threads` and `archivedThreads` are always empty. It only refreshes project repository details. The one thing that marks it is the optional `resolvedRepositoryIdentityRoots` field. See `loadProjectMetadataSnapshot` in `apps/server/src/ws.ts:1164`, the resume path around `apps/server/src/ws.ts:1374`, and the stream item schema in `packages/contracts/src/orchestrationV2.ts:2442`. T3's own client only treats a snapshot as complete when that field is absent (`packages/client-runtime/src/state/shell.ts:381`).

**Why it matters.** Any consumer that trusts `kind` drops every thread. VM Bridge did exactly that: each VM wake emptied that VM's threads in the sidebar until one of them changed (commit `c9d1e4d`).

**What VM Bridge does.** `Hub.applyShell` checks for `resolvedRepositoryIdentityRoots` and copies only `repositoryIdentity` from matching projects (`apps/server/src/gateway/hub.ts:158`).

**Suggested change.** Give it its own kind, for example `kind: "projects.enriched"` with just the projects, so `snapshot` always means the full shell.

### 2. Sequence numbers belong to one server and carry no identity

Limitation.

**What T3 does.** `snapshotSequence`, the `sequence` on stream items, and the `afterSequence` resume cursor are one counter per server database (`latestApplicationSequence` in `apps/server/src/orchestration-v2/EventStore.ts:71`). Resume compares the cursor to that counter and replays from it (`apps/server/src/ws.ts:1039` for threads, `apps/server/src/ws.ts:1374` for the shell). Nothing in the cursor says which server or database issued it. A cursor above the server's high-water mark falls back to a snapshot; a cursor from a different server that happens to be lower is replayed as if it were valid.

**Why it matters.** A bridge that merges several servers cannot pass a client's cursor through, and cannot offer resume at all. Every reconnect costs full snapshots. The same gap would hit T3 if a client ever reused a cursor against a restored or replaced database with a lower but non-zero sequence.

**What VM Bridge does.** It keeps its own fleet-wide shell counter (`Hub.bump`, `apps/server/src/gateway/hub.ts:113`), always answers shell subscriptions with a full snapshot (`apps/server/src/gateway/rpc.ts:91`), and strips `afterSequence` before forwarding `orchestration.subscribeThread` (`apps/server/src/gateway/rpc.ts:436`).

**Suggested change.** Make cursors opaque and scoped, for example `{ epoch, sequence }` where `epoch` is a per-database ID, and answer a cursor with a foreign epoch with a snapshot (or `snapshot-required`).

### 3. Absolute host paths are part of the protocol

Limitation.

**What T3 does.** Projects, threads, VCS calls and file calls identify things by absolute paths on the server's machine: `workspaceRoot`, `worktreePath`, `cwd`, and the path list `resolvedRepositoryIdentityRoots`. `filesystem.getMetadata` says so directly: "Absolute host paths, including ~/" (`packages/contracts/src/filesystem.ts:9`). `vcs.listRefs` and `vcs.refreshStatus` take only a `cwd` (`packages/contracts/src/git.ts:111`, `packages/contracts/src/git.ts:147`). The compact wire options (`compactIds`, `compactTurnItems`, `dedupeBodies` in `packages/contracts/src/environmentHttp.ts:743`, and the ID table in `packages/contracts/src/orchestrationV2IdTable.ts:95`) move values into side tables.

**Why it matters.** Two VMs both clone into `/workspace/...`, so their paths collide. A bridge must rewrite every path in both directions, and must decide what is a path from the field name. The compact encodings hide values from that rewrite, so the bridge has to turn them off and pay for larger payloads.

**What VM Bridge does.** It shows clients one virtual machine (`/projects/<id>/<name>` and `/vms/<vmId>/...`) and rewrites any string under a key that looks like a path (`isPathKey` and `translate` in `apps/server/src/gateway/paths.ts:10` and `apps/server/src/gateway/paths.ts:25`). It turns off compact IDs, compact turn items, deduped bodies, bounded snapshots and deferred work on thread streams (`apps/server/src/gateway/rpc.ts:428`) and removes the compact query flags from HTTP thread reads (`apps/server/src/gateway/http.ts:179`).

**Suggested change.** Let requests address files by `projectId` (or `threadId`) plus a relative path, and return paths relative to the project root alongside the absolute ones. At minimum, mark path fields in the schema so tools do not have to guess from key names.

### 4. Many requests do not say which thread or project they belong to

Limitation.

**What T3 does.** Some calls carry a `threadId` or `projectId`, others only a `cwd`, a list of `paths`, or a `runId`. Examples: `VcsStatusInput` and `VcsListRefsInput` (`packages/contracts/src/git.ts:111`, `packages/contracts/src/git.ts:147`) and `FilesystemGetMetadataInput`, whose `paths` can point into different projects (`packages/contracts/src/filesystem.ts:8`).

**Why it matters.** For one server this is fine. For a bridge, every request must be routed to the VM that owns it, so routing has to be reverse engineered from payload contents, including a scan of every cached shell to find which VM owns a `runId`.

**What VM Bridge does.** `Hub.targets` walks the whole payload looking for thread IDs, project IDs, path-like keys and run IDs (`apps/server/src/gateway/hub.ts:515`); `Hub.route` refuses requests that name zero or several VMs (`apps/server/src/gateway/hub.ts:549`). `filesystem.getMetadata` is split into one call per path (`apps/server/src/gateway/rpc.ts:281`).

**Suggested change.** Include `projectId` or `threadId` on every request that acts on a project or thread, even when the server could work it out from a path.

### 5. Command retries are only safe on the same server, and launch IDs can be minted server-side

Limitation.

**What T3 does.** `orchestration.launchThread` requires a `commandId` but `threadId` is optional (`packages/contracts/src/orchestrationV2.ts:3988`). The server deduplicates retries through command receipts in its own database and allocates a thread ID when none was sent (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:1278`).

**Why it matters.** A bridge has to choose a VM before T3 sees the command, and may create a VM to do it. If a retry landed on a different VM, that VM's receipts would not know the command and would start a second thread. The bridge also needs the thread ID before forwarding so later requests can be routed, which means it cannot let T3 mint it.

**What VM Bridge does.** `Hub.prepare` stores each `commandId` with a hash of the request, the chosen VM and the thread ID in one insert, rejects a reused ID with different content, and mints the thread ID itself when the client did not send one (`apps/server/src/gateway/hub.ts:576`, minting at `apps/server/src/gateway/hub.ts:597`; concurrency fix in commit `e23282c`).

**Suggested change.** Have clients always send `threadId` on launch, and document that `commandId` deduplication is per server.

### 6. There is no way to say "this environment is waking up"

Limitation.

**What T3 does.** The protocol has no state for an environment that is reachable but whose work is not ready yet. Reads either answer or fail. A generic failure arrives as an Effect "Die" defect, and T3's client does not retry a stream that ends that way: it parks the stream until the next session or fails it (`packages/client-runtime/src/rpc/client.ts:456`). Setup progress (`WorktreeSetupSnapshot`, `packages/contracts/src/worktreeSetup.ts:43`) only exists once a server is working on the thread.

**Why it matters.** A VM that sleeps after idling, or takes a minute to create and clone, has no honest way to tell the client what is happening. Without help, opening a sleeping thread would fail and stay failed.

**What VM Bridge does.** It caches each thread's projection and serves it while the VM sleeps, over both RPC and HTTP (`apps/server/src/gateway/rpc.ts:418`, `apps/server/src/gateway/http.ts:163`). It injects a synthetic `system_notice` turn item ("Waking the ... VM") into the cached projection while a wake runs (`Hub.sleepingProjection`, `apps/server/src/gateway/hub.ts:684`). It reports VM placement through fake worktree setup snapshots with a single `checkout` stage, then offsets the VM's own snapshot sequence so T3's "newer sequence wins" rule keeps working (`apps/server/src/gateway/rpc.ts:378`, `Hub.reportSetup` at `apps/server/src/gateway/hub.ts:625`; T3's rule is in `packages/client-runtime/src/worktreeSetup.ts:10`).

**Suggested change.** An environment status stream item (for example `starting`, `ready`, `unavailable` with a message) and a typed, retryable error for "not ready yet", so streams retry instead of parking.

### 7. Sidebar state lives with the agent's server

Limitation.

**What T3 does.** Settle, unsettle, auto-settle, archive and unarchive are orchestration commands checked and applied by the same server that runs the agent (`apps/server/src/orchestration-v2/Orchestrator.ts:4478`). `thread.auto-settle` is rejected if the thread changed after `snapshotAt` or has an explicit override (`packages/contracts/src/orchestrationV2.ts:3240`).

**Why it matters.** Filing a thread is a client concern, but it requires the execution machine. For a bridge that means waking a VM, or failing, just to flip a sidebar flag. A thread whose VM was deleted can never be archived.

**What VM Bridge does.** It applies these commands to its cached shell while the VM is away, stores them, and replays them in order when the VM connects; T3's rejection drops the command, and a lost answer keeps it for the next connect (`apps/server/src/gateway/held.ts:7`, `Hub.holdCommand` and `Hub.replayHeld` at `apps/server/src/gateway/hub.ts:215` and `apps/server/src/gateway/hub.ts:239`; commits `0e1bfb9` and `b915a7a`). `applyHeldCommand` mirrors T3's reducer, including the auto-settle rule (`apps/server/src/gateway/held.ts:28`), so it must be kept in step with T3 by hand.

**Suggested change.** Export the thread filing reducer from `@t3tools/contracts` (or a shared package) so other implementations reuse it instead of copying it, and treat archive of an already archived thread as a no-op rather than an error.

### 8. Server config mixes one machine's details with environment settings

Limitation.

**What T3 does.** `ServerConfig` (`packages/contracts/src/server.ts:703`) carries machine details (`cwd`, `hostname`, `homeDirectory`, `keybindingsConfigPath`, `directEndpoints`), the provider list, the full settings object (including secret provider and text generator settings), and feature flags, all in one value. Some flags exist both here and in the environment descriptor's capabilities (`shellThreadFamilies` and `shellOlderSettled`, `packages/contracts/src/server.ts:731` and `packages/contracts/src/environment.ts:215`).

**Why it matters.** A bridge must take one VM's config, then remove or replace the parts that describe that VM or its credentials, and set each flag to what the bridge itself supports. Every new config field is a new decision, and a missed one can leak a VM's details to the client.

**What VM Bridge does.** `Hub.config` copies the first VM's config, replaces `environment`, `auth`, `providers` and `providerInstances`, empties `secretProviders`, `usageLimitSources` and `textGenerators`, deletes `directEndpoints`, and sets `shellResumeCompletionMarker`, `shellThreadFamilies`, `shellOlderSettled` and `threadSnapshotPagination` itself (`apps/server/src/gateway/hub.ts:312`).

**Suggested change.** Split config into environment-level settings and capabilities versus host details, and keep each capability flag in one place.

### 9. The protocol version does not describe the wire

Limitation.

**What T3 does.** `orchestrationProtocolVersion` is a single integer checked by exact match, on the descriptor and on the `/ws` query string (`packages/contracts/src/environment.ts:13`, `apps/server/src/ws.ts:799`, `packages/client-runtime/src/connection/compatibility.ts:13`). It has stayed at 2 while the wire kept changing through optional fields ("Older servers omit it", `packages/contracts/src/orchestrationV2.ts:4015`) and dozens of capability flags (`ServerConfig` in `packages/contracts/src/server.ts:726` onward, `ExecutionEnvironmentCapabilities` in `packages/contracts/src/environment.ts:86`).

**Why it matters.** Matching the version number says little about whether a bridge and a client agree. A bridge has to track T3 releases one by one and test each.

**What VM Bridge does.** It requires version 2 from clients and from each VM, refusing a VM that reports anything else (`apps/server/src/gateway/http.ts:96`, `apps/server/src/gateway/hub.ts:121`), and pins or resolves the exact npm `t3` version it installs (`resolveT3Version`, `apps/server/src/vm/runtime.ts:158`).

**Suggested change.** Publish a changelog of wire changes per release, and consider a minor version alongside the integer so a peer can say which optional features it speaks.

### 10. Which RPCs read and which change state is not in the contract

Limitation.

**What T3 does.** The full method-to-scope map, which tells reads (`orchestration:read`) from changes (`orchestration:operate`), lives in the server: `RPC_REQUIRED_SCOPES` in `apps/server/src/auth/RpcAuthorization.ts:44`. The contracts package exports only a subset, `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts:19`).

**Why it matters.** A bridge must decide per request whether it may wake a VM (a change) or should answer from cache (a read). Without the map it guesses.

**What VM Bridge does.** It guesses from method names with regular expressions (`forwardable` and `mutation` in `apps/server/src/gateway/rpc.ts:48` and `apps/server/src/gateway/rpc.ts:49`). A new T3 method that changes state but does not match the pattern would be treated as a read.

**Suggested change.** Move the full scope map into `@t3tools/contracts`, next to the RPC definitions.

### 11. Each RPC has its own error shape

Limitation.

**What T3 does.** Failures are tagged errors with method-specific required fields, for example `OrchestrationV2DispatchCommandError` needs `commandId` and `commandType`, and `OrchestrationV2ThreadLaunchError` needs `commandId` and `projectId` (`packages/contracts/src/orchestrationV2.ts:4291`, `packages/contracts/src/orchestrationV2.ts:4319`). There is no shared "this request failed, here is why" error, so anything else becomes a defect (see finding 6).

**Why it matters.** For an error the bridge produces itself (no VM capacity, provider down), it has to build the right tagged error for each method or fall back to a defect the client handles worse.

**What VM Bridge does.** `Rpc.fail` hand-builds the tagged error for launch, dispatch, provider update and scheduled task calls, and sends a defect for the rest (`apps/server/src/gateway/rpc.ts:169`). Other handlers build `FilesystemBrowseError`, `GitCommandError`, `SourceControlRepositoryError` and `ServerSettingsError` the same way.

**Suggested change.** A common error type every RPC accepts, with a code, a message and an optional retry hint.

### 12. The wire format is Effect RPC's internal JSON

Limitation. Caused a connection outage in VM Bridge.

**What T3 does.** The socket speaks Effect RPC's JSON framing as-is. Request IDs come from a numeric counter in the client and replies are matched by value, so a reply with `"1"` does not match request `1` (effect 4.1.3 `rpc/RpcClient.ts:208` and `rpc/RpcClient.ts:262`). Streams wait for an `Ack` after each `Chunk` before sending the next (`rpc/RpcClient.ts:570`). None of this is documented by T3.

**Why it matters.** Any non-Effect peer has to rediscover these rules. VM Bridge replied with string IDs, and newer T3 clients never saw their first config snapshot and timed out during connection setup (commit `bfa2401`).

**What VM Bridge does.** It echoes request IDs with the type they arrived with (`apps/server/src/gateway/rpc.ts:21`) and sends an `Ack` for every chunk it receives from a VM (`apps/server/src/vm/backend.ts:132`).

**Suggested change.** Document the framing T3 depends on (frame tags, ID matching, Ack and Interrupt) in the contracts package, or pin it with a small conformance test peers can run.

## Checked and not reported

- **Stale `server-runtime.json` blocking startup.** VM Bridge's start script deletes a runtime record whose PID is dead or reused (`apps/server/src/vm/runtime.ts:141`). Current T3 uses an ownership lock and only applies the PID check to records without an `ownerId`, with a start-time check for reused PIDs (`apps/server/src/serverOwnership.ts:244`). Not a current T3 issue; the workaround may still matter for older npm releases.
- **T3 not re-checking agent versions after a wake.** VM Bridge calls `server.refreshProviders` on every VM connect (`apps/server/src/gateway/hub.ts:154`, commit `1f9aa88`). I could not confirm from T3's source which agents it re-checks on its own, so this is left out.

## What VM Bridge relies on

A T3 change to any of these would break VM Bridge.

- **Discovery and auth:** `GET /.well-known/t3/environment` (`orchestrationProtocolVersion`, `serverVersion`); `t3 auth session issue --base-dir --ttl --label --token-only` to mint VM Bridge's session on each VM; `POST /api/auth/websocket-ticket/rpc`; `/ws?orchestrationProtocol=2&wsTicket=...`; the `x-t3-orchestration-protocol: 2` header; the token exchange grant and token type URNs at `/oauth/token`; the `/api/auth/session` response shape.
- **Wire framing:** Effect RPC JSON frames `Request`, `Chunk`, `Exit`, `Ack`, `Interrupt`, `Ping` and `Pong`; request IDs echoed with their original type; one `Ack` per chunk.
- **Routing fields:** `threadId`, `parentThreadId`, `sourceThreadId`, `projectId`, `runId`, `commandId`, and path fields recognised by name (`cwd`, `path`, `paths`, `root`, and names ending in `Path`, `Root`, `Directory` or `Dir`).
- **Shell:** `orchestration.subscribeShell` item kinds (`snapshot`, `project.updated`, `project.removed`, `thread.updated`, `thread.removed`, `synchronized`), `location: "archive"`, `snapshotSequence`, the `resolvedRepositoryIdentityRoots` enrichment marker, and `GET /api/orchestration/shell`.
- **Threads:** `orchestration.subscribeThread` with its `accept*` opt-out flags and `snapshot` and `event` items; `orchestration.getThreadProjection`; the HTTP thread routes (`/api/orchestration/threads/:id`, `/bounded`, `/history`, `/transcript`) and their `compactIds`, `compactTurnItems` and `dedupeBodies` query flags.
- **Idle detection:** thread fields `activeRunId`, `pendingRuntimeRequest`, `status` and `activityRunStatus` with the values `preparing`, `queued`, `starting`, `running`, `waiting` and `pending`.
- **Commands:** `orchestration.dispatchCommand` with `thread.settle`, `thread.auto-settle`, `thread.unsettle`, `thread.archive` and `thread.unarchive`, and their reducer rules; `orchestration.launchThread` with `workspaceStrategy` types `root` and `worktree`.
- **Config and agents:** `server.getConfig`; `subscribeServerConfig` events `snapshot` and `providerStatuses` with the `providerCatalogsOnDemand`, `providerCatalogDigests` and `providerStatusDeltas` opt-outs; provider `versionAdvisory` (`status: "behind_latest"`, `canUpdate`, `updateCommand`); `server.refreshProviders`; `server.updateProvider`.
- **Other streams and snapshots:** `scheduledTasks.subscribe`; the `WorktreeSetupSnapshot` and project clone snapshot shapes, including their `sequence` fields.
- **Errors:** the tagged error names and fields VM Bridge builds itself (finding 11).
- **Startup:** the `pid` field in `userdata/server-runtime.json` under the T3 base directory.
