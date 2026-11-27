import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { brollSectionForEdit, continuousBrollSections, matchesEdit, REVISED_CHECK, type ThreadEdit } from "@scarlet/shared";
import { useShownCut } from "../../stores/shownCut";
import { EditVersion, RejectedMark, ThreadAction, ThreadEdits } from "../../components/review/ThreadEdits";
import { asksEditor, listPlaces, revisionWord } from "../../components/review/threadEditState";
import { Icon } from "../../components/ui/primitives";
import { editRowWord } from "../../lib/editKind";
import { clock as clockLabel, lengthLabel } from "../../lib/format";
import { editKey, unkeepEdits } from "../../lib/keptEdits";
import { madeSentence } from "../../lib/madeSentence";
import { inListOrder, ReviewLinger, tabShown, type ListOrder, type ReviewTab, type RowPlace } from "../../lib/reviewTabs";
import { type Thread } from "../../lib/threads";
import { useKeepSelectedInView } from "../../lib/uiHooks";
import { recordUndo } from "../../lib/undo";
import { useProjectStore } from "../../stores/project";
import { useLowRiskFold, useLowRiskLine } from "./lowRiskFold";
import { EditResultLink, entryKeys, Made, namedEdit, nestsUnder, passEntries, passMade, selectedRowKey, useListOpen, usePassFacts, useReveal, useThreadFacts, threadRowPlaces, type Entry, type PassRow } from "./passRows";
import { useDockHasTabs, useReviewDockStore, type DockEntry, type DockRow } from "./reviewDockStore";
import { useReviewTabHeight } from "./reviewTabHeight";
import { callRowKey, isWorking, letGo, listedBefore, noNests, noRejected, noSpent, type ChatActions, type Nest, type PassList, type Spent } from "./types";

/**
 * The three tabs over a request's rows once it has something for the editor to review: Needs review, Working and Done.
 * Every edit and call is under exactly one of them. A count shows only when there is one: Needs review's in amber, since
 * it is what waits on the editor, the others' muted.
 */
function ReviewListTabs({ need, working, done, list: [open, setOpen], reveal, showNeeded }: {
  need: number; working: number; done: number; list: PassList; reveal(): void; showNeeded(): void;
}) {
  const tab = tabShown(open);
  const show = (next: "working" | "done") => () => {
    if (tab === next) return;
    reveal();
    setOpen(next);
  };
  const tally = (n: number) => n > 0 && <span className="simple-review-tab-tally" aria-hidden="true">{n}</span>;
  return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab simple-pass-need" aria-label="Needs review" aria-pressed={tab === "you"}
      title={need ? `${need} ${need === 1 ? "needs" : "need"} you` : undefined} onClick={letGo(showNeeded)}>
      Needs review{need > 0 && <span className="simple-review-tab-count" aria-hidden="true">{need}</span>}
    </button>
    <button type="button" className="simple-review-tab" aria-label="Working" aria-pressed={tab === "working"}
      title={working ? `${working} with Scarlet` : undefined} onClick={letGo(show("working"))}>Working{tally(working)}</button>
    <button type="button" className="simple-review-tab" aria-label="Done" aria-pressed={tab === "done"}
      title={done ? `${done} decided` : undefined} onClick={letGo(show("done"))}>Done{tally(done)}</button>
  </div>;
}

/** What "low risk edits" says on hover: what those edits are and that nothing waits on them. */
export const LOW_RISK_TIP = "Edits Scarlet is confident about. They go into the video without your OK. Include them to look them over.";

/**
 * The one quiet line under Needs review's tabs, for the edits Scarlet didn't flag and the editor hasn't decided: a small
 * switch and their count ("22 low risk edits"). On, they are in Needs review's list, in their place among the rows that
 * wait; off until pressed (the editor chose the switch on 2026-11-24, in place of a box and "Include 22 low risk edits").
 */
function LowRisk({ count, on, onToggle, leaving }: { count: number; on: boolean; onToggle(): void;
  /** The last of them was just kept: the line closes, and takes no press meanwhile. */
  leaving?: boolean }) {
  const edits = count === 1 ? "edit" : "edits";
  return <div className="simple-low-risk" inert={leaving || undefined} aria-hidden={leaving || undefined}>
    <button type="button" role="switch" className="simple-low-risk-toggle" aria-checked={on} aria-label={`Include ${count} safe ${edits}`}
      aria-description={LOW_RISK_TIP} title={LOW_RISK_TIP} data-log-control="include-low-risk" onClick={letGo(onToggle)}>
      <span className="simple-low-risk-switch" aria-hidden="true" />
      <span className="simple-low-risk-words">{count} safe {edits}</span>
    </button>
  </div>;
}

/** What an empty tab says. Needs review says it whenever its list has no row, low risk edits included or not. */
const EMPTY_TAB = { you: "Nothing waits on you.", working: "Nothing in the works.", done: "Nothing decided yet." } as const;

/** The rows a turn holds for its lists while its block moves: which were just acted on, and the edit last opened. */
function useHeldRows(held?: ReviewLinger) {
  const [own] = useState(() => new ReviewLinger());
  useEffect(() => () => own.dispose(), [own]);
  const linger = held ?? own;
  useSyncExternalStore(linger.subscribe, linger.snapshot, linger.snapshot);
  return linger;
}

/**
 * What a dialogue pass made, as the rows of its block. Once it has something for the editor to review, its rows sit
 * under three tabs and each is under exactly one. Needs review, shown until another is pressed, lists what waits on the
 * editor: open calls and flagged edits, each by its time, with Scarlet's note. Pressed, it opens
 * the first one still waiting. A row the editor has just decided or sent back stays there a moment with its new word,
 * then fades and leaves. Over those rows one box includes the edits Scarlet didn't flag ("Include 112 low risk edits");
 * ticked, they join Needs review's list in their place in the video, edits that play as one change on one row. Working has the rows Scarlet has, each with
 * the editor's request under it, and Done every decided row. A pass with nothing to review has one list of every edit,
 * behind See all. Once Scarlet is done, what the pass applied is one sentence above the list. A row is one line and
 * opens its edit or call in the card on the timeline, where Keep and Reject edit move on to the next that waits. A
 * request about one cut or edit that is still in the chat (`nests`) sits directly under that cut's or edit's row.
 * `aside` is what the run used, when that shows.
 */
export function PassSummary({ projectId, thread, edits, rejected = noRejected, actions, aside, list: listState, listedNeed, working, nests = noNests, spent = noSpent, linger: heldLinger, lastOpen: heldOpen, listLoaded, onTabs, laterRequests = 0 }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[];
  /** Hears whether the rows are under Needs review, Working and Done: Scarlet's reply then stays over them. */
  onTabs?(tabbed: boolean): void;
  /** Edits the editor rejected: out of the video, each keeps a row in the list of every edit, with a × and "Rejected". */
  rejected?: Omit<ThreadEdit, "at">[];
  actions: ChatActions; aside?: ReactNode; list: PassList; listedNeed: RefObject<Set<string>>; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** The rows just acted on and the edit last opened, held by the turn: see `ThreadResult`. */
  linger?: ReviewLinger; lastOpen?: RefObject<string | undefined>;
  /** True once this thread's live edit list has settled (so initial saved → located arrival won't linger rows). */
  listLoaded?: boolean;
  /** Newer requests below this one in the chat; an increase collapses held blank tab space. */
  laterRequests?: number }) {
  const facts = usePassFacts({ projectId, thread, edits, rejected, actions, listedNeed, working });
  const { pass, need, hasForYou, totalRows, fold, single, empty, waiting } = facts;
  const linger = useHeldRows(heldLinger);
  const [open, setOpen] = listState;
  const paused = useProjectStore(s => s.current?.id === projectId ? !!s.current.project.editingPaused : false);
  const { timeline } = useShownCut();
  const media = useProjectStore(s => s.current?.media);
  const brollSections = useMemo(() => timeline ? continuousBrollSections(timeline, media) : undefined, [timeline, media]);
  const [host, reveal] = useReveal(open);
  const dock = useReviewDockStore();
  const dockHasTabs = useDockHasTabs();
  const tab = tabShown(open);
  const optionalOpen = hasForYou && open === "all";
  // Working and Done have no low risk switch: Needs review comes back with it as it was left.
  if (!dock && hasForYou && tab === "you") linger.lowRisk = optionalOpen;
  useLayoutEffect(() => { onTabs?.(hasForYou); }, [hasForYou]); // eslint-disable-line react-hooks/exhaustive-deps
  // Low risk rows open into the list and close out of it: `low.shown` while the list still draws them.
  const low = useLowRiskFold(host, !dock && optionalOpen && tab === "you", on => setOpen(on ? "all" : undefined), !dock && hasForYou && tab === "you");
  // A single preview follows the open card. An explicitly opened list keeps the timeline on the whole pass.
  const fullList = (dock ? !hasForYou : true) && open === "all" && edits.length > 0;
  // With nothing left in the video and nothing for the editor, the rejected edits' rows are all there is: they show
  // without a click or a tab, so a request whose only edit was rejected still says so (2026-11-23).
  const onlyRejected = !edits.length && rejected.length > 0 && !pass && !hasForYou;
  const listed = fullList || onlyRejected || (!!single && !hasForYou && open !== "need" && !!actions.showing && matchesEdit(actions.showing, single));
  // The Needs review list closes only if there are no Needs review items at all.
  useEffect(() => { if (open === "need" && !hasForYou) setOpen(undefined); }, [open, hasForYou]); // eslint-disable-line react-hooks/exhaustive-deps
  useListOpen(actions, thread.id, fullList);
  const editOf = new Map(edits.map(e => [editKey(e), e] as const));
  const editIndexOf = new Map(edits.map((e, i) => [editKey(e), i + 1] as const));
  const callIndexOf = new Map((pass?.calls ?? []).map(c => [callRowKey(c), c.index] as const));
  const { rows, calls, entries } = passEntries(facts, { projectId, thread, edits, rejected, actions, nests },
    // A folded pass with nothing to review has no rows to draw unless the bottom dock renders it.
    { drawRows: hasForYou || listed || !!dock, numbers: true, backToReview: dockHasTabs || hasForYou });
  // A row that has just left Needs review for Working or Done, or Done for Working, stays a moment where it was, with its new word.
  if (!dock && hasForYou) {
    const callKeys = listLoaded === false ? new Set(entries.filter(e => e.row.n > 0).map(e => e.key)) : undefined;
    linger.track(
      entries
        .filter(e => e.row.n > 0 || listLoaded !== false)
        .map(e => ({ key: e.key, place: e.place, was: e.row.was, busy: e.row.busy })),
      optionalOpen && tab === "you",
      tab === "done",
      callKeys ? key => !callKeys.has(key) : undefined,
    );
  }
  const heldFrom = (from: "you" | "optional" | "done") => entries.filter(e => (from === "done" ? e.place === "working" : e.place === "working" || e.place === "done") && linger.of(e.key)?.from === from);
  const inPlace = (place: RowPlace) => entries.filter(e => e.place === place);
  // Every list goes by time, as its rows lead with their times (the editor's call, 2026-11-24): low risk rows open in
  // their place among the ones that wait, and nothing else in the list moves or changes.
  const order: ListOrder = { numbers: false };
  const optional = inPlace("optional");
  const lowLine = useLowRiskLine(host, optional.length, !dock && hasForYou && tab === "you");
  // The rows that are in Needs review's list only while low risk edits are included, each marked so it can open and close.
  const lowRows = low.shown ? [...optional, ...heldFrom("optional")] : [];
  const lowKeys = new Set(lowRows.map(e => e.key));
  const youBaseRows = inPlace("you").length + heldFrom("you").length;
  const workingCount = inPlace("working").length;
  const doneCount = inPlace("done").length;
  const doneRows = doneCount + heldFrom("done").length;
  useReviewTabHeight(host, {
    enabled: !dock && hasForYou && !empty,
    tab,
    counts: { you: youBaseRows + lowRows.length, working: workingCount, done: doneRows },
    youBase: youBaseRows,
    hasLowRisk: optional.length > 0,
    lowOpen: low.shown,
    lowClosing: low.closing,
    nestedCount: nests.length,
    laterRequests,
  });
  // The lists on screen, top to bottom. With nothing to review there is the one list of every edit.
  type Drawn = { id: "all" | ReviewTab; label: string; rows: Entry[] };
  const drawn: Drawn[] = !hasForYou ? (listed ? [{ id: "all", label: "Every edit", rows: entries }] : [])
    : tab === "you" ? [
      // With low risk edits included they are in the one list, in their place in the video among the rows that wait.
      { id: "you", label: pass && calls.length ? "Calls that need you" : "Edits that need you",
        rows: inListOrder(entries.filter(e => e.place === "you" || ((e.place === "working" || e.place === "done") && linger.of(e.key)?.from === "you") || lowKeys.has(e.key)), order) },
    ] : [{ id: tab, label: tab === "working" ? "With Scarlet" : "Decided",
      rows: inListOrder(tab === "done" ? [...inPlace("done"), ...heldFrom("done")] : inPlace(tab), order) }];
  if (dock) {
    if (hasForYou) for (const e of entries) if (e.place === "you" && e.row.forYou) listedNeed.current.add(e.row.key);
  } else {
    for (const list of drawn) if (list.id === "you") for (const { row } of list.rows) if (row.forYou) listedNeed.current.add(row.key);
  }
  // Needs review opens the first waiting row on the timeline, or leaves it open if the editor is already on one.
  const showNeeded = () => {
    setOpen(was => was === "all" || linger.lowRisk ? "all" : undefined);
    if (!rows.some(row => row.on && row.needs)) inListOrder(inPlace("you"), order).find(e => e.row.needs)?.row.open?.();
  };
  // An edit or a call opened from somewhere else (the timeline, ⌘Z) shows the tab that holds it. One opened from the
  // list, stepped to or moved on to is in the tab shown already. The same one still open when the block is mounted
  // anew, between the conversation and the place above the message box, leaves the tabs as they were.
  const onEntry = hasForYou ? entries.find(e => e.row.on || e.members?.some(m => m.on)) : undefined;
  const ownOpen = useRef<string>(undefined);
  const lastOpen = heldOpen ?? ownOpen;
  const openId = onEntry?.row.id;
  useEffect(() => {
    if (dock) return;
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!onEntry || openId === was) return;
    // A row still in Needs review only for the moment after it was decided is Working's or Done's.
    const shown = tab === "you" ? onEntry.place === "you" || (onEntry.place === "optional" && optionalOpen) : onEntry.place === tab;
    if (!shown) setOpen(onEntry.place === "you" ? linger.lowRisk ? "all" : undefined : onEntry.place === "optional" ? "all" : onEntry.place);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  // While the pass's calls are listed, what is outside the list comes after it.
  const callsListed = hasForYou && !!pass && calls.length > 0;
  // What it came to, with the link that opens every edit after it. The edits the sentence would name are said by their
  // rows while the lists on screen have one for each of them. Low risk rows don't count: including them changes the
  // list and nothing over it.
  const onScreen = new Set(drawn.flatMap(list => list.rows.filter(e => list.id !== "you" || !lowKeys.has(e.key)).flatMap(entryKeys)));
  const rowsName = dock ? (!hasForYou && open === "all") : (drawn.length > 0 && !callsListed && edits.filter(namedEdit).every(e => onScreen.has(editKey(e))));
  const made = passMade(facts, edits, rejected, calls, working, rowsName);
  const under = (entry: Entry) => nestsUnder(nests, entry);
  useKeepSelectedInView(host, !dock && !empty ? selectedRowKey(drawn, nests) : undefined, ".simple-pass-list [aria-current=\"true\"]");
  const soFar = (!!working || !!pass?.running) && !made;
  const ownsEdit = (e: Omit<ThreadEdit, "at">) =>
    thread.changes.some(c => c.id === e.changeId) || e.previous.some(p => thread.changes.some(c => c.id === p.changeId));
  const dockRowOf = (r: PassRow, rowNests: readonly Nest[], extra?: { more?: string; moment?: string }): DockRow => {
    const callIdx = callIndexOf.get(r.key);
    const edit = editOf.get(r.key);
    return {
      key: `${thread.id}/${r.key}`,
      rawKey: r.key,
      threadId: thread.id,
      id: `${thread.id}/${r.id}`,
      was: r.was?.map(w => `${thread.id}/${w}`),
      at: r.at,
      displayAt: r.displayAt,
      mark: r.mark,
      hover: r.hover,
      label: r.label,
      n: r.n,
      num: r.num,
      decision: r.decision,
      value: r.value,
      word: r.word,
      revised: r.revised,
      rejected: r.rejected,
      skipped: r.skipped,
      forYou: r.forYou,
      busy: r.busy,
      pending: r.pending,
      needs: r.needs,
      asks: r.asks,
      decided: r.decided,
      version: r.version,
      fresh: r.fresh,
      title: r.title || r.label,
      ariaLabel: extra?.more ? `${clockLabel(r.displayAt)} ${r.label}, ${extra.more.replace("+ ", "and ")}` : r.rejected ? `${clockLabel(r.displayAt)} ${r.label}, rejected` : undefined,
      on: r.on,
      open: r.open,
      stepOpen: r.open ?? (callIdx !== undefined && pass ? () => pass.openCall(callIdx) : undefined),
      unkeep: r.unkeep,
      unkeepTip: r.unkeepTip,
      spent: spent.get(r.key),
      dataLogControl: "open-pass-item",
      dataLogLabel: extra?.moment ? "Moment" : "Pass item",
      callIndex: callIdx,
      edit,
      editKind: edit?.kind,
      stretch: edit?.range,
      brollSectionId: edit?.kind === "broll" && brollSections ? (brollSectionForEdit(brollSections, edit.range)?.id ?? null) : undefined,
      owns: edit ? ownsEdit(edit) : undefined,
      editOrder: editIndexOf.has(r.key) ? { index: editIndexOf.get(r.key)!, of: edits.length } : undefined,
      nests: rowNests,
    };
  };
  const dockEntries: DockEntry[] = !dock || empty ? [] : entries.map(entry => ({
    key: `${thread.id}/${entry.key}`,
    threadId: thread.id,
    row: dockRowOf(entry.row, under(entry), { more: entry.more, moment: entry.moment }),
    members: entry.members?.map(m => dockRowOf(m, nests.filter(nest => nest.key === m.key && m.key !== entry.row.key))),
    more: entry.more,
    moment: entry.moment,
    unfolded: entry.unfolded,
    onToggleMoment: entry.moment ? () => fold(entry.moment!) : undefined,
    place: entry.place,
    at: entry.at,
    num: entry.num,
    isPass: true,
  }));
  const singleOpen = !!single && ownsEdit(single) && !hasForYou && !dockHasTabs && open !== "need" && !!actions.showing && matchesEdit(actions.showing, single);
  const allRowsCount = totalRows + rejected.length;
  useLayoutEffect(() => {
    if (!dock) return;
    if (empty) { dock.report(thread.id); return; }
    dock.report(thread.id, {
      threadId: thread.id,
      isPass: true,
      hasCalls: !!pass && calls.length > 0,
      hasForYou,
      need,
      entries: dockEntries,
      allOpen: !hasForYou && open === "all" && edits.length > 0,
      allLabel: allRowsCount === 2 ? "See both" : "See all",
      soFar,
      onCloseAll: () => setOpen(undefined),
      onlyRejected,
      singleOpen,
      onCloseSingle: () => actions.stopShowing(),
      listLoaded,
      passApplying: !!(waiting && pass?.deciding),
      passError: pass?.error || undefined,
      onRetryPass: waiting && !pass?.deciding ? pass?.apply : undefined,
      onRowHover: (mark, hover) => actions.lightMark(mark, hover),
    });
  });
  useLayoutEffect(() => () => dock?.report(thread.id), [dock, thread.id]);
  if (empty) return null;
  // A request whose row is under a tab is drawn there, under that row, and nowhere else. One about a cut or edit with
  // no row at all still shows, under what the pass made.
  const placed = new Set((dock ? (dockHasTabs || listed ? entries : []) : hasForYou ? entries : drawn.flatMap(list => list.rows)).flatMap(entryKeys));
  const pastHour = drawn.some(list => list.rows.some(({ row }) => clockLabel(row.displayAt).length > 5));
  const rowList = ({ id, label, rows: list }: Drawn) => {
    // Every list leads with each row's time and keeps its version and amount: the time is bold amber on a tint while
    // the row needs the editor, and a decided row is ticked. A pass's rows lead with times while it waits too, never
    // its numbers, so including the low risk edits changes nothing about the rows that wait (the editor's call,
    // 2026-11-24), and nothing anywhere goes by a number. A list widens its time column for all its
    // rows once one on screen is past an hour ("1:02:07").
    return <ol key={id} className={pastHour ? "simple-pass-list has-hours" : "simple-pass-list"} aria-label={label}>
      {list.map(entry => {
        const { row, members, more, moment, unfolded: open } = entry;
        // Under the tabs a decided row says how it was decided; the list of every edit keeps its amount, ticked.
        const value = id === "all" ? row.value : row.decision ?? row.value;
        // Only rows leaving the list currently shown fade out: a row looked at in Working or Done meanwhile is where it belongs.
        const heldRow = linger.of(entry.key);
        const lingeringHere = !!heldRow && (id === "you" ? heldRow.from === "you" || heldRow.from === "optional" : id === heldRow.from);
        const lingerKind = lingeringHere ? (entry.place === "working" ? "working" : (row.decided || row.rejected || row.skipped) ? "done" : undefined) : undefined;
        const workingState = row.pending && !row.asks ? (row.busy ? "busy" : "pending") : undefined;
        const spinning = workingState === "busy" || (lingerKind === "working" && workingState === "pending" && !paused);
        const leaving = !!heldRow?.leaving && lingeringHere;
        const canUnkeepRow = !!row.unkeep && !leaving && !lingeringHere;
        return <li key={row.key} className={[leaving && "is-leaving", canUnkeepRow && "has-unkeep"].filter(Boolean).join(" ") || undefined}
          data-low-risk={id === "you" && lowKeys.has(entry.key) ? "" : undefined}
          data-lingering={lingerKind}
          data-working={workingState}
          data-paused={workingState === "pending" && paused ? "" : undefined}><button type="button" className={[row.on && "is-on", row.rejected && "is-rejected", row.asks && "is-asking", !row.on && !row.rejected && row.decided && "is-decided"].filter(Boolean).join(" ") || undefined} aria-current={row.on || undefined}
          data-log-control="open-pass-item" data-log-label={moment ? "Moment" : "Pass item"} disabled={!row.open} title={row.title || row.label} onClick={letGo(() => row.open?.())}
          aria-label={more ? `${clockLabel(row.displayAt)} ${row.label}, ${more.replace("+ ", "and ")}` : row.rejected ? `${clockLabel(row.displayAt)} ${row.label}, rejected` : undefined}
          onPointerEnter={() => actions.lightMark(row.mark, row.hover)} onPointerLeave={() => actions.lightMark()}>
          <span className={row.needs || row.asks ? "simple-pass-time is-need" : "simple-pass-time"}>{clockLabel(row.displayAt)}{(row.needs || row.asks) && <span>, needs you</span>}</span>
          <span className="simple-pass-label">{(row.rejected || row.skipped) && <RejectedMark />}{row.decided && !row.skipped && !row.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}{spinning && <span className="simple-pass-spin" aria-hidden="true" />}<span className="simple-pass-words">{row.label}</span>
            {row.version > 0 && <EditVersion n={row.version} hover={spent.get(row.key)} />}{row.fresh && <small className="edit-version is-new">New</small>}
            {/* What else the moment holds, which unfolds its edits under the row and folds them again. */}
            {more && moment && <span className="simple-pass-more" aria-expanded={!!open} title={open ? "Hide its edits" : "Show its edits"}
              onClick={e => { e.stopPropagation(); fold(moment); }}>{more}</span>}</span>
          {/* The word a row ends on (v2, Kept, Revising…) says on hover what the requests about its cut or edit took:
              their time and tokens, nothing else. The rest of the row keeps the row's own hover. */}
          {/* Every row ends on a word (2026-11-21, the editor's ask): where it stands once it has moved, or else what it is. */}
          {/* One whose request stopped to ask the editor something says Needs your answer, in amber and still: it is their turn. */}
          {!row.word && value && <span className={row.asks ? "simple-pass-value is-need" : row.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{value}</span>}
          {/* An applied edit sent back, or come back revised, ends on that word in place of its amount: quiet while
              Scarlet is on it, amber once it is back and waits on the editor. One word a row, on the row's own line. */}
          {row.word && <span className={`simple-pass-check${row.revised || row.asks ? "" : " is-kept"}${row.busy ? " working-text" : ""}`} title={spent.get(row.key)}>{row.word}</span>}
        </button>
        {canUnkeepRow && <span className="simple-row-unkeep"
          onPointerEnter={() => actions.lightMark(row.mark, row.hover)} onPointerLeave={() => actions.lightMark()}>
          <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
            aria-label={`Unkeep ${row.label}`} title={row.unkeepTip ?? "Unkeep"}
            onClick={letGo(() => row.unkeep!())}>Unkeep</button>
        </span>}
        {under(entry).map(nest => nest.node)}
        {open && members && <ol className="simple-pass-list is-moment" aria-label="Edits in this moment">
          {members.map(m => <li key={m.key} className={m.unkeep ? "has-unkeep" : undefined} data-working={m.busy && !m.asks ? "busy" : undefined}><button type="button" className={m.on ? "is-on" : m.decided ? "is-decided" : undefined} aria-current={m.on || undefined}
            data-log-control="open-pass-item" data-log-label="Edit in a moment" disabled={!m.open} title={m.title || m.label} onClick={letGo(() => m.open?.())}
            onPointerEnter={() => actions.lightMark(m.mark, m.hover)} onPointerLeave={() => actions.lightMark()}>
            <span className="simple-pass-label">{m.decided && !m.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}{m.busy && !m.asks && <span className="simple-pass-spin" aria-hidden="true" />}<span className="simple-pass-words">{m.label}</span>
              {m.version > 0 && <EditVersion n={m.version} hover={spent.get(m.key)} />}</span>
            {m.value && !m.word && <span className={m.busy && !m.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(m.key)}>{m.value}</span>}
            {m.word && <span className={`simple-pass-check${m.revised || m.asks ? "" : " is-kept"}${m.busy ? " working-text" : ""}`} title={spent.get(m.key)}>{m.word}</span>}
          </button>
          {m.unkeep && <span className="simple-row-unkeep"
            onPointerEnter={() => actions.lightMark(m.mark, m.hover)} onPointerLeave={() => actions.lightMark()}>
            <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
              aria-label={`Unkeep ${m.label}`} title={m.unkeepTip ?? "Unkeep"}
              onClick={letGo(() => m.unkeep!())}>Unkeep</button>
          </span>}{nests.filter(nest => nest.key === m.key && m.key !== row.key).map(nest => nest.node)}</li>)}
        </ol>}</li>;
      })}
    </ol>;
  };
  // The full list includes the pass's calls. A pass with no applied edits has only the calls to show.
  const canSeeAll = edits.length > 0;
  const revealList = dock ? () => dock.requestReveal() : reveal;
  const seeProps = { thread, actions, single, rows: totalRows + rejected.length, count: totalRows, soFar, list: listState, reveal: revealList };
  const seeEvery = dock && dockHasTabs
    ? (single && canSeeAll ? <EditResultLink {...seeProps} place="inline" />
      : null)
    : !hasForYou && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !dock && !hasForYou && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const tabs = !dock && hasForYou && <ReviewListTabs need={need} working={inPlace("working").length} done={inPlace("done").length} list={listState} reveal={reveal} showNeeded={showNeeded} />;
  const outsideList = <>
    {/* A request about a cut or edit that has no row still shows, under what the pass made. */}
    {nests.filter(nest => !placed.has(nest.key)).map(nest => nest.node)}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      {/* The pass goes in once its calls are decided and Scarlet finishes checking. */}
      {!dock && waiting && pass?.deciding && <span className="simple-pass-ok">Applying…</span>}
      <span className="req-right">{aside}</span>
    </div>
  </>;
  if (dock) {
    return <div ref={host} className="simple-pass">
      {made && <Made parts={made} link={seeEvery} />}
      {outsideList}
    </div>;
  }
  return <div ref={host} className="simple-pass" role="group" aria-label="Dialogue pass">
    {made && <Made parts={made} link={seeEvery} />}
    {!callsListed && outsideList}
    {seeTab}
    {tabs}
    {/* Over Needs review's rows, the edits Scarlet didn't flag are one line: a switch that includes them. */}
    {lowLine && <LowRisk count={lowLine.count} on={optionalOpen} onToggle={low.toggle} leaving={lowLine.leaving} />}
    {drawn.map(list => <Fragment key={list.id}>
      {list.rows.length > 0 ? rowList(list) : list.id !== "all" && <p className="simple-review-empty">{EMPTY_TAB[list.id]}</p>}
    </Fragment>)}
    {callsListed && outsideList}
    {/* Only a failed apply offers Retry, after the reason, whichever list is on screen. */}
    {pass?.error && <p className="simple-error" role="alert">{pass.error}
      {waiting && !pass.deciding && <button type="button" className="simple-link req-recover" onClick={pass.apply}>Retry</button>}</p>}
  </div>;
}

/**
 * What any other request made, as the rows of its block: one sentence, then a link that opens the edits themselves,
 * each by its time. Edits of one name that overlap exactly are one edit. Once Scarlet flagged one, the rows
 * sit under three tabs, as a pass's do: Needs review lists the flagged edits
 * not yet decided and counts them, with the edits Scarlet didn't flag behind one line under them ("3 optional");
 * Working has the ones sent back, each with its request under its row; Done has the ones kept or rejected. A row just
 * decided or sent back stays in Needs review a moment with its new word, then fades and leaves. A request about an edit
 * that is still in the chat (`nests`) sits directly under that edit's row.
 */
export function ThreadResult({ projectId, thread, edits, rejected, actions, aside, working, nests = noNests, spent = noSpent, list, listedNeed, wasShowing: heldShowing, linger: heldLinger, lastOpen: heldOpen, listLoaded, onTabs, laterRequests = 0 }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[]; rejected?: Omit<ThreadEdit, "at">[]; actions: ChatActions;
  /** Hears whether the rows are under Needs review, Working and Done: Scarlet's reply then stays over them. */
  onTabs?(tabbed: boolean): void;
  aside?: ReactNode; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** Which list is open and what Needs review has listed, held by the turn: the block is mounted anew when it moves
   *  between the conversation and the place above the message box, and a list the editor opened must not close then,
   *  nor turn into another. `wasShowing` is whether one of the edits was open when the block last drew, `lastOpen`
   *  which, and `linger` the rows just decided or sent back, which stay in Needs review a moment. */
  list: PassList; listedNeed: RefObject<Set<string>>; wasShowing?: RefObject<boolean>; linger?: ReviewLinger; lastOpen?: RefObject<string | undefined>;
  /** True once this thread's live edit list has settled (so initial saved → located arrival won't linger rows). */
  listLoaded?: boolean;
  /** Newer requests below this one in the chat; an increase collapses held blank tab space. */
  laterRequests?: number }) {
  const facts = useThreadFacts({ projectId, thread, edits, rejected, actions });
  const { reviewed, canUnkeep, revising, rejecting, adding, gone, showing, shownEdit, groups, need, openEdit, openId, brollSections } = facts;
  const linger = useHeldRows(heldLinger);
  const [open, setOpen] = list;
  const [host, reveal] = useReveal(open);
  const dock = useReviewDockStore();
  const dockHasTabs = useDockHasTabs();
  const isForYou = (e: Omit<ThreadEdit, "at">) => e.rejected ? (!!e.wasCheck || listedBefore(listedNeed.current, e)) : !!e.check;
  const flagged = useMemo(() => edits.filter(e => e.check && !reviewed(e) && !revising(e)), [edits, reviewed, revising]);
  const forYouGroups = groups.filter(group => group.members.some(m => isForYou(m.edit)));
  const forYouRejected = gone.filter(isForYou);
  // Whether the request has anything for the editor to review, now or decided: it then has the three tabs.
  const hasForYou = forYouGroups.length > 0 || forYouRejected.length > 0;
  const tab = tabShown(open);
  const optionalOpen = hasForYou && open === "all";
  // Working and Done have no low risk switch: Needs review comes back with it as it was left.
  if (!dock && hasForYou && tab === "you") linger.lowRisk = optionalOpen;
  useLayoutEffect(() => { onTabs?.(hasForYou); }, [hasForYou]); // eslint-disable-line react-hooks/exhaustive-deps
  // Low risk rows open into the list and close out of it: `low.shown` while the list still draws them.
  const low = useLowRiskFold(host, !dock && optionalOpen && tab === "you", on => setOpen(on ? "all" : undefined), !dock && hasForYou && tab === "you");
  // Each row's tab, with nothing to review only for the bottom dock.
  const { rowOf, placeOf, tracked } = threadRowPlaces(facts, nests, hasForYou || !!dock);
  // A row that has just left Needs review for Working or Done, or Done for Working, stays a moment where it was, with its new word.
  if (!dock && hasForYou) {
    linger.track(
      listLoaded === false ? [] : tracked,
      optionalOpen && tab === "you",
      tab === "done",
      listLoaded === false ? () => true : undefined,
    );
  }
  const place = (e: Omit<ThreadEdit, "at">) => placeOf.get(rowOf.get(editKey(e)) ?? "");
  const held = (e: Omit<ThreadEdit, "at">) => {
    const at = place(e);
    const h = at === "working" || at === "done" ? linger.of(rowOf.get(editKey(e)) ?? "") : undefined;
    return h && (h.from !== "done" || at === "working") ? h : undefined;
  };
  const inYou = (e: Omit<ThreadEdit, "at">) => place(e) === "you" || held(e)?.from === "you";
  const inOptional = (e: Omit<ThreadEdit, "at">) => place(e) === "optional" || held(e)?.from === "optional";
  const inDone = (e: Omit<ThreadEdit, "at">) => place(e) === "done" || held(e)?.from === "done";
  const countOf = (at: RowPlace) => tracked.filter(row => row.place === at).length;
  const some = (only: (e: Omit<ThreadEdit, "at">) => boolean) => edits.some(only) || gone.some(only);
  // Needs review's one list: what waits, and with low risk edits included those too, each in its place in the video.
  const lowRow = (e: Omit<ThreadEdit, "at">) => low.shown && !inYou(e) && inOptional(e);
  const optionalCount = countOf("optional");
  const lowLine = useLowRiskLine(host, optionalCount, !dock && hasForYou && tab === "you");
  const forYouList = (e: Omit<ThreadEdit, "at">) => inYou(e) || lowRow(e);
  const youBaseCount = countOf("you") + tracked.filter(row => (row.place === "working" || row.place === "done") && linger.of(row.key)?.from === "you").length;
  const lowShownCount = low.shown ? optionalCount + tracked.filter(row => (row.place === "working" || row.place === "done") && linger.of(row.key)?.from === "optional").length : 0;
  const doneShownCount = countOf("done") + tracked.filter(row => row.place === "working" && linger.of(row.key)?.from === "done").length;
  useReviewTabHeight(host, {
    enabled: !dock && hasForYou,
    tab,
    counts: { you: youBaseCount + lowShownCount, working: countOf("working"), done: doneShownCount },
    youBase: youBaseCount,
    hasLowRisk: optionalCount > 0,
    lowOpen: low.shown,
    lowClosing: low.closing,
    nestedCount: nests.length,
    laterRequests,
  });
  // Every edit belongs to Needs review: Needs review already lists them all.
  const allForYou = hasForYou && forYouGroups.length === groups.length && forYouRejected.length === gone.length;
  const single = !working && groups.length === 1 ? shownEdit ?? edits[0] : undefined;
  const showingInList = !!shownEdit && (!single || allForYou);
  // With nothing to review, an edit opened on the timeline opens the list of every edit. Only an edit the editor has
  // just opened does that. The same edit still open when its request moves between the conversation and the place
  // above the message box, mounted anew, leaves the lists as they were.
  const ownShowing = useRef(false);
  const wasShowing = heldShowing ?? ownShowing;
  useEffect(() => {
    if (!hasForYou && showingInList && !wasShowing.current) setOpen("all");
    wasShowing.current = showingInList;
  }, [showingInList]); // eslint-disable-line react-hooks/exhaustive-deps
  // Under the tabs, an edit opened from somewhere else (the timeline, ⌘Z) shows the tab that holds it: Needs review for one
  // that waits, with low risk edits included for one Scarlet didn't flag, Working for one sent back, Done for one
  // decided. One opened from the list, stepped to or moved on to is in the tab shown already.
  const ownOpen = useRef<string>(undefined);
  const lastOpen = heldOpen ?? ownOpen;
  useEffect(() => {
    if (dock) return;
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!hasForYou || !openEdit || openId === was) return;
    const at = place(openEdit);
    // A row still in Needs review only for the moment after it was decided is Working's or Done's.
    const shown = tab === "you" ? at === "you" || (at === "optional" && optionalOpen) : at === tab;
    if (shown) { if (at === "you") setOpen(o => o ?? "need"); }
    else if (at) setOpen(at === "you" ? linger.lowRisk ? "all" : "need" : at === "optional" ? "all" : at);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The Needs review list closes only if there are no Needs review items at all.
  useEffect(() => { if (open === "need" && !hasForYou) setOpen(undefined); }, [open, hasForYou]); // eslint-disable-line react-hooks/exhaustive-deps
  if (hasForYou && (dock || tab === "you")) {
    for (const edit of edits) if (inYou(edit)) listedNeed.current.add(editKey(edit));
    for (const edit of gone) if (inYou(edit)) listedNeed.current.add(editKey(edit));
  }
  // With nothing left in the video and nothing for the editor, the rejected edits' rows are all there is: they show
  // without a click or a tab, so a request whose only edit was rejected still says so (2026-11-23).
  const onlyRejected = !edits.length && gone.length > 0 && !hasForYou;
  const showsList = hasForYou || open === "all" || onlyRejected || (!!single && !!shownEdit);
  // The edits the sentence would name are said by their rows while the lists on screen have one for each of them.
  // Low risk rows don't count: including them changes the list and nothing over it.
  const rowsName = dock
    ? (!hasForYou && open === "all")
    : (hasForYou ? edits.every(e => e.beforeCut || e.marker || e.elsewhere || (tab === "you" ? inYou(e) : tab === "done" ? inDone(e) : place(e) === tab)) : open === "all");
  const made = useMemo(() => {
    if (working) return undefined;
    const said = madeSentence(edits, lengthLabel, false, rowsName);
    // A request that only flagged an edit another one made has made nothing to say.
    return said.length ? said : undefined;
  }, [working, edits, rowsName]);
  // Edits that are one row have their requests under that row. Under the tabs a
  // request whose row is under any of them is drawn there and nowhere else; with one list, every row it shows counts.
  const listed = new Set(dock ? (dockHasTabs || showsList ? [...edits, ...gone].map(editKey) : []) : hasForYou ? rowOf.keys() : showsList ? [...edits, ...gone].map(editKey) : []);
  const canSeeAll = open === "all" || edits.length > 0;
  const soFar = !!working && !made;
  const revealList = dock ? () => dock.requestReveal() : reveal;
  const seeProps = { thread, actions, single, rows: groups.length + gone.length, count: groups.length, soFar, list, reveal: revealList };
  const seeEvery = dock && dockHasTabs
    ? (single && canSeeAll ? <EditResultLink {...seeProps} place="inline" />
      : null)
    : !hasForYou && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !dock && !hasForYou && canSeeAll && <EditResultLink {...seeProps} place="tab" />;

  const ownsEdit = (e: Omit<ThreadEdit, "at">) =>
    thread.changes.some(c => c.id === e.changeId) || e.previous.some(p => thread.changes.some(c => c.id === p.changeId));
  // Build normalized rows for the fixed bottom review dock so every edit (and rejected edit) appears in order.
  const dockEntries: DockEntry[] = [];
  if (dock && (edits.length > 0 || gone.length > 0)) {
    const openIdx = showing?.rejected ? -1 : showing ? edits.findIndex(e => matchesEdit(showing, e)) : -1;
    const order = listPlaces(thread, edits, gone);
    const groupRows = groups.map(({ members, continuousBroll }) => {
      const shown = members.find(m => m.i === openIdx) ?? members.find(m => asksEditor(revising(m.edit))) ?? members.find(m => !!m.edit.check && !reviewed(m.edit) && !revising(m.edit)) ?? members[0]!;
      const needsCount = members.filter(m => !!m.edit.check && !reviewed(m.edit) && !revising(m.edit)).length;
      const allKept = members.every(m => reviewed(m.edit));
      const unkeepRefs = allKept ? members.filter(m => !m.edit.marker && canUnkeep(m.edit)).map(m => m.edit) : [];
      const groupEdits = members.map(m => m.edit);
      const rowNests = members.flatMap(m => nests.filter(nest => nest.key === editKey(m.edit)));
      const took = members.map(m => spent.get(editKey(m.edit))).find(Boolean);
      const was = members.flatMap(m => m.edit.previous.map(editKey));
      const stretch = {
        start: Math.min(...groupEdits.map(e => e.range.start)),
        end: Math.max(...groupEdits.map(e => e.range.end)),
      };
      return {
        edit: shown.edit,
        i: shown.i,
        first: members[0]!.i,
        places: members.length,
        continuousBroll,
        stretch,
        maxVersion: Math.max(0, ...groupEdits.map(e => e.previous.length ? e.previous.length + 1 : 0)),
        needs: needsCount,
        allKept,
        unkeepRefs,
        groupEdits,
        rowNests,
        took,
        was,
        firstKey: editKey(members[0]!.edit),
      };
    });
    const firstOf = (idx: number) => groupRows[idx]?.first ?? Infinity;
    const pushGone = (from: number, to: number) => {
      for (const e of order.gone) {
        const slot = order.slot(e);
        if (slot <= from || slot > to) continue;
        const at = (e as ThreadEdit).at ?? e.range.start;
        const rawKey = editKey(e);
        const on = !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing));
        dockEntries.push({
          key: `${thread.id}/${rawKey}`,
          threadId: thread.id,
          place: "done",
          at,
          isPass: false,
          row: {
            key: `${thread.id}/${rawKey}`,
            rawKey,
            threadId: thread.id,
            id: `${thread.id}/${editKey(e.previous[0] ?? e)}`,
            was: e.previous.map(w => `${thread.id}/${editKey(w)}`),
            at,
            displayAt: at,
            mark: undefined,
            hover: { threadId: thread.id, editKey: rawKey },
            label: e.label,
            n: 0,
            decision: "Rejected",
            value: "Rejected",
            revised: false,
            rejected: true,
            skipped: false,
            forYou: isForYou(e),
            busy: false,
            pending: false,
            needs: false,
            asks: false,
            decided: false,
            version: 0,
            fresh: false,
            title: undefined,
            ariaLabel: `${clockLabel(at)} ${e.label}, rejected`,
            on,
            open: () => actions.openEdit(thread, e),
            stepOpen: () => actions.openEdit(thread, e),
            spent: spent.get(rawKey),
            dataLogControl: "open-edit",
            dataLogLabel: "Edit",
            edit: e,
            nests: nests.filter(nest => nest.key === rawKey),
          },
        });
      }
    };
    pushGone(-1, firstOf(0));
    groupRows.forEach(({ edit, i, places, continuousBroll, stretch, maxVersion, needs: needCount, allKept, unkeepRefs, groupEdits, rowNests, took, was, firstKey }, atIdx) => {
      const rawKey = firstKey;
      const on = i === openIdx;
      const isKept = places > 1 ? allKept : reviewed(edit);
      const revisingNow = revising(edit), isRevising = !!revisingNow;
      const busy = !!revisingNow && isWorking(revisingNow.state);
      const statusWord = revisionWord(revisingNow, { rejecting: rejecting(edit), adding: adding(edit), nextQueuedId: actions.nextQueuedId });
      const asksNow = asksEditor(revisingNow);
      const version = continuousBroll ? maxVersion : (edit.previous.length ? edit.previous.length + 1 : 0);
      const decided = isKept && !isRevising;
      const value = continuousBroll ? "B-roll" : editRowWord(edit);
      const decision = decided ? (edit.marker ? "Done" : "Kept") : undefined;
      const check = asksNow || (places > 1 ? needCount > 0 : !!edit.check && !isRevising);
      const title = (edit.reason && edit.summary) || edit.label;
      const revised = edit.check === REVISED_CHECK && !reviewed(edit) && !isRevising;
      const at = continuousBroll ? stretch.start : ((edit as ThreadEdit).at ?? edit.range.start);
      const displayAt = continuousBroll ? stretch.start : ((!isKept && !isRevising ? edit.reviewRange?.start : undefined) ?? at);
      const rowTime = clockLabel(displayAt);
      const checkTitle = revised || edit.reason ? undefined : edit.check;
      const showUnkeep = decided && !edit.marker && unkeepRefs.length > 0;
      const unkeepTip = edit.check || dockHasTabs || hasForYou ? "Move back to Needs review" : "Unkeep";
      const entryPlace = placeOf.get(firstKey) ?? "optional";
      const brollSection = (continuousBroll || edit.kind === "broll") && brollSections
        ? brollSectionForEdit(brollSections, stretch)
        : undefined;
      dockEntries.push({
        key: `${thread.id}/${rawKey}`,
        threadId: thread.id,
        place: entryPlace,
        at,
        isPass: false,
        row: {
          key: `${thread.id}/${rawKey}`,
          rawKey,
          threadId: thread.id,
          id: `${thread.id}/${editKey(edit.previous[0] ?? edit)}`,
          was: was.map(w => `${thread.id}/${w}`),
          at,
          displayAt,
          mark: undefined,
          hover: { threadId: thread.id, editKey: editKey(edit) },
          label: title,
          n: 0,
          decision,
          value,
          word: statusWord,
          revised,
          rejected: false,
          skipped: false,
          forYou: isForYou(edit),
          busy,
          pending: isRevising,
          needs: !asksNow && check && !isKept,
          asks: asksNow,
          decided,
          version: places === 1 || continuousBroll ? version : 0,
          fresh: false,
          title: checkTitle,
          ariaLabel: `${rowTime}: ${title}${statusWord ? `, ${statusWord.replace(/…$/, "").toLowerCase()}` : isKept ? (edit.marker ? ", done" : ", kept") : check ? ", check" : ""}`,
          on,
          open: () => actions.openEdit(thread, edit),
          stepOpen: () => actions.openEdit(thread, edit),
          ...(showUnkeep && {
            unkeep: () => {
              actions.lightMark();
              unkeepEdits(projectId, thread.id, unkeepRefs);
              recordUndo({ kind: "unkeep", word: "Unkeep", projectId, threadId: thread.id, refs: unkeepRefs, name: title });
            },
            unkeepTip,
          }),
          spent: took,
          dataLogControl: "open-edit",
          dataLogLabel: "Edit",
          edit,
          editKind: continuousBroll ? "broll" : edit.kind,
          stretch,
          brollSectionId: (continuousBroll || edit.kind === "broll") && brollSections ? (brollSection?.id ?? null) : undefined,
          ...(continuousBroll && { continuousBroll: true }),
          owns: ownsEdit(edit),
          edits: groupEdits,
          editOrder: { index: i + 1, of: edits.length },
          nests: rowNests,
        },
      });
      pushGone(firstOf(atIdx), firstOf(atIdx + 1));
    });
  }
  const singleOpen = !!single && ownsEdit(single) && !!shownEdit && !hasForYou && !dockHasTabs;
  const totalCount = groups.length + gone.length;
  useLayoutEffect(() => {
    if (!dock) return;
    if (!edits.length && !gone.length) { dock.report(thread.id); return; }
    dock.report(thread.id, {
      threadId: thread.id,
      isPass: false,
      hasCalls: false,
      hasForYou,
      need,
      entries: dockEntries,
      allOpen: !hasForYou && open === "all",
      allLabel: totalCount === 2 ? "See both" : "See all",
      soFar,
      onCloseAll: () => setOpen(undefined),
      onlyRejected,
      singleOpen,
      onCloseSingle: () => actions.stopShowing(),
      listLoaded,
      onRowHover: (_mark, hover) => actions.lightMark(undefined, hover),
    });
  });
  useLayoutEffect(() => () => dock?.report(thread.id), [dock, thread.id]);

  const showNeeded = () => {
    setOpen(was => was === "all" || linger.lowRisk ? "all" : undefined);
    if (flagged.length && !flagged.some(edit => !!actions.showing && matchesEdit(actions.showing, edit))) actions.openEdit(thread, flagged[0]!);
  };
  const isLeaving = (edit: Omit<ThreadEdit, "at">) => {
    const h = held(edit);
    return !!h?.leaving && (tab === "you" ? h.from === "you" || h.from === "optional" : tab === h.from);
  };
  const lingerKindOf = (edit: Omit<ThreadEdit, "at">): "working" | "done" | undefined => {
    const h = held(edit);
    const here = !!h && (tab === "you" ? h.from === "you" || h.from === "optional" : tab === h.from);
    if (!here) return undefined;
    const at = place(edit);
    return at === "working" ? "working" : at === "done" ? "done" : undefined;
  };
  const rows = (label: string | undefined, only?: (e: Omit<ThreadEdit, "at">) => boolean, listKey?: string) =>
    <ThreadEdits key={listKey} projectId={projectId} thread={thread} edits={edits} rejected={rejected} showing={actions.showing} only={only} label={label}
      // Only rows leaving the list currently shown fade out: a row looked at under Working or Done meanwhile is where it belongs.
      leaving={only && tab !== "working" ? isLeaving : undefined}
      lingering={only && tab !== "working" ? lingerKindOf : undefined}
      low={only && tab === "you" ? lowRow : undefined}
      nextQueuedId={actions.nextQueuedId}
      onPlay={ref => actions.openEdit(thread, ref)}
      onHover={ref => actions.lightMark(undefined, ref && { threadId: thread.id, editKey: editKey(ref) })}
      under={edit => nests.filter(nest => nest.key === editKey(edit)).map(nest => nest.node)} spent={edit => spent.get(editKey(edit))} />;
  if (dock) {
    return <div ref={host} className="simple-pass" role="group" aria-label="Edits">
      {made && <Made parts={made} link={seeEvery} />}
      <div className="simple-pass-line req-row">
        {!made && seeEvery}
        <span className="req-right">{aside}
          {/* Undo these edits and File this thread have no place in the chat for now. What they reported still shows. */}
          <ThreadAction projectId={projectId} thread={thread} edits={edits} onPlay={ref => actions.openEdit(thread, ref)} menuOnly menu={false} /></span>
      </div>
      {nests.filter(nest => !listed.has(nest.key)).map(nest => nest.node)}
    </div>;
  }
  return <div ref={host} className="simple-pass" role="group" aria-label="Edits">
    {made && <Made parts={made} link={seeEvery} />}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      <span className="req-right">{aside}
        {/* Undo these edits and File this thread have no place in the chat for now. What they reported still shows. */}
        <ThreadAction projectId={projectId} thread={thread} edits={edits} onPlay={ref => actions.openEdit(thread, ref)} menuOnly menu={false} /></span>
    </div>
    {hasForYou && <ReviewListTabs need={need} working={countOf("working")} done={countOf("done")} list={list} reveal={reveal} showNeeded={showNeeded} />}
    {seeTab}
    {!hasForYou && showsList && rows(undefined)}
    {hasForYou && tab === "you" && <>
      {/* Over Needs review's rows, the edits Scarlet didn't flag are one line: a switch that includes them. */}
      {lowLine && <LowRisk count={lowLine.count} on={optionalOpen} onToggle={low.toggle} leaving={lowLine.leaving} />}
      {some(forYouList) ? rows("Edits that need you", forYouList, "you") : <p className="simple-review-empty">{EMPTY_TAB.you}</p>}
    </>}
    {hasForYou && tab === "working" && (countOf("working") > 0 ? rows("With Scarlet", e => place(e) === "working", "working")
      : <p className="simple-review-empty">{EMPTY_TAB.working}</p>)}
    {hasForYou && tab === "done" && (some(inDone) ? rows("Decided", inDone, "done")
      : <p className="simple-review-empty">{EMPTY_TAB.done}</p>)}
    {nests.filter(nest => !listed.has(nest.key)).map(nest => nest.node)}
  </div>;
}
