import { mergeRanges, rangesOverlap, type Timeline, type TimeRange } from "@scarlet/timeline";
import { Lanes } from "./review-prep.js";
import { sourceRangeToTimeline } from "./timeline-perception.js";

export const FIRST_CUT_BATCH_SIZE = 12;
const PAGES_PER_BATCH = 2;

/** Pages actually delivered to the model on one recording, independent of background detector progress. */
export class DialogueScanBatch {
  // Concurrent page requests share the same budget. Different recordings can still be read in parallel.
  readonly reads = new Lanes(1);
  private seen: TimeRange[] = [];
  private pending: TimeRange[] = [];
  private pages = 0;

  private unread(from: number, to: number) {
    const gaps: TimeRange[] = [];
    for (const range of this.seen) {
      if (range.start >= to) break;
      if (from < range.start) gaps.push({ start: from, end: range.start });
      from = Math.max(from, range.end);
    }
    if (from < to) gaps.push({ start: from, end: to });
    return gaps;
  }

  delivered(from: number, to: number) {
    const added = this.unread(from, to);
    if (!added.length) return;
    this.seen = mergeRanges([...this.seen, ...added]);
    this.pending.push(...added);
    this.pages++;
  }

  get checkpoint() {
    if (this.pages < PAGES_PER_BATCH) return;
    const through = Math.max(...this.pending.map(r => r.end));
    return { through, next: `Save the settled cuts in this section with dialogue_apply_cuts so the editor can review them now. Continue editing on its continueFrom version. If nothing is ready to save, pass noCutsReadyThrough: ${through} on your next dialogue_scan. You can leave a retake open for more context.` };
  }

  isNewPage(from: number, to: number) {
    return this.unread(from, to).length > 0;
  }

  needsSave(from: number, to: number) {
    return this.pages >= PAGES_PER_BATCH && this.isNewPage(from, to);
  }

  startRead(from: number, to: number, noCutsReadyThrough?: number) {
    const checkpoint = this.checkpoint;
    if (!checkpoint || !this.isNewPage(from, to)) return;
    if (noCutsReadyThrough !== checkpoint.through) throw new Error(checkpoint.next);
    this.closeSection();
  }

  saved(timeline: Timeline, mediaId: string, decisions: readonly TimeRange[]) {
    const touchesSection = this.pending.some(range =>
      sourceRangeToTimeline(timeline, mediaId, range.start, range.end).placed.some(placement =>
        decisions.some(decision => rangesOverlap(placement, decision))));
    if (touchesSection) this.closeSection();
  }

  private closeSection() {
    this.pending = [];
    this.pages = 0;
  }
}
