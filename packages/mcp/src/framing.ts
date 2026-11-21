/**
 * Framing a recording's picture on an area of it, over a stretch of the edit.
 *
 * A crop leaves the timeline's background beside any area that isn't the canvas's shape, and a crop can't be
 * keyframed, so a pass that framed its screen demos with crops filled 49–80% of the frame's width and made no moves
 * (2026-11-16). Here the model names the area to show; this works out the frame that fills the canvas around it,
 * clear of any picture laid over it, and the clip transforms and keyframes that hold it and move between frames,
 * across the cuts that split a demo into clips.
 */
import { applyOps, clipEnd, newId, Transform, type MediaAsset, type MediaClip, type Timeline, type TimelineOp, type TransformKeyframe } from "@scarlet/timeline";

/** A box in a picture as fractions of its width and height: left, top, right, bottom. */
export type Box = [number, number, number, number];

export interface Framing {
  /** Timeline seconds where the picture starts moving to this frame. */
  at: number;
  /** The area that must be seen, as fractions of the source picture. */
  show: Box;
  /** The area the frame may show. Outside it is what should stay out of the video. */
  within?: Box;
  /** Seconds the move takes. Zero is a straight cut to the frame. */
  over: number;
  /** How the move eases: the skill's feel for a zoom. easeInOut when absent. */
  ease?: MoveEase;
  /** The corner of the video the picture laid over the recording sits in from this framing on, at the size and margins it has. */
  inset?: Corner;
}

export const MOVE_EASES = ["easeInOut", "easeIn", "easeOut", "linear"] as const;
export type MoveEase = typeof MOVE_EASES[number];
export const CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"] as const;
export type Corner = typeof CORNERS[number];

/** A box on the canvas moved to a corner, keeping its size and its distance from the two edges it is nearest. */
export function boxInCorner(box: Box, corner: Corner): Box {
  const width = w(box), height = h(box);
  const mx = Math.max(0, Math.min(box[0], 1 - box[2])), my = Math.max(0, Math.min(box[1], 1 - box[3]));
  const left = corner.endsWith("right") ? 1 - mx - width : mx, top = corner.startsWith("bottom") ? 1 - my - height : my;
  return [left, top, left + width, top + height];
}

/** The corner of the video a box on it sits nearest. */
export const cornerOf = (box: readonly number[]): Corner => `${(box[1]! + box[3]!) / 2 >= 0.5 ? "bottom" : "top"}-${(box[0]! + box[2]!) / 2 >= 0.5 ? "right" : "left"}`;

const overlapArea = (a: readonly number[], b: readonly number[]) =>
  Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!)) * Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));

/**
 * Whether pictures over the video (`covers`, canvas fractions) sit on a real part of any line of text, with `frame` the
 * area of the source that fills the video and each line's box in source fractions. A sentence whose end runs under the
 * inset counts.
 */
export function coverOnText(frame: Box, covers: readonly Box[], lines: ReadonlyArray<{ box: readonly number[] }>): boolean {
  const [fl, ft, fr, fb] = frame, fw = fr - fl, fh = fb - ft;
  return lines.some(s => {
    const onVideo = [(s.box[0]! - fl) / fw, (s.box[1]! - ft) / fh, (s.box[2]! - fl) / fw, (s.box[3]! - ft) / fh];
    const seen = overlapArea(onVideo, [0, 0, 1, 1]);
    return seen > 0 && covers.some(c => overlapArea(onVideo, c) >= 0.05 * seen);
  });
}

export interface PlacedFrame {
  /** The area of the source picture that fills the canvas. */
  frame: Box;
  /** How far the frame reaches past `within` on each side, as shares of the frame's width or height. */
  beyondWithin?: { left?: number; right?: number; top?: number; bottom?: number };
  /** The share of `show` that another picture covers or the frame leaves out. */
  hidden: number;
  /** When the frame reaches past `within`: the largest frame that stays inside it around `show`, and the share of `show` that one hides. */
  insideWithin?: { frame: Box; hidden: number };
}

const w = (b: Box) => b[2] - b[0], h = (b: Box) => b[3] - b[1];
const area = (b: Box) => Math.max(0, w(b)) * Math.max(0, h(b));
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const meet = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const WHOLE: Box = [0, 0, 1, 1];
/** A cover this much of the canvas hides the recording under it: there is nothing to keep clear. */
const COVERS_ALL = 0.9;
/** The frame is drawn this much larger than the canvas, so rounding to whole pixels never leaves a line of background at an edge. */
const OVERSCAN = 1.003;

const insideBox = (a: Box, b: Box) => a[0] >= b[0] - 1e-9 && a[1] >= b[1] - 1e-9 && a[2] <= b[2] + 1e-9 && a[3] <= b[3] + 1e-9;

/** The maximal parts of the canvas that no cover touches, as canvas fractions. Falls back to the whole canvas if none is wide enough. */
function freeAreas(covers: readonly Box[]): Box[] {
  let areas: Box[] = [WHOLE];
  for (const c of covers) {
    const next: Box[] = [];
    for (const b of areas) {
      if (area(meet(b, c)) < 1e-9) { next.push(b); continue; }
      const splits: Box[] = [
        [b[0], b[1], c[0], b[3]],
        [c[2], b[1], b[2], b[3]],
        [b[0], b[1], b[2], c[1]],
        [b[0], c[3], b[2], b[3]],
      ];
      for (const s of splits) if (w(s) > 0.05 && h(s) > 0.05) next.push(s);
    }
    areas = next.filter((a, i) => !next.some((b, j) => i !== j && insideBox(a, b) && (j < i || !insideBox(b, a))));
    if (!areas.length) return [WHOLE];
  }
  return areas;
}

/** Where on one axis the frame starts: the shown area centred in the free span, inside `within` when both can hold, inside the picture always. */
function origin(size: number, show: [number, number], free: [number, number], within: [number, number]) {
  // The frame starts between these to keep the shown area inside the free span.
  let lo = show[1] - free[1] * size, hi = show[0] - free[0] * size;
  if (lo > hi) lo = hi = (lo + hi) / 2;
  const centred = (show[0] + show[1]) / 2 - (free[0] + free[1]) / 2 * size;
  const inside = size <= within[1] - within[0]
    ? clamp(clamp(centred, lo, hi), within[0], within[1] - size)
    : (within[0] + within[1]) / 2 - size / 2;
  return clamp(clamp(inside, lo, hi), 0, 1 - size);
}

/**
 * The tightest frame of the canvas's shape that shows `show` clear of the covers. `shape` is the source's aspect over
 * the canvas's: a frame `width` of the source wide is `width * shape` of it tall.
 */
export function placeFrame(show: Box, within: Box | undefined, covers: readonly Box[], shape: number): PlacedFrame {
  const bounds = within ?? WHOLE;
  const widest = Math.min(1, 1 / shape);
  let best: (PlacedFrame & { width: number }) | undefined;
  for (const free of freeAreas(covers)) {
    const width = clamp(Math.max(w(show) / w(free), h(show) / (h(free) * shape)), 0.01, widest), height = width * shape;
    const left = origin(width, [show[0], show[2]], [free[0], free[2]], [bounds[0], bounds[2]]);
    const top = origin(height, [show[1], show[3]], [free[1], free[3]], [bounds[1], bounds[3]]);
    const frame: Box = [left, top, left + width, top + height];
    const seen = meet(show, frame);
    const covered = covers.reduce((sum, [l, t, r, b]) =>
      sum + area(meet(seen, [left + l * width, top + t * height, left + r * width, top + b * height])), 0);
    const hidden = area(show) > 0 ? clamp(1 - (area(seen) - covered) / area(show), 0, 1) : 0;
    if (!best || hidden < best.hidden - 1e-6 || (Math.abs(hidden - best.hidden) <= 1e-6 && width < best.width - 1e-9)) {
      const past = { left: (bounds[0] - left) / width, right: (left + width - bounds[2]) / width,
        top: (bounds[1] - top) / height, bottom: (top + height - bounds[3]) / height };
      const beyond = Object.fromEntries(Object.entries(past).filter(([, share]) => share > 0.005).map(([side, share]) => [side, r4(share)]));
      best = { frame: frame.map(r4) as Box, hidden: r4(hidden), width, ...(Object.keys(beyond).length && { beyondWithin: beyond }) };
    }
  }
  const { width: _width, ...placed } = best!;
  if (!placed.beyondWithin) return placed;
  // What staying inside would cost, so the choice between the two needs no second call.
  const width = Math.min(w(bounds), h(bounds) / shape, widest), height = width * shape;
  const left = clamp((show[0] + show[2]) / 2 - width / 2, bounds[0], bounds[2] - width), top = clamp((show[1] + show[3]) / 2 - height / 2, bounds[1], bounds[3] - height);
  const inside: Box = [left, top, left + width, top + height];
  const seen = meet(show, inside);
  const covered = covers.reduce((sum, [l, t, r, b]) => sum + area(meet(seen, [left + l * width, top + t * height, left + r * width, top + b * height])), 0);
  return { ...placed, insideWithin: { frame: inside.map(r4) as Box, hidden: r4(clamp(1 - (area(seen) - covered) / area(show), 0, 1)) } };
}

interface Size { width: number; height: number }

const ease = (kind: TransformKeyframe["ease"], p: number) =>
  kind === "easeIn" ? p * p : kind === "easeOut" ? 1 - (1 - p) ** 2 : kind === "easeInOut" ? p * p * (3 - 2 * p) : p;

/** A clip's scale and offsets at `local` seconds from its start, as the renderer reads its keyframes. */
function motionAt(clip: Pick<MediaClip, "transform" | "keyframes">, local: number) {
  const base = Transform.parse(clip.transform ?? {});
  const keys = (clip.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
  const value = (prop: "x" | "y" | "scale") => {
    if (!keys.length) return base[prop];
    const points = keys.map(k => ({ time: k.time, value: k.transform[prop] ?? base[prop], ease: k.ease ?? "linear" }));
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!, b = points[i + 1]!;
      if (local >= b.time) continue;
      const dt = b.time - a.time;
      if (dt <= 0 || a.ease === "hold") return a.value;
      return a.value + (b.value - a.value) * ease(a.ease, clamp((local - a.time) / dt, 0, 1));
    }
    return points.at(-1)!.value;
  };
  return { base, x: value("x"), y: value("y"), scale: value("scale") };
}

/** Where a clip's picture sits on the canvas at `local` seconds from its start, as canvas fractions. It can reach past the canvas. */
export function pictureBox(clip: Pick<MediaClip, "transform" | "keyframes">, local: number, source: Size, canvas: Size): Box {
  const { base, x, y, scale } = motionAt(clip, local);
  const cw = Math.max(0.01, 1 - base.cropLeft - base.cropRight) * source.width, ch = Math.max(0.01, 1 - base.cropTop - base.cropBottom) * source.height;
  const fit = Math.min(canvas.width / cw, canvas.height / ch) * scale;
  const lw = cw * fit / canvas.width, lh = ch * fit / canvas.height;
  return [0.5 + x - lw / 2, 0.5 + y - lh / 2, 0.5 + x + lw / 2, 0.5 + y + lh / 2];
}

/** The area of its source a clip fills the canvas with at `local` seconds, or null when it is turned or leaves background showing. */
export function frameShown(clip: Pick<MediaClip, "transform" | "keyframes">, local: number, source: Size, canvas: Size): Box | null {
  const { base } = motionAt(clip, local);
  if (base.rotation) return null;
  const [l, t, r, b] = pictureBox(clip, local, source, canvas);
  const slack = 0.004;
  if (l > slack || t > slack || r < 1 - slack || b < 1 - slack) return null;
  const crop: Box = [base.cropLeft, base.cropTop, 1 - base.cropRight, 1 - base.cropBottom];
  const across = (at: number) => crop[0] + (at - l) / (r - l) * w(crop), down = (at: number) => crop[1] + (at - t) / (b - t) * h(crop);
  return [clamp(across(0), 0, 1), clamp(down(0), 0, 1), clamp(across(1), 0, 1), clamp(down(1), 0, 1)];
}

/** The scale and offsets that fill the canvas with `frame` of a source cropped to `crop`, which holds the frame. */
function motionFor(frame: Box, crop: Box, source: Size, canvas: Size) {
  const cw = w(crop) * source.width, ch = h(crop) * source.height;
  const fit = Math.min(canvas.width / cw, canvas.height / ch);
  const scale = canvas.width / (w(frame) * source.width * fit) * OVERSCAN;
  const lw = cw * fit * scale / canvas.width, lh = ch * fit * scale / canvas.height;
  return {
    scale: r4(scale),
    x: r4(-((frame[0] + frame[2]) / 2 - (crop[0] + crop[2]) / 2) / w(crop) * lw),
    y: r4(-((frame[1] + frame[3]) / 2 - (crop[1] + crop[3]) / 2) / h(crop) * lh),
  };
}

interface PathPoint { time: number; frame: Box; ease: TransformKeyframe["ease"] }

const sameFrame = (a: Box, b: Box) => a.every((n, i) => Math.abs(n - b[i]!) < 1e-4);

/** The points of a path a clip from `start` to `end` plays: those inside it, with the one before and the one after, which carry a move across its edges. */
function pointsOver<P extends { time: number; ease: TransformKeyframe["ease"] }>(path: readonly P[], start: number, end: number, same: (a: P, b: P) => boolean): P[] {
  let first = 0, last = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    if (path[i]!.time <= start + 1e-6) first = i;
    if (path[i]!.time >= end - 1e-6) { last = i; break; }
  }
  // Before a cut, the point ahead holds: nothing of what comes next shows on this side of it.
  const points = path.slice(first, last + 1).filter((p, i, all) => !(i === all.length - 1 && i > 0 && all[i - 1]!.ease === "hold" && p.time >= end - 1e-6));
  // A point that only repeats the one beside it at an end says nothing the renderer doesn't already hold.
  while (points.length > 1 && same(points[0]!, points[1]!)) points.shift();
  while (points.length > 1 && same(points.at(-1)!, points.at(-2)!)) points.pop();
  return points;
}

/** The transform and keyframes that play `path`, in timeline seconds, on a clip from `start` to `end`. */
function clipMotion(path: readonly PathPoint[], start: number, end: number, source: Size, canvas: Size, keep: Pick<Transform, "cornerRadius">) {
  const points = pointsOver(path, start, end, (a, b) => sameFrame(a.frame, b.frame));
  const frames = points.map(p => p.frame);
  const crop: Box = [Math.min(...frames.map(f => f[0])), Math.min(...frames.map(f => f[1])), Math.max(...frames.map(f => f[2])), Math.max(...frames.map(f => f[3]))];
  const cropped = { cropLeft: r4(crop[0]), cropTop: r4(crop[1]), cropRight: r4(Math.max(0, 1 - crop[2])), cropBottom: r4(Math.max(0, 1 - crop[3])) };
  // The crop as saved, so the motion is worked out on the picture the renderer will have.
  const saved: Box = [cropped.cropLeft, cropped.cropTop, 1 - cropped.cropRight, 1 - cropped.cropBottom];
  const corner = keep.cornerRadius ? { cornerRadius: keep.cornerRadius } : {};
  if (frames.every(f => sameFrame(f, frames[0]!))) {
    return { transform: Transform.parse({ ...motionFor(frames[0]!, saved, source, canvas), rotation: 0, ...cropped, ...corner }), keyframes: [] as TransformKeyframe[] };
  }
  const keyframes = points.map(p => ({ time: r4(p.time - start), transform: motionFor(p.frame, saved, source, canvas), ease: p.ease }));
  return { transform: Transform.parse({ ...keyframes[0]!.transform, rotation: 0, ...cropped, ...corner }), keyframes };
}

export interface FramingResult {
  ops: TimelineOp[];
  /** One per framing, in order. */
  frames: Array<PlacedFrame & {
    at: number;
    /** When the frame has settled, in timeline seconds. */
    settles: number;
    /** Seconds the frame holds once settled, until the next move or the end. */
    holds: number;
    /** "move" from the frame before it, or "cut". */
    arrives: "move" | "cut";
    /** How many times larger the picture plays than at full frame. */
    zoom: number;
    /** Source pixels per pixel of the video at this frame. Under 1, the picture is enlarged past its own detail. */
    sourcePixels: number;
    /** The clip that plays at `settles`, and the second of its source there. */
    clipId: string; sourceTime: number;
    /** Other pictures over the canvas while the frame holds, as canvas fractions. */
    covers: Box[];
    /** Another picture covers the whole canvas when the frame settles: the recording isn't seen there. */
    notOnPicture?: true;
  }>;
  clips: number;
  /** Clips of the picture laid over the recording that the framings moved to another corner. */
  insetClips: number;
}

interface VideoLayer { clip: MediaClip; track: number }

function videoLayers(timeline: Timeline): VideoLayer[] {
  return timeline.tracks.flatMap((track, index) => track.kind !== "video" || track.hidden ? []
    : track.clips.flatMap(clip => clip.kind === "media" && clip.enabled !== false && clip.opacity > 0 ? [{ clip, track: index }] : []));
}

/**
 * The edit that makes a recording's clips follow `framings` from the first one's time to `to`. A clip the first
 * framing or `to` falls inside is split there, so footage outside the stretch keeps the framing it had.
 */
export function framingOps(timeline: Timeline, media: readonly MediaAsset[], canvas: Size, framings: readonly Framing[],
  opts: { mediaId: string; trackId?: string; to?: number }): FramingResult {
  const asset = media.find(m => m.id === opts.mediaId);
  if (!asset || (asset.kind !== "video" && asset.kind !== "image" && asset.kind !== "graphic"))
    throw new Error(`Media ${opts.mediaId} is not a picture in this project. project_get lists media ids.`);
  const source = { width: asset.width || canvas.width, height: asset.height || canvas.height };
  const shape = (source.width / source.height) / (canvas.width / canvas.height);
  const sizes = new Map(media.map(m => [m.id, { width: m.width || canvas.width, height: m.height || canvas.height }]));
  if (!framings.length) throw new Error("Give at least one framing.");
  const problems: string[] = [];
  framings.forEach((f, i) => {
    if (i && f.at <= framings[i - 1]!.at) problems.push(`framings[${i}].at ${f.at} s is not after framings[${i - 1}].at ${framings[i - 1]!.at} s`);
    for (const [name, box] of [["show", f.show], ["within", f.within]] as const) {
      if (box && !(box[2] > box[0] && box[3] > box[1])) problems.push(`framings[${i}].${name} needs right greater than left and bottom greater than top`);
    }
  });
  const mine = (layer: VideoLayer, on: Timeline) => layer.clip.mediaId === opts.mediaId && (!opts.trackId || on.tracks[layer.track]!.id === opts.trackId);
  const playing = (on: Timeline, time: number) => videoLayers(on).find(l => mine(l, on) && l.clip.timelineIn <= time + 1e-6 && time < clipEnd(l.clip) - 1e-6);
  const from = framings[0]!.at;
  const lastClipEnd = Math.max(0, ...videoLayers(timeline).filter(l => mine(l, timeline)).map(l => clipEnd(l.clip)));
  const to = Math.min(opts.to ?? Infinity, lastClipEnd);
  if (opts.to !== undefined && opts.to <= framings.at(-1)!.at) problems.push(`to ${opts.to} s is not after the last framing's at ${framings.at(-1)!.at} s`);
  framings.forEach((f, i) => {
    if (!playing(timeline, f.at)) problems.push(`framings[${i}].at ${f.at} s: ${opts.mediaId} doesn't play there${opts.trackId ? ` on ${opts.trackId}` : ""}`);
  });
  if (problems.length) throw new Error(`${problems.join("; ")}. Nothing was saved. timeline_at maps a time to the clips under it.`);

  // The frame in place where the path begins, to move from: only footage that plays on from before it has one.
  const startsIn = playing(timeline, from)!;
  const startsInside = from > startsIn.clip.timelineIn + 1e-3;
  const before = startsInside ? frameShown(startsIn.clip, from - startsIn.clip.timelineIn, source, canvas) : null;

  // A graphic or a picture with transparency is laid over the whole canvas and hides little of it: nothing to keep clear of.
  const seeThrough = new Set(media.filter(m => m.kind === "graphic" || m.hasAlpha).map(m => m.id));
  const baseTrack = Math.min(...videoLayers(timeline).filter(l => mine(l, timeline)).map(l => l.track));
  const boxOf = (clip: MediaClip, local = 0) => pictureBox(clip, local, sizes.get(clip.mediaId) ?? canvas, canvas);
  /** A picture laid over part of the recording: an inset. */
  const isInset = (l: VideoLayer) => l.track > baseTrack && !seeThrough.has(l.clip.mediaId) && area(meet(boxOf(l.clip), WHOLE)) < COVERS_ALL && area(meet(boxOf(l.clip), WHOLE)) > 0.001;
  const movesInset = framings.some(f => f.inset);

  const splits: TimelineOp[] = [];
  let made = timeline;
  for (const at of [from, to]) {
    const under = [playing(made, at), ...(movesInset ? videoLayers(made).filter(l => isInset(l) && l.clip.timelineIn <= at && at < clipEnd(l.clip)) : [])];
    for (const layer of under) {
      if (!layer || at <= layer.clip.timelineIn + 1e-3 || at >= clipEnd(layer.clip) - 1e-3) continue;
      const op: TimelineOp = { op: "splitClip", clipId: layer.clip.id, at, newClipId: newId("clip") };
      splits.push(op);
      made = applyOps(made, [op]);
    }
  }

  const inRange = videoLayers(made).filter(l => mine(l, made) && l.clip.timelineIn >= from - 1e-3 && clipEnd(l.clip) <= to + 1e-3)
    .sort((a, b) => a.clip.timelineIn - b.clip.timelineIn);
  const layers = videoLayers(made).filter(l => !seeThrough.has(l.clip.mediaId));
  const coversOver = (track: number, start: number, end: number, corner?: Corner) => layers
    .filter(l => l.track > track && l.clip.timelineIn < end - 1e-6 && clipEnd(l.clip) > start + 1e-6)
    .map(l => {
      const placed = boxOf(l.clip, Math.max(0, start - l.clip.timelineIn));
      return { box: meet(corner && isInset(l) ? boxInCorner(placed, corner) : placed, WHOLE), atStart: l.clip.timelineIn <= start + 1e-6 };
    })
    .filter(c => area(c.box) > 0.001)
    // An inset cut into clips with the footage under it is one cover, not one per clip.
    .filter((c, i, all) => all.findIndex(o => sameFrame(o.box, c.box) && (o.atStart || !c.atStart)) === i);

  const frames: FramingResult["frames"] = [];
  const path: PathPoint[] = [];
  // Where the inset sits over time: null is where each of its clips already is.
  const insetPath: Array<{ time: number; corner: Corner | null; ease: TransformKeyframe["ease"] }> = [{ time: from, corner: null, ease: "linear" }];
  let corner: Corner | undefined;
  framings.forEach((f, i) => {
    const next = framings[i + 1]?.at ?? to;
    const previous = i ? frames[i - 1]!.frame : before;
    const over = previous ? Math.min(Math.max(0, f.over), Math.max(0, next - f.at)) : 0;
    const settles = f.at + over;
    const under = playing(made, Math.min(settles, to - 1e-3)) ?? playing(made, f.at)!;
    if (f.inset && f.inset !== corner) {
      // The inset goes with the frame: over the same move, or on the same cut.
      if (over > 0) insetPath.push({ time: f.at, corner: corner ?? null, ease: f.ease ?? "easeInOut" }, { time: settles, corner: f.inset, ease: "linear" });
      else { insetPath.at(-1)!.ease = "hold"; insetPath.push({ time: f.at, corner: f.inset, ease: "linear" }); }
      corner = f.inset;
    }
    const over_ = coversOver(under.track, settles, Math.max(settles + 1e-3, next), corner);
    const whole = over_.some(c => c.atStart && area(c.box) >= COVERS_ALL);
    const covers = over_.filter(c => area(c.box) < COVERS_ALL).map(c => c.box);
    const placed = placeFrame(f.show, f.within, covers, shape);
    if (over > 0 && previous) path.push({ time: f.at, frame: previous, ease: f.ease ?? "easeInOut" }, { time: settles, frame: placed.frame, ease: "linear" });
    else {
      if (path.length) path[path.length - 1]!.ease = "hold";
      path.push({ time: f.at, frame: placed.frame, ease: "linear" });
    }
    frames.push({
      ...placed, at: f.at, settles: r4(settles), holds: r4(Math.max(0, next - settles)), arrives: over > 0 && previous ? "move" : "cut",
      zoom: r4(1 / w(placed.frame)), sourcePixels: r4(w(placed.frame) * source.width / canvas.width),
      clipId: under.clip.id, sourceTime: r4(under.clip.sourceIn + Math.max(0, Math.min(settles, clipEnd(under.clip)) - under.clip.timelineIn) * (under.clip.speed ?? 1)),
      covers: covers.map(c => c.map(r4) as Box), ...(whole && { notOnPicture: true as const }),
    });
  });

  const updates: TimelineOp[] = inRange.map(({ clip }) => {
    const motion = clipMotion(path, clip.timelineIn, clipEnd(clip), source, canvas, Transform.parse(clip.transform ?? {}));
    return { op: "updateClip", clipId: clip.id, patch: { transform: motion.transform, keyframes: motion.keyframes } };
  });
  // The inset's clips through the stretch follow it from corner to corner, each from where it already sits.
  const insets = !movesInset ? [] : videoLayers(made).filter(l => isInset(l) && !l.clip.keyframes?.length && l.clip.timelineIn >= from - 1e-3 && clipEnd(l.clip) <= to + 1e-3);
  const moved: TimelineOp[] = insets.flatMap(({ clip }) => {
    const points = pointsOver(insetPath, clip.timelineIn, clipEnd(clip), (a, b) => a.corner === b.corner);
    if (points.every(p => p.corner === null)) return [];
    const own = Transform.parse(clip.transform ?? {}), placed = boxOf(clip);
    const at = (c: Corner | null) => {
      if (!c) return { x: own.x, y: own.y };
      const box = boxInCorner(placed, c);
      return { x: r4((box[0] + box[2]) / 2 - 0.5), y: r4((box[1] + box[3]) / 2 - 0.5) };
    };
    const keyframes = points.length > 1 ? points.map(p => ({ time: r4(p.time - clip.timelineIn), transform: at(p.corner), ease: p.ease })) : [];
    return [{ op: "updateClip" as const, clipId: clip.id, patch: { transform: { ...own, ...at(points[0]!.corner) }, keyframes } }];
  });
  return { ops: [...splits, ...updates, ...moved], frames, clips: inRange.length, insetClips: moved.length };
}
