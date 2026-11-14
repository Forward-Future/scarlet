import { CUT_LEAD_SECONDS, CUT_TAIL_SECONDS, mergeRanges, type TimeRange, type Timeline } from "@scarlet/timeline";
import type { Audition } from "./player";
import { verifiedJoinClock } from "./joinClock";

export { isolatedReviewCut } from "@scarlet/timeline";
/** Removals longer than this play only their edges. */
const LONG_CUT = 10;

/**
 * What to play for one cut, on the uncut video.
 * After: the lead-in, then straight on from where the footage resumes, as the join will sound. `others` are cuts
 * that already came out nearby, stepped over too.
 * Before: the passage with its context. A long staged cut plays only its opening and closing seconds unless `whole`:
 * an applied cut plays all of it, since its shaded passage on the timeline lets the editor click ahead.
 */
export function cutAudition(cut: TimeRange, side: "before" | "after", duration: number,
  { others = [], whole = false, tailFrom, merged, beyond = false }: { others?: TimeRange[]; whole?: boolean; tailFrom?: number; merged?: Iterable<TimeRange>; beyond?: boolean } = {}): Audition {
  const at = (t: number) => Math.max(0, Math.min(duration, t));
  const start = at(cut.start - CUT_LEAD_SECONDS);
  if (side === "after") {
    const resume = Math.max(cut.end, tailFrom ?? cut.end);
    let end = at(resume + CUT_TAIL_SECONDS);
    const skips: Audition["skips"] = [];
    // What came out either side of the listen. The listen never reaches it, but an editor who plays on does.
    const later: TimeRange[] = [];
    let past = false;
    // Each removal in the tail moves the stopping point forward and may bring another removal into earshot.
    // An indexed pass supplies its already-merged ranges starting at the first overlap.
    for (const range of merged ?? mergeRanges([cut, ...others])) {
      if (past) { later.push(range); continue; }
      if (range.start >= end - 1e-6) {
        // Fractional frame times can put an exact stop a few ulps beyond the next join.
        end = Math.min(end, range.start);
        if (!beyond) break;
        past = true;
        later.push(range);
        continue;
      }
      if (range.end <= start) {
        if (beyond) later.push(range);
        continue;
      }
      skips.push({ ...range, removed: true });
      end = at(end + Math.max(0, range.end - Math.max(resume, range.start)));
    }
    return later.length ? { start, end, skips, beyond: later } : { start, end, skips };
  }
  const end = at(Math.max(cut.end + CUT_LEAD_SECONDS, tailFrom === undefined ? 0 : tailFrom + CUT_TAIL_SECONDS));
  return { start, end, skips: !whole && cut.end - cut.start > LONG_CUT ? [{ start: cut.start + CUT_TAIL_SECONDS, end: cut.end - CUT_TAIL_SECONDS }] : [] };
}

/** The edited file can play the audition only if its joins account for every passage the player skips. */
export function cutAuditionClock(before: Timeline, after: Timeline, removed: TimeRange[], fps: number, cut: TimeRange, listen: Audition) {
  const clock = verifiedJoinClock(before, after, removed, fps, [listen.start, cut.start, cut.end, listen.end]);
  return clock && listen.skips.every(skip => clock.removed.some(r => r.start <= skip.start + 1e-6 && r.end >= skip.end - 1e-6)) ? clock : undefined;
}
