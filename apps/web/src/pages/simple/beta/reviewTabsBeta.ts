/**
 * The new layout's review tabs (`lib/reviewTabs`): its column of edits lists the optional rows (Low risk) after all of
 * Needs review's waiting rows, steps ↑ ↓ through one part of the column at a time, and holds a low risk row the editor
 * acts on by whether it was seen.
 */
import {
  inListOrder, ReviewLinger as SharedReviewLinger, rowsOfTab as sharedRowsOfTab, stopsShown as sharedStopsShown, tabShown,
  type ListOrder, type ReviewStop, type ReviewTab, type RowPlace,
} from "../../../lib/reviewTabs";

export {
  inListOrder, LINGER_FADE_MS, LINGER_MS, reviewStops, rowAfter, rowBeside, rowPlace, tabShown,
  type HeldFrom, type ListOrder, type ReviewStop, type ReviewTab, type RowPlace,
} from "../../../lib/reviewTabs";

/** The rows of the tab shown, top to bottom: Needs review's waiting rows, then the optional ones while that line is open. */
export function rowsOfTab<R extends { place: RowPlace; at: number; num?: number }>(rows: readonly R[], tab: ReviewTab, optionalOpen: boolean, order: ListOrder): R[] {
  return sharedRowsOfTab(rows, tab, optionalOpen, order, true);
}

/** The stops of the tab shown that ↑ and ↓ step through, top to bottom as the chat lists them. */
export function stopsShown<E, C>(stops: readonly ReviewStop<E, C>[], open: string | undefined, order: ListOrder) {
  return sharedStopsShown(stops, open, order, true);
}

/**
 * The stops ↑ and ↓ step through in the column of edits: the rows of the part the open row is in. A low-risk row
 * (`low`: an edit Scarlet didn't flag) steps through Low risk's rows; any other through the tab `open` shows: Needs review's
 * rows that wait, Working's or Done's.
 */
export function sectionStops<E, C>(stops: readonly ReviewStop<E, C>[], open: string | undefined, low: boolean, order: ListOrder) {
  const place: RowPlace = low ? "optional" : tabShown(open);
  return inListOrder(stops.filter(stop => stop.place === place), order).filter(stop => !!stop.row || !!stop.call);
}

/** The rows the editor has just acted on, as the column of edits holds them: a low risk row by whether it was seen. */
export class ReviewLinger extends SharedReviewLinger {
  constructor() { super(true); }
}
