import { changeRemovals, type EditRef } from "@scarlet/shared";
import { clipEnd, firstIndex, intervalCandidates, makeTimeMap, removedJoins, timelineDuration, type Change, type Timeline, type TimeRange } from "@scarlet/timeline";
import { cutAuditionClock } from "./cutAudition";
import { joinClock, type JoinClock } from "./joinClock";
import type { Audition } from "./player";

interface AppliedCutSource { version: string; removed?: TimeRange[] }
const sources = new WeakMap<Change, AppliedCutSource>();

/** A revised row keeps its original identity. Its latest saved change owns the current Before and After. */
export function cutChange(edit: EditRef & { previous: EditRef[] }, changes: readonly Change[]) {
  return changes.find(change => change.id === edit.changeId) ?? changes.find(change => edit.previous.some(ref => ref.changeId === change.id));
}

/** Prefer the version the editor applied. An older rebased pass can still name the original proposal in its steps. */
export function appliedCutSource(change: Change) {
  let source = sources.get(change);
  if (!source) {
    const saved = changeRemovals(change);
    const version = change.appliedVersion ?? change.toVersion;
    source = { version, removed: saved?.version === version ? saved.removed : undefined };
    sources.set(change, source);
  }
  return source;
}

const edgesOf = (timeline: Timeline) => [...new Set([0, timelineDuration(timeline), ...timeline.tracks.flatMap(track =>
  track.clips.flatMap(clip => clip.kind === "media" ? [clip.timelineIn, clipEnd(clip)] : []))])].sort((a, b) => a - b);

function compareVersions(before: Timeline, after: Timeline, fps: number) {
  const duration = timelineDuration(before);
  const mediaDuration = timelineDuration(after);
  const omissions = removedJoins(before, after, fps);
  const removed = omissions.map(join => join.removed);
  const collapsed = joinClock(removed, duration);
  const toAfter = makeTimeMap(before, after, fps);
  const toBefore = makeTimeMap(after, before, fps);
  const bySource = intervalCandidates(omissions, join => join.removed.start, join => join.removed.end);
  const joins = omissions.map(j => j.at);
  // A mixed save may restore unrelated footage as well as making this cut. Use actual source placement
  // outside deletions; a seek into a deletion lands on its real join in the applied version.
  const clock: JoinClock = { duration, removed,
    toMedia(time) {
      const deleted = bySource(time).find(j => time < j.removed.end);
      if (deleted) return deleted.at;
      return toAfter(time, "right") ?? toAfter(time, "left") ?? Math.min(mediaDuration, collapsed.toMedia(time));
    },
    toView(time) {
      const index = firstIndex(joins, join => join >= time - 1e-6);
      if (index < joins.length && Math.abs(joins[index]! - time) <= 1e-6) return omissions[index]!.removed.end;
      return toBefore(time, "right") ?? toBefore(time, "left") ?? Math.min(duration, collapsed.toView(time));
    },
  };
  return { after, fps, clock, collapsed, overlaps: bySource, toBefore, toAfter, mediaDuration, viewEdges: edgesOf(before), mediaEdges: edgesOf(after) };
}
const comparisons = new WeakMap<Timeline, ReturnType<typeof compareVersions>>();

/** Check both versions' clip boundaries throughout the listen. An insert, reorder or speed change inside it
 * must not masquerade as the selected join just because the two ends line up. */
export function appliedCutClock(before: Timeline, after: Timeline, saved: TimeRange[] | undefined, fps: number, cut: TimeRange, listen: Audition) {
  if (saved) return cutAuditionClock(before, after, saved, fps, cut, listen);
  let pair = comparisons.get(before);
  if (!pair || pair.after !== after || pair.fps !== fps) {
    pair = compareVersions(before, after, fps);
    comparisons.set(before, pair);
  }
  const { clock, collapsed, toAfter, toBefore, viewEdges, mediaEdges, mediaDuration } = pair;
  const tolerance = 0.5 / fps, same = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const heard = listen.skips.filter(r => r.removed);
  const present = pair.overlaps(listen.start, listen.end).map(join => join.removed).filter(r => r.end > listen.start && r.start < listen.end);
  // The edit must close every gap the listen requests without swallowing any additional retained footage.
  const covers = (outer: TimeRange, inner: TimeRange) => outer.start <= inner.start + tolerance && outer.end >= inner.end - tolerance;
  if (!present.some(r => covers(r, cut)) || !heard.every(s => present.some(r => covers(r, s))) ||
      !present.every(r => heard.some(s => covers(s, { start: Math.max(r.start, listen.start), end: Math.min(r.end, listen.end) })))) return;
  const start = clock.toMedia(listen.start), end = clock.toMedia(listen.end);
  const offset = start - collapsed.toMedia(listen.start);
  if (start < 0 || end > mediaDuration + tolerance || !same(end, collapsed.toMedia(listen.end) + offset)) return;
  // The mapping is linear between media boundaries. Probe each kept interval and both sides of its seams.
  const points = new Set([listen.start, listen.end, ...present.flatMap(r =>
    [Math.max(listen.start, r.start), Math.min(listen.end, r.end)])]);
  function addEdges(edges: number[], from: number, to: number, viewTime: (t: number) => number) {
    for (let i = firstIndex(edges, edge => edge > from); i < edges.length && edges[i]! < to; i++) {
      const t = viewTime(edges[i]!);
      if (t > listen.start && t < listen.end) points.add(t);
    }
  }
  addEdges(viewEdges, listen.start, listen.end, t => t);
  addEdges(mediaEdges, start, end, t => collapsed.toView(t - offset));
  const sorted = [...points].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!, b = sorted[i]!;
    const inset = Math.min((b - a) / 4, tolerance / 4);
    for (const t of [a + inset, b - inset]) {
      if (present.some(r => t >= r.start && t < r.end)) continue;
      const media = collapsed.toMedia(t) + offset;
      const actual = toAfter(t), back = toBefore(media);
      if (actual === null || back === null || !same(actual, media) || !same(back, t)) return;
    }
  }
  return clock;
}
