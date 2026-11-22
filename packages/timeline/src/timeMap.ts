/** Source-anchored time mapping between timeline versions. */
import type { MediaClip, Timeline, TimeRange, Track } from "./schema.js";
import { clipEnd, sourceAt, sourceToTimeline, timelineDuration } from "./time.js";
import { firstIndex, indexBySource, intervalCandidates } from "./intervals.js";
import { sameJson } from "./ids.js";

export const REBASE_EPS = 1e-6;

export const roundedTime = (t: number) => Math.round(t / REBASE_EPS);

// Mapping through different sequences of cuts can put the same source time a few
// ulps either side of a half frame. Use a stable tie only when comparing edits.
export function sameFrame(a: number, b: number, fps: number) {
  return Math.abs(a - b) <= 1e-9 || Math.round(a * fps + 1e-7) === Math.round(b * fps + 1e-7);
}

type Kind = "video" | "audio";
interface Placed {
  track: Track;
  clip: MediaClip;
}

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
  return sameJson(content(a), content(b));
}

export function sameTracks(a: Timeline, b: Timeline): boolean {
  if (a.tracks === b.tracks) return true;
  if (a.tracks.length !== b.tracks.length || a.tracks.some((track, i) => track.clips.length !== b.tracks[i]!.clips.length)) return false;
  return sameJson(a.tracks, b.tracks);
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
    if (at <= last + REBASE_EPS) continue;
    last = at;
    // Nothing plays before the start or after the end, so a trim there runs to the edge of the earlier version.
    const start = at <= REBASE_EPS ? 0 : back(at, "left");
    const end = at >= total - REBASE_EPS ? timelineDuration(before) : back(at, "right");
    if (start !== null && end !== null && end - start > 0.5 / fps) joins.push({ at, removed: { start, end } });
  }
  return joins;
}

export function sourceTimeMap(a: Timeline, b: Timeline, fps: number): TimeMap {
  const halfFrame = 0.5 / fps;
  const kinds: Kind[] = ["video", "audio"];
  const fromClips = kinds.map((k) => mediaOn(a, k));
  const fromAt = fromClips.map(clips => intervalCandidates(clips, x => x.clip.timelineIn - REBASE_EPS, x => clipEnd(x.clip) + REBASE_EPS));
  const toClips = kinds.map(k => indexBySource(mediaOn(b, k), x => x.clip, halfFrame));
  const allFrom = [...fromClips[0]!, ...fromClips[1]!];
  const starts = allFrom.map(x => x.clip.timelineIn).sort((a, b) => a - b);
  const ends = allFrom.map(x => clipEnd(x.clip)).sort((a, b) => a - b);

  const find = (k: number, x: Placed, s: number, t: number, side: "left" | "right"): number | null => {
    let best: { score: number[]; t: number } | null = null;
    for (const y of toClips[k]!.get(x.clip.mediaId)?.(s) ?? []) {
      if (s < y.clip.sourceIn - halfFrame || s > y.clip.sourceOut + halfFrame) continue;
      // A split can put the two sides of the same source frame on opposite
      // sides of a gap. Only a fragment containing the requested side counts.
      if (side === "right" ? s >= y.clip.sourceOut - REBASE_EPS : s <= y.clip.sourceIn + REBASE_EPS) continue;
      const at = sourceToTimeline(y.clip, Math.min(Math.max(s, y.clip.sourceIn), y.clip.sourceOut));
      const inside = s > y.clip.sourceIn + REBASE_EPS && s < y.clip.sourceOut - REBASE_EPS ? 0 : 1;
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
        const inside = side === "left" ? t > s + REBASE_EPS && t <= e + REBASE_EPS : t >= s - REBASE_EPS && t < e - REBASE_EPS;
        if (!inside) continue;
        covered = true;
        const found = find(k, x, sourceAt(x.clip, Math.min(t, e)), t, side);
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
    const prevEnd = ends[firstIndex(ends, end => end > t + REBASE_EPS) - 1];
    if (prevEnd !== undefined) {
      const m = locate(prevEnd, "left").value;
      if (m !== null) return m + (t - prevEnd);
    }
    const nextStart = starts[firstIndex(starts, start => start >= t - REBASE_EPS)];
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
