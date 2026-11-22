/**
 * Shared segment helpers: timeline slicing, ffconcat escaping, atomic temp-file
 * staging/publishing, and bounded parallel batch execution.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clipRange, firstIndex } from "@scarlet/timeline";
import type { Timeline, TimeRange } from "@scarlet/timeline";

/** Preserve compositing order while visiting each clip only in segments it intersects. */
export function segmentTimelines(timeline: Timeline, ranges: TimeRange[]): Timeline[] {
  const parts: Timeline[] = ranges.map(() => ({
    ...timeline,
    tracks: timeline.tracks.map(track => ({ ...track, clips: [] })),
  }));
  const ends = ranges.map(r => r.end);
  timeline.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      const { start, end } = clipRange(clip);
      const lo = firstIndex(ends, rangeEnd => rangeEnd > start);
      for (let i = lo; i < ranges.length && ranges[i]!.start < end; i++) {
        parts[i]!.tracks[trackIndex]!.clips.push(clip);
      }
    }
  });
  return parts;
}

export function exportSegments(ranges: TimeRange[], trim?: TimeRange): TimeRange[] {
  if (!trim) return ranges;
  return ranges.filter(r => r.end > trim.start && r.start < trim.end)
    .map(r => ({ start: Math.max(trim.start, r.start), end: Math.min(trim.end, r.end) }));
}

export function concatFile(f: string): string {
  return `file '${path.resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

export async function fileHasContent(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function publishSegment(temp: string, file: string): Promise<void> {
  try {
    await fs.rename(temp, file);
  } catch (err) {
    // Windows can lock a segment that a competing export has already started reading.
    const code = (err as NodeJS.ErrnoException).code;
    if (!["EPERM", "EACCES", "EEXIST"].includes(code ?? "") || !(await fileHasContent(file))) throw err;
    await fs.rm(temp);
  }
}

/** Run `work` writing into a unique sibling temp path, always cleaning it up on exit. */
export async function withStagedFile<T>(target: string, suffix: string, work: (temp: string) => Promise<T>): Promise<T> {
  const temp = `${target}.${randomUUID()}.${suffix}`;
  try {
    return await work(temp);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Stop siblings on failure and wait for every encoder and temporary file to drain. */
export async function renderBatch(
  count: number, concurrency: number, parent: AbortSignal | undefined,
  render: (index: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const failed = new AbortController();
  const signal = parent ? AbortSignal.any([parent, failed.signal]) : failed.signal;
  let next = 0;
  async function worker() {
    try {
      while (next < count && !signal.aborted) await render(next++, signal);
    } catch (error) {
      failed.abort(error);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
  signal.throwIfAborted();
}
