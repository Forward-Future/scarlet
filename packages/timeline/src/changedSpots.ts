/** Content-based diffing between two timeline versions. */
import type { Clip, MediaClip, Timeline, TimeRange, Track } from "./schema.js";
import { clipEnd, JOIN_SLACK, meets, sourceAt, timelineDuration } from "./time.js";
import { intervalCandidates } from "./intervals.js";
import { stableStringify } from "./ids.js";
import { REBASE_EPS, roundedTime, sameFrame, sameTracks, sourceTimeMap, type TimeMap } from "./timeMap.js";

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
interface LayerSample { content: string; source: number; fade?: number[]; transition?: string }

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
    if (left.content !== right.content || left.transition !== right.transition || !sameFrame(left.source, right.source, fps)) return false;
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
        // A transition changes the picture only around its join; `transitionAt` samples it there.
        const { id, timelineIn, sourceIn, sourceOut, label, audioFadeIn, audioFadeOut, videoFadeIn, videoFadeOut, transitionIn, ...rest } = c;
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

/**
 * The transition a clip's picture is in at `t`: its own into it for the first half of that transition, or the next
 * clip's out of it for the half before that clip starts. Elsewhere none, so a transition is a change only at its join.
 */
function transitionAt(candidates: (start: number, end: number) => Clip[], c: Clip, t: number, end: number): string | undefined {
  if (c.kind === "media" && c.transitionIn && t < c.timelineIn + c.transitionIn.duration / 2) return `in|${stableStringify(c.transitionIn)}`;
  // The same join the planner finds (`planTransitions`): footage or a colour can be the picture a transition leaves.
  const next = candidates(end - JOIN_SLACK, end + JOIN_SLACK).find(n => n !== c && n.kind === "media" && n.transitionIn && meets(end, n.timelineIn));
  if (next?.kind === "media" && next.transitionIn && t >= end - next.transitionIn.duration / 2) return `out|${stableStringify(next.transitionIn)}`;
}

function signature(tracks: ReturnType<typeof indexedLayers>, t: number) {
  const video: LayerSample[] = [];
  const captions: LayerSample[] = [];
  const audio: LayerSample[] = [];
  for (const { track, candidates, keyFor } of tracks) {
    const visible = track.kind === "video" && !track.hidden;
    const audible = track.kind !== "caption" && !track.muted;
    for (const c of candidates(t, t + REBASE_EPS)) {
      if (c.enabled === false) continue;
      const end = clipEnd(c);
      if (!(c.timelineIn <= t + REBASE_EPS && t < end - REBASE_EPS)) continue;
      if (c.kind === "media") {
        const part = { content: `${track.id}|m|${c.mediaId}|${keyFor(c)}`, source: sourceAt(c, t), fade: fadeLevels(c, t, end) };
        if (visible) video.push({ ...part, transition: transitionAt(candidates, c, t, end) });
        if (audible && c.volume > 0) audio.push(part);
      } else if (c.kind === "caption") {
        if (track.kind === "caption" && !track.hidden) captions.push({ content: keyFor(c), source: 0 });
      } else {
        if (visible) video.push({ content: keyFor(c), source: 0, transition: transitionAt(candidates, c, t, end) });
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
        // A transition changes the picture either side of its join.
        if (c.transitionIn) out.push(Math.max(0, c.timelineIn - c.transitionIn.duration / 2), c.timelineIn + c.transitionIn.duration / 2);
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
