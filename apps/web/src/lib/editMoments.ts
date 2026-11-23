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
  elsewhere?: unknown;
}

/**
 * A moment of a request's list: edits whose stretches overlap so much that they play as one change, such as a cut and
 * the zoom and reframe that begin on its join. `edits` leads with `main`, the edit the moment's row and card are
 * named for; `members` are the same edits in the order they come in the video. `places` marks a row that is no
 * moment: one edit made in many places, which opens at its first place and doesn't play as one change.
 */
export interface Moment<T extends MomentEdit> { key: string; main: T; edits: T[]; members: T[]; start: number; end: number; places?: true }

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
  const placed = edits.map(edit => ({ edit, stretch: editStretch(edit), window: editWindow(edit) }))
    .sort((a, b) => a.stretch.start - b.stretch.start || a.stretch.end - b.stretch.end);
  // An edit joins a moment when it overlaps the moment's first edit significantly, not just any edit already in it:
  // a run of close cuts doesn't chain into one long moment.
  const groups: { members: typeof placed; alone: boolean }[] = [];
  for (const item of placed) {
    const alone = !!item.edit.check || !!item.edit.marker;
    const group = alone ? undefined : groups.findLast(g => !g.alone && overlapSignificantly(g.members[0]!.window, item.window));
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

/**
 * An edit a pass made in many places under one name (a fade on every dialogue join), by each place's key: its first
 * place and all of them. It is one row of the pass's list, at its first place. A cut, a spot left for the editor, an
 * edit that asks for a look and one another request made stay one each.
 */
export function editPlaces<T extends MomentEdit>(edits: readonly T[]): Map<string, { first: string; members: T[] }> {
  const named = new Map<string, T[]>();
  for (const e of edits) {
    if (e.beforeCut || e.marker || e.check || e.elsewhere) continue;
    const name = `${e.changeId}\n${e.label}`;
    const members = named.get(name);
    if (members) members.push(e); else named.set(name, [e]);
  }
  const places = new Map<string, { first: string; members: T[] }>();
  for (const members of named.values()) {
    if (members.length < 2) continue;
    const group = { first: editKey(members[0]!), members };
    for (const e of members) places.set(editKey(e), group);
  }
  return places;
}

/**
 * The rows of a pass's list of every edit, in the order they come in the video: its moments, and each edit made in
 * many places as one row at its first place, apart from the moments. The chat's list and the card, Keep and ↑ ↓ on
 * the timeline all go by these rows, so a row in the chat is one stop for them too.
 */
export function passRows<T extends MomentEdit>(edits: readonly T[]): Moment<T>[] {
  const places = editPlaces(edits);
  if (!places.size) return listMoments(edits);
  const rows = listMoments(edits.filter(e => !places.has(editKey(e))));
  for (const { first, members } of new Set(places.values())) {
    const stretches = members.map(editStretch);
    rows.push({ key: first, main: members[0]!, edits: members, members, places: true,
      start: Math.min(...stretches.map(s => s.start)), end: Math.max(...stretches.map(s => s.end)) });
  }
  return rows.sort((a, b) => a.start - b.start);
}

/** The stretch a moment plays: from the first of its edits to the end of the last. */
export function momentRange(moment: Pick<Moment<MomentEdit>, "edits">): TimeRange {
  return { start: Math.min(...moment.edits.map(e => e.range.start)), end: Math.max(...moment.edits.map(e => e.range.end)) };
}
