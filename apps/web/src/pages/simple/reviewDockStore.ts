import { createContext, useContext, useSyncExternalStore } from "react";
import type { ThreadEdit } from "@scarlet/shared";
import { inListOrder, rowsOfTab, tabShown, type ReviewTab, type RowPlace } from "../../lib/reviewTabs";
import type { HoveredReviewRow, Nest, OpenList } from "./types";

/** One row inside the fixed bottom review dock: a cut/edit, a pass call, a rejected edit, or a decided call. */
export interface DockRow {
  /** Globally unique key across all threads in the dock: `${threadId}/${rawKey}`. */
  key: string;
  /** Row key within its thread (e.g. `editKey(e)` or `call/1`). */
  rawKey: string;
  threadId: string;
  /** Stable identity across revisions/rejections: `${threadId}/${rawId}`. */
  id: string;
  /** Earlier version keys this row replaced (for ReviewLinger continuity). */
  was?: string[];
  at: number;
  displayAt: number;
  mark?: number;
  hover?: HoveredReviewRow;
  label: string;
  n: number;
  num?: number;
  decision?: string;
  value?: string;
  word?: string;
  revised: boolean;
  rejected: boolean;
  skipped: boolean;
  forYou: boolean;
  busy: boolean;
  pending: boolean;
  needs: boolean;
  asks: boolean;
  decided: boolean;
  version: number;
  fresh: boolean;
  title?: string;
  ariaLabel?: string;
  on: boolean;
  open?: () => void;
  /** Opens this item when stepping with ↑ / ↓ even if its row button is disabled (e.g. a revising call). */
  stepOpen?: () => void;
  unkeep?: () => void;
  unkeepTip?: string;
  spent?: string;
  dataLogControl: "open-pass-item" | "open-edit";
  dataLogLabel: string;
  callIndex?: number;
  edit?: Omit<ThreadEdit, "at">;
  /** All edits represented by this row (a grouped multi-place edit or moment), for Keep confident. */
  edits?: readonly Omit<ThreadEdit, "at">[];
  /** 1-based position in its thread's edits list, for action logging when stepping with ↑ / ↓. */
  editOrder?: { index: number; of: number };
  nests: readonly Nest[];
}

/** One entry rendered in the fixed bottom review dock: a single row or a moment with expandable member edits. */
export interface DockEntry {
  key: string;
  threadId: string;
  row: DockRow;
  members?: DockRow[];
  more?: string;
  moment?: string;
  unfolded?: boolean;
  onToggleMoment?: () => void;
  place: RowPlace;
  at: number;
  num?: number;
  isPass: boolean;
}

/** Everything one thread contributes to the fixed bottom review dock. */
export interface DockThreadReport {
  threadId: string;
  isPass: boolean;
  hasCalls: boolean;
  hasForYou: boolean;
  need: number;
  entries: DockEntry[];
  /** True when the thread's untabbed "See all" / "See N edits so far" list is open. */
  allOpen: boolean;
  allLabel: string;
  soFar: boolean;
  onCloseAll?: () => void;
  /** True when this thread has only rejected edits (no live edits, no pass, no review tabs). */
  onlyRejected: boolean;
  /** True when a single-edit unflagged thread is currently showing its edit card. */
  singleOpen: boolean;
  onCloseSingle?: () => void;
  passApplying?: boolean;
  passError?: string;
  onRetryPass?: () => void;
  onRowHover: (mark?: number, hover?: HoveredReviewRow) => void;
}

function sameRow(a: DockRow, b: DockRow): boolean {
  if (a.nests.length > 0 || b.nests.length > 0) return false;
  return a.key === b.key && a.id === b.id && a.at === b.at && a.displayAt === b.displayAt && a.mark === b.mark
    && a.label === b.label && a.n === b.n && a.num === b.num && a.decision === b.decision && a.value === b.value
    && a.word === b.word && a.revised === b.revised && a.rejected === b.rejected && a.skipped === b.skipped
    && a.forYou === b.forYou && a.busy === b.busy && a.pending === b.pending && a.needs === b.needs
    && a.asks === b.asks && a.decided === b.decided && a.version === b.version && a.fresh === b.fresh
    && a.title === b.title && a.ariaLabel === b.ariaLabel && a.on === b.on && !!a.open === !!b.open
    && !!a.unkeep === !!b.unkeep && a.unkeepTip === b.unkeepTip && a.spent === b.spent;
}

function sameEntry(a: DockEntry, b: DockEntry): boolean {
  if (a.key !== b.key || a.place !== b.place || a.at !== b.at || a.num !== b.num || a.isPass !== b.isPass
    || a.more !== b.more || a.moment !== b.moment || a.unfolded !== b.unfolded || !sameRow(a.row, b.row)) return false;
  if ((a.members?.length ?? 0) !== (b.members?.length ?? 0)) return false;
  if (a.members && b.members) {
    for (let i = 0; i < a.members.length; i++) if (!sameRow(a.members[i]!, b.members[i]!)) return false;
  }
  return true;
}

function sameReport(a: DockThreadReport | undefined, b: DockThreadReport): boolean {
  if (!a) return false;
  if (a.isPass !== b.isPass || a.hasCalls !== b.hasCalls || a.hasForYou !== b.hasForYou || a.need !== b.need
    || a.allOpen !== b.allOpen || a.allLabel !== b.allLabel || a.soFar !== b.soFar || a.onlyRejected !== b.onlyRejected
    || a.singleOpen !== b.singleOpen || a.passApplying !== b.passApplying || a.passError !== b.passError
    || a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) if (!sameEntry(a.entries[i]!, b.entries[i]!)) return false;
  return true;
}

/**
 * Reactive store for the non-beta workspace's fixed bottom review dock.
 * Each Turn's PassSummary or ThreadResult publishes its normalized rows here; ReviewDock
 * merges every thread's lists into one fixed bottom panel above the message box so new
 * chat messages always flow above the lists.
 */
export class ReviewDockStore {
  private reports = new Map<string, DockThreadReport>();
  private listeners = new Set<() => void>();
  private tabListeners = new Set<() => void>();
  private version = 0;
  private revealSeq = 0;
  private cachedHasTabs = false;
  private pendingNotify = false;
  private pendingTabs = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeHasTabs = (listener: () => void) => {
    this.tabListeners.add(listener);
    return () => { this.tabListeners.delete(listener); };
  };

  snapshot = () => this.version;
  hasTabsSnapshot = () => this.cachedHasTabs;
  getRevealSeq = () => this.revealSeq;

  /** Ask the bottom dock to scroll its first row into view once the opened list renders. */
  requestReveal() {
    this.revealSeq++;
    this.notify();
  }

  private computeHasTabs(): boolean {
    for (const report of this.reports.values()) if (report.hasForYou) return true;
    return false;
  }

  private notify() {
    this.version++;
    const nextTabs = this.computeHasTabs();
    if (nextTabs !== this.cachedHasTabs) {
      this.cachedHasTabs = nextTabs;
      this.pendingTabs = true;
    }
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    // Coalesce reports from multiple turns within a commit into one ReviewDock update without forcing a sync layout flush.
    queueMicrotask(() => {
      this.pendingNotify = false;
      const notifyTabs = this.pendingTabs;
      this.pendingTabs = false;
      for (const listener of this.listeners) listener();
      if (notifyTabs) for (const listener of this.tabListeners) listener();
    });
  }

  /** Publish or clear one thread's contribution to the fixed bottom dock. */
  report(threadId: string, data?: DockThreadReport) {
    if (!data) {
      if (this.reports.delete(threadId)) this.notify();
      return;
    }
    const prev = this.reports.get(threadId);
    this.reports.set(threadId, data);
    if (!sameReport(prev, data)) this.notify();
  }

  get(threadId: string): DockThreadReport | undefined {
    return this.reports.get(threadId);
  }

  /** All thread reports ordered according to `threadIds` (oldest thread first for stable tie-breaking). */
  orderedReports(threadIds: readonly string[]): DockThreadReport[] {
    const out: DockThreadReport[] = [];
    const seen = new Set<string>();
    for (const id of threadIds) {
      const rep = this.reports.get(id);
      if (rep) { out.push(rep); seen.add(id); }
    }
    for (const [id, rep] of this.reports) if (!seen.has(id)) out.push(rep);
    return out;
  }

  /** A thread without review tabs whose standalone "See all" / "See N edits so far" list is explicitly open. */
  explicitAllReport(threadIds: readonly string[]): DockThreadReport | undefined {
    return this.orderedReports(threadIds).find(r => !r.hasForYou && r.allOpen);
  }

  /** A thread without review tabs explicitly showing in the dock ("See all" or an open single edit via "See edit"). */
  explicitReport(threadIds: readonly string[]): DockThreadReport | undefined {
    const ordered = this.orderedReports(threadIds);
    return ordered.find(r => !r.hasForYou && r.allOpen) ?? ordered.find(r => !r.hasForYou && r.singleOpen);
  }

  // Live handler dispatchers: `sameReport` skips re-rendering ReviewDock when only handler closures refresh,
  // so ReviewDock invokes handlers through the store to always reach the latest render's closures.
  openRow(threadId: string, entryKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.row.open?.();
  }

  openMember(threadId: string, entryKey: string, memberKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.members?.find(m => m.key === memberKey)?.open?.();
  }

  unkeepRow(threadId: string, entryKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.row.unkeep?.();
  }

  unkeepMember(threadId: string, entryKey: string, memberKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.members?.find(m => m.key === memberKey)?.unkeep?.();
  }

  toggleMoment(threadId: string, entryKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.onToggleMoment?.();
  }

  closeAll(threadId: string) {
    this.reports.get(threadId)?.onCloseAll?.();
  }

  closeSingle(threadId: string) {
    this.reports.get(threadId)?.onCloseSingle?.();
  }

  retryPass(threadId: string) {
    this.reports.get(threadId)?.onRetryPass?.();
  }

  hoverRow(threadId: string, mark?: number, hover?: HoveredReviewRow) {
    this.reports.get(threadId)?.onRowHover(mark, hover);
  }

  /** All entries across threads that have review tabs (For you / Working / Done), ordered by timeline time. */
  allEntries(threadIds: readonly string[]): DockEntry[] {
    const raw = this.orderedReports(threadIds).filter(r => r.hasForYou).flatMap(r => r.entries);
    return inListOrder(raw, { numbers: false });
  }

  /** Navigable entries currently shown in the active tab of the docked tabbed view, top to bottom. */
  tabNavigable(threadIds: readonly string[], dockList: OpenList): DockEntry[] {
    const all = this.allEntries(threadIds);
    const tab: ReviewTab = tabShown(dockList);
    const optionalOpen = dockList === "all";
    return rowsOfTab(all, tab, optionalOpen, { numbers: false })
      .filter(e => !e.row.rejected && !!(e.row.stepOpen ?? e.row.open));
  }

  /** Waiting ("For you") entries that still need a decision, ordered by timeline time. */
  waitingEntries(threadIds: readonly string[]): DockEntry[] {
    return rowsOfTab(this.allEntries(threadIds), "you", false, { numbers: false })
      .filter(e => (e.row.needs || e.row.asks) && !e.row.rejected && !!e.row.open);
  }

  /** Entries stepped through by Keep when low-risk edits are included (waiting + optional), ordered by timeline time. */
  keepEntries(threadIds: readonly string[], includeLowRisk: boolean): DockEntry[] {
    const waiting = this.waitingEntries(threadIds);
    if (!includeLowRisk) return waiting;
    return rowsOfTab(this.allEntries(threadIds), "you", true, { numbers: false })
      .filter(e => !e.row.rejected && !!e.row.open && (e.place === "optional" || e.row.needs || e.row.asks));
  }
}

export const ReviewDockContext = createContext<ReviewDockStore | undefined>(undefined);

const noopSub = () => () => {};
const alwaysFalse = () => false;

/** Access the fixed bottom review dock store (undefined outside LegacySimpleWorkspace). */
export function useReviewDockStore(): ReviewDockStore | undefined {
  return useContext(ReviewDockContext);
}

/** Subscribe only to whether ANY thread in the project has review tabs (For you / Working / Done). */
export function useDockHasTabs(): boolean {
  const store = useContext(ReviewDockContext);
  return useSyncExternalStore(
    store?.subscribeHasTabs ?? noopSub,
    store?.hasTabsSnapshot ?? alwaysFalse,
    alwaysFalse,
  );
}
