import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Recordings a folder can hold, by extension. A file named on its own is read whatever it is. */
const FOOTAGE = /\.(mov|mp4|m4v|mkv|webm|avi|mts|m2ts|mxf|3gp|wav|mp3|m4a|aac|aif|aiff|flac|ogg|opus)$/i;
/** How far into a folder's folders footage is looked for: a card's own layout puts clips a level or two down. */
const FOLDER_DEPTH = 2;
/** The most files one call adds. More is a whole drive, not a shoot. */
export const FOOTAGE_LIMIT = 200;

export interface FootageFile { path: string; size: number; modified: number }
export interface SkippedPath { path: string; reason: string }

/** `~` and `~/…` are the editor's home folder, as they'd say it. */
export function expandHome(path: string) {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * The files the paths name: each file as given, and each folder's recordings with those of the folders inside it,
 * by name. Hidden files and folders are passed over. A path that names nothing, or a folder with no recordings in
 * it, comes back with why.
 */
export async function footageAt(paths: string[]): Promise<{ files: FootageFile[]; skipped: SkippedPath[] }> {
  const files: FootageFile[] = [];
  const skipped: SkippedPath[] = [];
  const seen = new Set<string>();
  const add = async (path: string) => {
    const real = await realpath(path).catch(() => path);
    if (seen.has(real)) return;
    seen.add(real);
    const info = await stat(real);
    files.push({ path: real, size: info.size, modified: info.mtimeMs });
  };
  const walk = async (folder: string, depth: number): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).filter(e => !e.name.startsWith("."));
    entries.sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (files.length >= FOOTAGE_LIMIT) return;
      const path = join(folder, entry.name);
      if (entry.isFile() && FOOTAGE.test(entry.name)) await add(path).catch(() => {});
      else if (entry.isDirectory() && depth < FOLDER_DEPTH) await walk(path, depth + 1).catch(() => {});
    }
  };
  for (const given of paths) {
    const path = expandHome(given);
    if (!isAbsolute(path)) {
      skipped.push({ path: given, reason: "Not a full path. Give it from / or ~." });
      continue;
    }
    const info = await stat(path).catch(() => null);
    if (!info) {
      skipped.push({ path: given, reason: "Nothing is there." });
      continue;
    }
    if (info.isFile()) {
      if (files.length < FOOTAGE_LIMIT) await add(path);
      else skipped.push({ path: given, reason: `Only ${FOOTAGE_LIMIT} files are added at once.` });
      continue;
    }
    if (!info.isDirectory()) {
      skipped.push({ path: given, reason: "Not a file or a folder." });
      continue;
    }
    const before = files.length;
    try {
      await walk(path, 0);
    } catch (error) {
      skipped.push({ path: given, reason: `The folder couldn't be read: ${(error as Error).message}` });
      continue;
    }
    if (files.length === before) skipped.push({ path: given, reason: files.length >= FOOTAGE_LIMIT ? `Only ${FOOTAGE_LIMIT} files are added at once.` : "No video or audio in this folder or the folders inside it." });
  }
  return { files, skipped };
}

/**
 * The same import id for the same file in the same project, as long as it is unchanged, so asking twice adds it once.
 * Shaped as a UUID, as an import id is.
 */
export function footageImportId(projectId: string, file: FootageFile) {
  const hex = createHash("sha256").update(`${projectId}\0${file.path}\0${file.size}\0${file.modified}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
