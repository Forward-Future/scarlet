import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EditVersion, RejectedMark } from "../../components/review/ThreadEdits";
import { Icon } from "../../components/ui/primitives";
import { clock as clockLabel } from "../../lib/format";
import { inListOrder, ReviewLinger, tabShown, type ListOrder, type ReviewTab, type RowPlace } from "../../lib/reviewTabs";
import { useKeepSelectedInView } from "../../lib/uiHooks";
import { useLowRiskFold, useLowRiskLine } from "./lowRiskFold";
import { LOW_RISK_TIP } from "./PassSummary";
import type { DockEntry, DockRow, ReviewDockStore } from "./reviewDockStore";
import { useReviewTabHeight } from "./reviewTabHeight";
import { letGo, type PassList } from "./types";

const EMPTY_TAB = {
  you: "Nothing waits on you.",
  working: "Nothing in the works.",
  done: "Nothing decided yet.",
} as const;

const TIME_ORDER: ListOrder = { numbers: false };

function LowRiskSwitch({ count, on, onToggle, leaving }: { count: number; on: boolean; onToggle(): void; leaving?: boolean }) {
  const edits = count === 1 ? "edit" : "edits";
  return <div className="simple-low-risk" inert={leaving || undefined} aria-hidden={leaving || undefined}>
    <button type="button" role="switch" className="simple-low-risk-toggle" aria-checked={on} aria-label={`Include ${count} low risk ${edits}`}
      aria-description={LOW_RISK_TIP} title={LOW_RISK_TIP} data-log-control="include-low-risk" onClick={letGo(onToggle)}>
      <span className="simple-low-risk-switch" aria-hidden="true" />
      <span className="simple-low-risk-words">{count} low risk {edits}</span>
    </button>
  </div>;
}

function DockReviewTabs({ need, working, done, list: [open, setOpen], reveal, showNeeded, extraAll, closeExplicit }: {
  need: number; working: number; done: number; list: PassList; reveal(): void; showNeeded(): void;
  extraAll?: { label: string; onClose(): void };
  closeExplicit?: () => void;
}) {
  const tab = extraAll || closeExplicit ? undefined : tabShown(open);
  const show = (next: "working" | "done") => () => {
    if (extraAll) extraAll.onClose();
    else closeExplicit?.();
    if (tab === next) return;
    reveal();
    setOpen(next);
  };
  const tally = (n: number) => n > 0 && <span className="simple-review-tab-tally" aria-hidden="true">{n}</span>;
  return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab simple-pass-need" aria-label="For you" aria-pressed={tab === "you"}
      title={need ? `${need} ${need === 1 ? "needs" : "need"} you` : undefined} onClick={letGo(() => { extraAll?.onClose(); closeExplicit?.(); showNeeded(); })}>
      For you{need > 0 && <span className="simple-review-tab-count" aria-hidden="true">{need}</span>}
    </button>
    <button type="button" className="simple-review-tab" aria-label="Working" aria-pressed={tab === "working"}
      title={working ? `${working} with Scarlet` : undefined} onClick={letGo(show("working"))}>Working{tally(working)}</button>
    <button type="button" className="simple-review-tab" aria-label="Done" aria-pressed={tab === "done"}
      title={done ? `${done} decided` : undefined} onClick={letGo(show("done"))}>Done{tally(done)}</button>
    {extraAll && <button type="button" className="simple-review-tab is-see-all" aria-pressed title="Hide the edits" onClick={letGo(extraAll.onClose)}>
      {extraAll.label}
    </button>}
  </div>;
}

/**
 * The fixed bottom review lists dock for the non-beta workspace.
 * Sits between `.simple-chat` (above) and `.composer-dock` (below) so the For you, Working,
 * Done, and See all lists stay fixed at the bottom while new messages flow above them.
 */
export function ReviewDock({ store, threadIds, list: listState, laterRequests = 0, onListOpen }: {
  store: ReviewDockStore;
  /** Thread ids in conversation order (oldest first) for deterministic tie-breaking. */
  threadIds: readonly string[];
  /** Active tab state for the docked tabbed lists (`undefined`/`"need"` = For you, `"all"` = For you + low risk, `"working"`, `"done"`). */
  list: PassList;
  /** Number of requests in the chat above; an increase collapses held blank tab space. */
  laterRequests?: number;
  /** Focus the timeline on an applied pass's edits while low-risk edits are included in the dock. */
  onListOpen?(threadId: string, open: boolean, moved?: boolean): void;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [linger] = useState(() => new ReviewLinger());
  useEffect(() => () => linger.dispose(), [linger]);
  useSyncExternalStore(linger.subscribe, linger.snapshot, linger.snapshot);

  const [open, setOpen] = listState;
  const host = useRef<HTMLDivElement>(null);
  const askedReveal = useRef(false);
  const reveal = () => { askedReveal.current = true; };

  const reports = store.orderedReports(threadIds);
  const tabReports = reports.filter(r => r.hasForYou);
  const hasTabs = tabReports.length > 0;
  const explicitAllReport = reports.find(r => !r.hasForYou && r.allOpen);
  const explicitSingleReport = !explicitAllReport ? reports.find(r => !r.hasForYou && r.singleOpen) : undefined;
  const explicitReport = explicitAllReport ?? explicitSingleReport;
  const tab: ReviewTab = tabShown(open);
  const optionalOpen = hasTabs && !explicitReport && open === "all";
  // Working and Done have no low risk switch: For you comes back with it as it was left.
  if (hasTabs && !explicitReport && tab === "you") linger.lowRisk = optionalOpen;

  // Low risk rows open into For you's one list and close out of it without shifting what's in view.
  const low = useLowRiskFold(host, optionalOpen && tab === "you", on => setOpen(on ? "all" : undefined), hasTabs && !explicitReport && tab === "you");

  // Merge entries from threads with review lists in timeline order when in tabbed mode.
  const allEntries = hasTabs ? inListOrder(tabReports.flatMap(r => r.entries), TIME_ORDER) : [];
  if (hasTabs) {
    linger.track(
      allEntries.map(e => ({ key: e.key, place: e.place, was: e.row.was, busy: e.row.busy })),
      optionalOpen && tab === "you",
      tab === "done",
    );
  }
  const heldFrom = (from: "you" | "optional" | "done") =>
    allEntries.filter(e => (from === "done" ? e.place === "working" : e.place === "working" || e.place === "done") && linger.of(e.key)?.from === from);
  const inPlace = (place: RowPlace) => allEntries.filter(e => e.place === place);

  const optional = hasTabs ? inPlace("optional") : [];
  const lowLine = useLowRiskLine(host, optional.length, hasTabs && !explicitReport && tab === "you");
  const lowRows = hasTabs && !explicitReport && low.shown ? [...optional, ...heldFrom("optional")] : [];
  const lowKeys = new Set(lowRows.map(e => e.key));
  const need = hasTabs ? tabReports.reduce((sum, r) => sum + r.need, 0) : 0;
  const youBaseRows = hasTabs ? inPlace("you").length + heldFrom("you").length : 0;
  const workingCount = hasTabs ? inPlace("working").length : 0;
  const doneCount = hasTabs ? inPlace("done").length : 0;
  const doneRows = hasTabs ? doneCount + heldFrom("done").length : 0;

  // Count nested requests across visible entries so useReviewTabHeight knows when nested content changes.
  const visibleEntriesForCount = !hasTabs || explicitReport ? []
    : tab === "you" ? allEntries.filter(e => e.place === "you" || ((e.place === "working" || e.place === "done") && linger.of(e.key)?.from === "you") || lowKeys.has(e.key))
    : tab === "done" ? [...inPlace("done"), ...heldFrom("done")]
    : inPlace("working");
  const nestedCount = visibleEntriesForCount.reduce((n, e) => n + e.row.nests.length + (e.unfolded && e.members ? e.members.reduce((m, mem) => m + mem.nests.length, 0) : 0), 0);

  useReviewTabHeight(host, {
    enabled: hasTabs && !explicitReport,
    tab,
    counts: { you: youBaseRows + lowRows.length, working: workingCount, done: doneRows },
    youBase: youBaseRows,
    hasLowRisk: optional.length > 0,
    lowOpen: low.shown,
    lowClosing: low.closing,
    nestedCount,
    laterRequests,
  });

  // Untabbed mode (or an explicitly opened "See all" / "See edit" / "See N edits so far" on a thread with no review items).
  const untabbedReport = explicitReport ?? (!hasTabs ? reports.find(r => r.onlyRejected) : undefined);
  const hasCalls = tabReports.some(r => r.hasCalls);

  type Drawn = { id: "all" | ReviewTab; label: string; rows: DockEntry[] };
  const drawn: Drawn[] = untabbedReport
    ? [{
      id: "all",
      label: untabbedReport.isPass ? "Every edit" : "Edits in this thread",
      rows: untabbedReport.entries,
    }]
    : hasTabs
      ? tab === "you"
        ? [{
          id: "you",
          label: hasCalls ? "Calls that need you" : "Edits that need you",
          rows: inListOrder(
            allEntries.filter(e => e.place === "you" || ((e.place === "working" || e.place === "done") && linger.of(e.key)?.from === "you") || lowKeys.has(e.key)),
            TIME_ORDER,
          ),
        }]
        : [{
          id: tab,
          label: tab === "working" ? "With Scarlet" : "Decided",
          rows: inListOrder(tab === "done" ? [...inPlace("done"), ...heldFrom("done")] : inPlace(tab), TIME_ORDER),
        }]
      : [];

  // Auto-switch tabs when an edit or call is opened from outside (timeline dot, ⌘Z, Learnings, "See edit").
  const onEntry = hasTabs ? allEntries.find(e => e.row.on || e.members?.some(m => m.on)) : undefined;
  const openId = onEntry?.row.id;
  const lastOpen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!hasTabs || !onEntry || openId === was) return;
    if (explicitReport && onEntry.threadId === explicitReport.threadId) return;
    if (explicitAllReport) store.closeAll(explicitAllReport.threadId);
    const shown = !explicitReport && (tab === "you" ? onEntry.place === "you" || (onEntry.place === "optional" && optionalOpen) : onEntry.place === tab);
    if (!shown) setOpen(onEntry.place === "you" ? (linger.lowRisk ? "all" : undefined) : onEntry.place === "optional" ? "all" : onEntry.place);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset dock list state only when review tabs actually disappear (never on initial mount before threads report).
  const hadTabs = useRef(hasTabs);
  useEffect(() => {
    if (hadTabs.current && !hasTabs && open !== undefined) setOpen(undefined);
    hadTabs.current = hasTabs;
  }, [hasTabs, open, setOpen]);

  // While low-risk edits are toggled on in the dock, an applied pass's full cuts take the timeline until toggled off.
  const dockedPassThread = hasTabs && !explicitAllReport && open === "all"
    ? [...tabReports].reverse().find(r => r.isPass && r.entries.some(e => !!e.row.edit))?.threadId
    : undefined;
  useEffect(() => {
    if (!dockedPassThread || !onListOpen) return;
    onListOpen(dockedPassThread, true, false);
    return () => onListOpen(dockedPassThread, false);
  }, [dockedPassThread]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the first row into view when explicitly switching tabs or opening "See all" (unless a row is already selected).
  const revealSeq = store.getRevealSeq();
  const seenReveal = useRef(revealSeq);
  useEffect(() => {
    const requested = askedReveal.current || revealSeq !== seenReveal.current;
    if (!requested) return;
    const rows = host.current?.querySelector(".simple-pass-list");
    if (!rows) return;
    seenReveal.current = revealSeq;
    askedReveal.current = false;
    if (!rows.querySelector('[aria-current="true"]')) {
      rows.querySelector(":scope > li > button")?.scrollIntoView?.({ block: "nearest" });
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
    setOpen(was => was === "all" || linger.lowRisk ? "all" : undefined);
    if (!allEntries.some(e => (e.row.on && (e.row.needs || e.row.asks)) || e.members?.some(m => m.on && (m.needs || m.asks)))) {
      const target = inListOrder(inPlace("you"), TIME_ORDER).find(e => (e.row.needs || e.row.asks) && !!e.row.open);
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

  const rowList = ({ id, label, rows: list }: Drawn) => (
    <ol key={id} className={pastHour ? "simple-pass-list has-hours" : "simple-pass-list"} aria-label={label}>
      {list.map(entry => {
        const { row, members, more, moment, unfolded } = entry;
        const value = id === "all" ? row.value : row.decision ?? row.value;
        const heldRow = hasTabs ? linger.of(entry.key) : undefined;
        const leaving = !!heldRow?.leaving && (id === "you" ? heldRow.from === "you" || heldRow.from === "optional" : id === heldRow.from);
        const canUnkeepRow = !!row.unkeep && !leaving;
        return <li key={row.key}
          data-thread={entry.threadId}
          className={[leaving && "is-leaving", canUnkeepRow && "has-unkeep"].filter(Boolean).join(" ") || undefined}
          data-low-risk={id === "you" && lowKeys.has(entry.key) ? "" : undefined}>
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
            title={row.title}
            aria-label={row.ariaLabel}
            onClick={letGo(() => store.openRow(entry.threadId, entry.key))}
            onPointerEnter={() => store.hoverRow(entry.threadId, row.mark, row.hover)}
            onPointerLeave={() => store.hoverRow(entry.threadId)}>
            <span className={row.needs || row.asks ? "simple-pass-time is-need" : "simple-pass-time"}>
              {clockLabel(row.displayAt)}{entry.isPass && (row.needs || row.asks) && <span>, needs you</span>}
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
        </li>;
      })}
    </ol>
  );

  const extraAll = explicitAllReport && !explicitAllReport.soFar && explicitAllReport.onCloseAll
    ? { label: explicitAllReport.allLabel, onClose: () => store.closeAll(explicitAllReport.threadId) } : undefined;
  const closeExplicit = explicitSingleReport ? () => store.closeSingle(explicitSingleReport.threadId) : undefined;
  const seeTab = !hasTabs && untabbedReport?.allOpen && !untabbedReport.soFar && untabbedReport.onCloseAll && (
    <div className="simple-review-tabs" role="group" aria-label="Edit lists">
      <button type="button" className="simple-review-tab is-see-all" aria-pressed title="Hide the edits" onClick={letGo(() => store.closeAll(untabbedReport.threadId))}>
        {untabbedReport.allLabel}
      </button>
    </div>
  );

  const isPassDock = untabbedReport ? untabbedReport.isPass : tabReports.some(r => r.isPass);

  return <div className="simple-review-dock" role="region" aria-label="Edit lists">
    <div ref={host} className="simple-pass" role="group" aria-label={isPassDock ? "Dialogue pass" : "Edits"}>
      {hasTabs && <DockReviewTabs need={need} working={workingCount} done={doneCount} list={listState} reveal={reveal} showNeeded={showNeeded} extraAll={extraAll} closeExplicit={closeExplicit} />}
      {seeTab}
      {lowLine && <LowRiskSwitch count={lowLine.count} on={optionalOpen} onToggle={low.toggle} leaving={lowLine.leaving} />}
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
