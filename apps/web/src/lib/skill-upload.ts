import { skillUploadProblem, uploadLimits, type SkillFile } from "@vmbridge/contracts";

/** A skill read in the browser, ready to send. */
export interface SkillUpload {
  name: string;
  files: SkillFile[];
}

export class UploadError extends Error {}

/** A file read from a folder, a pick or an archive, its path relative to what was dropped. */
interface Entry {
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

/** Never part of a skill: version control, installed packages, and Finder's and macOS zip's leftovers. */
const skipped = new Set([".git", "node_modules", ".DS_Store", "__MACOSX"]);
const isSkipped = (path: string) => path.split("/").some((part) => skipped.has(part));

/** Stops reading a folder or archive dropped by mistake, such as a home folder, long before it is read whole. */
function guard() {
  let count = 0;
  let bytes = 0;
  return (path: string, size: number) => {
    if (++count > uploadLimits.skillFiles) throw new UploadError(`More than ${uploadLimits.skillFiles} files. Drop one skill folder.`);
    bytes += size;
    if (bytes > uploadLimits.skillBytes) throw new UploadError(`Larger than 1 MB at ${path}.`);
  };
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A script with a shebang, since a browser sees no file modes. */
const hasShebang = (bytes: Uint8Array) => bytes[0] === 0x23 && bytes[1] === 0x21;

const frontMatterName = (text: string) => /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text)?.[1];

/**
 * Turns what was dropped into a skill. SKILL.md at the top: the skill is named after `root` (the folder or archive).
 * Otherwise everything must sit in one folder with SKILL.md at its top, which names the skill.
 */
function toSkill(root: string, entries: Entry[]): SkillUpload {
  let name = root;
  let files = entries;
  if (!files.some((entry) => entry.path === "SKILL.md")) {
    const tops = new Set(files.map((entry) => entry.path.split("/")[0]));
    const [top] = tops;
    if (tops.size !== 1 || !top || !files.some((entry) => entry.path === `${top}/SKILL.md`)) throw new UploadError(`${root} has no SKILL.md at its top.`);
    name = top;
    files = files.map((entry) => ({ ...entry, path: entry.path.slice(top.length + 1) }));
  }
  const skill = {
    name,
    files: files.map(({ path, bytes, executable }) => ({ path, data: toBase64(bytes), ...(executable || hasShebang(bytes) ? { executable: true } : {}) })),
  };
  const problem = skillUploadProblem(skill.name, files.map((entry) => ({ path: entry.path, size: entry.bytes.length })));
  if (problem) throw new UploadError(problem);
  return skill;
}

const bytesOf = async (file: File) => new Uint8Array(await file.arrayBuffer());

/** A lone SKILL.md (or any .md with front matter), named by its front matter's `name`. */
async function fromMarkdown(file: File): Promise<SkillUpload> {
  if (file.size > uploadLimits.skillBytes) throw new UploadError(`${file.name} is larger than 1 MB.`);
  const bytes = await bytesOf(file);
  const name = frontMatterName(new TextDecoder().decode(bytes));
  if (!name) throw new UploadError(`${file.name} has no name in its front matter.`);
  return toSkill(name, [{ path: "SKILL.md", bytes, executable: false }]);
}

const u16 = (view: DataView, at: number) => view.getUint16(at, true);
const u32 = (view: DataView, at: number) => view.getUint32(at, true);

/** Inflates raw deflate data, stopping as soon as it grows past `size`, so a zip bomb cannot fill memory. */
async function inflate(data: Uint8Array<ArrayBuffer>, size: number, path: string) {
  const out = new Uint8Array(size);
  let length = 0;
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > size) {
      await reader.cancel();
      throw new UploadError(`${path} in the archive is not the size it claims.`);
    }
    out.set(value, length);
    length += value.length;
  }
  if (length !== size) throw new UploadError(`${path} in the archive is not the size it claims.`);
  return out;
}

/**
 * The files in a zip archive (a .zip, or a .skill as Claude exports them). Reads the central directory, the archive's
 * own list of what it holds. Refuses symbolic links, encrypted files, and anything but stored or deflated files.
 */
export async function readZip(archive: Uint8Array<ArrayBuffer>, label: string): Promise<{ path: string; bytes: Uint8Array; executable: boolean }[]> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end record is in the last 22 bytes plus a comment of up to 64 KB.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new UploadError(`${label} is not a zip archive.`);
  const count = u16(view, end + 10);
  let at = u32(view, end + 16);
  const check = guard();
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > archive.length || u32(view, at) !== 0x02014b50) throw new UploadError(`${label} is damaged.`);
    const madeBy = u16(view, at + 4) >> 8;
    const flags = u16(view, at + 8);
    const method = u16(view, at + 10);
    const compressed = u32(view, at + 20);
    const size = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    const mode = u32(view, at + 38) >>> 16;
    const local = u32(view, at + 42);
    const path = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/") || isSkipped(path)) continue;
    // Made on Unix (3) or macOS (19), where the upper half of the attributes is the file's mode.
    const unixMode = madeBy === 3 || madeBy === 19 ? mode : 0;
    if ((unixMode & 0o170000) === 0o120000) throw new UploadError(`${label} has a symbolic link, ${path}. Skills can't have links.`);
    if (flags & 1) throw new UploadError(`${label} is encrypted.`);
    if (method !== 0 && method !== 8) throw new UploadError(`${label} uses a compression VM Bridge can't read.`);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new UploadError(`${label} is larger than 1 MB.`);
    check(path, size);
    const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
    if (u32(view, local) !== 0x04034b50 || start + compressed > archive.length) throw new UploadError(`${label} is damaged.`);
    const data = archive.subarray(start, start + compressed);
    if (method === 0 && compressed !== size) throw new UploadError(`${label} is damaged.`);
    const bytes = method === 8 ? await inflate(data, size, path) : data;
    entries.push({ path, bytes, executable: (unixMode & 0o111) !== 0 });
  }
  return entries;
}

async function fromZip(file: File): Promise<SkillUpload> {
  // An archive compresses, but not by much more than this for text and scripts.
  if (file.size > uploadLimits.skillBytes * 2) throw new UploadError(`${file.name} is larger than 1 MB.`);
  const root = file.name.replace(/\.(zip|skill)$/i, "");
  return toSkill(root, await readZip(await bytesOf(file), file.name));
}

/** A skill picked or dropped as one file: an archive, or a lone SKILL.md. */
export async function skillFromFile(file: File): Promise<SkillUpload> {
  if (/\.(zip|skill)$/i.test(file.name)) return fromZip(file);
  if (/\.md$/i.test(file.name)) return fromMarkdown(file);
  throw new UploadError(`${file.name} is not a skill. Drop a skill folder, SKILL.md or .zip.`);
}

/** Every entry of a dropped folder. `readEntries` hands them over in batches until it returns none. */
async function readDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;
const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

async function fromFolder(folder: FileSystemDirectoryEntry): Promise<SkillUpload> {
  const check = guard();
  const entries: Entry[] = [];
  const walk = async (directory: FileSystemDirectoryEntry, prefix: string) => {
    for (const entry of await readDirectory(directory)) {
      if (skipped.has(entry.name)) continue;
      const path = prefix + entry.name;
      if (isDirectory(entry)) await walk(entry, `${path}/`);
      else if (isFile(entry)) {
        const file = await fileOf(entry);
        check(path, file.size);
        entries.push({ path, bytes: await bytesOf(file), executable: false });
      }
    }
  };
  await walk(folder, "");
  return toSkill(folder.name, entries);
}

/** The skills in a drop: each folder, SKILL.md or archive is one. */
export async function skillsFromDrop(items: DataTransferItemList): Promise<SkillUpload[]> {
  // Taken before the first await: the browser empties the list once the drop event is over. A file without an
  // entry, such as one dropped from another page, still comes as a File.
  const dropped = [...items].flatMap((item): (File | FileSystemDirectoryEntry)[] => {
    if (item.kind !== "file") return [];
    const entry = item.webkitGetAsEntry();
    if (entry && isDirectory(entry)) return [entry];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
  if (dropped.length === 0) throw new UploadError("Drop a skill folder, SKILL.md or .zip.");
  const skills: SkillUpload[] = [];
  for (const item of dropped) skills.push(item instanceof File ? await skillFromFile(item) : await fromFolder(item));
  return skills;
}

/** The skill in a folder picked with a `webkitdirectory` input, whose files carry paths from the folder's name. */
export async function skillFromFolderPick(files: FileList): Promise<SkillUpload> {
  const [first] = files;
  if (!first) throw new UploadError("That folder is empty.");
  const root = first.webkitRelativePath.split("/")[0] ?? first.name;
  const check = guard();
  const entries: Entry[] = [];
  for (const file of files) {
    const path = file.webkitRelativePath.split("/").slice(1).join("/");
    if (isSkipped(path)) continue;
    check(path, file.size);
    entries.push({ path, bytes: await bytesOf(file), executable: false });
  }
  return toSkill(root, entries);
}
