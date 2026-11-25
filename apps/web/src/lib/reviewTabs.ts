/**
 * A request with something for the editor to review lists its edits and calls under three tabs: For you, Working and
 * Done (the editor chose this on 2026-11-23). Every row is in exactly one place: waiting on the editor, optional (a low
 * risk edit: one Scarlet didn't flag that the editor hasn't decided, in For you's list once included), with Scarlet,
 * or decided.
 * The chat draws its lists from this and ↑ ↓ and Keep step by it, so the two can't disagree about a tab's rows.
 */
export type RowPlace = "you" | "optional" | "working" | "done";
export type ReviewTab = "you" | "working" | "done";

/** The tab a request's open list shows. For you is the one shown until another is pressed, low risk edits included or not. */
export const tabShown = (open: string | undefined): ReviewTab => open === "working" || open === "done" ? open : "you";

/**
 * Where one row is. A row can stand for several edits (an edit made in several places, a moment): it waits while any
 * of them does, is with Scarlet while any of them is, and is decided only once they all are.
 */
export function rowPlace<E>(row: readonly E[], is: { waits(e: E): boolean; sent(e: E): boolean; kept(e: E): boolean }): RowPlace {
  if (row.some(is.waits)) return "you";
  if (row.some(is.sent)) return "working";
  return row.every(is.kept) ? "done" : "optional";
}

/** How a list orders its rows. A pass's lists go by time, or by number while `numbers` and every row has one. Any other list keeps the order given. */
export type ListOrder = { numbers: boolean } | undefined;

export function inListOrder<R extends { at: number; num?: number }>(rows: readonly R[], order: ListOrder): R[] {
  if (!order) return [...rows];
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  return order.numbers && sorted.every(r => r.num !== undefined) ? sorted.sort((a, b) => a.num! - b.num!) : sorted;
}

/** The rows of the tab shown, top to bottom: For you's waiting rows, with the low risk ones among them while included. */
export function rowsOfTab<R extends { place: RowPlace; at: number; num?: number }>(rows: readonly R[], tab: ReviewTab, optionalOpen: boolean, order: ListOrder): R[] {
  const shown = (place: RowPlace) => tab === "you" ? place === "you" || (optionalOpen && place === "optional") : place === tab;
  return inListOrder(rows.filter(r => shown(r.place)), order);
}

/** Where a row is in its list when it isn't one of the list's rows: by number in a list that goes by numbers, else by time. */
function fromHere<R extends { at: number; num?: number }>(list: readonly R[], where: { at: number; num?: number }, order: ListOrder) {
  const byNumber = !!order?.numbers && where.num !== undefined && list.every(r => r.num !== undefined);
  return (r: R) => byNumber ? r.num! - where.num! || r.at - where.at : r.at - where.at;
}

/**
 * The row ↑ or ↓ reaches from `current` in `list`. From a row that isn't in the list (the tab shown doesn't hold it,
 * or it has just left) they step to the row after or before `where` it is.
 */
export function rowBeside<R extends { at: number; num?: number }>(list: readonly R[], current: R | undefined, where: { at: number; num?: number }, delta: number, order: ListOrder): R | undefined {
  const here = current ? list.indexOf(current) : -1;
  if (here >= 0) return list[here + delta];
  const after = fromHere(list, where, order);
  return delta > 0 ? list.find(r => after(r) >= 0) : list.findLast(r => after(r) < 0);
}

/** The next row of `list` after `current`, without wrapping to earlier rows. */
export function rowNext<R extends { at: number; num?: number }>(list: readonly R[], current: R | undefined, where: { at: number; num?: number }, order: ListOrder): R | undefined {
  const here = current ? list.indexOf(current) : -1;
  if (here >= 0) return list[here + 1];
  const after = fromHere(list, where, order);
  return list.find(r => after(r) > 0);
}

/** Where Keep goes from `current`: the next row of `list` after it, wrapping to the earlier ones. */
export function rowAfter<R extends { at: number; num?: number }>(list: readonly R[], current: R | undefined, where: { at: number; num?: number }, order: ListOrder): R | undefined {
  return rowNext(list, current, where, order) ?? (current && list[0] === current ? undefined : list[0]);
}

/**
 * One stop of a request's lists as ↑ ↓ and Keep go through them: a row of edits (one edit, an edit made in several
 * places, a moment) or a call. A rejected edit is neither: it is counted for how its list is ordered, and stepped past.
 */
export type ReviewStop<E, C> = { place: RowPlace; at: number; num?: number; row?: readonly E[]; call?: C };

/** A request's stops, in the order its lists are built from: its rows of edits, its calls, then what was rejected. */
export function reviewStops<E extends { at?: number; range: { start: number } }, C>(of: {
  rows: readonly (readonly E[])[]; place(row: readonly E[]): RowPlace; num?(edit: E): number | undefined;
  calls?: readonly { call: C; at: number; num?: number; place: RowPlace }[];
  gone?: readonly { at: number; num?: number }[];
}): ReviewStop<E, C>[] {
  return [
    ...of.rows.map(row => ({ row, place: of.place(row), at: Math.min(...row.map(e => e.at ?? e.range.start)), num: row.length === 1 ? of.num?.(row[0]!) : undefined })),
    ...(of.calls ?? []),
    ...(of.gone ?? []).map(gone => ({ ...gone, place: "done" as const })),
  ];
}

/** The stops of the tab shown that ↑ and ↓ step through, top to bottom as the chat lists them. */
export function stopsShown<E, C>(stops: readonly ReviewStop<E, C>[], open: string | undefined, order: ListOrder) {
  return rowsOfTab(stops, tabShown(open), open === "all", order).filter(stop => !!stop.row || !!stop.call);
}

/** How long a row the editor has just acted on stays in For you with its new word, and how long it then takes to fade. */
export const LINGER_MS = 2500;
export const LINGER_FADE_MS = 300;

type Held = { key: string; from: "you" | "optional"; leaving: boolean; timers: ReturnType<typeof setTimeout>[] };

/**
 * The rows the editor has just acted on. Kept, rejected or sent back, a row of For you belongs to Done or Working at
 * once, and stays where it was for a moment with its new word before it fades and leaves, so the list doesn't jump
 * under the pointer. Held by the turn, which outlives its block moving between the conversation and the place above
 * the message box.
 */
export class ReviewLinger {
  private places = new Map<string, RowPlace>();
  private held = new Map<string, Held>();
  private listeners = new Set<() => void>();
  private version = 0;
  /**
   * Whether For you's low risk switch was on when For you was last the tab shown. Working and Done have no switch, so
   * it is kept here for the way back: For you pressed leaves the switch as it was.
   */
  lowRisk = false;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;

  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  private drop(key: string) {
    const held = this.held.get(key);
    if (!held) return;
    held.timers.forEach(clearTimeout);
    this.held.delete(key);
  }

  /**
   * Where each row is now. One that was listed in For you (`optionalShown`: its optional rows were too) and has gone
   * to Working or Done is held. `was` names the rows it took the place of: a rejected edit is a new row for the old.
   * Called as the list draws, so a row that has just moved is still in the list in that same draw.
   */
  track(rows: readonly { key: string; place: RowPlace; was?: readonly string[] }[], optionalShown: boolean) {
    const next = new Map<string, RowPlace>();
    for (const { key, place, was = [] } of rows) {
      next.set(key, place);
      const earlier = [key, ...was].find(k => this.places.has(k));
      const from = earlier === undefined ? undefined : this.places.get(earlier);
      // A row an earlier one became keeps what was held for it.
      const carried = earlier !== undefined && earlier !== key ? this.held.get(earlier) : undefined;
      if (carried && !this.held.has(key)) { this.held.delete(earlier!); carried.key = key; this.held.set(key, carried); }
      if (place === "you" || place === "optional") this.drop(key);
      else if ((from === "you" || (from === "optional" && optionalShown)) && !this.held.has(key)) this.hold(key, from);
    }
    for (const key of [...this.held.keys()]) if (!next.has(key)) this.drop(key);
    this.places = next;
  }

  private hold(key: string, from: "you" | "optional") {
    const held: Held = { key, from, leaving: false, timers: [] };
    const leave = () => { if (this.held.get(held.key) === held) { this.held.delete(held.key); this.changed(); } };
    held.timers.push(setTimeout(() => {
      // With motion reduced it leaves at once, with no fade.
      if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return leave();
      held.leaving = true;
      this.changed();
      held.timers.push(setTimeout(leave, LINGER_FADE_MS));
    }, LINGER_MS));
    this.held.set(key, held);
  }

  /** Whether a row is held in the list it has left: `from` says which, and `leaving` that it is fading out. */
  of(key: string): { from: "you" | "optional"; leaving: boolean } | undefined { return this.held.get(key); }

  dispose() {
    for (const held of this.held.values()) held.timers.forEach(clearTimeout);
    this.held.clear();
    this.places.clear();
  }
}
