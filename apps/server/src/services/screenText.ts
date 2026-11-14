/**
 * The text on screen in a recording, read once and kept beside its waveform. A recording is read a minute at a time,
 * one frame a second, and a frame is read only when the picture has changed since the last one read: a screen that
 * holds still costs one reading. Each line of text becomes a span from the first frame that shows it to the first
 * that doesn't. This is evidence for the model, never a decision.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileInDirectory, probeMedia, screenFrameSize, screenFrames } from "@scarlet/render";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { audioWorker } from "../transcribe/audioWorker.js";
import { LocalWhisperModel } from "../transcribe/localModel.js";
import { SCREEN_TEXT_MODELS, type ScreenLine } from "../transcribe/screenTextModel.js";
import { pictureDecoder, pictureLane } from "./pictureWork.js";

/** Bump when the reading changes: the models, the sampling or how lines become spans. Kept readings are read again. */
export const SCREEN_TEXT_VERSION = 2;
/** Seconds of a recording read and kept together. */
export const SCREEN_TEXT_CHUNK = 60;
/** Frames a second looked at. Text shown for less than a second can be missed. */
export const SCREEN_TEXT_FPS = 1;
/** Frames decoded and read in one go, so a recording that changes every second holds about 60 MB of frames at once. */
const BATCH_SECONDS = 10;
/** A line the reader is less sure of than this is left out: on real screens, those were icons read as letters. */
const MIN_CONFIDENCE = 0.7;

/** A line of text on screen: source seconds, its words, and its box as fractions of the frame (left, top, right, bottom). */
export interface ScreenTextSpan { start: number; end: number; text: string; box: [number, number, number, number]; confidence: number }

interface Kept { identity: string; chunks: Record<string, ScreenTextSpan[]> }

/** Mean grey of each cell of a cols × rows grid over the frame, from every other pixel. */
export function pictureGrid(rgb: Buffer, width: number, height: number, cols = 32, rows = 18): Float32Array {
  const sums = new Float32Array(cols * rows), counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 2) {
    const row = Math.min(rows - 1, Math.floor(y * rows / height));
    for (let x = 0; x < width; x += 2) {
      const p = (y * width + x) * 3, cell = row * cols + Math.min(cols - 1, Math.floor(x * cols / width));
      sums[cell] = sums[cell]! + (rgb[p]! * 3 + rgb[p + 1]! * 6 + rgb[p + 2]!) / 10;
      counts[cell] = counts[cell]! + 1;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] = counts[i] ? sums[i]! / counts[i]! : 0;
  return sums;
}

/** Whether the picture changed enough to read again: any cell by 6 grey levels, about a word typed in a 60-pixel cell. */
export function pictureChanged(before: Float32Array, after: Float32Array) {
  for (let i = 0; i < after.length; i++) if (Math.abs(after[i]! - before[i]!) > 6) return true;
  return false;
}

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** How alike two readings are, 0..1: one minus their edit distance over the longer one's length. */
function likeness(a: string, b: string) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = next;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

function boxOverlap(a: ScreenTextSpan["box"], b: ScreenTextSpan["box"]) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const both = w * h, area = (r: ScreenTextSpan["box"]) => (r[2] - r[0]) * (r[3] - r[1]);
  return both / Math.min(area(a), area(b));
}

/**
 * Whether two readings are the same line on screen: in about the same place, with words that hold one another or
 * differ by a letter or two. The reader can read a line a little differently from frame to frame, and a frame can cut
 * a line's first word off; on a real recording that split one line into a span a second.
 */
export function sameLine(a: Pick<ScreenTextSpan, "text" | "box">, b: Pick<ScreenTextSpan, "text" | "box">) {
  if (boxOverlap(a.box, b.box) < 0.6) return false;
  const x = plain(a.text), y = plain(b.text);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y, long = short === x ? y : x;
  return x === y || (short.length >= 4 && long.includes(short)) || likeness(x.slice(0, 200), y.slice(0, 200)) >= 0.8;
}

/** Keep the fuller, surer reading of a line seen twice, and the box that holds both. */
function absorb(into: ScreenTextSpan, other: ScreenTextSpan) {
  if (plain(other.text).length > plain(into.text).length || (plain(other.text).length === plain(into.text).length && other.confidence > into.confidence)) into.text = other.text;
  into.confidence = Math.max(into.confidence, other.confidence);
  into.box = [Math.min(into.box[0], other.box[0]), Math.min(into.box[1], other.box[1]), Math.max(into.box[2], other.box[2]), Math.max(into.box[3], other.box[3])];
}

/**
 * Spans from the frames read in one window, in order. A line lasts from the first frame read that shows it to the next
 * frame read that doesn't, or to `end`. The same words in about the same place (within 2% of the frame) are one line.
 */
export function spansFromFrames(frames: ReadonlyArray<{ at: number; lines: readonly ScreenLine[] }>, end: number, width: number, height: number): ScreenTextSpan[] {
  const done: ScreenTextSpan[] = [];
  let open: ScreenTextSpan[] = [];
  for (const { at, lines } of frames) {
    const still: ScreenTextSpan[] = [];
    for (const line of lines) {
      if (line.confidence < MIN_CONFIDENCE || !/[\p{L}\p{N}]/u.test(line.text)) continue;
      const [x0, y0, x1, y1] = line.box;
      const span: ScreenTextSpan = { start: at, end, text: line.text, confidence: r3(line.confidence),
        box: [r3(x0 / width), r3(y0 / height), r3(x1 / width), r3(y1 / height)] };
      const index = open.findIndex(o => sameLine(o, span));
      if (index >= 0) {
        const kept = open.splice(index, 1)[0]!;
        absorb(kept, span);
        still.push(kept);
      } else if (!still.some(s => sameLine(s, span) && (absorb(s, span), true))) still.push(span);
    }
    for (const span of open) { span.end = at; done.push(span); }
    open = still;
  }
  for (const span of open) { span.end = end; done.push(span); }
  return done.sort((a, b) => a.start - b.start || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/** Spans of neighbouring windows, with a line that runs across the boundary made one. */
export function joinSpans(spans: readonly ScreenTextSpan[]): ScreenTextSpan[] {
  const out: ScreenTextSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const before = out.find(o => Math.abs(o.end - span.start) < 1e-6 && sameLine(o, span));
    if (before) {
      before.end = span.end;
      absorb(before, span);
      continue;
    }
    out.push({ ...span, box: [...span.box] as ScreenTextSpan["box"] });
  }
  return out.sort((a, b) => a.start - b.start || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/** Whether a line holds the words searched for, ignoring case, punctuation and spacing. */
export function screenTextMatches(text: string, query: string) {
  const q = plain(query);
  return !!q && plain(text).includes(q);
}

interface Recording {
  kept?: Promise<Kept>;
  /** Windows waiting to be read, in order, and the one being read. */
  queue: number[];
  /** Windows a request asked for. The rest are read unasked, and a pause of the project's media work holds them. */
  asked: Set<number>;
  reading?: Promise<void>;
  /** Wakes those waiting for windows to be read. */
  waiters: Set<() => void>;
  error?: string;
}

const recordings = new Map<string, Recording>();
const models = new Map<string, LocalWhisperModel[]>();

function modelsFor(ctx: Ctx) {
  let list = models.get(ctx.paths.root);
  if (!list) models.set(ctx.paths.root, list = Object.values(SCREEN_TEXT_MODELS).map(m => new LocalWhisperModel(join(ctx.paths.root, "models"), m, ctx.log)));
  return list;
}

function keptPath(ctx: Ctx, media: MediaAsset & { projectId: string }) {
  return join(ctx.paths.waveforms(media.projectId), `${media.id}.screen-text.json`);
}

function identity(media: MediaAsset) {
  return createHash("sha256").update(JSON.stringify([SCREEN_TEXT_VERSION, media.hash ?? media.path, media.duration,
    Object.values(SCREEN_TEXT_MODELS).map(m => m.sha256), SCREEN_TEXT_FPS, SCREEN_TEXT_CHUNK])).digest("hex");
}

async function loadKept(ctx: Ctx, media: MediaAsset & { projectId: string }): Promise<Kept> {
  const id = identity(media);
  try {
    const kept = JSON.parse(await readFile(keptPath(ctx, media), "utf8")) as Kept;
    if (kept.identity === id && kept.chunks && typeof kept.chunks === "object") return kept;
  } catch { /* Not read yet, or from another reading. */ }
  return { identity: id, chunks: {} };
}

async function save(ctx: Ctx, media: MediaAsset & { projectId: string }, kept: Kept) {
  const path = keptPath(ctx, media), temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(ctx.paths.waveforms(media.projectId), { recursive: true });
  await writeFile(temp, JSON.stringify(kept));
  await rename(temp, path);
}

/** Read one window of a recording: decode it a second at a time, read the frames that changed, and make spans. */
async function readWindow(ctx: Ctx, media: MediaAsset & { projectId: string }, file: string, index: number, signal: AbortSignal): Promise<ScreenTextSpan[]> {
  const duration = media.duration ?? 0;
  const start = index * SCREEN_TEXT_CHUNK, end = Math.min(duration, start + SCREEN_TEXT_CHUNK);
  const source = media.width && media.height ? { width: media.width, height: media.height } : await probeMedia(file);
  const { width, height } = screenFrameSize(source.width, source.height);
  // CUDA shrinks each frame on the GPU before it comes back to memory. VideoToolbox hands back every 4K frame whole:
  // ten seconds of a 4K recording took 2.6 s that way and 0.5 s on the CPU (M-series, 2026-11-13).
  const gpu = await pictureDecoder(ctx.settings().render.hwaccel);
  const decoder = gpu === "cuda" ? gpu : undefined;
  const [finder, reader, letters] = await Promise.all(modelsFor(ctx).map(m => m.get(signal))) as [string, string, string];
  const read: Array<{ at: number; lines: ScreenLine[] }> = [];
  let last: Float32Array | undefined;
  for (let from = start; from < end - 1e-6; from += BATCH_SECONDS) {
    const to = Math.min(end, from + BATCH_SECONDS);
    const frames = join(ctx.paths.tmp, `screen-text-${randomUUID()}.rgb`);
    await mkdir(ctx.paths.tmp, { recursive: true });
    const fd = openSync(frames, "w");
    const picked: number[] = [];
    try {
      await pictureLane(ctx).run(() => screenFrames(file, { start: from, end: to }, { fps: SCREEN_TEXT_FPS, width, height, decoder, signal,
        onFallback: reason => ctx.log(`[screen-text] ${media.id}: ${reason}`) }, (i, rgb) => {
        const grid = pictureGrid(rgb, width, height);
        if (last && !pictureChanged(last, grid)) return;
        last = grid;
        picked.push(from + i / SCREEN_TEXT_FPS);
        writeSync(fd, rgb);
      }), { signal });
      closeSync(fd);
      if (picked.length) {
        const lines = await audioWorker.request<ScreenLine[][]>({ kind: "screenText", frames, width, height, finder, reader, letters }, { signal });
        picked.forEach((at, i) => read.push({ at, lines: lines[i] ?? [] }));
      }
    } finally {
      try { closeSync(fd); } catch { /* Closed above. */ }
      await rm(frames, { force: true });
    }
  }
  return spansFromFrames(read, end, width, height);
}

function recordingFor(ctx: Ctx, media: MediaAsset & { projectId: string }) {
  const key = `${ctx.paths.root}\0${media.id}\0${identity(media)}`;
  let state = recordings.get(key);
  if (!state) recordings.set(key, state = { queue: [], asked: new Set(), waiters: new Set() });
  state.kept ??= loadKept(ctx, media);
  return state;
}

/** Read the windows queued for a recording, one after another, saving each as it is read. */
function readQueued(ctx: Ctx, media: MediaAsset & { projectId: string }, file: string, state: Recording) {
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
          kept.chunks[index] = await readWindow(ctx, media, file, index, signal);
          state.error = undefined;
          await save(ctx, media, kept);
        } catch (error) {
          // A pause stopped a window read unasked, which a request may since have asked for: look again.
          if (signal.aborted) continue;
          state.error = error instanceof Error ? error.message : String(error);
          ctx.log(`[screen-text] ${media.id} at ${index * SCREEN_TEXT_CHUNK} s: ${state.error}`);
          state.queue = [];
        }
      }
      state.queue.shift();
      for (const wake of state.waiters) wake();
    }
  })()).finally(() => {
    state.reading = undefined;
    for (const wake of state.waiters) wake();
  });
}

export interface ScreenTextResult {
  mediaId: string;
  from: number; to: number;
  spans: ScreenTextSpan[];
  /** Seconds of the range read so far, and whether the whole range has been. */
  readSeconds: number; done: boolean;
  /** Why reading stopped, when it did. */
  error?: string;
}

/**
 * The text on screen in a range of a recording, reading what hasn't been read yet. Waits up to `waitMs` for it, then
 * returns what is ready; reading carries on in the background.
 */
export async function screenText(ctx: Ctx, media: MediaAsset & { projectId: string }, range: { from?: number; to?: number },
  opts: { query?: string; waitMs?: number; signal?: AbortSignal } = {}): Promise<ScreenTextResult> {
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
  for (let i = Math.floor(from / SCREEN_TEXT_CHUNK); i * SCREEN_TEXT_CHUNK < to; i++) wanted.push(i);
  const missing = () => wanted.filter(i => !kept.chunks[i]);
  // Once a video is asked about, all of it is read: the asked-for windows first, then the rest in order, so a later
  // search across the whole video answers at once. Windows already queued keep their place behind the asked ones.
  const every = Array.from({ length: Math.ceil(duration / SCREEN_TEXT_CHUNK) }, (_, i) => i).filter(i => !kept.chunks[i]);
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
  const ready = wanted.filter(i => kept.chunks[i]);
  const spans = joinSpans(ready.flatMap(i => kept.chunks[i]!))
    .filter(s => s.end > from && s.start < to)
    .filter(s => !opts.query || screenTextMatches(s.text, opts.query));
  const readSeconds = ready.reduce((n, i) => n + Math.max(0, Math.min(to, (i + 1) * SCREEN_TEXT_CHUNK) - Math.max(from, i * SCREEN_TEXT_CHUNK)), 0);
  return { mediaId: media.id, from, to, spans, readSeconds: r3(readSeconds), done: ready.length === wanted.length,
    ...(state.error && ready.length < wanted.length && { error: state.error }) };
}
