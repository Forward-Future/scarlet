import { clipEnd, intervalCandidates, mergeRanges, timelineToSource, type MediaClip, type Timeline, type TimelineOp, type TimeRange } from "@scarlet/timeline";

const epsilon = 1e-9;

/** Parts of a range left uncovered by sorted, nonoverlapping intervals. */
function uncovered(range: TimeRange, covered: readonly TimeRange[]): TimeRange[] {
  const missing: TimeRange[] = [];
  let at = range.start;
  for (const part of covered) {
    if (part.start >= range.end || at >= range.end) break;
    if (part.end <= at) continue;
    if (part.start > at + epsilon) missing.push({ start: at, end: part.start });
    at = Math.max(at, part.end);
  }
  if (at < range.end - epsilon) missing.push({ start: at, end: range.end });
  return missing;
}

/** Ripples can also remove empty time or generated picture. Each track has its own selection clock
 * after a track-specific ripple. Marker, clip and track property edits leave that clock in place. */
export function rippleOutsideSelection(before: Timeline, ops: readonly TimelineOp[], allowed: TimeRange[]): TimeRange | undefined {
  const clocks = new Map(before.tracks.map(t => [t.id, allowed]));
  for (const op of ops) {
    if (op.op === "addTrack") clocks.set(op.track.id, allowed);
    if (op.op === "removeTrack") clocks.delete(op.trackId);
    if (op.op !== "rippleDelete" && op.op !== "rippleInsertGap") continue;
    for (const id of op.trackIds ?? clocks.keys()) {
      const ranges = clocks.get(id);
      if (!ranges) continue;
      if (op.op === "rippleDelete") {
        if (!ranges.some(r => r.start <= op.start + epsilon && op.end <= r.end + epsilon)) return op;
        const shift = (t: number) => t <= op.start ? t : t - (op.end - op.start);
        clocks.set(id, ranges.map(r => ({ start: shift(r.start), end: shift(r.end) })));
      } else {
        clocks.set(id, ranges.map(r => ({
          start: r.start >= op.at ? r.start + op.duration : r.start,
          end: r.start >= op.at || r.end > op.at ? r.end + op.duration : r.end,
        })));
      }
    }
  }
}

const mediaClips = (timeline: Timeline) => timeline.tracks.flatMap(track => track.clips
  .filter((c): c is MediaClip => c.kind === "media" && c.enabled).map(clip => ({ clip, track: track.id })));
const sourceRange = (c: MediaClip) => ({ start: c.sourceIn, end: c.sourceOut });

const location = (track: string, mediaId: string) => JSON.stringify([track, mediaId]);

function bySource(placements: ReturnType<typeof mediaClips>) {
  const byRecording = new Map<string, MediaClip[]>();
  for (const { track, clip } of placements) {
    const key = location(track, clip.mediaId);
    const group = byRecording.get(key);
    if (group) group.push(clip);
    else byRecording.set(key, [clip]);
  }
  return new Map([...byRecording].map(([key, clips]) => [key, intervalCandidates(clips, c => c.sourceIn, c => c.sourceOut)]));
}

/** A generic edit may trim or replace clips directly. Account for the source of each protected piece
 * on the input timeline, including multiple uses of the same recording. A split carries a new clip id. */
export function removalOutsideSelection(before: Timeline, after: Timeline, allowed: readonly TimeRange[]): TimeRange | undefined {
  const selected = mergeRanges([...allowed]);
  const old = mediaClips(before), next = mediaClips(after);
  const ids = new Set(old.map(({ clip }) => clip.id));
  const byId = new Map(next.map(({ clip }) => [clip.id, clip]));
  const originals = bySource(old);
  const index = bySource(next.filter(({ clip }) => !ids.has(clip.id)));
  // Each fresh fragment can account for its source once, even if two original clips played identical words.
  const used = new Map<string, TimeRange[]>();
  for (const { track, clip } of old) {
    const survivor = byId.get(clip.id);
    const sameSource = survivor?.mediaId === clip.mediaId;
    if (sameSource && survivor.sourceIn <= clip.sourceIn && survivor.sourceOut >= clip.sourceOut) continue;
    const at = (t: number) => clip.timelineIn + (t - clip.sourceIn) / clip.speed;
    for (const protectedPart of uncovered({ start: clip.timelineIn, end: clipEnd(clip) }, selected)) {
      const needed = { start: timelineToSource(clip, protectedPart.start), end: timelineToSource(clip, protectedPart.end) };
      let missing = uncovered(needed, sameSource ? [sourceRange(survivor)] : []);
      if (!missing.length) continue;
      const possibleShift = selected.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, protectedPart.start) - r.start), 0);
      const key = location(track, clip.mediaId);
      const repeated = originals.get(key)!(needed.start, needed.end).some(other => other.id !== clip.id &&
        other.sourceIn < needed.end - epsilon && other.sourceOut > needed.start + epsilon);
      for (const fragment of index.get(key)?.(needed.start, needed.end) ?? []) {
        const claimed = used.get(fragment.id) ?? [];
        const available = uncovered(sourceRange(fragment), claimed);
        const rest: TimeRange[] = [];
        for (const part of missing) {
          const plays = fragment.timelineIn + (part.start - fragment.sourceIn) / fragment.speed;
          // A protected piece split by a ripple can move left by at most the selected time removed ahead of it.
          // Its copy elsewhere in the source cannot stand in for it.
          if (repeated && (plays < at(part.start) - possibleShift - epsilon || plays > at(part.start) + epsilon)) { rest.push(part); continue; }
          for (const span of available) {
            const start = Math.max(part.start, span.start), end = Math.min(part.end, span.end);
            if (end > start) claimed.push({ start, end });
          }
          rest.push(...uncovered(part, available));
        }
        used.set(fragment.id, mergeRanges(claimed));
        missing = rest;
        if (!missing.length) break;
      }
      if (missing.length) return { start: at(missing[0]!.start), end: at(missing[0]!.end) };
    }
  }
}
