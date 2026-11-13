import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
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

export async function writeArtifact(workDir: string, output: string, data: string): Promise<string> {
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
