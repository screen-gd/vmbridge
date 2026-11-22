import type { Box } from "../src/providers/index.ts";

/** The files a program from `prepareVm` or `writeCredentials` writes, by path. */
export function programFiles(program: string) {
  const files: Record<string, string> = {};
  for (const [, path, data] of program.matchAll(/^put '([^']+)' <<'VMBRIDGE_FILE'\n([^]*?)VMBRIDGE_FILE$/gm)) {
    files[path!] = Buffer.from(data!, "base64").toString();
  }
  return files;
}

/** A VM that records each command and the files its programs write, and reports nothing back. */
export function recordingBox() {
  const written: Record<string, string> = {};
  const commands: string[] = [];
  const box = {
    run: async (command: string, options: { stdin?: string } = {}) => {
      commands.push(command);
      if (options.stdin) Object.assign(written, programFiles(options.stdin));
      return { ok: true, exitCode: 0, stdout: "", stderr: "", output: "" };
    },
  } as unknown as Box;
  return { box, written, commands };
}
