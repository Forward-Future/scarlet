import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

async function artifactPath(workDir: string, input: string, createParents: boolean): Promise<string> {
  // Work from the configured root, including when the caller uses a relative path.
  if (!(await lstat(workDir)).isDirectory()) throw new Error("Invalid task artifact directory");
  const root = await realpath(workDir);
  const target = resolve(workDir, input);
  // On macOS the same workspace can be named through /var or /private/var.
  // Accept our own returned canonical path on the next tool call as well.
  const rel = [resolve(workDir), root].map((base) => relative(base, target))
    .find((part) => part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  if (!rel) throw new Error("File must be inside the task artifact directory");
  const parts = rel.split(sep);
  if (parts.some((part) => part.startsWith(".") || (process.platform === "win32" && /[:]|[ .]$/.test(part)))) {
    throw new Error("Invalid artifact path");
  }
  // A private, host-created root is separate from the runner configs. Never
  // follow a link in an agent-selected path, including during recursive mkdir.
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (createParents) {
      await mkdir(parent, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
    }
    if (!(await lstat(parent)).isDirectory()) throw new Error("Artifact parent must be a directory, not a link");
  }
  return join(parent, basename(rel));
}

export async function readArtifact(workDir: string, input: string): Promise<Buffer<ArrayBuffer>> {
  const path = await artifactPath(workDir, input, false);
  if (!(await lstat(path)).isFile()) throw new Error("Artifact must be a regular file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Artifact must be a private regular file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function writeArtifact(workDir: string, output: string, data: string | Uint8Array): Promise<string> {
  const path = await artifactPath(workDir, output, true);
  const existing = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return undefined;
  });
  if (existing && !existing.isFile()) throw new Error("Export destination must be a regular file");
  // Replace the directory entry atomically without opening an existing link.
  const temp = join(dirname(path), `.export-${randomUUID()}`);
  try {
    await writeFile(temp, data, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
    return path;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Remove a session's own temporary folder when the session ends, all but the files in `keep` (as `writeArtifact`
 * returned them) and the folders that hold them. With nothing to keep, the folder goes too.
 */
export async function removeSessionFiles(dir: string, keep: ReadonlySet<string>): Promise<void> {
  if (!keep.size) return rm(dir, { recursive: true, force: true });
  const clear = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (keep.has(path)) continue;
      if (entry.isDirectory() && [...keep].some(file => file.startsWith(path + sep))) await clear(path);
      else await rm(path, { recursive: true, force: true });
    }
  };
  await clear(await realpath(dir));
}

export function guessKind(name: string): "video" | "audio" | "image" | "graphic" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["mp4", "mov", "mkv", "webm", "avi", "m4v", "mxf"].includes(ext)) return "video";
  if (["wav", "mp3", "aac", "m4a", "flac", "ogg", "aif", "aiff"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(ext)) return "image";
  if (["svg", "json", "lottie"].includes(ext)) return "graphic";
  return "video";
}

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
