import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Put `value` in a map kept to `limit` entries as the most recently used, letting go of the least recently used first.
 * An entry `busy` says is in use stays, even past the limit.
 */
export function rememberLast<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
  busy: (value: V) => boolean = () => false,
): V {
  map.delete(key);
  for (const [other, old] of map) {
    if (map.size < limit) break;
    if (!busy(old)) map.delete(other);
  }
  map.set(key, value);
  return value;
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Write `data` to `tempPath` (preserving caller's leftover-sweeper naming) and atomically rename into place. */
export async function atomicWriteFile(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  tempPath: string,
  opts?: { mode?: number; flag?: string },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, data, opts);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/** Synchronous sibling of `atomicWriteFile`. */
export function atomicWriteFileSync(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  tempPath: string,
  opts?: { mode?: number; flag?: string },
): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, data, opts);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * Walk RIFF chunks of an open 16-bit mono PCM WAV handle to locate `"data"` and sample count.
 * FFmpeg may emit `LIST` chunks before `"data"`. When `requireSampleRate` is given, also verifies
 * the `"fmt "` chunk is 16-bit mono PCM at that exact sample rate.
 */
export async function readWavDataLayout(
  handle: FileHandle,
  opts?: { requireSampleRate?: number },
): Promise<{ data: number; samples: number } | undefined> {
  const head = Buffer.alloc(64 * 1024);
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  const size = (await handle.stat()).size;
  let format: Buffer | undefined;
  for (let at = 12; at + 8 <= bytesRead;) {
    const id = head.toString("ascii", at, at + 4);
    const bytes = head.readUInt32LE(at + 4);
    const start = at + 8;
    if (id === "fmt ") format = head.subarray(start, start + 16);
    if (id === "data") {
      if (opts?.requireSampleRate !== undefined) {
        if (
          !format ||
          format.readUInt16LE(0) !== 1 ||
          format.readUInt16LE(2) !== 1 ||
          format.readUInt32LE(4) !== opts.requireSampleRate ||
          format.readUInt16LE(14) !== 16
        ) {
          return undefined;
        }
      }
      return { data: start, samples: Math.floor(Math.min(bytes, size - start) / 2) };
    }
    at = start + bytes + (bytes % 2);
  }
  return undefined;
}
