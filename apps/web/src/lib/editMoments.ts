import type { EditRef } from "@scarlet/shared";
import { CUT_LEAD_SECONDS, CUT_TAIL_SECONDS, type TimeRange } from "@scarlet/timeline";

export const editKey = (ref: EditRef) => `${ref.changeId}/${ref.spot}`;

/** What placing an edit in a moment needs to know of it. */
export interface MomentEdit {
  changeId: string;
  spot: number;
  range: TimeRange;
  at?: number;
  beforeCut?: { removed: TimeRange };
  check?: string;
  marker?: unknown;
  label?: string;
}

/**
 * A moment of a request's list: edits that change the same stretch of the video, such as a cut and the zoom and
 * reframe that begin on its join. `edits` leads with `main`, the edit the moment's row and card are
 * named for; `members` are the same edits in the order they come in the video.
 */
export interface Moment<T extends MomentEdit> { key: string; main: T; edits: T[]; members: T[]; start: number; end: number }

/** Where an edit plays in the video as it runs now. A cut is its join, a point. */
export function editStretch(edit: MomentEdit): TimeRange {
  if (edit.at !== undefined) return { start: edit.at, end: edit.at };
  return edit.beforeCut ? { start: edit.range.start, end: edit.range.start } : edit.range;
}

/**
 * The stretch an edit is weighed by. A cut has no length of its own in the video, so it is what its card plays around
 * the join: the lead-in and the tail.
 */
export function editWindow(edit: MomentEdit): TimeRange {
  const stretch = editStretch(edit);
  return stretch.end > stretch.start ? stretch : { start: stretch.start - CUT_LEAD_SECONDS, end: stretch.end + CUT_TAIL_SECONDS };
}

/** A stretch this many times longer than another is under it, not with it: a music bed and a zoom in it. */
const LONGER = 3;

/** How near two points of the video are the same place: about a frame. */
const SAME_PLACE = 0.05;

/**
 * Whether two stretches overlap significantly: they share at least half of the shorter one, and neither is many times
 * the other. A cut and the zoom that starts on its join do; two edits that only touch don't, and nor do a music bed
 * under the whole video and a zoom somewhere in it.
 */
export function overlapSignificantly(a: TimeRange, b: TimeRange) {
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.min(a.end - a.start, b.end - b.start), longer = Math.max(a.end - a.start, b.end - b.start);
  return shared > 0 && shared >= shorter / 2 && longer <= shorter * LONGER;
}

/**
 * Whether two edits change the same stretch of the video, so they are one moment. Edits in different places never
 * are, however close: two cuts are only when they join at the same point, and a cut and another edit only when its join
 * is inside that edit. Two edits with a length share at least half of the shorter one. Neither may run many times the
 * other, a cut counting as what its card plays round its join, so a music bed doesn't take every edit under it.
 */
export function samePlace(a: MomentEdit, b: MomentEdit) {
  const sa = editStretch(a), sb = editStretch(b);
  const pointA = sa.end <= sa.start, pointB = sb.end <= sb.start;
  if (!pointA && !pointB) return overlapSignificantly(sa, sb);
  const wa = editWindow(a), wb = editWindow(b);
  const shorter = Math.min(wa.end - wa.start, wb.end - wb.start), longer = Math.max(wa.end - wa.start, wb.end - wb.start);
  return sa.start <= sb.end + SAME_PLACE && sb.start <= sa.end + SAME_PLACE && longer <= shorter * LONGER;
}

/**
 * A moment is named for its largest cut, else its longest edit, else its first. Between two that are as large, the one
 * Scarlet said more about names it: a cut it described, not one that only reads "Cut".
 */
function mainOf<T extends MomentEdit>(members: T[]) {
  const removed = (e: T) => e.beforeCut ? Math.round((e.beforeCut.removed.end - e.beforeCut.removed.start) * 100) : -1;
  const length = (e: T) => { const s = editStretch(e); return s.end - s.start; };
  const words = (e: T) => e.label?.trim().length ?? 0;
  const rank = (a: T, b: T) => removed(a) - removed(b) || length(a) - length(b) || words(a) - words(b);
  return members.reduce((best, e) => rank(e, best) > 0 ? e : best);
}

/**
 * A request's edits as the moments its list shows, in the order they come in the video. An edit Scarlet asks the editor
 * to look at, or a spot it marked for them, is always a moment of its own: those are decided one by one.
 */
export function listMoments<T extends MomentEdit>(edits: readonly T[]): Moment<T>[] {
  const placed = edits.map(edit => ({ edit, stretch: editStretch(edit) }))
    .sort((a, b) => a.stretch.start - b.stretch.start || a.stretch.end - b.stretch.end);
  // An edit joins a moment when it changes the same stretch as an edit already in it. Cuts at different joins never
  // share one, so a run of close cuts stays a row each.
  const groups: { members: typeof placed; alone: boolean }[] = [];
  for (const item of placed) {
    const alone = !!item.edit.check || !!item.edit.marker;
    const group = alone ? undefined : groups.findLast(g => !g.alone && g.members.some(m => samePlace(m.edit, item.edit)));
    if (group) group.members.push(item);
    else groups.push({ members: [item], alone });
  }
  return groups.map(({ members }) => {
    const list = members.map(m => m.edit);
    const main = mainOf(list);
    return { key: editKey(main), main, edits: [main, ...list.filter(e => e !== main)], members: list,
      start: Math.min(...members.map(m => m.stretch.start)), end: Math.max(...members.map(m => m.stretch.end)) };
  });
}

/** The stretch a moment plays: from the first of its edits to the end of the last. */
export function momentRange(moment: Pick<Moment<MomentEdit>, "edits">): TimeRange {
  return { start: Math.min(...moment.edits.map(e => e.range.start)), end: Math.max(...moment.edits.map(e => e.range.end)) };
}
