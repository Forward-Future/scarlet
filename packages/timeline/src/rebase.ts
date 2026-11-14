/**
 * Source-anchored time mapping, content diffs, and rebasing.
 *
 * Timeline times shift every time something earlier in the cut is trimmed or
 * extended, so "12.4 s" means different things in different versions. A moment
 * in the *source footage* ("14.2 s into interview.mp4") does not move. These
 * helpers translate times between two versions through the footage, which lets
 * Scarlet:
 *
 *  - find what visibly changed between two versions (short, accurate change
 *    clips even when a cut shifts everything after it),
 *  - re-apply an agent's edits onto a cut that moved since the agent started
 *    (parallel threads), and refuse when the edits overlap,
 *  - apply only some spots of a batch ("keep 5 of these 6 cuts").
 */
import { CaptionWord } from "./schema.js";
import type { Clip, Marker, MediaClip, Timeline, TimeRange, Track } from "./schema.js";
import { OpError, applyOp, replayOnCopy, shiftClip, type TimelineOp } from "./ops.js";
import { ZodError } from "zod/v3";
import { clipEnd, timelineDuration } from "./time.js";
import { firstIndex, intervalCandidates } from "./intervals.js";
import { stableStringify } from "./ids.js";

const EPS = 1e-6;

// Mapping through different sequences of cuts can put the same source time a few
// ulps either side of a half frame. Use a stable tie only when comparing edits.
function sameFrame(a: number, b: number, fps: number) {
  return Math.abs(a - b) <= 1e-9 || Math.round(a * fps + 1e-7) === Math.round(b * fps + 1e-7);
}

type Kind = "video" | "audio";
interface Placed {
  track: Track;
  clip: MediaClip;
}

const srcAt = (c: MediaClip, t: number) => c.sourceIn + (t - c.timelineIn) * (c.speed ?? 1);
const tlAt = (c: MediaClip, s: number) => c.timelineIn + (s - c.sourceIn) / (c.speed ?? 1);

function mediaOn(tl: Timeline, kind: Kind): Placed[] {
  const out: Placed[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== kind) continue;
    for (const clip of track.clips) if (clip.kind === "media" && clip.enabled !== false) out.push({ track, clip });
  }
  return out;
}

/** Same timeline content (ignores version bookkeeping). */
export function sameContent(a: Timeline, b: Timeline): boolean {
  if (a === b) return true;
  const content = ({ version, parent, createdAt, name, ...rest }: Timeline) => rest;
  return stableStringify(content(a)) === stableStringify(content(b));
}

export type TimeMap = (t: number, side?: "left" | "right") => number | null;

/**
 * Translate a time on timeline `a` to the same footage moment on timeline `b`.
 * Returns null when that moment was cut from `b`. `side` picks the clip ending
 * at `t` ("left") or starting at `t` ("right") when `t` is a cut point.
 */
export function makeTimeMap(a: Timeline, b: Timeline, fps = 30): TimeMap {
  return sameTracks(a, b) ? (t) => t : sourceTimeMap(a, b, fps);
}

/**
 * Each stretch of `before` that `after` no longer plays, in `before`'s clock, with the time on `after` where its two
 * sides now join. It reads the two versions alone, for a change that saved the video and not the steps that made it.
 * Read the other way round, it is the footage `after` put back.
 */
export function removedJoins(before: Timeline, after: Timeline, fps = 30): Array<{ at: number; removed: TimeRange }> {
  if (sameTracks(before, after)) return [];
  const back = sourceTimeMap(after, before, fps);
  const total = timelineDuration(after);
  const edges = [0, total];
  for (const kind of ["video", "audio"] as const) for (const { clip } of mediaOn(after, kind)) edges.push(clip.timelineIn, clipEnd(clip));
  edges.sort((a, b) => a - b);
  const joins: Array<{ at: number; removed: TimeRange }> = [];
  let last = -Infinity;
  for (const at of edges) {
    if (at <= last + EPS) continue;
    last = at;
    // Nothing plays before the start or after the end, so a trim there runs to the edge of the earlier version.
    const start = at <= EPS ? 0 : back(at, "left");
    const end = at >= total - EPS ? timelineDuration(before) : back(at, "right");
    if (start !== null && end !== null && end - start > 0.5 / fps) joins.push({ at, removed: { start, end } });
  }
  return joins;
}

function sameTracks(a: Timeline, b: Timeline): boolean {
  if (a.tracks === b.tracks) return true;
  if (a.tracks.length !== b.tracks.length || a.tracks.some((track, i) => track.clips.length !== b.tracks[i]!.clips.length)) return false;
  return stableStringify(a.tracks) === stableStringify(b.tracks);
}

function sourceTimeMap(a: Timeline, b: Timeline, fps: number): TimeMap {
  const halfFrame = 0.5 / fps;
  const kinds: Kind[] = ["video", "audio"];
  const fromClips = kinds.map((k) => mediaOn(a, k));
  const fromAt = fromClips.map(clips => intervalCandidates(clips, x => x.clip.timelineIn - EPS, x => clipEnd(x.clip) + EPS));
  const toClips = kinds.map(k => {
    const groups = new Map<string, Placed[]>();
    for (const item of mediaOn(b, k)) {
      const group = groups.get(item.clip.mediaId);
      if (group) group.push(item);
      else groups.set(item.clip.mediaId, [item]);
    }
    return new Map([...groups].map(([id, clips]) => [id,
      intervalCandidates(clips, x => x.clip.sourceIn - halfFrame, x => x.clip.sourceOut + halfFrame)]));
  });
  const allFrom = [...fromClips[0]!, ...fromClips[1]!];
  const starts = allFrom.map(x => x.clip.timelineIn).sort((a, b) => a - b);
  const ends = allFrom.map(x => clipEnd(x.clip)).sort((a, b) => a - b);

  const find = (k: number, x: Placed, s: number, t: number, side: "left" | "right"): number | null => {
    let best: { score: number[]; t: number } | null = null;
    for (const y of toClips[k]!.get(x.clip.mediaId)?.(s) ?? []) {
      if (s < y.clip.sourceIn - halfFrame || s > y.clip.sourceOut + halfFrame) continue;
      // A split can put the two sides of the same source frame on opposite
      // sides of a gap. Only a fragment containing the requested side counts.
      if (side === "right" ? s >= y.clip.sourceOut - EPS : s <= y.clip.sourceIn + EPS) continue;
      const at = tlAt(y.clip, Math.min(Math.max(s, y.clip.sourceIn), y.clip.sourceOut));
      const inside = s > y.clip.sourceIn + EPS && s < y.clip.sourceOut - EPS ? 0 : 1;
      const score = [y.clip.id === x.clip.id ? 0 : 1, y.track.id === x.track.id ? 0 : 1, inside, Math.abs(at - t)];
      if (!best || compare(score, best.score) < 0) best = { score, t: at };
    }
    return best ? best.t : null;
  };

  const locate = (t: number, side: "left" | "right"): { covered: boolean; value: number | null } => {
    let covered = false;
    for (let k = 0; k < kinds.length; k++) {
      for (const x of fromAt[k]!(t)) {
        const s = x.clip.timelineIn;
        const e = clipEnd(x.clip);
        const inside = side === "left" ? t > s + EPS && t <= e + EPS : t >= s - EPS && t < e - EPS;
        if (!inside) continue;
        covered = true;
        const found = find(k, x, srcAt(x.clip, Math.min(t, e)), t, side);
        if (found !== null) return { covered, value: found };
      }
    }
    return { covered, value: null };
  };

  const map: TimeMap = (t, side) => {
    const sides: Array<"left" | "right"> = side ? [side] : ["right", "left"];
    let covered = false;
    for (const sd of sides) {
      const r = locate(t, sd);
      if (r.value !== null) return r.value;
      covered ||= r.covered;
    }
    if (covered) return null;
    // In a gap: anchor on the nearest clip edge before t, else after it.
    if (!ends.length) return t;
    if (Number.isNaN(t)) return null;
    const prevEnd = ends[firstIndex(ends, end => end > t + EPS) - 1];
    if (prevEnd !== undefined) {
      const m = locate(prevEnd, "left").value;
      if (m !== null) return m + (t - prevEnd);
    }
    const nextStart = starts[firstIndex(starts, start => start >= t - EPS)];
    if (nextStart !== undefined) {
      const m = locate(nextStart, "right").value;
      if (m !== null) return Math.max(0, m - (nextStart - t));
    }
    return null;
  };
  return map;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

// ---------------------------------------------------------------------------
// What visibly changed
// ---------------------------------------------------------------------------

function indexTracks(tl: Timeline) {
  return tl.tracks.map(track => ({ track, candidates: intervalCandidates(track.clips, c => c.timelineIn, clipEnd) }));
}

/** Build once for repeated clipsAt queries against the same immutable timeline. */
export function indexClipsAt(timeline: Timeline) {
  const tracks = indexTracks(timeline);
  return (time: number) => {
    const hits: { track: Track; clip: Clip }[] = [];
    for (const { track, candidates } of tracks) {
      for (const clip of candidates(time)) {
        if (clip.timelineIn <= time && time < clipEnd(clip)) hits.push({ track, clip });
      }
    }
    return hits;
  };
}

/** `fade` is how far each fade has come at the sample, 0 to 1 (video in, video
 * out, audio in, audio out), and absent while the clip plays at full level. */
interface LayerSample { content: string; source: number; fade?: number[] }

// Compare fade levels by distance, not by rounding each to a step. A cut on
// another track often splits a crossfade in half, which puts the sample on an
// exact rounding tie (a quarter or three quarters through), and the same moment
// mapped through the footage is a few ulps off, so it rounded the other way.
const FADE_TOLERANCE = 0.05;
const FULL_LEVEL = [1, 1, 1, 1];

function fadeLevels(c: MediaClip, t: number, end: number): number[] | undefined {
  const { audioFadeIn, audioFadeOut, videoFadeIn, videoFadeOut } = c;
  if (!(audioFadeIn || audioFadeOut || videoFadeIn || videoFadeOut)) return undefined;
  // Fades only matter inside their zone at the clip edges.
  const rel = t - c.timelineIn;
  const left = end - t;
  const levels = [
    rel < videoFadeIn ? rel / videoFadeIn : 1,
    left < videoFadeOut ? left / videoFadeOut : 1,
    rel < audioFadeIn ? rel / audioFadeIn : 1,
    left < audioFadeOut ? left / audioFadeOut : 1,
  ];
  return levels.every(level => level === 1) ? undefined : levels;
}

function sameLayers(a: LayerSample[], b: LayerSample[], fps: number) {
  return a.length === b.length && a.every((left, i) => {
    const right = b[i]!;
    if (left.content !== right.content || !sameFrame(left.source, right.source, fps)) return false;
    if (!left.fade && !right.fade) return true;
    const other = right.fade ?? FULL_LEVEL;
    return (left.fade ?? FULL_LEVEL).every((level, k) => Math.abs(level - other[k]!) <= FADE_TOLERANCE);
  });
}

/** Keep source time separate so equivalent mappings can be compared before
 * rounding each layer to a display frame. */
// Compare a clip at many boundaries (especially timed caption words) without
// serializing its unchanged picture, sound or style at every sample.
function indexedLayers(timeline: Timeline) {
  return indexTracks(timeline).map(({ track, candidates }) => {
    const keys = new Map<Clip, string>();
    const captionStyle = track.kind === "caption" ? stableStringify(track.captionStyle ?? {}) : "";
    const keyFor = (c: Clip) => {
      let key = keys.get(c);
      if (key !== undefined) return key;
      if (c.kind === "media") {
        const { id, timelineIn, sourceIn, sourceOut, label, audioFadeIn, audioFadeOut, videoFadeIn, videoFadeOut, ...rest } = c;
        // Splitting a clip shifts its local keyframe times while retaining the
        // same animation at each source frame.
        key = stableStringify(rest.keyframes?.length ? { ...rest, keyframes: rest.keyframes.map(k => ({
          ...k, time: roundedTime(sourceIn + k.time * c.speed),
        })) } : rest);
      } else if (c.kind === "caption") {
        key = `${track.id}|c|${c.text}|${captionStyle}|${stableStringify(c.style ?? {})}`;
      } else {
        key = `${track.id}|k|${c.color}|${stableStringify({ transform: c.transform, opacity: c.opacity })}`;
      }
      keys.set(c, key);
      return key;
    };
    return { track, candidates, keyFor };
  });
}

function signature(tracks: ReturnType<typeof indexedLayers>, t: number) {
  const video: LayerSample[] = [];
  const captions: LayerSample[] = [];
  const audio: LayerSample[] = [];
  for (const { track, candidates, keyFor } of tracks) {
    const visible = track.kind === "video" && !track.hidden;
    const audible = track.kind !== "caption" && !track.muted;
    for (const c of candidates(t, t + EPS)) {
      if (c.enabled === false) continue;
      const end = clipEnd(c);
      if (!(c.timelineIn <= t + EPS && t < end - EPS)) continue;
      if (c.kind === "media") {
        const part = { content: `${track.id}|m|${c.mediaId}|${keyFor(c)}`, source: srcAt(c, t), fade: fadeLevels(c, t, end) };
        if (visible) video.push(part);
        if (audible && c.volume > 0) audio.push(part);
      } else if (c.kind === "caption") {
        if (track.kind === "caption" && !track.hidden) captions.push({ content: keyFor(c), source: 0 });
      } else {
        if (visible) video.push({ content: keyFor(c), source: 0 });
      }
    }
  }
  // The renderer composites video layers in stored order and then draws captions.
  // Audio mixing, in contrast, is independent of track order.
  audio.sort((a, b) => a.content < b.content ? -1 : a.content > b.content ? 1 : a.source - b.source);
  return { video, captions, audio };
}

function boundaries(tl: Timeline): number[] {
  const out: number[] = [0, timelineDuration(tl)];
  for (const track of tl.tracks) {
    for (const c of track.clips) {
      const end = clipEnd(c);
      out.push(c.timelineIn, end);
      if (c.kind === "media") {
        for (const f of [c.videoFadeIn, c.audioFadeIn]) if (f > 0) out.push(c.timelineIn + f);
        for (const f of [c.videoFadeOut, c.audioFadeOut]) if (f > 0) out.push(end - f);
      }
      if (c.kind === "caption" && c.words) for (const w of c.words) out.push(w.start, w.end);
    }
  }
  return out;
}

function uniqueSorted(values: number[]): number[] {
  const s = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1]! > 1e-4) out.push(v);
  return out;
}

export interface ChangedSpot {
  /** Where the change is, on the new timeline (zero length for a pure removal). */
  after: TimeRange;
  /** The same place on the old timeline (what was there before). */
  before: TimeRange;
}

/**
 * Spots that look or sound different between two versions, each paired with
 * the matching range on the old version. A cut that only shifts later clips
 * earlier is one spot at the cut point, not "everything after it".
 */
export function changedSpots(before: Timeline, after: Timeline, opts: { gap?: number; fps?: number } = {}): ChangedSpot[] {
  const { gap = 0.5, fps = 30 } = opts;
  const identicalTracks = sameTracks(before, after);
  const sameCanvas = before.background === after.background && stableStringify(before.captionStyle ?? {}) === stableStringify(after.captionStyle ?? {});
  if (identicalTracks && sameCanvas) return [];
  const identity: TimeMap = t => t;
  const toBefore = identicalTracks ? identity : sourceTimeMap(after, before, fps);
  const toAfter = identicalTracks ? identity : sourceTimeMap(before, after, fps);
  const tracksBefore = indexedLayers(before);
  const tracksAfter = indexedLayers(after);
  const durA = timelineDuration(after);
  const durB = timelineDuration(before);
  const mapped = boundaries(before)
    .map((b) => toAfter(b))
    .filter((x): x is number => x !== null);
  const points = uniqueSorted([...boundaries(after), ...mapped]).filter((p) => p <= durA + 1e-4);
  const spots: ChangedSpot[] = [];

  // Segments whose content differs.
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    if (q - p < 1e-4) continue;
    const mid = (p + q) / 2;
    const mb = toBefore(mid);
    if (mb !== null && sameCanvas) {
      const a = signature(tracksAfter, mid);
      const b = signature(tracksBefore, mb);
      if (sameLayers(a.video, b.video, fps) && sameLayers(a.captions, b.captions, fps) && sameLayers(a.audio, b.audio, fps)) continue;
    }
    const bp = toBefore(p, "right") ?? mb;
    const bq = toBefore(q, "left") ?? mb;
    const b0 = bp ?? bq ?? Math.min(mid, durB);
    const b1 = bq ?? bp ?? b0;
    spots.push({ after: { start: p, end: q }, before: { start: Math.min(b0, b1), end: Math.max(b0, b1) } });
  }

  // Jumps: material removed (or reordered) at a cut point.
  for (const b of points) {
    if (b <= 1e-4 || b >= durA - 1e-4) continue;
    const l = toBefore(b, "left");
    const r = toBefore(b, "right");
    if (l !== null && r !== null && !sameFrame(l, r, fps)) {
      spots.push({ after: { start: b, end: b }, before: { start: Math.min(l, r), end: Math.max(l, r) } });
    }
  }
  // Removed from the very start or end.
  const head = toBefore(0, "right");
  if (head !== null && head > 0 && !sameFrame(head, 0, fps)) spots.push({ after: { start: 0, end: 0 }, before: { start: 0, end: head } });
  const tail = durA > 0 ? toBefore(durA, "left") : 0;
  if (tail !== null && durB > tail && !sameFrame(durB, tail, fps) && durA < durB) spots.push({ after: { start: durA, end: durA }, before: { start: tail, end: durB } });

  return mergeSpots(spots, gap);
}

function mergeSpots(spots: ChangedSpot[], gap: number): ChangedSpot[] {
  const sorted = [...spots].sort((x, y) => x.after.start - y.after.start || x.before.start - y.before.start);
  const out: ChangedSpot[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.after.start <= last.after.end + gap) {
      last.after.end = Math.max(last.after.end, s.after.end);
      last.before.start = Math.min(last.before.start, s.before.start);
      last.before.end = Math.max(last.before.end, s.before.end);
    } else {
      out.push({ after: { ...s.after }, before: { ...s.before } });
    }
  }
  return out;
}

export function rangesOverlapWithin(a: TimeRange[], b: TimeRange[], tolerance = 0.25): TimeRange | null {
  for (const x of a) for (const y of b) if (x.start <= y.end + tolerance && y.start <= x.end + tolerance) return x;
  return null;
}

// ---------------------------------------------------------------------------
// Rebasing ops
// ---------------------------------------------------------------------------

export class RebaseConflict extends Error {
  constructor(
    message: string,
    public readonly opIndex?: number,
    public readonly at?: number,
  ) {
    super(message);
    this.name = "RebaseConflict";
  }
}

function findClip(tl: Timeline, id: string): Clip | undefined {
  for (const t of tl.tracks) for (const c of t.clips) if (c.id === id) return c;
  return undefined;
}

/** Re-express one op, written against `from`, for timeline `onto`, using `map` (from → onto). */
export function rebaseOp(op: TimelineOp, map: TimeMap, onto: Timeline, index = 0, fps = 30, from?: Timeline): TimelineOp {
  const need = (t: number, side?: "left" | "right") => {
    const m = map(t, side);
    if (m === null) throw new RebaseConflict(`the moment at ${t.toFixed(2)} s was cut in the current version`, index, t);
    return m;
  };
  const needClip = (id: string) => {
    if (!findClip(onto, id)) throw new RebaseConflict(`clip ${id} no longer exists in the current version`, index);
  };
  // A zero-length range moves with its start, including at an inserted gap.
  const markerEndSide = (end: number, start?: number) => end === start ? "right" : "left";
  const placeClip = (clip: Clip) => {
    const shift = need(clip.timelineIn, "right") - clip.timelineIn;
    const end = clipEnd(clip);
    if (end > clip.timelineIn && !sameFrame(need(end, "left"), end + shift, fps)) {
      throw new RebaseConflict(`the footage under clip ${clip.id} changed since`, index, clip.timelineIn);
    }
    return shiftClip(clip, shift);
  };
  switch (op.op) {
    case "rippleDelete": {
      const start = need(op.start, "right");
      const end = need(op.end, "left");
      if (Math.abs(end - start - (op.end - op.start)) > 1 / fps + 0.01) {
        throw new RebaseConflict(`the part at ${op.start.toFixed(2)}–${op.end.toFixed(2)} s was edited since`, index, op.start);
      }
      return { ...op, start, end };
    }
    case "rippleInsertGap":
      return { ...op, at: need(op.at) };
    case "splitClip":
      needClip(op.clipId);
      return { ...op, at: need(op.at) };
    case "moveClip":
      needClip(op.clipId);
      return { ...op, timelineIn: need(op.timelineIn, "right") };
    case "addClip": {
      if (findClip(onto, op.clip.id)) throw new RebaseConflict(`clip ${op.clip.id} already exists`, index);
      return { ...op, clip: placeClip(op.clip) };
    }
    case "updateClip": {
      needClip(op.clipId);
      const patch = { ...op.patch };
      if (typeof patch.timelineIn === "number") patch.timelineIn = need(patch.timelineIn, "right");
      if (typeof patch.timelineOut === "number") patch.timelineOut = need(patch.timelineOut, "left");
      // Caption word timings are timeline seconds too, so they move with the footage under them.
      if (Array.isArray(patch.words)) {
        patch.words = CaptionWord.array().parse(patch.words).map((w) =>
          ({ ...w, start: need(w.start, "right"), end: need(w.end, markerEndSide(w.end, w.start)) }));
      }
      return { ...op, patch };
    }
    case "removeClip":
      needClip(op.clipId);
      return op;
    case "addMarker": {
      const time = need(op.marker.time, "right");
      const end = op.marker.end !== undefined ? need(op.marker.end, markerEndSide(op.marker.end, op.marker.time)) : undefined;
      return { ...op, marker: { ...op.marker, time, ...(end !== undefined ? { end } : {}) } };
    }
    case "removeMarker":
    case "updateMarker": {
      const current = onto.markers.find(m => m.id === op.markerId);
      if (!current) throw new RebaseConflict(`marker ${op.markerId} no longer exists`, index);
      const original = from?.markers.find(m => m.id === op.markerId);
      if (original) {
        const keys = new Set(Object.keys(op.op === "removeMarker" ? { ...original, ...current } : op.patch) as Array<keyof Marker>);
        if (keys.has("time") || keys.has("end")) { keys.add("time"); keys.add("end"); }
        for (const key of keys) {
          const before = original[key], now = current[key];
          if (before === now) continue;
          if ((key === "time" || key === "end") && typeof before === "number" && typeof now === "number") {
            const moved = map(before, key === "time" ? "right" : markerEndSide(before, original.time));
            if (moved !== null && sameFrame(moved, now, fps)) continue;
          }
          throw new RebaseConflict(`marker ${op.markerId} changed since (${key})`, index);
        }
      }
      if (op.op === "removeMarker") return op;
      const patch = { ...op.patch };
      if (typeof patch.end === "number") patch.end = need(patch.end, markerEndSide(patch.end, patch.time ?? original?.time));
      if (typeof patch.time === "number") patch.time = need(patch.time, "right");
      return { ...op, patch };
    }
    case "addTrack":
      if (onto.tracks.some((t) => t.id === op.track.id)) throw new RebaseConflict(`track ${op.track.id} already exists`, index);
      return { ...op, track: { ...op.track, clips: op.track.clips.map(placeClip) } };
    case "removeTrack":
    case "updateTrack":
      if (!onto.tracks.some((t) => t.id === op.trackId)) throw new RebaseConflict(`track ${op.trackId} no longer exists`, index);
      return op;
    case "setTimeline":
      return op;
  }
}

/**
 * Replay `ops` (written in sequence against `base`) onto `onto`, translating
 * every time through the footage. `include(i)` skips ops; later ops are still
 * translated correctly because each op is mapped from "where the original
 * sequence was" to "where we actually are".
 */
export function replayOps(base: Timeline, ops: TimelineOp[], onto: Timeline, include: (i: number) => boolean = () => true, fps = 30, translatedOps?: TimelineOp[]): Timeline {
  let orig = base;
  let cur = onto;
  ops.forEach((op, i) => {
    const nextOrig = applyOp(orig, op);
    if (include(i)) {
      // makeTimeMap would serialize both track lists again to decide the same thing.
      const tracksSame = stableStringify(orig.tracks) === stableStringify(cur.tracks);
      const same = tracksSame && stableStringify(orig.markers) === stableStringify(cur.markers);
      const translated = same ? op : rebaseOp(op, tracksSame ? (t => t) : sourceTimeMap(orig, cur, fps), cur, i, fps, orig);
      try {
        cur = applyOp(cur, translated);
        translatedOps?.push(translated);
      } catch (e) {
        throw new RebaseConflict(`edit ${i + 1} no longer applies: ${(e as Error).message}`, i);
      }
    }
    orig = nextOrig;
  });
  return cur;
}

function sameRanges(actual: TimeRange[], expected: TimeRange[]): boolean {
  return actual.length === expected.length && actual.every((r, i) =>
    Math.abs(r.start - expected[i]!.start) < 1e-4 && Math.abs(r.end - expected[i]!.end) < 1e-4);
}

/** Check the replay from both directions. It must change only selected footage
 * on the original cut and differ from the full proposal only at skipped spots. */
function replaySelection(base: Timeline, to: Timeline, ops: TimelineOp[], owners: Array<number | null>, spots: ChangedSpot[], keep: Set<number>, fps: number): Timeline | null {
  let timeline: Timeline;
  try {
    const selected = (i: number) => owners[i] === null || keep.has(owners[i]!);
    timeline = (ops.every(isPropertyEdit) || descendingCuts(ops)) ? replayOnCopy(base, ops.filter((_, i) => selected(i))) :
      replayOps(base, ops, base, selected, fps);
  } catch (error) {
    if (error instanceof RebaseConflict || error instanceof OpError || error instanceof ZodError) return null;
    throw error;
  }
  const applied = changedSpots(base, timeline, { fps }).map((s) => s.before);
  const skipped = changedSpots(timeline, to, { fps }).map((s) => s.after);
  return sameRanges(applied, spots.filter((_, i) => keep.has(i)).map((s) => s.before)) &&
    sameRanges(skipped, spots.filter((_, i) => !keep.has(i)).map((s) => s.after)) ? timeline : null;
}

type RippleDelete = Extract<TimelineOp, { op: "rippleDelete" }>;

// A cut at a later time cannot move an earlier, disjoint cut's coordinates.
function descendingCuts(ops: TimelineOp[]): ops is RippleDelete[] {
  let limit = Infinity;
  for (const op of ops) {
    if (op.op !== "rippleDelete" || op.trackIds !== undefined || op.end > limit || op.start >= op.end) return false;
    limit = op.start;
  }
  return true;
}

/** Recognize independent removals on continuous chronological recordings. The saved diff
 * must identify each exact deleted interval and its corresponding join. Other layouts
 * (gapped overlays, repeated footage, fades) still go through the general replay verifier. */
export function independentCutSpots(base: Timeline, ops: TimelineOp[], differences: ChangedSpot[], fps: number) {
  if (ops.length < 2 || ops.length !== differences.length || !descendingCuts(ops)) return;
  const populated = base.tracks.filter(track => track.clips.length);
  if (!populated.some(track => track.kind === "video" && !track.hidden)) return;
  const sources = new Set<string>();
  const duration = timelineDuration(base);
  for (const track of populated) {
    const first = track.clips[0]!;
    if (track.kind === "caption" || first.kind !== "media" || sources.has(first.mediaId)) return;
    sources.add(first.mediaId);
    let end = 0, previousSourceOut = 0;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.mediaId !== first.mediaId || clip.sourceOut <= clip.sourceIn || clip.sourceIn < previousSourceOut ||
          Math.abs(clip.timelineIn - end) > EPS || !clip.enabled || clip.speed !== 1 ||
          clip.effects.length || clip.keyframes?.length || clip.audioFadeIn || clip.audioFadeOut ||
          clip.videoFadeIn || clip.videoFadeOut) return;
      end = clipEnd(clip);
      previousSourceOut = clip.sourceOut;
    }
    if (Math.abs(end - duration) > EPS) return;
  }
  const owners: number[] = [];
  let shift = 0;
  for (let i = 0; i < differences.length; i++) {
    const opIndex = ops.length - 1 - i;
    const op = ops[opIndex]!;
    const { before, after } = differences[i]!;
    const join = op.start - shift;
    if (op.end - op.start < 1 / fps + EPS || op.end > duration || Math.abs(before.start - op.start) > EPS || Math.abs(before.end - op.end) > EPS ||
        Math.abs(after.start - join) > EPS || Math.abs(after.end - join) > EPS ||
        (i > 0 && join - differences[i - 1]!.after.end <= 0.3)) return;
    shift += op.end - op.start;
    owners[opIndex] = i;
  }
  return owners;
}

// These properties can only change the existing clip interval. Each must own one
// distinct, complete interval in the actual before/after diff, in both coordinates.
export function independentClipSpots(base: Timeline, ops: TimelineOp[], spots: TimeRange[], tolerance: number, fps: number, knownDiff?: ChangedSpot[]) {
  if (ops.length !== spots.length || ops.length < 2 || !ops.every(op => op.op === "updateClip")) return;
  const clips = new Map<string, Clip>();
  for (const track of base.tracks) {
    let start = -Infinity;
    for (const clip of track.clips) {
      // Applying a property edit also sorts its track. Use the full replay for unordered legacy tracks.
      if (clip.timelineIn < start || clips.has(clip.id)) return;
      start = clip.timelineIn;
      clips.set(clip.id, clip);
    }
  }
  const owners: number[] = [];
  for (const op of ops) {
    const clip = clips.get(op.clipId);
    if (!clip || !Object.keys(op.patch).every(key => clip.kind === "media" ? key === "volume" || key === "opacity"
      : clip.kind === "caption" && (key === "text" || key === "style"))) return;
    const end = clipEnd(clip);
    const matches = spots.flatMap((spot, i) => clip.timelineIn >= spot.start - tolerance && end <= spot.end + tolerance ? [i] : []);
    const i = matches[0];
    if (matches.length !== 1 || i === undefined || Math.abs(spots[i]!.start - clip.timelineIn) > 1e-9 ||
        Math.abs(spots[i]!.end - end) > 1e-9) return;
    owners.push(i);
  }
  if (new Set(owners).size !== spots.length) return;
  const differences = knownDiff ?? changedSpots(base, replayOnCopy(base, ops), { fps });
  if (sameRanges(differences.map(s => s.after), spots) && sameRanges(differences.map(s => s.before), spots)) return owners;
}

/**
 * Map each operation to one independently selectable spot. A null entry is an
 * operation with no visible footprint. A null result means the spots must be
 * approved together (one edit spans spots, or a footprint cannot be attributed).
 */
export function assignSpots(base: Timeline, ops: TimelineOp[], spots: TimeRange[], tolerance = 0.3, fps = 30): Array<number | null> | null {
  const independent = independentClipSpots(base, ops, spots, tolerance, fps);
  if (independent) return independent;
  const states: Timeline[] = [base];
  for (const op of ops) states.push(applyOp(states[states.length - 1]!, op));
  const final = states[states.length - 1]!;
  const owners: Array<number | null> = [];
  for (let i = 0; i < ops.length; i++) {
    const next = states[i + 1]!;
    const toFinal = makeTimeMap(next, final, fps);
    let owner: number | null = null;
    for (const { after } of changedSpots(states[i]!, next, { gap: 0, fps })) {
      const a = toFinal(after.start, "right");
      const b = toFinal(after.end, "left");
      if (a === null || b === null) return null;
      const matches = spots.flatMap((s, k) =>
        Math.min(a, b) >= s.start - tolerance && Math.max(a, b) <= s.end + tolerance ? [k] : []);
      if (matches.length !== 1 || (owner !== null && owner !== matches[0])) return null;
      owner = matches[0]!;
    }
    owners.push(owner);
  }
  const covered = new Set(owners);
  if (!spots.every((_, i) => covered.has(i))) return null;
  const differences = changedSpots(base, final, { fps });
  if (!sameRanges(differences.map((s) => s.after), spots)) return null;
  // A preceding edit can mask the footprint of a later edit (e.g. removing
  // one caption before hiding its track). Exercise every spot in isolation.
  return spots.every((_, i) => replaySelection(base, final, ops, owners, differences, new Set([i]), fps)) ? owners : null;
}

export function canApproveSpots(base: Timeline, ops: TimelineOp[] | undefined, ranges: TimeRange[], fps = 30): boolean {
  return ranges.length > 1 && !!ops?.length && assignSpots(base, ops, ranges, undefined, fps) !== null;
}

export type ApplyPlan =
  | { kind: "fast-forward"; timeline: Timeline }
  | { kind: "rebased" | "partial"; timeline: Timeline }
  | { kind: "conflict"; reason: string; at?: number; spotsUnsupported?: boolean };

// Properties within a group can depend on one another (e.g. a new caption
// text and its word timings). Timing, source and unknown fields stay structural.
const propertyGroups = new Map<string, string>([
  ["text", "caption"], ["words", "caption"], ["style", "style"],
  ["transform", "transform"], ["keyframes", "transform"], ["color", "color"],
  ["volume", "volume"], ["audioFadeIn", "audioFadeIn"], ["audioFadeOut", "audioFadeOut"],
  ["opacity", "opacity"], ["videoFadeIn", "videoFadeIn"], ["videoFadeOut", "videoFadeOut"],
]);

const roundedTime = (t: number) => Math.round(t / EPS);

/** Compare layers in the target's local time, including the source samples
 * underneath it. Trimming earlier footage can translate the entire window. */
function clipEditContext(tl: Timeline, target: Clip, groups: Set<string>): string {
  const start = target.timelineIn;
  const end = clipEnd(target);
  const layers = tl.tracks.flatMap(({ clips, name: _name, ...track }) => {
    const context = clips.flatMap((clip) => {
      const left = Math.max(start, clip.timelineIn);
      const right = Math.min(end, clipEnd(clip));
      if (right <= left && clip.id !== target.id) return [];
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(clip)) {
        if (["id", "label", "timelineIn", "timelineOut", "sourceIn", "sourceOut"].includes(key)) continue;
        const group = propertyGroups.get(key);
        if (group && (clip.id !== target.id || !groups.has(group))) continue;
        properties[key] = key === "words" && clip.kind === "caption"
          ? clip.words?.map((w) => [w.text, roundedTime(w.start - start), roundedTime(w.end - start)])
          : value;
      }
      const source = clip.kind === "media" ? [roundedTime(srcAt(clip, left)), roundedTime(srcAt(clip, right))] : null;
      return [{ target: clip.id === target.id, left: roundedTime(left - start), right: roundedTime(right - start), source, properties }];
    });
    return context.length ? [{ track, context }] : [];
  });
  return stableStringify([tl.background, tl.captionStyle, layers]);
}

type ClipUpdate = Extract<TimelineOp, { op: "updateClip" }>;

function isPropertyEdit(op: TimelineOp): op is ClipUpdate {
  return op.op === "updateClip" && Object.keys(op.patch).every((key) => propertyGroups.has(key));
}

function mergePropertyEdits(base: Timeline, head: Timeline, edits: ClipUpdate[], fps: number): Timeline {
  let merged = head;
  let map: TimeMap | undefined;
  for (const [i, edit] of edits.entries()) {
    const before = findClip(base, edit.clipId);
    const current = findClip(head, edit.clipId);
    const groups = new Set(Object.keys(edit.patch).map((key) => propertyGroups.get(key)!));
    if (!before || !current || clipEditContext(base, before, groups) !== clipEditContext(head, current, groups)) {
      throw new RebaseConflict(`the properties or footage for clip ${edit.clipId} changed since`, i, before?.timelineIn);
    }
    const shift = current.timelineIn - before.timelineIn;
    if (shift !== 0) {
      map ??= makeTimeMap(base, head, fps);
      const mapped = map(before.timelineIn, "right");
      if (mapped === null || Math.abs(mapped - current.timelineIn) > EPS) {
        throw new RebaseConflict(`clip ${edit.clipId} moved to different footage`, i, before.timelineIn);
      }
    }
    const patch = { ...edit.patch };
    if (shift !== 0 && current.kind === "caption" && Array.isArray(patch.words)) {
      patch.words = CaptionWord.array().parse(patch.words).map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
    }
    try {
      merged = applyOp(merged, { ...edit, patch });
    } catch (error) {
      throw new RebaseConflict(`edit ${i + 1} no longer applies: ${(error as Error).message}`, i);
    }
  }
  return merged;
}

/**
 * Work out how to put an approved change into the current cut.
 *
 * - Cut unchanged and every spot approved: take the change as-is.
 * - Cut moved on: re-apply the change's edits onto it, unless they touch the
 *   same clip properties or depend on footage that changed. Structural edits
 *   use the conservative time-overlap check.
 * - Some spots approved: apply only the edits for those spots.
 */
export function planApply(input: { from: Timeline; to: Timeline; head: Timeline; ops?: TimelineOp[]; spots?: number[]; changeRanges: TimeRange[]; fps?: number },
  verifiedOwners?: Array<number | null> | null): ApplyPlan {
  const { from, to, head, ops, changeRanges, fps = 30 } = input;
  const all = !input.spots || changeRanges.every((_, i) => input.spots!.includes(i));
  const sameBase = head.name === from.name && sameContent(head, from);
  if (sameBase && all) return { kind: "fast-forward", timeline: to };
  if (!ops || !ops.length) {
    return {
      kind: "conflict",
      spotsUnsupported: !all,
      reason: !all
        ? "this edit replaces the whole timeline, so its spots can't be approved individually"
        : "this edit replaces the whole timeline, which now has a newer version",
    };
  }
  const keep = new Set(input.spots);
  const owners = all ? null : verifiedOwners !== undefined ? verifiedOwners : assignSpots(from, ops, changeRanges, undefined, fps);
  const propertyEdits = ops.every(isPropertyEdit) ? ops : undefined;
  // A full property approval only needs to inspect the clips it depends on.
  const differences = all && propertyEdits ? [] : changedSpots(from, to, { fps });
  const selection = owners && replaySelection(from, to, ops, owners, differences, keep, fps);
  if (!all && !selection) {
    return { kind: "conflict", spotsUnsupported: true, reason: "the edits for these spots cannot be applied independently" };
  }
  if (head === from && selection) return { kind: "partial", timeline: selection };
  const mine = differences.filter((_, i) => all || keep.has(i)).map((s) => s.before);
  const include = (i: number) => all || owners![i] === null || keep.has(owners![i]!);
  try {
    let timeline: Timeline;
    if (propertyEdits) {
      timeline = mergePropertyEdits(from, head, propertyEdits.filter((_, i) => include(i)), fps);
    } else {
      const since = changedSpots(from, head, { fps }).map((s) => s.before);
      const hit = rangesOverlapWithin(mine, since);
      if (hit) return { kind: "conflict", reason: `it overlaps with a change approved since (around ${hit.start.toFixed(1)} s)`, at: hit.start };
      timeline = replayOps(from, ops, head, include, fps);
    }
    if (!all) {
      const map = makeTimeMap(from, head, fps);
      const mapped = mine.map((r) => ({ start: map(r.start, "right"), end: map(r.end, "left") }));
      const expected = mapped.filter((r): r is TimeRange => r.start !== null && r.end !== null);
      if (expected.length !== mine.length || !sameRanges(changedSpots(head, timeline, { fps }).map((s) => s.before), expected)) {
        return { kind: "conflict", reason: "the selected edits would affect different footage in the current edit" };
      }
    }
    return { kind: all ? "rebased" : "partial", timeline };
  } catch (e) {
    if (e instanceof RebaseConflict) return { kind: "conflict", reason: e.message, at: e.at };
    throw e;
  }
}

