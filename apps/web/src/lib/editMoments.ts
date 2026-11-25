import type { EditRef } from "@scarlet/shared";
import type { TimeRange } from "@scarlet/timeline";

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
  elsewhere?: unknown;
}

/**
 * A moment of a request's list: edits that overlap on the timeline exactly, such as two cuts at the same join or two
 * edits over the exact same stretch. `edits` leads with `main`, the edit the moment's row and card are named for;
 * `members` are the same edits in the order they come in the video.
 */
export interface Moment<T extends MomentEdit> { key: string; main: T; edits: T[]; members: T[]; start: number; end: number }

/** Where an edit plays in the video as it runs now. A cut is its join, a point. */
export function editStretch(edit: MomentEdit): TimeRange {
  if (edit.at !== undefined) return { start: edit.at, end: edit.at };
  return edit.beforeCut ? { start: edit.range.start, end: edit.range.start } : edit.range;
}

/** How near two timeline edges count as the exact same point: about a frame. */
const SAME_PLACE = 0.05;

/**
 * Whether two edits overlap on the timeline exactly, so they are one moment: both their start and end match within a
 * frame. Two cuts at the same join do, and two ranged edits over the exact same stretch do; a cut and a zoom or B-roll
 * shot that starts on it, or two edits that only partly overlap, stay separate rows.
 */
export function samePlace(a: MomentEdit, b: MomentEdit) {
  const sa = editStretch(a), sb = editStretch(b);
  return Math.abs(sa.start - sb.start) <= SAME_PLACE && Math.abs(sa.end - sb.end) <= SAME_PLACE;
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
  // An edit joins a moment only when it overlaps the moment's first edit on the timeline exactly, so edits never chain.
  const groups: { members: typeof placed; alone: boolean }[] = [];
  for (const item of placed) {
    const alone = !!item.edit.check || !!item.edit.marker;
    const group = alone ? undefined : groups.findLast(g => !g.alone && samePlace(g.members[0]!.edit, item.edit));
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
