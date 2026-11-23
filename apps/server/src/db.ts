import type { Sql } from "./sql.ts";

// Append only. Entry N (from 1) runs once, in its own transaction, and is then recorded in the migrations table.
export const migrations = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE pairing_links (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  );

  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE vms (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    sandbox_id TEXT,
    name TEXT NOT NULL,
    size TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    endpoint TEXT,
    t3_token TEXT,
    t3_version TEXT,
    checkpoint TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    last_connected_at INTEGER,
    last_slept_at INTEGER
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    branch TEXT,
    title TEXT NOT NULL,
    vm_id TEXT REFERENCES vms(id) ON DELETE SET NULL,
    checkout_path TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE
  );

  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    thread_id TEXT
  );

  CREATE TABLE vm_snapshots (
    vm_id TEXT PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
    shell TEXT,
    config TEXT,
    scheduled_tasks TEXT
  );

  CREATE TABLE projections (
    thread_id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    updated_at TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE clones (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE held_commands (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // One active provider became a list of added providers with a default.
  `
  INSERT INTO settings (key, value) SELECT 'providers', json_array(json(value)) FROM settings WHERE key = 'activeProvider' AND value != 'null';
  INSERT INTO settings (key, value) SELECT 'defaultProvider', value FROM settings WHERE key = 'activeProvider';
  DELETE FROM settings WHERE key = 'activeProvider';
  `,
  `ALTER TABLE vms ADD COLUMN t3_credentials TEXT;`,
  `
  CREATE TABLE skills (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    description TEXT,
    hash TEXT NOT NULL,
    files TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE vms ADD COLUMN skills TEXT;
  `,
  // A project can live on several VMs. The first one added is its primary. The old projects.vm_id and
  // projects.checkout_path columns stay behind unused: SQLite cannot drop a column a foreign key uses.
  `
  CREATE TABLE project_vms (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    checkout_path TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, vm_id)
  );
  INSERT INTO project_vms (project_id, vm_id, checkout_path, added_at)
    SELECT id, vm_id, checkout_path, created_at FROM projects WHERE vm_id IS NOT NULL;
  UPDATE projects SET vm_id = NULL, checkout_path = NULL;
  `,
  // The local branches each of a project's VMs had when last read, for while it sleeps.
  `ALTER TABLE project_vms ADD COLUMN branches TEXT;`,
  // The snapshot new VMs of each provider and size start from (see vm/bases.ts), the VM building the next one, and
  // replaced snapshots still to delete.
  `
  CREATE TABLE base_snapshots (
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    snapshot TEXT,
    stamp TEXT,
    created_at INTEGER,
    builder TEXT,
    PRIMARY KEY (provider, size)
  );
  CREATE TABLE retired_snapshots (
    provider TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (provider, snapshot)
  );
  `,
  // The latest background failures (see traffic.ts), kept across restarts. `resolved` is set once the same operation
  // works again for the same VM or provider.
  `
  CREATE TABLE errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    operation TEXT NOT NULL,
    reason TEXT,
    vm_id TEXT,
    provider TEXT,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  `,
  // Usage for cost estimates (see usage.ts). No foreign keys: the history outlives the VMs and snapshots.
  `
  CREATE TABLE vm_usage (
    id INTEGER PRIMARY KEY,
    vm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    state TEXT NOT NULL,
    repos TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    open INTEGER NOT NULL
  );
  CREATE INDEX vm_usage_time ON vm_usage (ended_at, started_at);
  CREATE TABLE snapshot_usage (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    size TEXT,
    vm_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    open INTEGER NOT NULL
  );
  CREATE INDEX snapshot_usage_time ON snapshot_usage (ended_at, started_at);
  `,
  // VM lifecycle and agent turns for analytics (see analytics.ts). No foreign keys, like usage. Turns hold no
  // message content: only which thread, run, repository, agent and model.
  `
  CREATE TABLE vm_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    vm_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    kind TEXT NOT NULL,
    duration_ms INTEGER
  );
  CREATE INDEX vm_events_at ON vm_events (at);
  CREATE TABLE turns (
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    vm_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    repo TEXT,
    agent TEXT,
    model TEXT,
    PRIMARY KEY (thread_id, run_id)
  );
  CREATE INDEX turns_at ON turns (at);
  `,
  // Agent sign-ins, which used to be files under `<data dir>/auths` (see bun/auth-files.ts). Both values are sealed
  // with the contexts the files used, `auths/<id>/profile.json` and `auths/<id>/auth.json`, so they move unchanged.
  `
  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    codex_auth TEXT
  );
  `,
  // Sign-in fingerprints were plain SHA-256 hashes, which a copy of the database could check guessed secrets
  // against. Now they are keyed (see `credentialsFingerprint`): a VM with an old one counts as behind on sign-ins, so
  // it restarts T3 with the current ones, as after any sign-in change.
  `UPDATE vms SET t3_credentials = 'unkeyed' WHERE t3_credentials IS NOT NULL;`,
  // AGENTS.md and CLAUDE.md pasted in the dashboard, sealed with the context `instructions:<name>`.
  `
  CREATE TABLE instructions (
    name TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

/**
 * Brings the schema up to date. `legacyVersion` is the `PRAGMA user_version` older versions tracked migrations with:
 * on the first start with a migrations table, the ones it counts are recorded as done instead of run again.
 */
export function migrate(db: Sql, legacyVersion = 0) {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = () => db.one<{ version: number | null }>("SELECT MAX(version) AS version FROM migrations")?.version ?? 0;
  if (done() === 0 && legacyVersion > 0) {
    db.transaction(() => {
      for (let version = 1; version <= Math.min(legacyVersion, migrations.length); version++) {
        db.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", version, Date.now());
      }
    });
  }
  for (let next = done(); next < migrations.length; next++) {
    db.transaction(() => {
      db.exec(migrations[next]!);
      db.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", next + 1, Date.now());
    });
  }
}
