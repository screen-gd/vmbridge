import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingBox } from "./vm-program.ts";
import { envNameProblem, envValueProblem, prepareVm, type VmCredentials } from "../src/vm/runtime.ts";

/** The files prepareVm writes into the VM. */
async function vmFiles(credentials: VmCredentials) {
  const { box, written } = recordingBox();
  await prepareVm(box, "1.0.0", credentials, "fingerprint");
  return written;
}

const envFile = async (credentials: VmCredentials) => (await vmFiles(credentials))["/workspace/.vmbridge/env"]!;

describe("environment variables", () => {
  test.each(["bash", "sh"])("values come out of the env file exactly as set, read by %s", async (shell) => {
    const values = {
      SPACES: "  two  spaces  ",
      QUOTES: `it's "quoted" and 'again'`,
      DOLLAR: "$HOME ${PATH} $(whoami) `id` \\n stays",
      NEWLINES: "first\nsecond\n\nfourth\n",
      EMPTY: "",
    };
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-env-"));
    try {
      const file = join(dir, "env");
      writeFileSync(file, await envFile({ env: values }));
      for (const [name, value] of Object.entries(values)) {
        const read = Bun.spawnSync([shell, "-c", `. ${file} && printf '%s' "$${name}"`]);
        expect(read.stdout.toString()).toBe(value);
      }
      // Set even when empty, unlike a variable VM Bridge leaves out.
      expect(Bun.spawnSync([shell, "-c", `. ${file} && printf '%s' "\${EMPTY-unset}"`]).stdout.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names VM Bridge sets, or that would break shells and agents, are refused", () => {
    for (const name of ["PATH", "HOME", "SHELL", "IFS", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GH_TOKEN", "GITHUB_TOKEN", "GIT_TERMINAL_PROMPT", "ANTHROPIC_API_KEY", "T3CODE_HOME", "T3CODE_ANYTHING", "VMBRIDGE_CREDENTIALS", "LD_PRELOAD"]) {
      expect(envNameProblem(name)).toContain("reserved");
    }
    for (const name of ["", "1ABC", "MY-VAR", "MY VAR", "A=B", "ÄPI"]) expect(envNameProblem(name)).toStartWith("Use letters");
    for (const name of ["API_URL", "_private", "npm_config_registry", "Path", "data", "root"]) expect(envNameProblem(name)).toBeNull();
  });

  test("names bash refuses to assign are refused, so the env file always loads", () => {
    // Bash 5 adds BASHOPTS to these; whichever bash runs the tests, everything it marks readonly is covered.
    const readonly = [...Bun.spawnSync(["bash", "-c", "readonly -p"], { env: {} }).stdout.toString().matchAll(/^declare -\S+ (\w+)/gm)].map((m) => m[1]!);
    expect(readonly).toContain("UID");
    for (const name of [...readonly, "UID", "EUID", "PPID", "SHELLOPTS", "BASHOPTS", "BASHPID", "GROUPS", "FUNCNAME", "BASH_SOURCE"]) {
      expect(envNameProblem(name)).toContain("reserved");
    }
  });

  test("a name saved before it was reserved is left out of the env file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-env-"));
    try {
      const file = join(dir, "env");
      writeFileSync(file, await envFile({ env: { UID: "1000", API_URL: "https://example.com" } }));
      const read = Bun.spawnSync(["bash", "-c", `set -e; . ${file}; printf '%s' "$API_URL"`]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout.toString()).toBe("https://example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("values are limited in UTF-8 bytes", () => {
    expect(envValueProblem("a".repeat(32_768))).toBeNull();
    expect(envValueProblem("é".repeat(16_384))).toBeNull();
    expect(envValueProblem("é".repeat(16_385))).toBe("Use at most 32,768 bytes.");
  });

  test("variables named like the start script's own neither change T3's folders nor get changed for T3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-env-"));
    try {
      // The VM's /workspace, moved into a temporary folder, with a t3 that prints how it was started.
      const vm = (text: string) => text.replaceAll("/workspace", dir);
      const env = { data: "/srv/app", root: "/srv", runtime: "mine", pid: "1", API_URL: "https://example.com" };
      const files = await vmFiles({ env });
      mkdirSync(join(dir, ".vmbridge/npm/bin"), { recursive: true });
      for (const [path, text] of Object.entries(files)) writeFileSync(vm(path), vm(text));
      writeFileSync(join(dir, ".vmbridge/npm/bin/t3"), `#!/bin/sh\nprintf '%s\\n' "$*" "$data" "$root" "$runtime" "$pid" "$API_URL"\n`);
      chmodSync(join(dir, ".vmbridge/npm/bin/t3"), 0o755);
      const run = Bun.spawnSync(["bash", join(dir, ".vmbridge/start-t3.sh")]);
      expect(run.stderr.toString()).toBe("");
      const [args, ...vars] = run.stdout.toString().trimEnd().split("\n");
      expect(args).toStartWith(`--base-dir ${dir}/.vmbridge/t3 `);
      expect(vars).toEqual(Object.values(env));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
