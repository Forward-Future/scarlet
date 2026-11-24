import { useLayoutEffect, type RefObject } from "react";
import { create } from "zustand";

/**
 * Pause holds all editing in the project, and Resume picks it all up, so the chat draws that control once however many
 * requests Scarlet has. Each thread says which of its requests could draw it, as they stand in the chat; the one that
 * does is the request fixed above the message box, else the lowest band in the chat, and a request under a cut's or
 * edit's row only when no band can. Every request keeps its own Stop.
 */
export interface PauseOffer {
  /** The requests with a band of their own (or, with no heading, their own working line) that could draw it, top to bottom. */
  bands: string[];
  /** The requests under a row that could, top to bottom. */
  rows: string[];
  /** The request whose block is fixed above the message box, when its band could draw it. */
  pinnedBand?: string;
  /** The request Scarlet is on, when it sits under a row. */
  pinnedRow?: string;
}

const offers = new Map<string, { at: Element | null; offer: PauseOffer }>();
/** The request that draws Pause or Resume, by its run. */
const useHolder = create<{ run?: string }>(() => ({}));

function settle() {
  // In the chat's own order, whatever order the threads last drew in. A thread no longer on the page offers nothing.
  const live = [...offers.values()].filter(o => o.at?.isConnected)
    .sort((a, b) => a.at!.compareDocumentPosition(b.at!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).map(o => o.offer);
  const run = live.find(o => o.pinnedBand)?.pinnedBand ?? live.flatMap(o => o.bands).at(-1)
    ?? live.find(o => o.pinnedRow)?.pinnedRow ?? live.flatMap(o => o.rows).at(-1);
  if (useHolder.getState().run !== run) useHolder.setState({ run }, true);
}

/**
 * Say which of a thread's requests could draw Pause, and read which request in the whole chat does. `offer` is read as
 * the thread is drawn: it is settled before the chat is painted, so no frame shows two of them or none.
 */
export function usePauseOn(thread: string, at: RefObject<Element | null>, offer: PauseOffer): string | undefined {
  useLayoutEffect(() => {
    const empty = !offer.bands.length && !offer.rows.length;
    if (empty && !offers.has(thread)) return;
    if (empty) offers.delete(thread);
    else offers.set(thread, { at: at.current, offer });
    settle();
  });
  useLayoutEffect(() => () => { if (offers.delete(thread)) settle(); }, [thread]);
  return useHolder(s => s.run);
}
