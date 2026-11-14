import { clipEnd, makeTimeMap, timelineDuration, type TimeRange, type Timeline } from "@scarlet/timeline";

export interface Removal {
  /** The footage that came out, in the clock of the earlier version. */
  removed: TimeRange;
  /** Where it joins in the later version. */
  at: number;
}

/**
 * The footage `before` has that `now` doesn't, wherever `now` jumps over it, each passage in `before`'s clock with its
 * join on `now`. Footage `now` added or holds in another order isn't counted.
 */
export function removedSince(before: Timeline, now: Timeline, fps: number): Removal[] {
  const toBefore = makeTimeMap(now, before, fps);
  const end = timelineDuration(now), beforeEnd = timelineDuration(before);
  const points = new Set([0, end]);
  for (const track of now.tracks) for (const clip of track.clips) {
    if (clip.kind === "media" && clip.enabled !== false) { points.add(clip.timelineIn); points.add(clipEnd(clip)); }
  }
  const out: Removal[] = [];
  for (const at of [...points].sort((a, b) => a - b)) {
    if (at < 0 || at > end + 1e-6) continue;
    const from = at <= 1e-6 ? 0 : toBefore(at, "left");
    const to = at >= end - 1e-6 ? beforeEnd : toBefore(at, "right");
    if (from === null || to === null || to - from < 0.5 / fps) continue;
    const last = out.at(-1);
    if (last && from <= last.removed.end + 1e-6 && to >= last.removed.start - 1e-6) {
      last.removed = { start: Math.min(last.removed.start, from), end: Math.max(last.removed.end, to) };
    } else out.push({ removed: { start: from, end: to }, at });
  }
  return out;
}

/** What is left of each removal once the passages already shown are taken out, leaving out slivers under a few frames. */
export function besides(removals: Removal[], shown: TimeRange[], fps: number): Removal[] {
  const out: Removal[] = [];
  for (const { removed, at } of removals) {
    let pieces: TimeRange[] = [removed];
    for (const s of shown) pieces = pieces.flatMap(p => s.end <= p.start || s.start >= p.end ? [p]
      : [{ start: p.start, end: s.start }, { start: s.end, end: p.end }].filter(q => q.end > q.start));
    for (const piece of pieces) if (piece.end - piece.start >= 3 / fps) out.push({ removed: piece, at });
  }
  return out;
}
