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

/**
 * Ripple removals run in order, each written on the edit the ones before it leave as they were asked. Each goes on
 * whole frames on its own, so it takes out a little less (or, under a frame, more) than asked, and everything after
 * it plays that much later than the next removal's times assume. `place` moves a later range by what each earlier
 * removal before it left (asked length less removed length) before it goes on frames; `removed` records each
 * all-track removal as asked and as made. Without this every cut came out about a frame early on the footage for
 * each cut before it: at 30 fps, 10.010–12.020 s took out 10.0333–12.0 s, and the next removal, at 20–21 s,
 * landed 0.0433 s early.
 *
 * A start at an earlier removal's join is the first footage kept after it and moves; an end there is the footage
 * before it and stays.
 */
export function rippleDrift() {
  /** Where each earlier removal joins, on the edit as asked, and how much later than asked everything after it plays. */
  const marks: Array<{ at: number; shift: number }> = [];
  const EPS = 1e-9;
  return {
    place(r: TimeRange): TimeRange {
      let start = r.start, end = r.end;
      for (const m of marks) {
        if (m.at <= r.start + EPS) start += m.shift;
        if (m.at < r.end - EPS) end += m.shift;
      }
      return { start, end };
    },
    removed(asked: TimeRange, removed: TimeRange) {
      const length = asked.end - asked.start;
      // Earlier joins after this removal come nearer by what it was asked to take out; one inside it is at its join.
      for (const m of marks) m.at = m.at >= asked.end ? m.at - length : m.at > asked.start ? asked.start : m.at;
      const shift = length - (removed.end - removed.start);
      if (Math.abs(shift) > EPS) marks.push({ at: asked.start, shift });
    },
  };
}

/** Each synchronized ripple shortens the selected passage for the next one. Check and measure the ranges that will play. */
export function boundedRippleOps(ops: readonly TimelineOp[], scope: TimeRange, fps: number, duration: number) {
  let end = scope.end;
  const runsToEnd = Math.abs(duration - end) < 1e-6;
  const drift = rippleDrift();
  return ops.map(op => {
    if (op.op !== "rippleDelete" || op.trackIds || op.end <= op.start)
      throw new Error("Ripple operations must stay inside the selected timeline range as it shortens.");
    const placed = drift.place(op);
    if (placed.start < scope.start || placed.end > end + 1e-6)
      throw new Error("Ripple operations must stay inside the selected timeline range as it shortens.");
    const aligned = frameAlignedRemoval(placed, fps, { start: scope.start, end });
    if (runsToEnd && Math.abs(placed.end - end) < 1e-6) aligned.end = end;
    drift.removed(op, aligned);
    end -= aligned.end - aligned.start;
    return { ...op, ...aligned };
  });
}
