import { useLayoutEffect, type RefObject } from "react";
import { create } from "zustand";

/**
 * Pause holds all editing in the project, and Resume picks it all up, so the chat draws that control once however many
 * requests Scarlet has. Each thread says which of its bands could draw it, as they stand in the chat. The one that does
 * is the band of the block fixed above the message box; else the lowest band whose own request has a Stop; else the
 * lowest band of a block Scarlet is working under the rows of. A request under a cut's or edit's row never draws it.
 * Every request keeps its own Stop.
 */
export interface PauseOffer {
  /** The requests with a band of their own (or, with no heading, their own working line) that have a Stop, top to bottom. */
  bands: string[];
  /** The requests whose band has no Stop of its own while Scarlet works on a request under one of their block's rows, top to bottom. */
  under: string[];
  /** The request whose block is fixed above the message box, when its band is one of either. */
  pinned?: string;
}

const offers = new Map<string, { at: Element | null; offer: PauseOffer }>();
/** The request that draws Pause or Resume, by its run. */
const useHolder = create<{ run?: string }>(() => ({}));

function settle() {
  // In the chat's own order, whatever order the threads last drew in. A thread no longer on the page offers nothing.
  const live = [...offers.values()].filter(o => o.at?.isConnected)
    .sort((a, b) => a.at!.compareDocumentPosition(b.at!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).map(o => o.offer);
  const run = live.find(o => o.pinned)?.pinned ?? live.flatMap(o => o.bands).at(-1) ?? live.flatMap(o => o.under).at(-1);
  if (useHolder.getState().run !== run) useHolder.setState({ run }, true);
}

/**
 * Say which of a thread's bands could draw Pause, and read which request's band in the whole chat does. `offer` is read as
 * the thread is drawn: it is settled before the chat is painted, so no frame shows two of them or none.
 */
export function usePauseOn(thread: string, at: RefObject<Element | null>, offer: PauseOffer): string | undefined {
  useLayoutEffect(() => {
    const empty = !offer.bands.length && !offer.under.length;
    if (empty && !offers.has(thread)) return;
    if (empty) offers.delete(thread);
    else offers.set(thread, { at: at.current, offer });
    settle();
  });
  useLayoutEffect(() => () => { if (offers.delete(thread)) settle(); }, [thread]);
  return useHolder(s => s.run);
}
