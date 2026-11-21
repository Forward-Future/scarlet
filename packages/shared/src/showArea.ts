/**
 * What of a recording's picture viewers may see. A screen recording holds more than the window being presented: the
 * desktop, a recording app, a call beside it. An area is a box confirmed on one frame, and it holds for as long as the
 * straight edges it sits on stay where they were, so a box for each window layout covers a recording. One pass framed
 * every screen demo with another app in the picture for a third of the demos' time, having looked at no frame for it
 * (2026-11-16).
 */
export type AreaSide = "left" | "top" | "right" | "bottom";
export const AREA_SIDES: readonly AreaSide[] = ["left", "top", "right", "bottom"];
/** [left, top, right, bottom] as fractions of the picture. */
export type AreaBox = [number, number, number, number];

/** The small frames edges are read on, and the seconds between two of them. */
export const SHOW_EDGE_WIDTH = 480, SHOW_EDGE_HEIGHT = 270, SHOW_EDGE_STEP = 5;
/** Bump when the edge reading changes: it names the kept file. */
export const SHOW_EDGE_VERSION = 1;
/** A brightness step this large across a pixel is part of a line. */
const LINE_STEP = 4;
/** A box holds on a frame when every edge it needs is a line along this share of its length. */
export const AREA_HOLDS_AT = 0.5;
/** How far past its area a picture may show and still count as inside, as a fraction of the picture: a window's border and shadow. */
export const AREA_SLACK = 0.01;

const plane = (w: number, h: number) => Math.ceil(w * h / 8);
export const edgeBytes = (w = SHOW_EDGE_WIDTH, h = SHOW_EDGE_HEIGHT) => 2 * plane(w, h);

/** Where a packed RGB frame steps in brightness: one bit a pixel for steps across (upright lines), then one for steps down. */
export function edgeBits(rgb: Uint8Array, w = SHOW_EDGE_WIDTH, h = SHOW_EDGE_HEIGHT): Uint8Array {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) gray[i] = (rgb[p]! * 77 + rgb[p + 1]! * 150 + rgb[p + 2]! * 29) >> 8;
  const size = plane(w, h), bits = new Uint8Array(2 * size);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0 && x < w - 1 && Math.abs(gray[i + 1]! - gray[i - 1]!) > LINE_STEP) bits[i >> 3]! |= 1 << (i & 7);
    if (y > 0 && y < h - 1 && Math.abs(gray[i + w]! - gray[i - w]!) > LINE_STEP) bits[size + (i >> 3)]! |= 1 << (i & 7);
  }
  return bits;
}

const onFrameEdge = (side: AreaSide, v: number) => side === "left" || side === "top" ? v <= 0.002 : v >= 0.998;
export const wholePicture = (area: AreaBox) => AREA_SIDES.every((side, i) => onFrameEdge(side, area[i]!));

/**
 * How much of each edge of a box is a line in a frame, 0 to 1, read a little inside the box's corners and within a
 * pixel of the edge. An edge on the frame's own edge is 1.
 */
export function sideFits(bits: Uint8Array, area: AreaBox, w = SHOW_EDGE_WIDTH, h = SHOW_EDGE_HEIGHT): Record<AreaSide, number> {
  const size = plane(w, h);
  const x0 = Math.round(w * (area[0] + 0.03)), x1 = Math.round(w * (area[2] - 0.03));
  const y0 = Math.round(h * (area[1] + 0.03)), y1 = Math.round(h * (area[3] - 0.03));
  const bit = (offset: number, i: number) => (bits[offset + (i >> 3)]! >> (i & 7)) & 1;
  const column = (x: number) => {
    if (x < 1 || x > w - 2 || y1 <= y0) return 0;
    let n = 0;
    for (let y = y0; y < y1; y++) n += bit(0, y * w + x);
    return n / (y1 - y0);
  };
  const row = (y: number) => {
    if (y < 1 || y > h - 2 || x1 <= x0) return 0;
    let n = 0;
    for (let x = x0; x < x1; x++) n += bit(size, y * w + x);
    return n / (x1 - x0);
  };
  const out = {} as Record<AreaSide, number>;
  AREA_SIDES.forEach((side, i) => {
    const v = area[i]!, upright = side === "left" || side === "right";
    if (onFrameEdge(side, v)) { out[side] = 1; return; }
    const c = Math.round(v * (upright ? w : h)), at = upright ? column : row;
    out[side] = Math.round(Math.max(at(c - 1), at(c), at(c + 1)) * 100) / 100;
  });
  return out;
}

export interface ShowArea {
  /** The source second of the frame the box was given on. */
  at: number;
  area: AreaBox;
  /** Edges with no line under them on that frame: the box holds without them. */
  noLine: AreaSide[];
}
export interface HeldArea extends ShowArea {
  /** The stretches of source seconds this box holds for. */
  holds: Array<[number, number]>;
}
export interface ShowAreas { areas: HeldArea[]; unset: Array<[number, number]> }
/** Where a recording's picture was read for changes, and the source seconds where it changes at once. */
export interface PictureChanges { read: Array<[number, number]>; at: number[] }
/** The share of the picture that must change at once to end a one-edge box's hold: a switch of app, not a scroll. */
export const AREA_PICTURE_CHANGE = 0.25;

/** The stretch around `at` in which the picture was read and doesn't change at once, if it was read there. */
function steadyAround(changes: PictureChanges, at: number): [number, number] | undefined {
  const read = changes.read.find(([from, to]) => at >= from - 1e-6 && at < to + 1e-6);
  if (!read) return undefined;
  let from = read[0], to = read[1];
  for (const change of changes.at) {
    if (change <= at && change > from) from = change;
    if (change > at && change < to) to = change;
  }
  return [from, to];
}

/**
 * Which area holds on each frame. A frame goes to a box whose needed edges are all lines there, and of several the one
 * given nearest in time: two windows can share edges, and a browser behind an app keeps most of its own in view, so the
 * surest fit is often the wrong window (one page's box took 790 s of an app's time that way). A box with one edge to
 * find again, such as the whole screen but its menu bar, can't tell one app from another by that line alone, which is on
 * every frame: it holds for as long as its line is there and the picture doesn't change at once (`changes`, read from
 * the recording), so a switch to another app ends it. Its demo otherwise played as 5 s pieces of screen between the
 * camera, a box asked for each (2026-11-21). With no edges to find, or before the picture has been read, a box holds
 * only on its own frame, unless it is the whole picture, which holds wherever no other does.
 */
export function assignAreas(frames: number, duration: number, areas: readonly ShowArea[], fitsAt: (frame: number, area: AreaBox) => Record<AreaSide, number>,
  step = SHOW_EDGE_STEP, changes?: PictureChanges): ShowAreas {
  const held: HeldArea[] = areas.map(a => ({ ...a, holds: [] }));
  const needs = areas.map(a => AREA_SIDES.filter((side, i) => !a.noLine.includes(side) && !onFrameEdge(side, a.area[i]!)));
  const unset: Array<[number, number]> = [];
  const push = (list: Array<[number, number]>, from: number, to: number) => {
    const last = list.at(-1);
    if (last && Math.abs(last[1] - from) < 1e-6) last[1] = to;
    else list.push([from, to]);
  };
  const steady = areas.map((a, index) => needs[index]!.length === 1 && changes ? steadyAround(changes, a.at) : undefined);
  for (let i = 0; i < frames; i++) {
    // The last frame read stands for the rest of the recording: a clip from its final seconds had no area to be inside
    // and none it could be given, so every save that framed it was refused (2026-11-17).
    const second = i * step, start = Math.max(0, second - step / 2), end = i === frames - 1 ? duration : Math.min(duration, second + step / 2);
    if (end <= start) continue;
    // A step the picture changes in at once is two pictures: each part goes to its own area.
    const cuts = (changes?.at ?? []).filter(at => at > start + 1e-6 && at < end - 1e-6);
    const bounds = [start, ...cuts, end];
    for (let part = 0; part + 1 < bounds.length; part++) {
      const from = bounds[part]!, to = bounds[part + 1]!;
      let best: { index: number; fit: number; near: number } | undefined, whole: number | undefined;
      areas.forEach((a, index) => {
        const near = Math.abs(a.at - second);
        if (wholePicture(a.area)) { if (whole === undefined || near < Math.abs(areas[whole]!.at - second)) whole = index; return; }
        const run = steady[index];
        if (needs[index]!.length < 2 && !(run && from >= run[0] - 1e-6 && to <= run[1] + 1e-6)) {
          if (near <= step / 2 && !best && bounds.length === 2) best = { index, fit: 0, near };
          return;
        }
        const fits = fitsAt(i, a.area), fit = Math.min(...needs[index]!.map(side => fits[side]));
        if (fit < AREA_HOLDS_AT) return;
        if (!best || near < best.near || (near === best.near && fit > best.fit)) best = { index, fit, near };
      });
      // A box holds on the frame it was given on, where the model looked, even when the edges read on this step's frame
      // don't fit it: a window that moves a little within five seconds left its own second unset, and each save asked
      // about the same frame again, four times (2026-11-18).
      const own = best ? undefined : areas.findIndex(a => !wholePicture(a.area) && a.at >= from - 1e-6 && a.at < to + 1e-6);
      const index = best?.index ?? (own !== undefined && own >= 0 ? own : whole);
      if (index === undefined) push(unset, from, to);
      else push(held[index]!.holds, from, to);
    }
  }
  return { areas: held, unset };
}

/** The area that holds at a source second, if one does. */
export function areaAt(areas: readonly HeldArea[], second: number): HeldArea | undefined {
  return areas.find(a => a.holds.some(([from, to]) => second >= from - 1e-6 && second < to + 1e-6));
}
