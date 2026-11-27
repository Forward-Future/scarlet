import { createContext, useContext, useSyncExternalStore } from "react";
import { BROLL_CONTIGUOUS_GAP, matchesEdit, stretchesContiguous, type EditKind, type EditRef, type ThreadEdit } from "@scarlet/shared";
import type { TimeRange } from "@scarlet/timeline";
import { editKey } from "../../lib/editMoments";
import { inListOrder, rowBeside, rowsOfTab, tabShown, type ReviewTab, type RowPlace } from "../../lib/reviewTabs";
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
  /** True when `edit` belongs to this thread's own changes (not an elsewhere flag or unrelated fallback). */
  owns?: boolean;
  /** All edits represented by this row (a grouped multi-place edit or moment), for Keep confident. */
  edits?: readonly Omit<ThreadEdit, "at">[];
  /** Specific edit kind for continuous B-roll grouping across requests. */
  editKind?: EditKind;
  /** Working-cut timeline stretch of this row (union across all shots when continuous B-roll). */
  stretch?: TimeRange;
  /** Active continuous B-roll section ID on the current timeline (`null` when checked and no active B-roll plays here). */
  brollSectionId?: string | null;
  /** True when multiple contiguous B-roll edits combined into one continuous section row. */
  continuousBroll?: boolean;
  /** Additional threads' edits folded into this row when continuous B-roll spans multiple requests. */
  extraThreadEdits?: readonly { threadId: string; edits: readonly Omit<ThreadEdit, "at">[]; unkeep?: () => void }[];
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
  /** True once this thread's live edit list has settled (so initial saved → located arrival won't linger rows). */
  listLoaded?: boolean;
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
    && !!a.unkeep === !!b.unkeep && a.unkeepTip === b.unkeepTip && a.spent === b.spent
    && a.editKind === b.editKind && a.brollSectionId === b.brollSectionId && !!a.continuousBroll === !!b.continuousBroll
    && a.stretch?.start === b.stretch?.start && a.stretch?.end === b.stretch?.end;
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
    || a.singleOpen !== b.singleOpen || a.listLoaded !== b.listLoaded || a.passApplying !== b.passApplying || a.passError !== b.passError
    || a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) if (!sameEntry(a.entries[i]!, b.entries[i]!)) return false;
  return true;
}

const PLACE_RANK: Record<RowPlace, number> = { you: 4, working: 3, done: 2, optional: 1 };

function entryEditId(entry: DockEntry): string | undefined {
  if (entry.row.callIndex !== undefined || entry.members?.length) return undefined;
  const e = entry.row.edit;
  return e ? `${e.changeId}:${e.spot}` : undefined;
}

function isContinuousBrollDockEntry(entry: DockEntry): boolean {
  const { row } = entry;
  return !entry.members?.length && row.callIndex === undefined && !row.rejected && !row.skipped
    && row.editKind === "broll" && row.brollSectionId !== null && !!row.stretch && row.stretch.end > row.stretch.start;
}

function sameContinuousBrollDock(a: DockEntry, b: DockEntry): boolean {
  if (!isContinuousBrollDockEntry(a) || !isContinuousBrollDockEntry(b)) return false;
  if (a.row.brollSectionId && b.row.brollSectionId) return a.row.brollSectionId === b.row.brollSectionId;
  if (a.row.brollSectionId || b.row.brollSectionId) return false;
  return stretchesContiguous(a.row.stretch, b.row.stretch, BROLL_CONTIGUOUS_GAP);
}

function synthesizeBrollDockGroup(group: readonly DockEntry[]): DockEntry {
  if (group.length === 1) return group[0]!;
  const asks = group.filter(e => e.row.asks);
  const needs = group.filter(e => e.row.needs);
  const pending = group.filter(e => e.row.pending);
  const pool = asks.length ? asks : needs.length ? needs : pending.length ? pending : group;
  const lead = [...pool].sort((a, b) => a.at - b.at)[0]!;
  const unionStretch: TimeRange = {
    start: Math.min(...group.map(e => e.row.stretch!.start)),
    end: Math.max(...group.map(e => e.row.stretch!.end)),
  };
  const place: RowPlace = group.some(e => e.place === "you" || e.row.needs || e.row.asks) ? "you"
    : group.some(e => e.place === "working" || e.row.pending) ? "working"
    : group.every(e => e.place === "done" || e.row.decided) ? "done"
    : "optional";
  const decided = place === "done" && group.every(e => e.row.decided);
  const decision = decided ? "Kept" : undefined;
  const byThread = new Map<string, { edits: Omit<ThreadEdit, "at">[]; unkeep?: () => void }>();
  for (const entry of group) {
    const edits = entry.row.edits?.length ? entry.row.edits : entry.row.edit ? [entry.row.edit] : [];
    const cur = byThread.get(entry.threadId) ?? { edits: [], unkeep: entry.row.unkeep };
    for (const e of edits) {
      if (!cur.edits.some(x => editKey(x) === editKey(e))) cur.edits.push(e);
    }
    if (!cur.unkeep && entry.row.unkeep) cur.unkeep = entry.row.unkeep;
    byThread.set(entry.threadId, cur);
  }
  const leadEdits = byThread.get(lead.threadId)?.edits ?? [];
  const extraThreadEdits = [...byThread.entries()]
    .filter(([tid]) => tid !== lead.threadId)
    .map(([threadId, data]) => ({ threadId, edits: data.edits, ...(data.unkeep && { unkeep: data.unkeep }) }));
  const unkeeps = group.map(e => e.row.unkeep).filter((fn): fn is () => void => !!fn);
  const unkeep = decided && unkeeps.length > 0 ? () => { for (const fn of unkeeps) fn(); } : undefined;
  const was = [...new Set(group.flatMap(e => [e.key, ...(e.row.was ?? [])]).filter(k => k !== lead.key))];
  return {
    ...lead,
    place,
    at: unionStretch.start,
    row: {
      ...lead.row,
      was: was.length ? was : lead.row.was,
      at: unionStretch.start,
      displayAt: unionStretch.start,
      mark: unionStretch.start,
      stretch: unionStretch,
      continuousBroll: true,
      editKind: "broll",
      value: place === "done" ? (decision ?? "Kept") : "B-roll",
      decision,
      word: group.find(e => e.row.asks)?.row.word ?? group.find(e => e.row.pending)?.row.word ?? lead.row.word,
      needs: group.some(e => e.row.needs),
      asks: group.some(e => e.row.asks),
      pending: group.some(e => e.row.pending),
      busy: group.some(e => e.row.busy),
      revised: !group.some(e => e.row.pending) && group.some(e => e.row.revised),
      decided,
      forYou: group.some(e => e.row.forYou),
      version: Math.max(...group.map(e => e.row.version)),
      fresh: group.some(e => e.row.fresh),
      on: group.some(e => e.row.on),
      edits: leadEdits,
      ...(extraThreadEdits.length > 0 && { extraThreadEdits }),
      unkeep,
      nests: group.flatMap(e => e.row.nests),
    },
  };
}

/**
 * When a later request flags an edit made by an earlier request (`elsewhere: true`), both threads report that
 * `(changeId, spot)`. Keep a single entry across the merged dock, preferring active review states over `optional`.
 * Also collapses contiguous B-roll entries that belong to one continuous B-roll section into a single line item.
 */
export function dedupeDockEntries(entries: readonly DockEntry[]): DockEntry[] {
  const best = new Map<string, DockEntry>();
  for (const entry of entries) {
    const id = entryEditId(entry);
    if (!id) continue;
    const prev = best.get(id);
    if (!prev || PLACE_RANK[entry.place] > PLACE_RANK[prev.place]
      || (PLACE_RANK[entry.place] === PLACE_RANK[prev.place]
        && ((entry.row.needs && !prev.row.needs)
          || (entry.row.needs === prev.row.needs && entry.row.owns && !prev.row.owns)))) {
      best.set(id, entry);
    }
  }
  const unique = entries.filter(entry => {
    const id = entryEditId(entry);
    return !id || best.get(id) === entry;
  });
  const groups: DockEntry[][] = [];
  for (const entry of unique) {
    if (!isContinuousBrollDockEntry(entry)) {
      groups.push([entry]);
      continue;
    }
    const matching: DockEntry[][] = [];
    for (const g of groups) {
      if (g.some(prev => sameContinuousBrollDock(prev, entry))) matching.push(g);
    }
    if (matching.length) {
      const target = matching[0]!;
      for (let k = 1; k < matching.length; k++) {
        const extra = matching[k]!;
        target.push(...extra);
        const idx = groups.indexOf(extra);
        if (idx >= 0) groups.splice(idx, 1);
      }
      target.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups.map(synthesizeBrollDockGroup);
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

  // Live handler dispatchers: `sameReport` skips re-rendering ReviewDock when only handler closures refresh,
  // so ReviewDock invokes handlers through the store to always reach the latest render's closures.
  openRow(threadId: string, entryKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.row.open?.();
  }

  openMember(threadId: string, entryKey: string, memberKey: string) {
    this.reports.get(threadId)?.entries.find(e => e.key === entryKey)?.members?.find(m => m.key === memberKey)?.open?.();
  }

  unkeepRow(threadId: string, entryKey: string, threadIds?: readonly string[]) {
    if (threadIds) {
      const merged = this.allEntries(threadIds).find(e => e.key === entryKey);
      if (merged?.row.unkeep) { merged.row.unkeep(); return; }
    }
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

  /** All entries across all threads, deduplicated by edit identity and ordered by timeline time. */
  allEntries(threadIds: readonly string[]): DockEntry[] {
    const raw = dedupeDockEntries(this.orderedReports(threadIds).flatMap(r => r.entries));
    return inListOrder(raw, { numbers: false });
  }

  /** Find the merged dock entry containing a specific thread edit (including multi-thread continuous B-roll sections). */
  findForEdit(threadIds: readonly string[], threadId: string, ref: EditRef): DockEntry | undefined {
    for (const entry of this.allEntries(threadIds)) {
      if (entry.threadId === threadId) {
        if (entry.row.edit && matchesEdit(entry.row.edit, ref)) return entry;
        if (entry.row.edits?.some(e => matchesEdit(e, ref))) return entry;
      }
      if (entry.row.extraThreadEdits?.some(part => part.threadId === threadId && part.edits.some(e => matchesEdit(e, ref)))) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Priority-ordered Needs review entries: flagged/waiting rows first (timeline order), followed by
   * confident/unflagged rows when `showAll` is true (newest request first, timeline order within each request).
   */
  priorityForYou(threadIds: readonly string[], showAll: boolean): DockEntry[] {
    const ordered = this.orderedReports(threadIds);
    const deduped = dedupeDockEntries(ordered.flatMap(r => r.entries));
    const dedupedByKey = new Map(deduped.map(e => [e.key, e]));
    const waiting = inListOrder(
      deduped.filter(e => e.place === "you"),
      { numbers: false },
    );
    if (!showAll) return waiting;
    const confident = [...ordered].reverse().flatMap(r =>
      inListOrder(
        r.entries.flatMap(e => {
          const merged = dedupedByKey.get(e.key);
          return merged && merged.place === "optional" ? [merged] : [];
        }),
        { numbers: false },
      ),
    );
    return [...waiting, ...confident];
  }

  /** All confident (unflagged, undecided) edits grouped by thread, for Keep confident + Undo. */
  confidentEdits(threadIds: readonly string[]): Array<{ threadId: string; refs: Omit<ThreadEdit, "at">[] }> {
    const ordered = this.orderedReports(threadIds);
    const deduped = dedupeDockEntries(ordered.flatMap(r => r.entries));
    const byThread = new Map<string, Omit<ThreadEdit, "at">[]>();
    const addRefs = (tid: string, items: readonly Omit<ThreadEdit, "at">[]) => {
      const list = byThread.get(tid) ?? [];
      for (const e of items) {
        if (!list.some(x => editKey(x) === editKey(e))) list.push(e);
      }
      if (list.length) byThread.set(tid, list);
    };
    for (const entry of deduped) {
      if (entry.place !== "optional") continue;
      if (entry.row.edits?.length) addRefs(entry.threadId, entry.row.edits);
      else if (entry.members?.length) addRefs(entry.threadId, entry.members.flatMap(m => m.edit ? [m.edit] : []));
      else if (entry.row.edit) addRefs(entry.threadId, [entry.row.edit]);
      for (const extra of entry.row.extraThreadEdits ?? []) addRefs(extra.threadId, extra.edits);
    }
    const order = [...ordered].reverse().map(r => r.threadId);
    const out: Array<{ threadId: string; refs: Omit<ThreadEdit, "at">[] }> = [];
    for (const tid of order) {
      const refs = byThread.get(tid);
      if (refs?.length) out.push({ threadId: tid, refs });
    }
    for (const [tid, refs] of byThread) {
      if (!order.includes(tid) && refs.length) out.push({ threadId: tid, refs });
    }
    return out;
  }

  /** Navigable entries currently shown in the active tab of the docked tabbed view, top to bottom. */
  tabNavigable(threadIds: readonly string[], dockList: OpenList): DockEntry[] {
    const tab: ReviewTab = tabShown(dockList);
    if (tab === "you") {
      return this.priorityForYou(threadIds, true)
        .filter(e => !e.row.rejected && !!(e.row.stepOpen ?? e.row.open));
    }
    const all = this.allEntries(threadIds);
    return rowsOfTab(all, tab, false, { numbers: false })
      .filter(e => !e.row.rejected && !!(e.row.stepOpen ?? e.row.open));
  }

  /** Waiting ("Needs review") entries that still need a decision or an answer, ordered by timeline time. */
  waitingEntries(threadIds: readonly string[]): DockEntry[] {
    return this.priorityForYou(threadIds, false)
      .filter(e => (e.row.needs || e.row.asks) && !e.row.rejected && !!e.row.open);
  }

  /** Entries stepped through by Keep in the Priority list: waiting rows first, then confident rows when included. */
  keepEntries(threadIds: readonly string[], includeConfident: boolean): DockEntry[] {
    const waiting = this.waitingEntries(threadIds);
    if (!includeConfident) return waiting;
    return this.priorityForYou(threadIds, true)
      .filter(e => !e.row.rejected && !!e.row.open && (e.place === "optional" || e.row.needs || e.row.asks));
  }
}

/**
 * Step ↑ (-1) or ↓ (+1) through `nav` (Priority-ordered on Needs review: flagged rows in timeline order,
 * followed by confident rows newest-request-first). When `current` is in `nav`, steps strictly by index;
 * when `current` left `nav` (e.g. just rejected or from another tab), stays aligned with its tier.
 */
export function stepInDock(
  nav: readonly DockEntry[],
  current: DockEntry | undefined,
  where: { at: number; threadId?: string; tier?: "you" | "optional" },
  delta: number,
): DockEntry | undefined {
  const here = current ? nav.indexOf(current) : -1;
  if (here >= 0) return nav[here + delta];
  if (!nav.length) return undefined;
  if (where.tier && nav.every(e => e.place === "you" || e.place === "optional")) {
    if (where.tier === "you") {
      const you = nav.filter(e => e.place === "you");
      return delta > 0
        ? you.find(e => e.at >= where.at) ?? nav.find(e => e.place === "optional")
        : you.findLast(e => e.at < where.at);
    }
    const opt = nav.filter(e => e.place === "optional");
    if (!opt.length) return delta < 0 ? nav.at(-1) : undefined;
    const sameThread = where.threadId ? opt.filter(e => e.threadId === where.threadId) : opt;
    const pool = sameThread.length ? sameThread : opt;
    const pick = delta > 0 ? pool.find(e => e.at >= where.at) : pool.findLast(e => e.at < where.at);
    if (pick) return pick;
    return delta > 0 ? nav[nav.indexOf(pool.at(-1)!) + 1] : nav[nav.indexOf(pool[0]!) - 1];
  }
  return rowBeside(nav, undefined, { at: where.at }, delta, { numbers: false });
}

export const ReviewDockContext = createContext<ReviewDockStore | undefined>(undefined);

const noopSub = () => () => {};
const alwaysFalse = () => false;

/** Access the fixed bottom review dock store (undefined outside LegacySimpleWorkspace). */
export function useReviewDockStore(): ReviewDockStore | undefined {
  return useContext(ReviewDockContext);
}

/** Subscribe only to whether ANY thread in the project has review tabs (Needs review / Working / Done). */
export function useDockHasTabs(): boolean {
  const store = useContext(ReviewDockContext);
  return useSyncExternalStore(
    store?.subscribeHasTabs ?? noopSub,
    store?.hasTabsSnapshot ?? alwaysFalse,
    alwaysFalse,
  );
}
