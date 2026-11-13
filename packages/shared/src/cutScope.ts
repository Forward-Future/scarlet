import { frameAlignedRemoval, makeTimeMap, mergeRanges, removedJoins, timelineDuration, type Timeline, type TimelineOp, type TimeRange } from "@scarlet/timeline";
import type { Task } from "./api.js";

/**
 * The range the editor selected for a request, in the seconds its context gives. A request sent from an applied edit
 * carries where that edit plays (for a cut, its join and a moment either side). That is what the editor had open, not
 * a selection: "take out the sentence before this too" reaches outside it.
 */
export function selectedRange(anchor: Task["context"] | undefined): TimeRange | undefined {
  if (anchor?.time === undefined || anchor.end === undefined) return undefined;
  return anchor.changeId && anchor.editIndex !== undefined ? undefined : { start: anchor.time, end: anchor.end };
}

/** Translate the selected passage or pinned playhead to the version about to be edited. */
export function cutAnchorOn(anchor: Task["context"], timeline: Timeline, original?: Timeline): Task["context"] {
  const saved = anchor.dialogueRange;
  const selected = saved ? { ...anchor, mediaId: undefined, changeId: undefined, time: saved.start, end: saved.end } : anchor;
  if (selected.mediaId || selected.time === undefined || !original || original.version === timeline.version) return selected;
  const map = makeTimeMap(original, timeline);
  const back = makeTimeMap(timeline, original);
  let joins: ReturnType<typeof removedJoins> | undefined;
  const edge = (time: number, side: "left" | "right") => {
    // The same source time can survive in another copy of the clip. Confirm this is the editor's placement.
    for (const direction of [side, side === "left" ? "right" : "left"] as const) {
      const mapped = map(time, direction);
      const returned = mapped === null ? null : back(mapped, direction);
      if (mapped !== null && returned !== null && Math.abs(returned - time) < 1e-6) return mapped;
    }
    // A previous part may have removed the frame at the original edge. That edge now sits at its join.
    joins ??= removedJoins(original, timeline);
    return joins.find(j => j.removed.start <= time && time <= j.removed.end)?.at ?? null;
  };
  const start = edge(selected.time, "right");
  const end = selected.end === undefined ? undefined : edge(selected.end, "left");
  if (start === null || end === null || (end !== undefined && start > end))
    throw new Error("The selected passage changed. Inspect its current location and ask the editor to select it again.");
  return { ...selected, time: start, end };
}

/** All timeline placements of a selection; a source playhead maps to zero-length placements. */
export function selectionPlacements(tl: Timeline, anchor: Task["context"]): TimeRange[] {
  const selected = selectedRange(anchor) ?? (anchor.time === undefined ? undefined : { start: anchor.time, end: anchor.time });
  if (!selected) return [];
  if (!anchor.mediaId) return [selected];
  return tl.tracks.flatMap(track => track.clips).flatMap(clip => {
    if (clip.kind !== "media" || !clip.enabled || clip.mediaId !== anchor.mediaId) return [];
    const at = (t: number) => clip.timelineIn + (t - clip.sourceIn) / clip.speed;
    if (selected.start === selected.end) {
      const pin = selected.start;
      return pin >= clip.sourceIn && pin <= clip.sourceOut ? [{ start: at(pin), end: at(pin) }] : [];
    }
    const start = Math.max(selected.start, clip.sourceIn), end = Math.min(selected.end, clip.sourceOut);
    return end > start ? [{ start: at(start), end: at(end) }] : [];
  });
}

/** Bound timeline removals to the editor's selection, including trimmed or reused source clips. */
export function cutScope(tl: Timeline, anchor: Task["context"] | undefined, requested?: TimeRange, local = false): TimeRange {
  const duration = timelineDuration(tl);
  const selected = selectedRange(anchor);
  if (local && !requested && !(selected && !anchor?.mediaId)) throw new Error("Supply the local timeline range for the pause edit.");
  if (anchor?.mediaId && selected && !requested) throw new Error("Map the selected source range to timeline seconds.");
  const scope = requested ?? selected ?? { start: 0, end: duration };
  if (scope.start < 0 || scope.start >= scope.end || scope.end > duration) throw new Error("Choose a nonempty range inside the timeline.");
  if (!anchor?.mediaId) {
    if (selected && (scope.start < selected.start || scope.end > selected.end)) throw new Error("Stay inside the selected timeline range.");
    if (local && !selected && anchor?.time !== undefined && (anchor.time < scope.start || anchor.time > scope.end))
      throw new Error("The local range must contain the pinned playhead.");
    return scope;
  }
  if (!selected && !(local && anchor.time !== undefined)) return scope;
  const placements = selectionPlacements(tl, anchor);
  if (selected) {
    const placement = mergeRanges(placements).find(p => scope.start >= p.start - 1e-6 && scope.end <= p.end + 1e-6);
    if (placement && placement.end > scope.start && placement.start < scope.end)
      return { start: Math.max(scope.start, placement.start), end: Math.min(scope.end, placement.end) };
  } else if (placements.some(p => scope.start <= p.start && p.start <= scope.end)) return scope;
  throw new Error("Stay within the selected source placement on the timeline.");
}

/** Each synchronized ripple shortens the selected passage for the next one. Check and measure the ranges that will play. */
export function boundedRippleOps(ops: readonly TimelineOp[], scope: TimeRange, fps: number, duration: number) {
  let end = scope.end;
  const runsToEnd = Math.abs(duration - end) < 1e-6;
  return ops.map(op => {
    if (op.op !== "rippleDelete" || op.trackIds || op.start < scope.start || op.end > end + 1e-9 || op.end <= op.start)
      throw new Error("Ripple operations must stay inside the selected timeline range as it shortens.");
    const aligned = frameAlignedRemoval(op, fps, { start: scope.start, end });
    if (runsToEnd && Math.abs(op.end - end) < 1e-9) aligned.end = end;
    end -= aligned.end - aligned.start;
    return { ...op, ...aligned };
  });
}
