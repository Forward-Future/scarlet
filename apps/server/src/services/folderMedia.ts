import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { ExpandMediaPathsResponse } from "@scarlet/shared";
import { humanDuration } from "../logText.js";

/**
 * Unambiguous video file extensions discovered inside dropped folders.
 * `.ts` is checked separately for MPEG-TS packet sync bytes so TypeScript source files aren't mistaken for video.
 * `.lrv` (GoPro low-res proxy) and sidecars (`.xml`, `.thm`, `.srt`) are deliberately omitted.
 */
export const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
  ".mts", ".m2ts", ".mxf", ".3gp", ".3g2", ".wmv",
  ".asf", ".mpg", ".mpeg", ".flv", ".ogv", ".f4v",
  ".vob", ".dv", ".m2v", ".insv",
]);

const IGNORED_DIRS = new Set(["__macosx", "$recycle.bin", "system volume information"]);
const MAX_DEPTH = 16;
const MAX_ENTRIES = 20_000;
const MAX_VIDEOS = 1000;
const MPEG_TS_SYNC = 0x47;
const MPEG_TS_STRIDES = [
  { offset: 0, stride: 188 },
  { offset: 4, stride: 192 },
] as const;

const isLink = (source: string) => /^https?:\/\//i.test(source);
const pathBaseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const compareNatural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * Distinguish MPEG-TS video streams (`.ts`) from TypeScript source files by checking the 0x47 sync byte
 * at standard 188-byte (TS) or 192-byte (M2TS) packet boundaries.
 */
export async function isMpegTsFile(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const { offset, stride } of MPEG_TS_STRIDES) {
      if (bytesRead >= offset + stride * 2 + 1) {
        if (buffer[offset] === MPEG_TS_SYNC && buffer[offset + stride] === MPEG_TS_SYNC && buffer[offset + stride * 2] === MPEG_TS_SYNC) {
          return true;
        }
      } else if (bytesRead >= offset + stride + 1) {
        if (buffer[offset] === MPEG_TS_SYNC && buffer[offset + stride] === MPEG_TS_SYNC) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Whether a file inside a dropped folder is a video Scarlet should import. */
export async function isVideoFile(filePath: string): Promise<boolean> {
  const ext = extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return true;
  if (ext === ".ts") return isMpegTsFile(filePath);
  return false;
}

/**
 * Expand dropped paths for media import:
 * - Folders are searched recursively for video files (skipping hidden files, AppleDouble `._*` forks, OS junk, and symlink cycles).
 * - Directly dropped files (any format) and http(s) URLs pass through unchanged.
 * - Dropped folders that contain no video files are reported in `emptyFolders`.
 */
export async function expandMediaPaths(
  paths: readonly string[],
  opts: { signal?: AbortSignal; maxVideos?: number; maxEntries?: number; maxDepth?: number; log?: (line: string) => void } = {},
): Promise<ExpandMediaPathsResponse> {
  const maxVideos = opts.maxVideos ?? MAX_VIDEOS;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const log = opts.log ?? (() => {});
  const began = performance.now();
  let unreadable = 0;
  let limited = false;
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const emptyFolders: Array<{ path: string; name: string }> = [];
  let folders = 0;
  let scannedEntries = 0;

  const addFile = async (filePath: string): Promise<boolean> => {
    const key = isLink(filePath) ? filePath : await realpath(filePath).catch(() => filePath);
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    files.push(filePath);
    return true;
  };

  for (const input of paths) {
    opts.signal?.throwIfAborted();
    if (isLink(input) || !isAbsolute(input)) {
      await addFile(input);
      continue;
    }
    const info = await stat(input).catch(() => null);
    if (!info?.isDirectory()) {
      await addFile(input);
      continue;
    }
    folders++;
    const visitedDirs = new Set<string>();
    let foundInFolder = 0;
    let hitLimit = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      opts.signal?.throwIfAborted();
      if (depth > maxDepth) return;
      if (scannedEntries >= maxEntries || files.length >= maxVideos) {
        hitLimit = true;
        return;
      }
      const canonical = await realpath(dir).catch(() => dir);
      if (visitedDirs.has(canonical)) return;
      visitedDirs.add(canonical);

      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        // A folder that can't be listed (no permission, gone) is skipped; it is counted for the log.
        unreadable++;
        return;
      }

      const fileEntries: string[] = [];
      const dirEntries: string[] = [];
      entries.sort((a, b) => compareNatural(a.name, b.name));

      for (const entry of entries) {
        opts.signal?.throwIfAborted();
        if (scannedEntries >= maxEntries || files.length >= maxVideos) {
          hitLimit = true;
          break;
        }
        scannedEntries++;
        // Skip dotfiles (`.DS_Store`, `._clip.mp4` AppleDouble forks, `.git`) and OS metadata folders.
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name.toLowerCase())) dirEntries.push(full);
        } else if (entry.isFile()) {
          fileEntries.push(full);
        } else if (entry.isSymbolicLink()) {
          const target = await stat(full).catch(() => null);
          if (!target) continue;
          if (target.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name.toLowerCase())) dirEntries.push(full);
          } else if (target.isFile()) {
            fileEntries.push(full);
          }
        }
      }

      for (const file of fileEntries) {
        opts.signal?.throwIfAborted();
        if (files.length >= maxVideos) {
          hitLimit = true;
          break;
        }
        if (await isVideoFile(file)) {
          foundInFolder++;
          await addFile(file);
        }
      }

      for (const sub of dirEntries) {
        if (scannedEntries >= maxEntries || files.length >= maxVideos) {
          hitLimit = true;
          break;
        }
        await walk(sub, depth + 1);
      }
    };

    await walk(input, 0);
    if (hitLimit) limited = true;
    if (foundInFolder === 0 && !hitLimit) {
      emptyFolders.push({ path: input, name: pathBaseName(input) });
    }
  }

  // Counts only: the folders' and files' names are the editor's.
  if (folders) {
    log(`[media] dropped folders searched in ${humanDuration(performance.now() - began)}: ${folders} folders, ${scannedEntries} entries, ${files.length} files, ${emptyFolders.length} without video${unreadable ? `, ${unreadable} couldn't be listed` : ""}${limited ? ", stopped at the limit" : ""}`);
  }
  return { files, folders, emptyFolders };
}
