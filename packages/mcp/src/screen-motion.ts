/**
 * Where a recording's picture changes on a version of the edit: the engine's second-by-second reading of the recording
 * (`/screen-motion`), carried through the clips that play it and run together where the same area keeps changing.
 */
import { clipEnd, type MediaClip, type Timeline } from "@scarlet/timeline";

/** A second of a recording, from `at`, and the areas that changed in it: [left, top, right, bottom, share of the frame]. */
export interface MotionSecond { at: number; areas: Array<[number, number, number, number, number]> }

/** Where a recording's picture has something in it (text, an edge, a picture), from source second `at` until the next: a 64 × 36 grid, a bit a cell row by row, in base64. */
export interface DetailFrame { at: number; cells: string }
export const DETAIL_COLS = 64, DETAIL_ROWS = 36;

/** Whether a cell of a detail grid has something in it. */
export const hasDetail = (cells: Uint8Array, i: number) => ((cells[i >> 3]! >> (i & 7)) & 1) === 1;

/** The share of the cells in `box` (source fractions) that have something in them. */
export function detailShare(cells: Uint8Array, box: readonly number[]): number {
  const c0 = Math.max(0, Math.floor(box[0]! * DETAIL_COLS)), c1 = Math.min(DETAIL_COLS, Math.ceil(box[2]! * DETAIL_COLS));
  const r0 = Math.max(0, Math.floor(box[1]! * DETAIL_ROWS)), r1 = Math.min(DETAIL_ROWS, Math.ceil(box[3]! * DETAIL_ROWS));
  let all = 0, some = 0;
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) { all++; if (hasDetail(cells, r * DETAIL_COLS + c)) some++; }
  return all ? some / all : 0;
}

/** The things in a picture, inside `within` (source fractions) by each cell's middle: cells with something in them that touch, each with its box in source fractions and its cells. */
export function detailAreas(cells: Uint8Array, within: readonly number[] = [0, 0, 1, 1]): Array<{ box: [number, number, number, number]; cells: number[] }> {
  const seen = new Uint8Array(DETAIL_COLS * DETAIL_ROWS), out: Array<{ box: [number, number, number, number]; cells: number[] }> = [];
  for (let i = 0; i < seen.length; i++) {
    const x = (i % DETAIL_COLS + 0.5) / DETAIL_COLS, y = (Math.floor(i / DETAIL_COLS) + 0.5) / DETAIL_ROWS;
    if (x < within[0]! || x > within[2]! || y < within[1]! || y > within[3]!) seen[i] = 1;
  }
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !hasDetail(cells, start)) continue;
    const members: number[] = [], stack = [start];
    seen[start] = 1;
    let l = DETAIL_COLS, t = DETAIL_ROWS, r = -1, b = -1;
    while (stack.length) {
      const cell = stack.pop()!, x = cell % DETAIL_COLS, y = Math.floor(cell / DETAIL_COLS);
      members.push(cell);
      l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * DETAIL_COLS + nx;
        if (nx < 0 || ny < 0 || nx >= DETAIL_COLS || ny >= DETAIL_ROWS || seen[n] || !hasDetail(cells, n)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    out.push({ box: [l / DETAIL_COLS, t / DETAIL_ROWS, (r + 1) / DETAIL_COLS, (b + 1) / DETAIL_ROWS], cells: members });
  }
  return out;
}

export interface MotionSpan {
  mediaId: string;
  /** Timeline seconds. */
  from: number; to: number;
  /** The area that kept changing, as fractions of the source picture: every second's largest change over the span. */
  box: [number, number, number, number];
  /** The largest share of the picture that changed in one second of the span. */
  share: number;
  /** Small changes away from it, the size a pointer or a cursor makes, by where they were: up to five. */
  small?: Array<[number, number]>;
}

/** A change under this share of the picture is small: a pointer, a cursor, a blinking dot. */
export const SMALL = 0.004;
type Box = [number, number, number, number];
const overlap = (a: Box, b: Box) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return w * h / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
};
const r2 = (n: number) => Math.round(n * 100) / 100, r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The spans of change on a version, for each recording in `seconds` whose picture plays. Seconds in a row whose largest
 * changes share most of their area are one span; a second whose only changes are small adds to the span it is in.
 */
export function motionSpans(tl: Timeline, seconds: ReadonlyMap<string, readonly MotionSecond[]>, range?: { start: number; end: number }): MotionSpan[] {
  const clips = tl.tracks.filter(t => t.kind === "video" && !t.hidden)
    .flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && seconds.has(c.mediaId)))
    .sort((a, b) => a.timelineIn - b.timelineIn);
  const spans: MotionSpan[] = [];
  for (const clip of clips) {
    const speed = clip.speed ?? 1;
    let open: MotionSpan | undefined;
    for (const second of seconds.get(clip.mediaId)!) {
      if (second.at + 1 <= clip.sourceIn || second.at >= clip.sourceOut) continue;
      const from = Math.max(clip.timelineIn, clip.timelineIn + (second.at - clip.sourceIn) / speed);
      const to = Math.min(clipEnd(clip), clip.timelineIn + (second.at + 1 - clip.sourceIn) / speed);
      if (range && (to < range.start || from > range.end)) continue;
      if (!second.areas.length) continue;
      const big = second.areas.filter(a => a[4] >= SMALL), small = second.areas.filter(a => a[4] < SMALL);
      // With only small changes, the pointer's: the area they cover together.
      const main: Box = big[0] ? big[0].slice(0, 4) as Box
        : [Math.min(...small.map(a => a[0])), Math.min(...small.map(a => a[1])), Math.max(...small.map(a => a[2])), Math.max(...small.map(a => a[3]))];
      const share = big[0] ? big[0][4] : small.reduce((n, a) => n + a[4], 0);
      // The next second, with none between that held still.
      const adjoins = open && from - open.to < 0.05;
      // Small changes beside a span carry it on; a large change elsewhere starts another.
      if (open && adjoins && (!big[0] || overlap(open.box, main) >= 0.5)) {
        open.to = to;
        if (big[0]) { open.box = [Math.min(open.box[0], main[0]), Math.min(open.box[1], main[1]), Math.max(open.box[2], main[2]), Math.max(open.box[3], main[3])]; open.share = Math.max(open.share, share); }
      } else spans.push(open = { mediaId: clip.mediaId, from, to, box: [...main], share });
      if (big[0]) for (const a of small) {
        const at: [number, number] = [r3((a[0] + a[2]) / 2), r3((a[1] + a[3]) / 2)];
        if (overlap(open.box, a.slice(0, 4) as Box) > 0) continue;
        if ((open.small ??= []).length < 5 && !open.small.some(p => Math.abs(p[0] - at[0]) < 0.03 && Math.abs(p[1] - at[1]) < 0.03)) open.small.push(at);
      }
    }
  }
  return spans.sort((a, b) => a.from - b.from).map(s => ({ ...s, from: r2(s.from), to: r2(s.to), box: s.box.map(r3) as Box, share: r3(s.share) }));
}
