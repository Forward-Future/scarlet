import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EditVersion, RejectedMark } from "../../components/review/ThreadEdits";
import { Icon } from "../../components/ui/primitives";
import { clock as clockLabel } from "../../lib/format";
import { inListOrder, ReviewLinger, tabShown, type ListOrder, type ReviewTab, type RowPlace } from "../../lib/reviewTabs";
import { useKeepSelectedInView } from "../../lib/uiHooks";
import { useLeavingRows } from "./lowRiskFold";
import { dedupeDockEntries, type DockEntry, type DockRow, type ReviewDockStore } from "./reviewDockStore";
import { useReviewTabHeight } from "./reviewTabHeight";
import { letGo, type PassList } from "./types";

const EMPTY_TAB = {
  you: "Nothing waits on you.",
  working: "Nothing in the works.",
  done: "Nothing decided yet.",
} as const;

const TIME_ORDER: ListOrder = { numbers: false };

const doneLabel = (count: number) => count === 1 ? "Keep the safe edit" : `Keep all ${count} safe edits`;

function DockReviewTabs({ need, optional, working, done, list: [open, setOpen], reveal, showNeeded }: {
  need: number; optional: number; working: number; done: number; list: PassList; reveal(): void; showNeeded(): void;
}) {
  const tab = tabShown(open);
  const total = need + optional;
  const show = (next: "working" | "done") => () => {
    if (tab === next) return;
    reveal();
    setOpen(next);
  };
  const tally = (n: number) => n > 0 && <span className="simple-review-tab-tally" aria-hidden="true">{n}</span>;
  const forYouTitle = need > 0 && optional > 0
    ? `${total} unreviewed (${need} ${need === 1 ? "needs" : "need"} you)`
    : need > 0 ? `${need} ${need === 1 ? "needs" : "need"} you`
    : optional > 0 ? `${optional} safe ${optional === 1 ? "edit" : "edits"}` : undefined;
  return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab simple-pass-need" aria-label="Needs review" aria-pressed={tab === "you"}
      title={forYouTitle} onClick={letGo(showNeeded)}>
      Needs review
      {total > 0 && (need > 0 && optional > 0
        ? <><span className="simple-review-tab-total" aria-hidden="true">{total}</span><span className="simple-review-tab-sep" aria-hidden="true">·</span><span className="simple-review-tab-count" aria-hidden="true">{need}</span></>
        : need > 0
          ? <span className="simple-review-tab-count" aria-hidden="true">{need}</span>
          : <span className="simple-review-tab-total" aria-hidden="true">{optional}</span>)}
    </button>
    <button type="button" className="simple-review-tab" aria-label="Working" aria-pressed={tab === "working"}
      title={working ? `${working} with Scarlet` : undefined} onClick={letGo(show("working"))}>Working{tally(working)}</button>
    <button type="button" className="simple-review-tab" aria-label="Done" aria-pressed={tab === "done"}
      title={done ? `${done} decided` : undefined} onClick={letGo(show("done"))}>Done{tally(done)}</button>
  </div>;
}

/**
 * The fixed bottom review lists dock for the non-beta workspace.
 * Sits between `.simple-chat` (above) and `.composer-dock` (below) so the combined Needs review
 * Priority list (flagged edits pinned on top, confident edits right below), Working, Done,
 * and See all lists stay fixed at the bottom while new messages flow above them.
 */
export function ReviewDock({ store, threadIds, list: listState, laterRequests = 0, onListOpen, onKeepConfident, flashedThreadId }: {
  store: ReviewDockStore;
  /** Thread ids in conversation order (oldest first) for deterministic tie-breaking. */
  threadIds: readonly string[];
  /** Active tab/filter state (`undefined`/`"all"` = Needs review All, `"need"` = Needs review Needs you only, `"working"`, `"done"`). */
  list: PassList;
  /** Number of requests in the chat above; an increase collapses held blank tab space. */
  laterRequests?: number;
  /** Notify the workspace when a pass's confident edits are shown on screen so the timeline marks them too. */
  onListOpen?(threadId: string, open: boolean, moved?: boolean): void;
  /** Keep all confident edits at once (with ⌘Z undo). */
  onKeepConfident?(): void;
  /** Thread whose rows briefly flash after clicking Show → in chat. */
  flashedThreadId?: string;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [linger] = useState(() => new ReviewLinger());
  useEffect(() => () => linger.dispose(), [linger]);
  useSyncExternalStore(linger.subscribe, linger.snapshot, linger.snapshot);

  const [open, setOpen] = listState;
  const host = useRef<HTMLDivElement>(null);
  useLeavingRows(host);
  const askedReveal = useRef(false);
  const reveal = () => { askedReveal.current = true; };

  const reports = store.orderedReports(threadIds);
  const loadedOf = new Map(reports.map(r => [r.threadId, r.listLoaded] as const));
  const hasTabs = reports.some(r => r.hasForYou);
  const tab: ReviewTab = tabShown(open);
  if (hasTabs && tab === "you") linger.needsOnly = open === "need";

  // Merge all threads' entries (deduplicated across cross-thread flags) in timeline order for tracking, Working, and Done.
  const deduped = hasTabs ? dedupeDockEntries(reports.flatMap(r => r.entries)) : [];
  const allowedKeys = new Set(deduped.map(e => e.key));
  const allEntries = hasTabs ? inListOrder(deduped, TIME_ORDER) : [];
  const inPlace = (place: RowPlace) => allEntries.filter(e => e.place === place);
  const optional = hasTabs ? inPlace("optional") : [];
  const need = hasTabs ? inPlace("you").filter(e => e.row.needs || e.row.asks).length : 0;
  const needsOnly = hasTabs && tab === "you" && open === "need" && need > 0;
  const optionalShown = hasTabs && tab === "you" && !needsOnly;
  const allLoaded = reports.length > 0 && reports.every(r => r.listLoaded !== false);

  // Automatically drop the "Needs you" filter once edit lists have loaded and no flagged edits remain so confident edits stay visible.
  useEffect(() => {
    if (hasTabs && allLoaded && open === "need" && need === 0 && optional.length > 0) setOpen(undefined);
  }, [hasTabs, allLoaded, open, need, optional.length, setOpen]);

  // While a pass's confident edits are shown in the dock (and its list has settled), notify the workspace so the timeline shows its cuts too.
  const openPassThreadId = optionalShown
    ? reports.find(r => r.isPass && r.listLoaded !== false && r.entries.some(e => e.place === "optional" && allowedKeys.has(e.key)))?.threadId
    : undefined;
  useEffect(() => {
    if (!onListOpen || !openPassThreadId) return;
    onListOpen(openPassThreadId, true, false);
    return () => { onListOpen(openPassThreadId, false); };
  }, [openPassThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hasTabs) {
    linger.track(
      allEntries
        .filter(e => e.row.callIndex !== undefined || loadedOf.get(e.threadId) !== false)
        .map(e => ({ key: e.key, place: e.place, was: e.row.was, busy: e.row.busy })),
      optionalShown,
      tab === "done",
    );
  }
  const heldFrom = (from: "you" | "optional" | "done") =>
    allEntries.filter(e => (from === "done" ? e.place === "working" : e.place === "working" || e.place === "done") && linger.of(e.key)?.from === from);

  // Priority list rows: flagged pinned at top (timeline order), confident right below (newest request first, timeline order within each request).
  const youRows = hasTabs && tab === "you"
    ? inListOrder(
      allEntries.filter(e => e.place === "you" || ((e.place === "working" || e.place === "done") && linger.of(e.key)?.from === "you")),
      TIME_ORDER,
    )
    : [];
  const lowRows = optionalShown
    ? [...reports].reverse().flatMap(r =>
      inListOrder(
        r.entries.filter(e => allowedKeys.has(e.key) && (e.place === "optional" || ((e.place === "working" || e.place === "done") && linger.of(e.key)?.from === "optional"))),
        TIME_ORDER,
      ),
    )
    : [];
  const lowKeys = new Set(lowRows.map(e => e.key));
  const youBaseRows = youRows.length;
  const workingCount = hasTabs ? inPlace("working").length : 0;
  const doneCount = hasTabs ? inPlace("done").length : 0;
  const doneRows = hasTabs ? doneCount + heldFrom("done").length : 0;

  // Count nested requests across visible entries so useReviewTabHeight knows when nested content changes.
  const visibleEntriesForCount = !hasTabs ? []
    : tab === "you" ? [...youRows, ...lowRows]
    : tab === "done" ? [...inPlace("done"), ...heldFrom("done")]
    : inPlace("working");
  const nestedCount = visibleEntriesForCount.reduce((n, e) => n + e.row.nests.length + (e.unfolded && e.members ? e.members.reduce((m, mem) => m + mem.nests.length, 0) : 0), 0);

  useReviewTabHeight(host, {
    enabled: hasTabs,
    tab,
    counts: { you: youBaseRows + lowRows.length, working: workingCount, done: doneRows },
    youBase: youBaseRows,
    hasLowRisk: need > 0 && optional.length > 0,
    lowOpen: optionalShown,
    nestedCount,
    laterRequests,
  });

  // Untabbed mode: show whichever thread opened "See all" / "See N edits so far", else any single open edit or rejected-only thread.
  const untabbedReport = !hasTabs
    ? reports.find(r => r.allOpen) ?? reports.find(r => r.singleOpen) ?? reports.find(r => r.onlyRejected)
    : undefined;
  const hasCalls = reports.some(r => r.hasCalls);

  type Drawn = { id: "all" | ReviewTab; label: string; rows: DockEntry[]; splitAt?: number };
  const drawn: Drawn[] = hasTabs
    ? tab === "you"
      ? [{
        id: "you",
        label: hasCalls ? "Calls and edits for you" : "Edits for you",
        rows: [...youRows, ...lowRows],
        splitAt: lowRows.length > 0 && (youRows.length > 0 || optional.length > 0) ? youRows.length : undefined,
      }]
      : [{
        id: tab,
        label: tab === "working" ? "With Scarlet" : "Decided",
        rows: inListOrder(tab === "done" ? [...inPlace("done"), ...heldFrom("done")] : inPlace(tab), TIME_ORDER),
      }]
    : untabbedReport
      ? [{
        id: "all",
        label: untabbedReport.isPass ? "Every edit" : "Edits in this thread",
        rows: untabbedReport.entries,
      }]
      : [];

  // Auto-switch tabs/filter when an edit or call is opened from outside (timeline dot, ⌘Z, Learnings, Show →).
  const onEntry = hasTabs ? allEntries.find(e => e.row.on || e.members?.some(m => m.on)) : undefined;
  const openId = onEntry?.row.id;
  const lastOpen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!hasTabs || !onEntry || openId === was) return;
    const shown = tab === "you" ? onEntry.place === "you" || (onEntry.place === "optional" && optionalShown) : onEntry.place === tab;
    if (!shown) setOpen(onEntry.place === "you" ? (linger.needsOnly ? "need" : undefined) : onEntry.place === "optional" ? undefined : onEntry.place);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset dock list state only when review tabs disappear after having been shown (never on initial mount before turns report).
  const hadTabs = useRef(false);
  if (hasTabs) hadTabs.current = true;
  useEffect(() => {
    if (hadTabs.current && !hasTabs && open !== undefined) {
      hadTabs.current = false;
      setOpen(undefined);
    }
  }, [hasTabs, open, setOpen]);

  // Bring the first row into view when explicitly switching tabs or opening an untabbed list via See all.
  const revealSeq = store.getRevealSeq();
  const lastRevealSeq = useRef(revealSeq);
  useEffect(() => {
    const fromStore = revealSeq !== lastRevealSeq.current;
    if (!askedReveal.current && !fromStore) return;
    const rows = host.current?.querySelector(".simple-pass-list");
    if (!rows) return;
    askedReveal.current = false;
    lastRevealSeq.current = revealSeq;
    if (!rows.querySelector('[aria-current="true"]')) {
      rows.querySelector(":scope > li:not(.review-tier-sep) > button")?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, untabbedReport?.threadId, revealSeq, drawn.length]);

  // Keep the currently open row scrolled into view as ↑ / ↓ / Keep step through the list.
  let selectedKey: string | undefined;
  scan: for (const list of drawn) {
    let before = 0;
    for (const entry of list.rows) {
      const { row, members, unfolded } = entry;
      if (row.on) { selectedKey = `${list.id}:${before}:${row.key}`; break scan; }
      before += 1 + row.nests.length;
      if (unfolded && members) for (const m of members) {
        if (m.on) { selectedKey = `${list.id}:${before}:member:${m.key}`; break scan; }
        before += 1 + m.nests.length;
      }
    }
  }
  useKeepSelectedInView(host, selectedKey, '.simple-pass-list [aria-current="true"]');

  const passApplying = reports.some(r => r.passApplying);
  const passErrorReport = reports.find(r => !!r.passError);

  if (!hasTabs && !untabbedReport && !passApplying && !passErrorReport) return null;

  const showNeeded = () => {
    setOpen(linger.needsOnly ? "need" : undefined);
    const waitingOpen = allEntries.some(e => (e.row.on && (e.row.needs || e.row.asks)) || e.members?.some(m => m.on && (m.needs || m.asks)));
    const confidentOpen = !waitingOpen && need === 0 && allEntries.some(e => e.row.on && e.place === "optional");
    if (!waitingOpen && !confidentOpen) {
      const target = inListOrder(inPlace("you"), TIME_ORDER).find(e => (e.row.needs || e.row.asks) && !!e.row.open) ?? lowRows.find(e => !!e.row.open);
      if (target) store.openRow(target.threadId, target.key);
    }
  };

  const pastHour = drawn.some(list => list.rows.some(({ row }) => clockLabel(row.displayAt).length > 5));

  const renderMember = (entry: DockEntry, m: DockRow) => (
    <li key={m.key} className={m.unkeep ? "has-unkeep" : undefined}>
      <button type="button" className={m.on ? "is-on" : m.decided ? "is-decided" : undefined} aria-current={m.on || undefined}
        data-log-control={m.dataLogControl} data-log-label="Edit in a moment" disabled={!m.open} title={m.title || m.label}
        onClick={letGo(() => store.openMember(entry.threadId, entry.key, m.key))}
        onPointerEnter={() => store.hoverRow(entry.threadId, m.mark, m.hover)} onPointerLeave={() => store.hoverRow(entry.threadId)}>
        <span className="simple-pass-label">
          {m.decided && !m.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}
          <span className="simple-pass-words">{m.label}</span>
          {m.version > 0 && <EditVersion n={m.version} hover={m.spent} />}
        </span>
        {m.value && !m.word && <span className={m.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={m.spent}>{m.value}</span>}
        {m.word && <span className={`simple-pass-check${m.revised || m.asks ? "" : " is-kept"}${m.busy ? " working-text" : ""}`} title={m.spent}>{m.word}</span>}
      </button>
      {m.unkeep && <span className="simple-row-unkeep"
        onPointerEnter={() => store.hoverRow(entry.threadId, m.mark, m.hover)} onPointerLeave={() => store.hoverRow(entry.threadId)}>
        <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
          aria-label={`Unkeep ${m.label}`} title={m.unkeepTip ?? "Unkeep"}
          onClick={letGo(() => store.unkeepMember(entry.threadId, entry.key, m.key))}>Unkeep</button>
      </span>}
      {m.nests.map(nest => nest.node)}
    </li>
  );

  const rowList = ({ id, label, rows: list, splitAt }: Drawn) => (
    <ol key={id} className={pastHour ? "simple-pass-list has-hours" : "simple-pass-list"} aria-label={label}>
      {list.map((entry, idx) => {
        const { row, members, more, moment, unfolded } = entry;
        const value = id === "all" ? row.value : row.decision ?? row.value;
        const heldRow = hasTabs ? linger.of(entry.key) : undefined;
        const leaving = !!heldRow?.leaving && (id === "you" ? heldRow.from === "you" || heldRow.from === "optional" : id === heldRow.from);
        const canUnkeepRow = !!row.unkeep && !leaving;
        const isLowRow = id === "you" && lowKeys.has(entry.key);
        const flashed = !!flashedThreadId && flashedThreadId === entry.threadId;
        return <Fragment key={row.key}>
          {splitAt !== undefined && idx === splitAt && (
            <li className={splitAt === 0 ? "review-tier-sep is-first" : "review-tier-sep"} role="presentation">
              <span className="review-tier-sep-row">
                <span className="review-tier-label">Safe edits ({optional.length})</span>
                {optional.length > 0 && onKeepConfident && (
                  <button type="button" className="review-head-keep" title={doneLabel(optional.length)} aria-label={doneLabel(optional.length)}
                    onClick={letGo(onKeepConfident)}>Keep {optional.length} safe {optional.length === 1 ? "edit" : "edits"}</button>
                )}
              </span>
            </li>
          )}
          <li className={[leaving && "is-leaving", canUnkeepRow && "has-unkeep"].filter(Boolean).join(" ") || undefined}
            data-thread={entry.threadId}
            data-low-risk={isLowRow ? "" : undefined}
            data-flash={flashed ? "" : undefined}>
            <button type="button"
              className={[
                row.on && "is-on",
                row.rejected && "is-rejected",
                row.asks && "is-asking",
                !row.on && !row.rejected && row.decided && (id !== "all" || entry.isPass) && "is-decided",
              ].filter(Boolean).join(" ") || undefined}
              aria-current={row.on || undefined}
              data-log-control={row.dataLogControl}
              data-log-label={row.dataLogLabel}
              disabled={!row.open}
              title={row.title || row.label}
              aria-label={row.ariaLabel}
              onClick={letGo(() => store.openRow(entry.threadId, entry.key))}
              onPointerEnter={() => store.hoverRow(entry.threadId, row.mark, row.hover)}
              onPointerLeave={() => store.hoverRow(entry.threadId)}>
              <span className={row.needs || row.asks ? "simple-pass-time is-need" : "simple-pass-time"}>
                {clockLabel(row.displayAt)}{(row.needs || row.asks) && <span>, needs you</span>}
              </span>
              <span className="simple-pass-label">
                {(row.rejected || row.skipped) && <RejectedMark />}
                {row.decided && !row.skipped && !row.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}
                <span className="simple-pass-words">{row.label}</span>
                {row.version > 0 && <EditVersion n={row.version} hover={row.spent} />}
                {row.fresh && <small className="edit-version is-new">New</small>}
                {more && moment && entry.onToggleMoment && <span className="simple-pass-more" aria-expanded={!!unfolded}
                  title={unfolded ? "Hide its edits" : "Show its edits"}
                  onClick={e => { e.stopPropagation(); store.toggleMoment(entry.threadId, entry.key); }}>{more}</span>}
              </span>
              {!row.word && value && <span className={row.asks ? "simple-pass-value is-need" : row.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={row.spent}>{value}</span>}
              {row.word && <span className={`simple-pass-check${row.revised || row.asks ? "" : " is-kept"}${row.busy ? " working-text" : ""}`} title={row.spent}>{row.word}</span>}
            </button>
            {canUnkeepRow && <span className="simple-row-unkeep"
              onPointerEnter={() => store.hoverRow(entry.threadId, row.mark, row.hover)} onPointerLeave={() => store.hoverRow(entry.threadId)}>
              <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
                aria-label={`Unkeep ${row.label}`} title={row.unkeepTip ?? "Unkeep"}
                onClick={letGo(() => store.unkeepRow(entry.threadId, entry.key))}>Unkeep</button>
            </span>}
            {row.nests.map(nest => nest.node)}
            {unfolded && members && <ol className="simple-pass-list is-moment" aria-label="Edits in this moment">
              {members.map(m => renderMember(entry, m))}
            </ol>}
          </li>
        </Fragment>;
      })}
    </ol>
  );

  const seeTab = !hasTabs && untabbedReport?.allOpen && !untabbedReport.soFar && untabbedReport.onCloseAll && (
    <div className="simple-review-tabs" role="group" aria-label="Edit lists">
      <button type="button" className="simple-review-tab is-see-all" aria-pressed title="Hide the edits" onClick={letGo(() => store.closeAll(untabbedReport.threadId))}>
        {untabbedReport.allLabel}
      </button>
    </div>
  );

  const isPassDock = hasTabs ? reports.some(r => r.isPass) : !!(untabbedReport?.isPass || passApplying || passErrorReport);

  return <div className="simple-review-dock" role="region" aria-label="Edit lists">
    <div ref={host} className="simple-pass" role="group" aria-label={isPassDock ? "Dialogue pass" : "Edits"}>
      {hasTabs && <DockReviewTabs need={need} optional={optional.length} working={workingCount} done={doneCount}
        list={listState} reveal={reveal} showNeeded={showNeeded} />}
      {seeTab}
      {hasTabs && tab === "you" && need > 0 && optional.length > 0 && (
        <div className="review-filter-bar" role="group" aria-label="Filter edits">
          <button type="button" className="review-filter-chip" aria-pressed={!needsOnly}
            onClick={letGo(() => setOpen(undefined))}>All {need + optional.length}</button>
          <button type="button" className="review-filter-chip is-warn" aria-pressed={needsOnly}
            onClick={letGo(() => setOpen("need"))}><span className="review-filter-dot" aria-hidden="true" />Needs you {need}</button>
        </div>
      )}
      {drawn.map(list => <Fragment key={list.id}>
        {list.rows.length > 0 ? rowList(list) : list.id !== "all" && <p className="simple-review-empty">{EMPTY_TAB[list.id]}</p>}
      </Fragment>)}
      {passApplying && <div className="simple-pass-line req-row"><span className="simple-pass-ok">Applying…</span></div>}
      {passErrorReport?.passError && <p className="simple-error" role="alert">
        {passErrorReport.passError}
        {passErrorReport.onRetryPass && <button type="button" className="simple-link req-recover" onClick={() => store.retryPass(passErrorReport.threadId)}>Retry</button>}
      </p>}
    </div>
  </div>;
}
