/**
 * A reading of a video's picture that is done a window at a time and kept beside its waveform: the text on screen
 * (screenText.ts) and the faces in frame (faces.ts). Once a video is asked about, all of it is read: the asked-for
 * windows first, then the rest in order, so a later question about the whole video answers at once. Windows nobody
 * asked for are held by a pause of the project's media work.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fileInDirectory, probeMedia, screenFrameSize, screenFrames } from "@scarlet/render";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { atomicWriteFile, rememberLast, round3 } from "../util.js";
import { machineBusy, pictureDecoder, pictureLane } from "./pictureWork.js";
import { previewCopyByTime } from "./previewPictures.js";

export type VideoMedia = MediaAsset & { projectId: string };

export interface PictureReading<W> {
  /** Names the kept file (`<media id>.<name>.json`), the working frames (`<name>-<uuid>.rgb`) and log lines. */
  name: string;
  /** Seconds of video read and kept together. */
  window: number;
  /** What the kept reading depends on. A reading kept under another identity is read again. */
  identity(media: MediaAsset): string;
  /** Read one window, `start`–`end` source seconds. `unasked` when no request asked for it: it is read behind those that were. */
  read(ctx: Ctx, media: VideoMedia, file: string, window: { index: number; start: number; end: number; unasked?: boolean }, signal: AbortSignal): Promise<W>;
}

/** A kept reading's identity: its version, the recording, and every setting the reading depends on, in order. */
export function readingIdentity(version: number, media: MediaAsset, ...dependsOn: unknown[]): string {
  return createHash("sha256").update(JSON.stringify([version, media.hash ?? media.path, media.duration, ...dependsOn])).digest("hex");
}

/** The size a recording's frames are read at: its own size, from its record or else the file, fit to `maxSide`. */
export async function readingFrameSize(media: VideoMedia, file: string, maxSide?: number): Promise<{ width: number; height: number }> {
  const source = media.width && media.height ? { width: media.width, height: media.height } : await probeMedia(file);
  return screenFrameSize(source.width, source.height, maxSide);
}

export interface PictureReadResult<W> {
  from: number; to: number;
  /** The windows of the range read so far, in order. */
  ready: Array<{ index: number; start: number; end: number; value: W }>;
  /** Every window of the video read so far, in order. */
  all: Array<{ index: number; start: number; end: number; value: W }>;
  /** Seconds of the range read so far, and whether the whole range has been. */
  readSeconds: number; done: boolean;
  /** Why reading stopped, when it did. */
  error?: string;
}

interface Kept<W> { identity: string; chunks: Record<string, W> }

interface Recording<W> {
  kept?: Promise<Kept<W>>;
  /** Windows waiting to be read, in order, and the one being read. */
  queue: number[];
  /** Windows a request asked for. The rest are read unasked, and a pause of the project's media work holds them. */
  asked: Set<number>;
  reading?: Promise<void>;
  /** Wakes those waiting for windows to be read. */
  waiters: Set<() => void>;
  error?: string;
}

/** Seconds or a fraction to the thousandth, as readings report them. */
export const r3 = round3;

/** Mean grey of each cell of a cols × rows grid over the frame, from every `step`th pixel each way. */
export function pictureGrid(rgb: Buffer, width: number, height: number, cols = 32, rows = 18, step = 2): Float32Array {
  const sums = new Float32Array(cols * rows), counts = new Uint32Array(cols * rows);
  const colOf = new Int32Array(width);
  for (let x = 0; x < width; x += step) colOf[x] = Math.min(cols - 1, Math.floor(x * cols / width));
  for (let y = 0; y < height; y += step) {
    const rowBase = Math.min(rows - 1, Math.floor(y * rows / height)) * cols;
    const rowPixel = y * width;
    for (let x = 0; x < width; x += step) {
      const p = (rowPixel + x) * 3, cell = rowBase + colOf[x]!;
      sums[cell] = sums[cell]! + (rgb[p]! * 3 + rgb[p + 1]! * 6 + rgb[p + 2]!) / 10;
      counts[cell] = counts[cell]! + 1;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] = counts[i] ? sums[i]! / counts[i]! : 0;
  return sums;
}

/** Recordings whose reading state a reader keeps. */
const MAX_RECORDINGS = 32;

/** A reader for one kind of reading. `read` answers a range of a video, reading what hasn't been read yet. */
export function pictureReader<W>(spec: PictureReading<W>) {
  const recordings = new Map<string, Recording<W>>();
  const keptPath = (ctx: Ctx, media: VideoMedia) => join(ctx.paths.waveforms(media.projectId), `${media.id}.${spec.name}.json`);

  async function loadKept(ctx: Ctx, media: VideoMedia): Promise<Kept<W>> {
    const id = spec.identity(media);
    try {
      const kept = JSON.parse(await readFile(keptPath(ctx, media), "utf8")) as Kept<W>;
      if (kept.identity === id && kept.chunks && typeof kept.chunks === "object") return kept;
    } catch { /* Not read yet, or from another reading. */ }
    return { identity: id, chunks: {} };
  }

  async function save(ctx: Ctx, media: VideoMedia, kept: Kept<W>) {
    const path = keptPath(ctx, media);
    await atomicWriteFile(path, JSON.stringify(kept), `${path}.${randomUUID()}.tmp`);
  }

  function recordingFor(ctx: Ctx, media: VideoMedia) {
    const key = `${ctx.paths.root}\0${media.id}\0${spec.identity(media)}`;
    // What was read is kept on disk, so a recording let go is read back from there when it is asked for again. One
    // being read, or waited for, stays.
    const state = rememberLast<string, Recording<W>>(recordings, key, recordings.get(key) ?? { queue: [], asked: new Set(), waiters: new Set() }, MAX_RECORDINGS,
      other => !!other.reading || other.waiters.size > 0);
    state.kept ??= loadKept(ctx, media);
    return state;
  }

  const bounds = (media: VideoMedia, index: number) =>
    ({ index, start: index * spec.window, end: Math.min(media.duration ?? 0, (index + 1) * spec.window) });

  /** Read the windows queued for a recording, one after another, saving each as it is read. */
  function readQueued(ctx: Ctx, media: VideoMedia, file: string, state: Recording<W>) {
    if (state.reading) return;
    state.reading = ctx.track((async () => {
      const kept = await state.kept!;
      while (state.queue.length) {
        const index = state.queue[0]!;
        const signal = state.asked.has(index) ? ctx.projectSignal(media.projectId) : ctx.mediaSignal(media.projectId);
        if (signal.aborted) {
          // Paused or gone: what nobody asked for waits for the next request.
          if (!state.asked.has(index)) { state.queue = state.queue.filter(i => state.asked.has(i)); continue; }
          break;
        }
        if (!kept.chunks[index]) {
          try {
            kept.chunks[index] = await spec.read(ctx, media, file, { ...bounds(media, index), unasked: !state.asked.has(index) }, signal);
            state.error = undefined;
            await save(ctx, media, kept);
          } catch (error) {
            // A pause stopped a window read unasked, which a request may since have asked for: look again.
            if (signal.aborted) continue;
            state.error = error instanceof Error ? error.message : String(error);
            ctx.log(`[${spec.name}] ${media.id} at ${index * spec.window} s: ${state.error}`);
            state.queue = [];
          }
        }
        state.queue.shift();
        for (const wake of state.waiters) wake();
      }
    })(), media.projectId).finally(() => {
      state.reading = undefined;
      for (const wake of state.waiters) wake();
    });
  }

  /**
   * A range of a video, reading what hasn't been read yet. Waits up to `waitMs` for it, then returns what is ready;
   * reading carries on in the background.
   */
  async function read(ctx: Ctx, media: VideoMedia, range: { from?: number; to?: number },
    opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<PictureReadResult<W>> {
    if (media.kind !== "video") throw new Error("Only a video has a picture to read.");
    const duration = media.duration;
    if (!duration) throw new Error("The recording is still being prepared. Ask again in a moment.");
    const file = fileInDirectory(ctx.paths.media(media.projectId), media.path);
    if (!file) throw new Error("The recording's file is missing.");
    const from = Math.max(0, range.from ?? 0), to = Math.min(duration, range.to ?? duration);
    if (!(to > from)) throw new Error(`Choose a range inside the recording's ${duration.toFixed(2)} s.`);
    const state = recordingFor(ctx, media);
    const kept = await state.kept!;
    const wanted: number[] = [];
    for (let i = Math.floor(from / spec.window); i * spec.window < to; i++) wanted.push(i);
    const missing = () => wanted.filter(i => !kept.chunks[i]);
    const windows = Math.ceil(duration / spec.window);
    // Windows already queued keep their place behind the asked ones.
    const every = Array.from({ length: windows }, (_, i) => i).filter(i => !kept.chunks[i]);
    if (every.length && (missing().length || !state.reading)) {
      const first = missing();
      for (const i of first) state.asked.add(i);
      const current = state.reading && state.queue.length ? [state.queue[0]!] : [];
      state.queue = [...new Set([...current, ...first, ...state.queue, ...every])];
      state.error = undefined;
      readQueued(ctx, media, file, state);
    }
    if (missing().length) {
      const waitMs = opts.waitMs ?? 30_000;
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, waitMs);
        const check = () => { if (!missing().length || !state.reading) done(); };
        function done() { clearTimeout(timer); state.waiters.delete(check); opts.signal?.removeEventListener("abort", done); resolve(); }
        state.waiters.add(check);
        opts.signal?.addEventListener("abort", done, { once: true });
        check();
      });
    }
    const window = (i: number) => ({ ...bounds(media, i), value: kept.chunks[i]! });
    const ready = wanted.filter(i => kept.chunks[i]);
    const readSeconds = ready.reduce((n, i) => n + Math.max(0, Math.min(to, (i + 1) * spec.window) - Math.max(from, i * spec.window)), 0);
    return { from, to, ready: ready.map(window),
      all: Array.from({ length: windows }, (_, i) => i).filter(i => kept.chunks[i]).map(window),
      readSeconds: r3(readSeconds), done: ready.length === wanted.length,
      ...(state.error && ready.length < wanted.length && { error: state.error }) };
  }

  /** How many recordings the reader keeps in memory. */
  const kept = () => recordings.size;

  return { read, kept };
}

/**
 * Decode `start`–`end` of a video at `fps`, `width` by `height`, in one pass, write the frames `keep` accepts to working
 * files of up to `batch` frames, and hand each file with its frames' source seconds to `use` as soon as it is full, while
 * decoding goes on. Returns what `use` returned for each, in order. A long distance between keyframes makes each
 * separate seek decode up to that much again: 8 s on a 4K camera file.
 *
 * With `fromCopy`, the frames come from the recording's verified preview copy when it is at least as tall as they are:
 * a reading of small frames sees in it what it would in the original, and decodes it far sooner. On a machine with
 * five times as much work as cores, a minute of a 4K recording read for its edges took 93 s from the original and 5 s
 * from its 720p copy, and the whole 28-minute recording took 22 minutes inside a pass (2026-11-22). `background` reads
 * behind everything that was asked for.
 */
export async function withFrames<T>(ctx: Ctx, media: VideoMedia, file: string, name: string,
  frames: { start: number; end: number; fps: number; width: number; height: number; signal: AbortSignal; batch?: number; fromCopy?: boolean; background?: boolean },
  keep: (at: number, rgb: Buffer) => boolean, use: (path: string, times: number[]) => Promise<T>): Promise<T[]> {
  const { start, end, fps, width, height, signal, batch = Infinity } = frames;
  const copy = frames.fromCopy ? await previewCopyByTime(ctx.paths.media(media.projectId), media, height, signal).catch(() => undefined) : undefined;
  // CUDA shrinks each frame on the GPU before it comes back to memory. VideoToolbox hands back every 4K frame whole:
  // ten seconds of a 4K recording took 2.6 s that way and 0.5 s on the CPU (M-series, 2026-11-13), so it decodes an
  // original only while the machine is too busy to give the CPU's decoder its cores.
  const gpu = await pictureDecoder(ctx.settings().render.hwaccel);
  const decoder = gpu === "cuda" || (gpu === "videotoolbox" && machineBusy()) ? gpu : undefined;
  await mkdir(ctx.paths.tmp, { recursive: true });
  const handed: Array<Promise<T>> = [];
  // Each file is closed once before handing it to `use`.
  let open: { path: string; handle: FileHandle; times: number[] } | undefined;
  const close = async () => {
    if (!open) return;
    const { path, handle, times } = open;
    open = undefined;
    await handle.close();
    const used = (times.length ? use(path, times) : Promise.resolve(undefined as T)).finally(() => rm(path, { force: true }));
    // Settled below; a failure while frames are still decoding is not left unhandled meanwhile.
    used.catch(() => {});
    handed.push(used);
  };
  let delivered = 0;
  const onFrame = async (i: number, rgb: Buffer) => {
    delivered = i + 1;
    const at = start + i / fps;
    if (!keep(at, rgb)) return;
    if (!open) {
      const path = join(ctx.paths.tmp, `${name}-${randomUUID()}.rgb`);
      open = { path, handle: await openFile(path, "w"), times: [] };
    }
    open.times.push(at);
    for (let written = 0; written < rgb.length;) {
      const { bytesWritten } = await open.handle.write(rgb, written, rgb.length - written);
      written += bytesWritten;
    }
    if (open.times.length >= batch) await close();
  };
  const onFallback = (reason: string) => ctx.log(`[${name}] ${media.id}: ${reason}`);
  // The copy's clock runs `copy.start` seconds behind the source; a frame's second stays the source's. The copy is small
  // enough for the CPU, and an HDR original's is already tone-mapped.
  const fromCopy = copy && (() => screenFrames(copy.file, { start: start - copy.start, end: end - copy.start }, { fps, width, height, signal, onFallback }, onFrame));
  const fromOriginal = () => screenFrames(file, { start, end }, { fps, width, height, decoder, hdr: media.color?.hdr, signal, onFallback }, onFrame);
  try {
    await pictureLane(ctx).run(async () => {
      if (fromCopy) {
        try { return await fromCopy(); }
        catch (error) {
          // Frames already handed over stay handed over: the original is read only when the copy gave none.
          signal.throwIfAborted();
          if (delivered) throw error;
          onFallback(`its preview copy could not be read (${error instanceof Error ? error.message : String(error)}); read the original.`);
        }
      }
      return fromOriginal();
    }, { signal, priority: frames.background ? "background" : false });
    await close();
    return await Promise.all(handed);
  } finally {
    if (open) {
      const leftover = open;
      open = undefined;
      await leftover.handle.close().catch(() => {});
      await rm(leftover.path, { force: true });
    }
    await Promise.allSettled(handed);
  }
}
