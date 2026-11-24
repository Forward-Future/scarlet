import { createContext, useContext, useSyncExternalStore } from "react";

/** The lists of the column of edits: what waits on the editor, the edits Scarlet didn't flag (Low risk), what is with Scarlet, what is decided. */
export type RailSection = "you" | "low" | "working" | "done";

/**
 * What one request has in each list, and how to open its first and last row that waits (`openFirst`, `openLast`) and
 * its first and last low-risk row (`openFirstLow`, `openLastLow`).
 */
export interface RailInfo { you: number; optional: number; working: number; done: number; openFirst?(): void; openLast?(): void; openFirstLow?(): void; openLastLow?(): void }

/**
 * The column of edits beside the chat is one list for the whole video, and each request draws its own rows into it:
 * the request knows its rows, the column knows where they go. The column makes a place for every request in every
 * list (`ref`), a request draws into its places (`host`) and says how many rows it has in each (`report`).
 */
export class RailStore {
  private hosts = new Map<string, HTMLElement>();
  private refs = new Map<string, (el: HTMLElement | null) => void>();
  private infos = new Map<string, RailInfo>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.version++; for (const listener of this.listeners) listener(); }

  /** Where a request draws its rows of one list, once the column has made the place. */
  host(section: RailSection, threadId: string) { return this.hosts.get(`${section}/${threadId}`) ?? null; }
  /** The ref of a request's place in one list. The same function each time, so React sets it once. */
  ref(section: RailSection, threadId: string) {
    const key = `${section}/${threadId}`;
    let ref = this.refs.get(key);
    if (!ref) {
      ref = el => {
        if (el ? this.hosts.get(key) === el : !this.hosts.has(key)) return;
        if (el) this.hosts.set(key, el); else this.hosts.delete(key);
        this.changed();
      };
      this.refs.set(key, ref);
    }
    return ref;
  }

  /** A request says what it has in each list. With nothing, it has left. */
  report(threadId: string, info?: RailInfo) {
    const was = this.infos.get(threadId);
    if (!info) { if (this.infos.delete(threadId)) this.changed(); return; }
    this.infos.set(threadId, info);
    if (!was || was.you !== info.you || was.optional !== info.optional || was.working !== info.working || was.done !== info.done) this.changed();
  }
  info(threadId: string) { return this.infos.get(threadId); }
  total(section: Exclude<RailSection, "low"> | "optional") { let n = 0; for (const info of this.infos.values()) n += info[section]; return n; }
}

export const ReviewRailContext = createContext<RailStore | undefined>(undefined);

const never = () => () => {};
const zero = () => 0;
/** The column of edits, when the page has one: a request then draws its rows there and not in the chat. */
export function useReviewRail() {
  const store = useContext(ReviewRailContext);
  useSyncExternalStore(store?.subscribe ?? never, store?.snapshot ?? zero, store?.snapshot ?? zero);
  return store;
}
