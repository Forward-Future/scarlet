import type { ThreadEdit } from "@scarlet/shared";
import { createContext, useContext, useSyncExternalStore } from "react";

/** The lists of the column of edits: what waits on the editor, the edits Scarlet didn't flag (Low risk), what is with Scarlet, what is decided. */
export type RailSection = "you" | "low" | "working" | "done";

/**
 * What one request has in each list, and how to open its first and last row that waits (`openFirst`, `openLast`) and
 * its first and last low-risk row (`openFirstLow`, `openLastLow`).
 */
export interface RailInfo { you: number; optional: number; working: number; done: number; openFirst?(): void; openLast?(): void; openFirstLow?(): void; openLastLow?(): void;
  /** The edits of the request's low-risk rows, every place of each: what Mark all done keeps. */
  lowRiskEdits?(): Omit<ThreadEdit, "at">[];
  /** Ordered row keys of this request's For you items (waiting, working, or decided) that take sequential rail numbers. */
  numberedKeys?: readonly string[];
  /** Live located edits reported by this thread so question headers can name the exact edit. */
  edits?: readonly Omit<ThreadEdit, "at">[];
}

/**
 * The column of edits beside the chat is one list for the whole video, and each request draws its own rows into it:
 * the request knows its rows, the column knows where they go. The column makes a place for every request in every
 * list (`ref`), a request draws into its places (`host`) and says how many rows it has in each (`report`).
 */
export class RailStore {
  private hosts = new Map<string, HTMLElement>();
  private refs = new Map<string, (el: HTMLElement | null) => void>();
  private infos = new Map<string, RailInfo>();
  private threadOrder: readonly string[] = [];
  private reservedMax = 0;
  private numbers = new Map<string, number>();
  private numbersSig = "";
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.version++; for (const listener of this.listeners) listener(); }

  private recomputeNumbers(): boolean {
    const next = new Map<string, number>();
    let cursor = this.reservedMax;
    const seenThreads = new Set<string>();
    const visit = (threadId: string) => {
      if (seenThreads.has(threadId)) return;
      seenThreads.add(threadId);
      const keys = this.infos.get(threadId)?.numberedKeys;
      if (!keys?.length) return;
      for (const key of keys) next.set(`${threadId}/${key}`, ++cursor);
    };
    for (const id of this.threadOrder) visit(id);
    for (const id of this.infos.keys()) visit(id);
    const sig = [...next.entries()].map(([k, n]) => `${k}=${n}`).join(",");
    if (sig === this.numbersSig) return false;
    this.numbers = next;
    this.numbersSig = sig;
    return true;
  }

  /** Sets the order requests appear in the rail and the highest number already reserved by a waiting dialogue pass. */
  setNumbering(threadIds: readonly string[], reservedMax: number) {
    const sameOrder = threadIds.length === this.threadOrder.length && threadIds.every((id, i) => id === this.threadOrder[i]);
    if (sameOrder && reservedMax === this.reservedMax) return;
    this.threadOrder = threadIds;
    this.reservedMax = reservedMax;
    if (this.recomputeNumbers()) this.changed();
  }

  /** The rail-wide number for one request's For you row, guaranteed never to collide across requests or with Low risk. */
  numberOf(threadId: string, key: string): number | undefined {
    return this.numbers.get(`${threadId}/${key}`);
  }

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
    if (!info) {
      if (this.infos.delete(threadId)) {
        this.recomputeNumbers();
        this.changed();
      }
      return;
    }
    this.infos.set(threadId, info);
    const numbersChanged = this.recomputeNumbers();
    const editsArrived = (was?.edits?.length ?? 0) !== (info.edits?.length ?? 0);
    if (numbersChanged || editsArrived || !was || was.you !== info.you || was.optional !== info.optional || was.working !== info.working || was.done !== info.done) this.changed();
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
