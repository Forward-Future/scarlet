import { firstIndex, makeTimeMap, timelineDuration, type TimeRange, type Timeline } from "@scarlet/timeline";

/**
 * Plays one version while the timeline shows another. The media is a rendered version with footage removed, so
 * its joins sound exactly as the cut does; the view is the version before, where the timeline shades what came out.
 */
export interface JoinClock {
  /** Media time to view time. A join reads as the moment the footage resumes. */
  toView(t: number): number;
  /** View time to media time. A moment inside removed footage lands on its join. */
  toMedia(t: number): number;
  /** The view's length, which the transport shows. */
  duration: number;
  /** The removed passages, in the view's clock. */
  removed: TimeRange[];
}

const EPS = 1e-6;

/** A clock for a media version that is the view minus `removed`, each range in the view's clock. */
export function joinClock(removed: TimeRange[], duration: number): JoinClock {
  const ranges: TimeRange[] = [];
  for (const r of [...removed].filter(r => r.end - r.start > EPS).sort((a, b) => a.start - b.start)) {
    const last = ranges.at(-1);
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else ranges.push({ start: r.start, end: r.end });
  }
  // A playing clock is sampled every animation frame. Store the cumulative
  // removed time and each join's position on both clocks once per edit.
  const shift = [0], joins: number[] = [], ends: number[] = [];
  for (const range of ranges) {
    const before = shift[shift.length - 1]!;
    joins.push(range.start - before);
    ends.push(range.end - EPS);
    shift.push(before + (range.end - range.start));
  }
  return {
    duration,
    removed: ranges,
    toMedia(t) {
      const i = firstIndex(ends, end => t < end);
      return Math.min(t, ranges[i]?.start ?? t) - shift[i]!;
    },
    toView(t) {
      return t + shift[firstIndex(joins, join => join > t + EPS)]!;
    },
  };
}

/**
 * The clock for playing `media` in place of `view`, when `media` is `view` with exactly `removed` taken out.
 * Checked against the footage itself at `checkAt` (view times), so a version that differs in any other way
 * gets no clock and the caller keeps its own playback.
 */
export function verifiedJoinClock(view: Timeline, media: Timeline, removed: TimeRange[], fps: number, checkAt: number[]): JoinClock | undefined {
  const duration = timelineDuration(view);
  const clock = joinClock(removed, duration);
  const total = clock.removed.reduce((sum, r) => sum + r.end - r.start, 0);
  const tolerance = 0.5 / fps;
  if (!duration || Math.abs(duration - total - timelineDuration(media)) > tolerance) return;
  const map = makeTimeMap(view, media, fps);
  for (const t of checkAt) {
    if (t < 0 || t > duration || clock.removed.some(r => t > r.start - tolerance && t < r.end + tolerance)) continue;
    const at = map(t, "right") ?? map(t, "left");
    if (at === null || Math.abs(at - clock.toMedia(t)) > tolerance) return;
  }
  return clock;
}
