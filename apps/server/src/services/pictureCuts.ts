/**
 * Where a recording's picture cuts: the moments much of it changes at once and holds still either side, as when a
 * screen recording switches to another window or loads another page. Read once and kept beside its waveform, as screen
 * motion is.
 *
 * A pass laid a 2.5 s stretch of a screen recording over the camera after looking at three frames of it that all showed
 * the same reply. The recording switched to another window and back between them, so the insert flashed through three
 * pictures in two seconds (2026-11-18). What a stretch of a recording shows between its frames is measured here; whether
 * a picture plays too briefly is the model's call.
 */
import { createHash } from "node:crypto";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { pictureReader, r3, withFrames, type VideoMedia } from "./pictureReading.js";

/** Bump when the reading changes: the sampling, the grid or what counts as a cut. Kept readings are read again. */
const CUTS_VERSION = 1;
/** Seconds of a recording read and kept together. */
const CUTS_WINDOW = 60;
/** Frames a second compared, at most: every frame of most recordings. */
const CUTS_FPS = 30;
/** The grid a frame is averaged on, columns by rows: each frame is read at this size. */
export const CUT_COLS = 64, CUT_ROWS = 36;
/** A cell whose mean grey moves this many levels between two frames changed, as in screen motion. */
const CHANGED = 8;
/** Frames either side of a change in which its cells must hold still for it to be a cut, not a scroll or a game. */
const HOLD = 3;
/** The fewest cells, as a share of the frame, that a cut changes: fewer is a pointer, a cursor or a blinking dot. */
const LEAST = 0.01;

/** A cut in a recording's picture. */
export interface PictureCut {
  /** Source seconds of the first frame of the new picture. */
  at: number;
  /** The share of the frame's cells that changed at once. */
  share: number;
  /** Which cells changed, CUT_COLS by CUT_ROWS row by row, one bit each, in base64. */
  cells: string;
}

/**
 * The cuts in a run of frames' cell greys, frame `i` at `times[i]`. A cell cuts at frame `i` when it changes from frame
 * `i - 1` and holds still for HOLD frames before that and after the frame that follows: a redraw over two frames is one
 * cut, and a scroll or an animation, whose cells keep changing, is none.
 */
export function cutsIn(greys: readonly Float32Array[], times: readonly number[], cols = CUT_COLS, rows = CUT_ROWS): PictureCut[] {
  const cells = cols * rows;
  // changed[k]: the cells that changed from frame k - 1 to frame k.
  const changed = greys.map((g, k) => {
    const out = new Uint8Array(cells);
    if (k === 0) return out;
    const prev = greys[k - 1]!;
    for (let i = 0; i < cells; i++) if (Math.abs(g[i]! - prev[i]!) > CHANGED) out[i] = 1;
    return out;
  });
  const found: Array<{ k: number; bits: Uint8Array; count: number }> = [];
  for (let k = HOLD + 1; k + 1 + HOLD < greys.length; k++) {
    // A picture drawn over two frames, part in each, is one cut at the first.
    const prev = found.at(-1);
    const last = prev?.k === k - 1 && prev.count >= LEAST * cells ? prev : undefined;
    const into = last ?? { k, bits: new Uint8Array(Math.ceil(cells / 8)), count: 0 };
    for (let i = 0; i < cells; i++) {
      if (!changed[k]![i] || (into.bits[i >> 3]! >> (i & 7)) & 1) continue;
      let still = true;
      for (let d = 1; d <= HOLD && still; d++) if (changed[k - d]![i] || changed[k + 1 + d]![i]) still = false;
      if (!still) continue;
      into.bits[i >> 3]! |= 1 << (i & 7);
      into.count++;
    }
    if (!last && into.count) found.push(into);
  }
  return found.filter(f => f.count >= LEAST * cells)
    .map(f => ({ at: r3(times[f.k]!), share: r3(f.count / cells), cells: Buffer.from(f.bits).toString("base64") }));
}

function identity(media: MediaAsset) {
  return createHash("sha256").update(JSON.stringify([CUTS_VERSION, media.hash ?? media.path, media.duration,
    CUTS_FPS, CUT_COLS, CUT_ROWS, CHANGED, HOLD, LEAST, CUTS_WINDOW])).digest("hex");
}

/** Compare a window's frames one after another, with a few frames' margin either side, and keep its cuts. */
async function readWindow(ctx: Ctx, media: VideoMedia, file: string, { start, end }: { start: number; end: number }, signal: AbortSignal): Promise<PictureCut[]> {
  const fps = Math.min(CUTS_FPS, media.fps ?? CUTS_FPS);
  const margin = (HOLD + 2) / fps;
  const from = Math.max(0, start - margin), to = Math.min(media.duration ?? end, end + margin);
  const greys: Float32Array[] = [], times: number[] = [];
  await withFrames(ctx, media, file, "picture-cuts", { start: from, end: to, fps, width: CUT_COLS, height: CUT_ROWS, signal }, (at, rgb) => {
    const grey = new Float32Array(CUT_COLS * CUT_ROWS);
    for (let i = 0; i < grey.length; i++) grey[i] = (rgb[i * 3]! * 3 + rgb[i * 3 + 1]! * 6 + rgb[i * 3 + 2]!) / 10;
    greys.push(grey);
    times.push(at);
    return false;
  }, async () => undefined);
  return cutsIn(greys, times).filter(c => c.at >= start && c.at < end);
}

const reading = pictureReader<PictureCut[]>({ name: "picture-cuts", window: CUTS_WINDOW, identity, read: readWindow });

export interface PictureCutsResult {
  mediaId: string;
  from: number; to: number;
  /** The cuts in the range, in order. */
  cuts: PictureCut[];
  /** Seconds of the range read so far, and whether the whole range has been. */
  readSeconds: number; done: boolean;
  /** Why reading stopped, when it did. */
  error?: string;
}

/**
 * Where the picture cuts in a range of a recording, reading what hasn't been read yet. Waits up to `waitMs` for it, then
 * returns what is ready; reading carries on in the background.
 */
export async function pictureCuts(ctx: Ctx, media: MediaAsset & { projectId: string }, range: { from?: number; to?: number },
  opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<PictureCutsResult> {
  const read = await reading.read(ctx, media, range, opts);
  const cuts = read.ready.flatMap(w => w.value).filter(c => c.at >= read.from && c.at < read.to);
  return { mediaId: media.id, from: read.from, to: read.to, cuts, readSeconds: read.readSeconds, done: read.done, ...(read.error && { error: read.error }) };
}

/**
 * Where a recording's picture has been read for cuts, as merged stretches of source seconds, and the cuts there that
 * change at least `share` of the picture at once. Starts reading what hasn't been read and waits up to `waitMs` for it.
 */
export async function pictureChanges(ctx: Ctx, media: MediaAsset & { projectId: string }, share: number, waitMs: number): Promise<{ read: Array<[number, number]>; at: number[] }> {
  const result = await reading.read(ctx, media, {}, { waitMs });
  const read: Array<[number, number]> = [];
  for (const w of result.ready) {
    const last = read.at(-1);
    if (last && Math.abs(last[1] - w.start) < 1e-6) last[1] = w.end;
    else read.push([w.start, w.end]);
  }
  return { read, at: result.ready.flatMap(w => w.value).filter(c => c.share >= share).map(c => c.at).sort((a, b) => a - b) };
}
