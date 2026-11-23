import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Box } from "../src/providers/index.ts";
import { prepareVm, setupStamp, t3Port, type VmCredentials } from "../src/vm/runtime.ts";

// A curl that logs every URL and answers only GitHub CLI release downloads, with a fake gh of the asked version,
// and only when GH_DOWNLOADS is set. Everything else fails, as GitHub's API does for anonymous calls from boxd.
const fakeCurl = `#!/bin/bash
for url; do :; done
echo "$url" >> "$CURL_LOG"
case "$url" in
  https://github.com/cli/cli/releases/download/*)
    [ -n "\${GH_DOWNLOADS:-}" ] || exit 22
    version="\${url##*/gh_}"; version="\${version%%_linux*}"
    dir="$(mktemp -d)"; mkdir -p "$dir/gh/bin"
    printf '#!/bin/sh\\necho "gh version %s (test)"\\n' "$version" > "$dir/gh/bin/gh"; chmod +x "$dir/gh/bin/gh"
    tar -cz -C "$dir" gh ;;
  *) exit 22 ;;
esac
`;

let dir: string;
let t3: ReturnType<typeof Bun.serve>;
let t3Up: boolean;
/** Every command run on the fake VM, and its stdin. */
let runs: { command: string; stdin?: string; stderr: string }[];
let env: Record<string, string>;

/** The VM's /workspace, moved into the temporary folder, and T3's port to the fake T3 server. */
const local = (text: string) => text.replaceAll("/workspace", dir).replaceAll(`127.0.0.1:${t3Port}/`, `127.0.0.1:${t3.port}/`);

/** A VM whose commands run here in bash. Files the program writes are base64, so they are moved into `dir` too. */
const box = {
  run: async (command: string, options: { stdin?: string } = {}) => {
    const stdin = local(options.stdin ?? "").replace(
      /(<<'VMBRIDGE_FILE'\n)([A-Za-z0-9+/=\n]*)(VMBRIDGE_FILE)/g,
      (_, start: string, data: string, end: string) => `${start}${Buffer.from(local(Buffer.from(data, "base64").toString())).toString("base64")}\n${end}`,
    );
    // Not spawnSync: the program calls the fake T3 server, which answers on this event loop.
    const run = Bun.spawn(["bash", "-c", local(command)], { stdin: Buffer.from(stdin), env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    runs.push({ command, stdin: options.stdin, stderr });
    return { ok: exitCode === 0, exitCode, stdout, stderr, output: stdout + stderr };
  },
} as unknown as Box;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-setup-"));
  t3Up = false;
  runs = [];
  t3 = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => (t3Up ? Response.json({ orchestrationProtocolVersion: 2 }) : new Response(null, { status: 503 })),
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // npm logs what it was asked to install. t3 and codex are on the image; claude is not.
  for (const [name, text] of Object.entries({ curl: fakeCurl, npm: '#!/bin/sh\necho "$*" >> "$NPM_LOG"\n', t3: "#!/bin/sh\n", codex: "#!/bin/sh\n" })) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  // The binary itself: a version manager's shim may need more of the environment than these tests give it.
  symlinkSync(Bun.spawnSync(["node", "-p", "process.execPath"]).stdout.toString().trim(), join(bin, "node"));
  // Only the fakes and the system's own tools, so agent CLIs installed on this machine do not count.
  env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CURL_LOG: join(dir, "curl.log"), NPM_LOG: join(dir, "npm.log") };
});
afterEach(() => {
  t3.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const log = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim().split("\n") : []);
const vmFile = (path: string) => join(dir, ".vmbridge", path);

describe("VM setup", () => {
  test("finishes without the GitHub CLI when GitHub refuses its download", async () => {
    await prepareVm(box, "1.0.0", {}, "fingerprint");
    expect(runs.at(-1)!.stderr).toContain("Could not install the GitHub CLI");
    expect(existsSync(vmFile("gh"))).toBe(false);
    expect(existsSync(vmFile("gh.new"))).toBe(false);
    expect(log("curl.log").filter((url) => url.includes("api.github.com"))).toEqual([]);
  });

  test("installs the pinned GitHub CLI from its release download, without GitHub's API, once", async () => {
    env.GH_DOWNLOADS = "1";
    await prepareVm(box, "1.0.0", {}, "fingerprint");
    const urls = log("curl.log");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/github\.com\/cli\/cli\/releases\/download\/v[\d.]+\/gh_[\d.]+_linux_(amd64|arm64)\.tar\.gz$/);
    expect(Bun.spawnSync([vmFile("gh/bin/gh"), "--version"]).stdout.toString()).toStartWith("gh version ");

    // Setup runs again, and finds the pinned gh already there.
    rmSync(vmFile("setup-stamp"));
    await prepareVm(box, "1.0.0", {}, "fingerprint");
    expect(log("curl.log")).toHaveLength(1);
  });

  test("installs only what is missing in one npm run, then skips setup until the T3 version changes", async () => {
    await prepareVm(box, "1.0.0", {}, "fingerprint");
    expect(log("npm.log")).toEqual([expect.stringMatching(/ t3@1\.0\.0 @anthropic-ai\/claude-code$/)]);
    expect(readFileSync(vmFile("setup-stamp"), "utf8")).toBe(setupStamp("1.0.0"));

    await prepareVm(box, "1.0.0", {}, "fingerprint");
    expect(log("npm.log")).toHaveLength(1);
    expect(log("curl.log")).toHaveLength(1);

    await prepareVm(box, "1.0.1", {}, "fingerprint");
    expect(log("npm.log")).toHaveLength(2);
    expect(log("npm.log")[1]).toContain(" t3@1.0.1 ");
    expect(readFileSync(vmFile("setup-stamp"), "utf8")).toBe(setupStamp("1.0.1"));
  });

  test("one exec writes the sign-ins from stdin and reports T3, its sign-ins and the skills manifest", async () => {
    const credentials: VmCredentials = {
      github: { token: "github_pat_secret", login: "octo", name: "Octo Cat", email: "octo@example.test" },
      claudeOAuthToken: "claude-secret",
    };
    await prepareVm(box, "1.0.0", credentials, "fingerprint");
    // As T3 and skills would leave them.
    t3Up = true;
    mkdirSync(vmFile("t3"));
    writeFileSync(vmFile("t3/credentials"), "fingerprint");
    writeFileSync(vmFile("skills.json"), '{"fingerprint":"f1","skills":{}}');
    runs = [];

    const prepared = await prepareVm(box, "1.0.0", credentials, "fingerprint");
    expect(runs).toHaveLength(1);
    // The sign-ins travel on stdin, never in the command line.
    expect(runs[0]!.command).toBe("bash -s");
    expect(readFileSync(vmFile("git-credentials"), "utf8")).toBe("https://octo:github_pat_secret@github.com\n");
    expect(readFileSync(vmFile("env"), "utf8")).toContain("export CLAUDE_CODE_OAUTH_TOKEN='claude-secret'");
    expect(prepared).toEqual({
      codexAuth: null,
      skillsManifest: '{"fingerprint":"f1","skills":{}}',
      t3: { descriptor: '{"orchestrationProtocolVersion":2}', credentials: "fingerprint" },
    });
  });

  test("switches OpenCode on in T3 with an OpenCode sign-in, keeping what the user set", async () => {
    const settings = () => JSON.parse(readFileSync(vmFile("t3/userdata/settings.json"), "utf8"));
    await prepareVm(box, "1.0.0", {}, "fingerprint");
    expect(existsSync(vmFile("t3/userdata/settings.json"))).toBe(false);

    await prepareVm(box, "1.0.0", { opencodeApiKey: "opencode-secret" }, "fingerprint");
    expect(settings()).toEqual({ providerInstances: { opencode: { driver: "opencode", enabled: true } } });

    // A VM whose user changed other settings, then switched OpenCode off in T3.
    const changed = { defaultThreadEnvMode: "worktree", providerInstances: { opencode: { driver: "opencode", enabled: false } } };
    writeFileSync(vmFile("t3/userdata/settings.json"), JSON.stringify(changed));
    await prepareVm(box, "1.0.0", { opencodeApiKey: "opencode-secret" }, "fingerprint");
    expect(settings()).toEqual(changed);

    // Other settings stay when OpenCode is switched on.
    writeFileSync(vmFile("t3/userdata/settings.json"), JSON.stringify({ defaultThreadEnvMode: "worktree" }));
    await prepareVm(box, "1.0.0", { opencodeApiKey: "opencode-secret" }, "fingerprint");
    expect(settings()).toEqual({ defaultThreadEnvMode: "worktree", providerInstances: { opencode: { driver: "opencode", enabled: true } } });
  });

  test("keeps a Codex sign-in the VM refreshed later than VM Bridge's, and hands it back", async () => {
    const auth = (refreshed: string) => JSON.stringify({ last_refresh: refreshed, tokens: { refresh_token: refreshed } });
    await prepareVm(box, "1.0.0", { codexAuthJson: auth("2026-01-01T00:00:00Z") }, "fingerprint");
    expect(readFileSync(vmFile("codex/auth.json"), "utf8")).toBe(auth("2026-01-01T00:00:00Z"));

    // Codex on the VM refreshed on its own.
    writeFileSync(vmFile("codex/auth.json"), auth("2026-01-02T00:00:00Z"));
    const kept = await prepareVm(box, "1.0.0", { codexAuthJson: auth("2026-01-01T00:00:00Z") }, "fingerprint");
    expect(kept.codexAuth).toBe(auth("2026-01-02T00:00:00Z"));
    expect(readFileSync(vmFile("codex/auth.json"), "utf8")).toBe(auth("2026-01-02T00:00:00Z"));

    // VM Bridge refreshed since: the VM gets its file.
    const replaced = await prepareVm(box, "1.0.0", { codexAuthJson: auth("2026-01-03T00:00:00Z") }, "fingerprint");
    expect(replaced.codexAuth).toBeNull();
    expect(readFileSync(vmFile("codex/auth.json"), "utf8")).toBe(auth("2026-01-03T00:00:00Z"));
    expect(existsSync(vmFile("codex/auth.json.incoming"))).toBe(false);
  });
});
