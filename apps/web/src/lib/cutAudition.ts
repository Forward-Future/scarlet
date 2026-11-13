import { mergeRanges, type CutReview, type TimeRange, type Timeline } from "@scarlet/timeline";
import type { Audition } from "./player";
import { verifiedJoinClock } from "./joinClock";

/** Seconds of context before a cut, and after it once the footage resumes. */
const LEAD = 2;
const CUT_TAIL = 3;
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
  { others = [], whole = false, tailFrom }: { others?: TimeRange[]; whole?: boolean; tailFrom?: number } = {}): Audition {
  const at = (t: number) => Math.max(0, Math.min(duration, t));
  const start = at(cut.start - LEAD);
  if (side === "after") {
    const resume = Math.max(cut.end, tailFrom ?? cut.end);
    let end = at(resume + CUT_TAIL);
    const skips: Audition["skips"] = [];
    // Each removal in the tail moves the stopping point forward and may bring another removal into earshot.
    for (const range of mergeRanges([cut, ...others])) {
      if (range.start >= end - 1e-6) {
        // Fractional frame times can put an exact stop a few ulps beyond the next join.
        end = Math.min(end, range.start);
        break;
      }
      if (range.end <= start) continue;
      skips.push({ ...range, removed: true });
      end = at(end + Math.max(0, range.end - Math.max(resume, range.start)));
    }
    return { start, end, skips };
  }
  const end = at(Math.max(cut.end + LEAD, tailFrom === undefined ? 0 : tailFrom + CUT_TAIL));
  return { start, end, skips: !whole && cut.end - cut.start > LONG_CUT ? [{ start: cut.start + CUT_TAIL, end: cut.end - CUT_TAIL }] : [] };
}

/** A proposed pass can play this call's After only if it leaves the surrounding dialogue in place. */
export function isolatedReviewCut(review: CutReview, cut: TimeRange, listen: TimeRange) {
  return review.cuts.every(({ removed }) => (Math.abs(removed.start - cut.start) < 1e-6 && Math.abs(removed.end - cut.end) < 1e-6)
    || removed.end <= listen.start || removed.start >= listen.end);
}

/** The edited file can play the audition only if its joins account for every passage the player skips. */
export function cutAuditionClock(before: Timeline, after: Timeline, removed: TimeRange[], fps: number, cut: TimeRange, listen: Audition) {
  const clock = verifiedJoinClock(before, after, removed, fps, [listen.start, cut.start, cut.end, listen.end]);
  return clock && listen.skips.every(skip => clock.removed.some(r => r.start <= skip.start + 1e-6 && r.end >= skip.end - 1e-6)) ? clock : undefined;
}
