/**
 * Where a recording's picture changes, second by second, read once and kept beside its waveform as screen text is.
 *
 * Framing a screen demo turns on where the action is: the pane a game plays in, the page that scrolls, the pointer
 * moving over a button. The text on screen says what is there, not what moves. A pass framed a demo on the controls
 * while the cube it showed was still turning above them (2026-11-17). This measures the movement; what it means for
 * the framing is the model's call.
 *
 * The same frames say where the picture has anything in it at all (`detail`): a camera inset laid over a screen sat on
 * the usage rings of a quota page, with nothing there that screen text reads (2026-11-20).
 */
import { createHash } from "node:crypto";
import { probeMedia, screenFrameSize } from "@scarlet/render";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { pictureGrid, pictureReader, r3, withFrames, type VideoMedia } from "./pictureReading.js";

/** Bump when the reading changes: the sampling, the grid or how changes become areas. Kept readings are read again. */
const MOTION_VERSION = 2;
/** Seconds of a recording read and kept together. */
const MOTION_WINDOW = 60;
/** Frames a second compared: a pointer or a scroll moves between two of them. */
const MOTION_FPS = 4;
/** The longer side of the frames compared. A 4K screen's pointer is about a cell of the grid at this size. */
const MOTION_SIDE = 384;
/** The grid a frame is averaged on, columns by rows. */
const COLS = 64, ROWS = 36;
/** A cell whose mean grey moves this many levels between two frames changed. */
const CHANGED = 8;
/** The areas kept for each second, largest first. */
const MAX_AREAS = 4;
/** A cell whose grey spans this many levels has something in it (a line of text, an edge, a picture); a flat background doesn't. */
const DETAILED = 24;
/** A second's detail is kept when this share of the cells differs from the detail kept last. */
const DETAIL_CHANGED = 0.02;

/** Where a recording's picture has something in it, from a source second until the next one kept. */
export interface DetailFrame {
  at: number;
  /** The grid's cells, row by row, a bit each (1: something there), as base64. */
  cells: string;
}

/** A window's reading: the seconds whose picture changed, and its detail wherever that changed. */
interface MotionWindow { seconds: MotionSecond[]; detail: DetailFrame[] }

/** Each cell of the grid whose grey spans `DETAILED` levels or more, a bit per cell. */
export function detailCells(rgb: Buffer, width: number, height: number, cols = COLS, rows = ROWS): Uint8Array {
  const lo = new Float32Array(cols * rows).fill(255), hi = new Float32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor(y * rows / height));
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3, cell = row * cols + Math.min(cols - 1, Math.floor(x * cols / width));
      const grey = (rgb[p]! * 3 + rgb[p + 1]! * 6 + rgb[p + 2]!) / 10;
      if (grey < lo[cell]!) lo[cell] = grey;
      if (grey > hi[cell]!) hi[cell] = grey;
    }
  }
  const bits = new Uint8Array(Math.ceil(cols * rows / 8));
  for (let i = 0; i < cols * rows; i++) if (hi[i]! - lo[i]! >= DETAILED) bits[i >> 3]! |= 1 << (i & 7);
  return bits;
}

/** A second of a recording and the areas of its picture that changed in it. */
export interface MotionSecond {
  /** Source seconds: the second from `at` to `at + 1`. */
  at: number;
  /** Each area: [left, top, right, bottom] as fractions of the frame, then the share of the frame's cells in it that changed. */
  areas: Array<[number, number, number, number, number]>;
}

/**
 * The areas of changed cells, as boxes: cells that touch, or lie within a cell of one another, are one area. Largest first.
 */
export function changedAreas(changed: Uint8Array, cols = COLS, rows = ROWS): MotionSecond["areas"] {
  const seen = new Uint8Array(changed.length);
  const areas: Array<{ box: [number, number, number, number]; cells: number }> = [];
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue;
    let l = cols, t = rows, r = -1, b = -1, cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop()!, x = cell % cols, y = Math.floor(cell / cols);
      l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); cells++;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (changed[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    areas.push({ box: [l / cols, t / rows, (r + 1) / cols, (b + 1) / rows], cells });
  }
  return areas.sort((a, b) => b.cells - a.cells).slice(0, MAX_AREAS)
    .map(({ box, cells }) => [...box.map(r3), r3(cells / (cols * rows))] as MotionSecond["areas"][number]);
}

function identity(media: MediaAsset) {
  return createHash("sha256").update(JSON.stringify([MOTION_VERSION, media.hash ?? media.path, media.duration,
    MOTION_FPS, MOTION_SIDE, COLS, ROWS, CHANGED, MOTION_WINDOW])).digest("hex");
}

const bitsDiffer = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) { let x = a[i]! ^ b[i]!; while (x) { n += x & 1; x >>= 1; } } return n; };

/** Compare one window's frames, a quarter second apart, and keep the seconds whose picture changed, with the picture's detail once a second where it changed. */
async function readWindow(ctx: Ctx, media: VideoMedia, file: string, { start, end }: { start: number; end: number }, signal: AbortSignal): Promise<MotionWindow> {
  const source = media.width && media.height ? { width: media.width, height: media.height } : await probeMedia(file);
  const { width, height } = screenFrameSize(source.width, source.height, MOTION_SIDE);
  const seconds = new Map<number, Uint8Array>();
  let last: Float32Array | undefined;
  const detail: DetailFrame[] = [];
  let detailKept: Uint8Array | undefined, detailSecond = -Infinity;
  await withFrames(ctx, media, file, "screen-motion", { start, end, fps: MOTION_FPS, width, height, signal }, (at, rgb) => {
    // Every pixel: a pointer-sized change has to register.
    const now = pictureGrid(rgb, width, height, COLS, ROWS, 1);
    if (last) {
      const second = Math.floor(at - 1e-6);
      let cells = seconds.get(second);
      for (let i = 0; i < now.length; i++) if (Math.abs(now[i]! - last[i]!) > CHANGED) (cells ??= new Uint8Array(COLS * ROWS))[i] = 1;
      if (cells) seconds.set(second, cells);
    }
    last = now;
    // Once a second, the first frame of it: kept when it differs from the detail kept last.
    if (Math.floor(at + 1e-6) > detailSecond) {
      detailSecond = Math.floor(at + 1e-6);
      const cells = detailCells(rgb, width, height);
      if (!detailKept || bitsDiffer(cells, detailKept) >= DETAIL_CHANGED * COLS * ROWS) {
        detail.push({ at: r3(at), cells: Buffer.from(cells).toString("base64") });
        detailKept = cells;
      }
    }
    return false;
  }, async () => undefined);
  return { seconds: [...seconds].sort((a, b) => a[0] - b[0]).map(([at, cells]) => ({ at, areas: changedAreas(cells) })), detail };
}

const reading = pictureReader<MotionWindow>({ name: "screen-motion", window: MOTION_WINDOW, identity, read: readWindow });

export interface ScreenMotionResult {
  mediaId: string;
  from: number; to: number;
  /** The seconds whose picture changed, in order. A second not listed held still. */
  seconds: MotionSecond[];
  /** Where the picture has something in it (a 64 × 36 grid), from each `at` until the next; the one in force at `from` comes first. */
  detail: DetailFrame[];
  /** Seconds of the range read so far, and whether the whole range has been. */
  readSeconds: number; done: boolean;
  /** Why reading stopped, when it did. */
  error?: string;
}

/**
 * Where the picture changes in a range of a recording, reading what hasn't been read yet. Waits up to `waitMs` for it,
 * then returns what is ready; reading carries on in the background.
 */
export async function screenMotion(ctx: Ctx, media: MediaAsset & { projectId: string }, range: { from?: number; to?: number },
  opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<ScreenMotionResult> {
  const read = await reading.read(ctx, media, range, opts);
  const seconds = read.ready.flatMap(w => w.value.seconds).filter(s => s.at + 1 > read.from && s.at < read.to);
  const frames = read.ready.flatMap(w => w.value.detail);
  const first = frames.findLastIndex(d => d.at <= read.from);
  const detail = frames.slice(Math.max(0, first)).filter(d => d.at < read.to);
  return { mediaId: media.id, from: read.from, to: read.to, seconds, detail, readSeconds: read.readSeconds, done: read.done, ...(read.error && { error: read.error }) };
}
