import { DialogueScanPage, type TaskEvent } from "@scarlet/shared";
import { mergeRanges, type TimeRange } from "@scarlet/timeline";

/**
 * How much of a run's countable work is done: the dialogue read so far, and the suggested cuts with a
 * recommendation. Each counts finished work against a known total, so it shows where the finish line is
 * without guessing how long the agent will take to get there.
 */
export interface RunProgress {
  /** Source seconds of dialogue read, against the seconds the scan covers. */
  read?: { seconds: number; total: number };
  /**
   * Source seconds the cutting has got through, against what the scan covers of the recordings the pass is cutting. A
   * recording that was scanned but never cut, such as a second angle of the same take, isn't part of it: counted, the
   * cut could never finish.
   *
   * `seconds` is as far as the saved parts reach or, where that is further, the joins checked ahead of the next save:
   * the agent checks a part's joins minutes before it saves the part, and a figure that waited for the save sat at
   * nothing all that time. `saved` is the saved parts alone, absent until the first is in: the cut is done, and its
   * flagged cuts are all known, only once they reach the end.
   */
  cut?: { seconds: number; total: number; saved?: number };
  /**
   * Suggested cuts the agent has looked at or recommended, against all the cuts in the latest review. Recommendations
   * are often saved in one batch at the end, so a cut counts from the moment it's inspected.
   *
   * `share` is how much of all the checking that is: the counted share, scaled by how far the saved parts reach, since
   * the parts still to come bring cuts of their own. It never moves back while the cut stays as long: a recording that
   * joins the cut makes the job longer, and what is checked a smaller share of it.
   */
  cuts?: { checked: number; total: number; share: number };
  /** When each figure last moved, in ms, from the events' own times. The bar keeps moving from there. */
  at?: { read?: number; cut?: number; cuts?: number };
  /** When each stage's first figure arrived, in ms: with `at`, how long one unit of its work takes. */
  since?: { cut?: number; cuts?: number };
  /** Recordings the run reads or waits on a transcript for. Their transcripts come before the read. */
  recordings?: string[];
}

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function runProgress(events: readonly TaskEvent[]): RunProgress {
  const scans = new Map<string, { mediaId: string; start: number; end: number; ranges: TimeRange[] }>();
  // A pass saved in parts stages a new review for each part, carrying earlier recommendations into it.
  // The review introduced last is the current one.
  const reviews = new Map<string, { checked: number; total: number }>();
  let current: string | undefined;
  const recordings = new Set<string>();
  // How far into each recording the saved cuts reach, and the joins checked ahead of a save.
  const saved = new Map<string, number>();
  const checked = new Map<string, number>();
  const at: NonNullable<RunProgress["at"]> = {};
  const since: NonNullable<RunProgress["since"]> = {};
  // What the scans cover of each recording and how much of that is read. A recording read again over part of its
  // range is one recording, counted once.
  let coverage: Map<string, { spans: TimeRange[]; read: TimeRange[] }> | undefined;
  const covered = () => {
    if (coverage) return coverage;
    const all = new Map<string, { spans: TimeRange[]; read: TimeRange[] }>();
    for (const scan of scans.values()) {
      const entry = all.get(scan.mediaId) ?? { spans: [], read: [] };
      entry.spans.push({ start: scan.start, end: scan.end });
      for (const r of scan.ranges) {
        const start = Math.max(r.start, scan.start), end = Math.min(r.end, scan.end);
        if (end > start) entry.read.push({ start, end });
      }
      all.set(scan.mediaId, entry);
    }
    for (const entry of all.values()) {
      entry.spans = mergeRanges(entry.spans);
      entry.read = mergeRanges(entry.read);
    }
    coverage = all;
    return all;
  };
  const length = (ranges: readonly TimeRange[]) => ranges.reduce((sum, r) => sum + r.end - r.start, 0);
  // `upTo` is how far the saved parts reached at an earlier moment, to measure those parts against the cut as it is now.
  const reach = (upTo: ReadonlyMap<string, number> = saved) => {
    let through = 0, kept = 0, total = 0, parts = false;
    for (const [mediaId, { spans }] of covered()) {
      const to = upTo.get(mediaId), looked = checked.get(mediaId);
      if (!saved.has(mediaId) && looked === undefined) continue;
      total += length(spans);
      const within = (at: number) => spans.reduce((sum, span) => sum + Math.max(0, Math.min(span.end, at) - span.start), 0);
      if (to !== undefined) { parts = true; kept += within(to); }
      through += within(Math.max(to ?? 0, looked ?? 0));
    }
    return { through: Math.min(total, through), saved: parts ? Math.min(total, kept) : undefined, total };
  };
  // What is checked is never taken back. With no part saved it is a share of the review alone. Counted where a part is
  // saved, it is held as a share of the footage saved by then, with how far into each recording that was, and not as a
  // share of the cut as long as it was: a recording that joins the cut later makes the job longer, and what was checked
  // a smaller share of it.
  let checkedShare = 0, held: { share: number; saved: Map<string, number> } | undefined;
  // What the held count comes to of the cut as it is now.
  const heldShare = () => {
    if (!held) return 0;
    const { saved: kept, total } = reach(held.saved);
    return kept ? held.share * (kept / total) : 0;
  };
  const countChecked = () => {
    const review = current ? reviews.get(current) : undefined;
    if (!review) return;
    const share = review.checked / review.total;
    // Only saved parts have staged their cuts: joins checked ahead of a save bring none yet.
    const { saved: kept, total } = reach();
    if (kept === undefined || !total) checkedShare = Math.max(checkedShare, share);
    else if (share * (kept / total) > heldShare()) held = { share, saved: new Map(saved) };
  };
  for (const event of events) {
    if (event.type !== "log" || !event.data) continue;
    const when = Date.parse(event.at ?? "") || undefined;
    if (event.data.kind === "media_wait" && event.data.wait === "transcript" && typeof event.data.mediaId === "string") {
      recordings.add(event.data.mediaId);
    } else if (event.data.kind === "editor_progress" && event.data.scanPage) {
      const parsed = DialogueScanPage.safeParse(event.data.scanPage);
      if (!parsed.success) continue;
      const page = parsed.data;
      recordings.add(page.mediaId);
      const key = JSON.stringify([page.mediaId, page.end]);
      coverage = undefined;
      const scan = scans.get(key) ?? { mediaId: page.mediaId, start: page.from, end: page.end, ranges: [] };
      scans.set(key, scan);
      scan.start = Math.min(scan.start, page.from);
      if (page.to !== undefined) {
        scan.ranges = mergeRanges([...scan.ranges, { start: page.from, end: page.to }]);
        if (when) at.read = when;
      }
    } else if (event.data.kind === "pass_progress" && typeof event.data.mediaId === "string") {
      const through = event.data.through;
      if (typeof through !== "number" || !Number.isFinite(through) || through < 0) continue;
      // A later part never reaches less far than an earlier one.
      if (through > (saved.get(event.data.mediaId) ?? -1)) {
        saved.set(event.data.mediaId, through);
        if (when) { at.cut = when; since.cut ??= when; }
        // The checking isn't counted here. The review on hand is the part before's and says nothing of the cuts this
        // part flagged: against the new reach, a first part fully checked read as all the checking done. This part's
        // own review reports next.
      }
    } else if (event.data.kind === "join_progress" && typeof event.data.mediaId === "string") {
      const through = event.data.through;
      if (typeof through !== "number" || !Number.isFinite(through) || through < 0) continue;
      if (through > (checked.get(event.data.mediaId) ?? -1)) {
        checked.set(event.data.mediaId, through);
        // The figure moves only where the checked joins are ahead of the saved parts.
        if (when && through > (saved.get(event.data.mediaId) ?? -1)) { at.cut = when; since.cut ??= when; }
      }
    } else if (event.data.kind === "cut_progress" && typeof event.data.changeId === "string") {
      const checked = count(event.data.checked), total = count(event.data.total);
      if (checked === undefined || !total) continue;
      const previous = reviews.get(event.data.changeId);
      if (!previous) current = event.data.changeId;
      // The staging notice and a save can land in either order. Recommendations are never taken back.
      const reached = Math.min(total, Math.max(checked, count(event.data.looked) ?? 0, previous?.checked ?? 0));
      if (when && (!previous || reached > previous.checked)) at.cuts = when;
      if (when) since.cuts ??= when;
      reviews.set(event.data.changeId, { checked: reached, total });
      countChecked();
    }
  }
  const progress: RunProgress = {};
  if (scans.size) {
    let seconds = 0, total = 0;
    for (const { spans, read } of covered().values()) {
      total += length(spans);
      seconds += length(read);
    }
    if (total > 0) progress.read = { seconds: Math.min(total, seconds), total };
    const cut = reach();
    if (cut.total > 0) progress.cut = { seconds: cut.through, total: cut.total, ...(cut.saved !== undefined && { saved: cut.saved }) };
  }
  const review = current ? reviews.get(current) : undefined;
  if (review) progress.cuts = { ...review, share: Math.min(1, Math.max(checkedShare, heldShare())) };
  if (recordings.size) progress.recordings = [...recordings];
  if (Object.keys(at).length) progress.at = at;
  if (Object.keys(since).length) progress.since = since;
  return progress;
}
