/**
 * A request with something for the editor to review lists its edits and calls under three tabs: For you, Working and
 * Done (the editor chose this on 2026-11-23). Every row is in exactly one place: waiting on the editor, optional (an
 * edit Scarlet didn't flag that the editor hasn't decided, folded under For you's rows), with Scarlet, or decided.
 * The chat draws its lists from this and ↑ ↓ and Keep step by it, so the two can't disagree about a tab's rows.
 */
export type RowPlace = "you" | "optional" | "working" | "done";
export type ReviewTab = "you" | "working" | "done";

/** The tab a request's open list shows. For you is the one shown until another is pressed, its optional line open or not. */
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

/** The rows of the tab shown, top to bottom: For you's waiting rows, then the optional ones while that line is open. */
export function rowsOfTab<R extends { place: RowPlace; at: number; num?: number }>(rows: readonly R[], tab: ReviewTab, optionalOpen: boolean, order: ListOrder): R[] {
  const of = (place: RowPlace) => inListOrder(rows.filter(r => r.place === place), order);
  return tab === "you" ? [...of("you"), ...(optionalOpen ? of("optional") : [])] : of(tab);
}

/**
 * The row ↑ or ↓ reaches from `current` in `list`. A row that isn't in the list (the tab shown doesn't hold it) steps
 * to the one after or before where it is in the video.
 */
export function rowBeside<R extends { at: number }>(list: readonly R[], current: R | undefined, at: number, delta: number): R | undefined {
  const here = current ? list.indexOf(current) : -1;
  if (here >= 0) return list[here + delta];
  return delta > 0 ? list.find(r => r.at >= at) : list.findLast(r => r.at < at);
}

/** Where Keep goes from `current`: the next row of `list` after it, wrapping to the earlier ones. */
export function rowAfter<R extends { at: number }>(list: readonly R[], current: R | undefined, at: number): R | undefined {
  const here = current ? list.indexOf(current) : -1;
  if (here >= 0) return list[here + 1] ?? (here > 0 ? list[0] : undefined);
  return list.find(r => r.at > at) ?? list[0];
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
