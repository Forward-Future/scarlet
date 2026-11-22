import type { ThreadEdit } from "@scarlet/shared";
import { makeTimeMap, type Timeline, type TimeRange } from "@scarlet/timeline";
import { verifiedJoinClock } from "./joinClock";
import { removedSince } from "./removedSince";

/**
 * An applied cut plays on the version before its own batch. A cut an earlier batch made near it is already out of that
 * version, so the timeline had nothing to show for it. The version before the earliest of those cuts still has all their
 * footage: the cut opens there, as a call does, and each of them is a gap. `madeAt` orders the edits by when they were saved.
 */
export function cutViewBase(edit: ThreadEdit, edits: readonly ThreadEdit[], madeAt: (edit: ThreadEdit) => number, head?: string): string | undefined {
  const own = edit.beforeCut;
  if (!own) return;
  const at = edit.at ?? edit.range.start;
  // The stretch the card zooms to round the join (`focusAround`), with a little room for what plays past it.
  const reach = Math.max(5, (own.removed.end - own.removed.start) * 0.15) + 2;
  const made = madeAt(edit);
  let base: { version: string; made: number } | undefined;
  for (const e of edits) {
    if (e === edit || !e.beforeCut || e.rejected || e.at === undefined || Math.abs(e.at - at) > reach) continue;
    if (e.beforeCut.version === own.version || e.beforeCut.version === head) continue;
    const when = madeAt(e);
    if (!(when < made)) continue;
    if (!base || when < base.made) base = { version: e.beforeCut.version, made: when };
  }
  return base?.version;
}

/**
 * The cut's footage on `base`, a version before its own (`own`) that differs from it only by footage taken out. None
 * when `base` differs in any other way round the cut, or an earlier cut fell inside this one's footage: the cut then
 * stays on its own version.
 */
export function rebaseCut(own: Timeline, base: Timeline, cut: TimeRange, fps: number): TimeRange | undefined {
  const removals = removedSince(base, own, fps).map(r => r.removed);
  if (!removals.length) return;
  const toBase = makeTimeMap(own, base, fps);
  const start = toBase(cut.start, "right"), end = toBase(cut.end, "left");
  if (start === null || end === null || Math.abs(end - start - (cut.end - cut.start)) > 1 / fps) return;
  const near = removals.filter(r => r.end > start - 30 && r.start < end + 30).flatMap(r => [r.start - 1 / fps, r.end + 1 / fps]);
  const clock = verifiedJoinClock(base, own, removals, fps, [start - 20, start - 5, start - 1 / fps, end + 1 / fps, end + 5, end + 20, ...near]);
  return clock ? { start, end } : undefined;
}
