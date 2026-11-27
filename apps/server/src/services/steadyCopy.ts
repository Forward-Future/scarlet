import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, open, realpath, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { clip, humanDuration } from "../logText.js";

const run = promisify(execFile);

/** How much may be written before it is flushed to disk. */
const FLUSH_EVERY = 64 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

/**
 * Copy a large file without filling the system's write cache.
 *
 * A plain copy of an 8 GB recording hands all of it to the cache in a few seconds, and the disk then spends the next
 * half minute writing it out. Anything else that flushes to that disk waits for all of it. The engine's database does
 * so on its one thread: during an import its writes took 21.4 s, 19.6 s and 27.7 s, and the engine answered nothing
 * meanwhile (2026-11-07). Here the copy flushes what it has written every 64 MB, so another flush waits for that
 * much at most.
 *
 * The copy keeps the source's times, as the platform copy does.
 */
export async function steadyCopy(source: string, destination: string, signal?: AbortSignal,
  options: { flushEvery?: number; chunk?: number } = {}): Promise<void> {
  const flushEvery = options.flushEvery ?? FLUSH_EVERY;
  const input = await open(source, "r");
  try {
    const output = await open(destination, "w");
    try {
      const buffer = Buffer.allocUnsafe(options.chunk ?? CHUNK);
      let unflushed = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written);
          if (!bytesWritten) throw new Error("Copy stopped before the file was written.");
          written += bytesWritten;
        }
        unflushed += bytesRead;
        if (unflushed >= flushEvery) {
          await output.datasync();
          unflushed = 0;
        }
      }
      await output.datasync();
    } finally {
      await output.close();
    }
    // Seconds as a number carry the time to a quarter of a microsecond. A Date would round it to the millisecond.
    const { atimeNs, mtimeNs } = await input.stat({ bigint: true });
    await utimes(destination, Number(atimeNs) / 1e9, Number(mtimeNs) / 1e9);
  } finally {
    await input.close();
  }
}

/** Below this a plain copy is quick enough that it needn't be throttled. */
const SMALL_COPY = 16 * 1024 * 1024;

/**
 * Share the source's blocks when the disk can: an APFS clone on a Mac, a reflink on Linux. Says whether it did.
 * macOS `cp -c` clones within a volume and silently copies in full across volumes, so a Mac clones only within one.
 */
async function cloneFile(source: string, destination: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform === "darwin") {
    const [from, into] = await Promise.all([stat(source), stat(dirname(destination))]);
    if (from.dev !== into.dev) return false;
    await run("/bin/cp", ["-c", await realpath(source), destination], { signal });
    return true;
  }
  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") throw error;
    await rm(destination, { force: true });
    return false;
  }
}

/**
 * Copy a file into the library as its own file: a clone where the disk allows it, which is instant and takes no space,
 * and otherwise `steadyCopy`, so a large recording on a disk without clones doesn't stall the engine. A copy that fails
 * leaves nothing at the destination. `log` hears how a large file was copied and how long it took, untagged: the caller
 * names the file.
 */
export async function cloneOrSteadyCopy(source: string, destination: string, signal?: AbortSignal,
  options: { smallBytes?: number; clone?: typeof cloneFile; log?: (line: string) => void } = {}): Promise<void> {
  const started = Date.now();
  let size: number | undefined;
  try {
    signal?.throwIfAborted();
    size = (await stat(source)).size;
    if (size < (options.smallBytes ?? SMALL_COPY)) await copyFile(source, destination, constants.COPYFILE_FICLONE);
    else if (await (options.clone ?? cloneFile)(source, destination, signal)) {
      options.log?.(`${megabytes(size)} cloned in ${humanDuration(Date.now() - started)}`);
    } else {
      await steadyCopy(source, destination, signal);
      options.log?.(`${megabytes(size)} copied in steps (the disk can't clone it) in ${humanDuration(Date.now() - started)}`);
    }
  } catch (error) {
    if (!signal?.aborted && size !== undefined) {
      options.log?.(`copying ${megabytes(size)} into the library failed after ${humanDuration(Date.now() - started)}: ${failure(error)}`);
    }
    await rm(destination, { force: true });
    throw error;
  }
}

/** The error's code alone where it has one: a file system message names the editor's file. */
const failure = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : clip(error instanceof Error ? error.name : String(error), 60);
};
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 * 1024 ? 0 : 1)} MB`;
