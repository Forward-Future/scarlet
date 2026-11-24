import { AimRow } from "../../components/review/AimRow";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { matchesEdit, REVISED_CHECK, type EditRef, type ThreadEdit } from "@scarlet/shared";
import { EditBadge, EditVersion, RejectedMark, ThreadAction, ThreadEdits } from "../../components/review/ThreadEdits";
import { asksEditor, editGroups, revisionWord, useAdding, useRejecting, useReviewed, useRevising, waitingPassRows, waitingRows } from "../../components/review/threadEditState";
import { Icon } from "../../components/ui/primitives";
import { editKindWord, editRowWord } from "../../lib/editKind";
import { listMoments, type Moment } from "../../lib/editMoments";
import { clock as clockLabel, editRemovedLabel, lengthLabel, plural } from "../../lib/format";
import { editKey } from "../../lib/keptEdits";
import { madeSentence, type SentencePart } from "../../lib/madeSentence";
import { decidedPassCalls, rejectedCallRef } from "../../lib/passCalls";
import { inListOrder, ReviewLinger, rowPlace, tabShown, type ListOrder, type RowPlace } from "../../lib/reviewTabs";
import { isRecheck, type Thread } from "../../lib/threads";
import { useKeepSelectedInView } from "../../lib/uiHooks";
import { useReviewRail, type RailSection } from "./railStore";
import { callRowKey, isWorking, letGo, listedBefore, noNests, noRejected, noSpent, type ChatActions, type HoveredReviewRow, type Nest, type PassList, type Spent } from "./types";

/**
 * A finished request with one result opens its edit on the timeline. A collection opens a list to choose from. Closed,
 * either is a link after the sentence (`place` "inline"): See edit for one, See both or See all for several, and the
 * edits so far while Scarlet works. Open, a finished collection's list is under its tab, in the row where For you,
 * Working and Done sit when there is something to review (`place` "tab"), and the tab pressed again closes it. Each
 * place draws only its own. The word counts the rows the list opens (`rows`), a rejected edit's too: See both is for two.
 */
function EditResultLink({ thread, actions, single, rows, count, soFar, list: [open, setOpen], reveal, place, column }: {
  thread: Thread; actions: ChatActions; single?: EditRef; rows: number; count: number; soFar?: boolean; list: PassList; reveal(): void; place: "inline" | "tab";
  /** The rows are in the column of edits, not under this link: a request's one edit keeps its link whatever is open there. */
  column?: boolean;
}) {
  const expanded = open === "all";
  const current = !!single && !!actions.showing && matchesEdit(actions.showing, single);
  const one = !!single && (column || !expanded || current);
  const tab = !column && expanded && !one && !soFar;
  if (tab !== (place === "tab")) return null;
  const label = rows === 2 ? "See both" : "See all";
  if (tab) return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab" aria-pressed title="Hide the edits" onClick={letGo(() => setOpen(undefined))}>{label}</button>
  </div>;
  if (single && one) {
    const toggleEdit = () => {
      if (!current) return actions.openEdit(thread, single);
      setOpen(undefined);
      actions.stopShowing();
    };
    return <button type="button" className="simple-pass-toggle" aria-current={current || undefined}
      title={current ? "Close this edit (Esc)" : "Show on the timeline"} onClick={letGo(toggleEdit)}>{current ? "Close edit" : "See edit"}</button>;
  }
  if (!soFar) return <button type="button" className="simple-pass-toggle" aria-expanded={false} title="Show the edits in order"
    onClick={letGo(() => { reveal(); setOpen("all"); })}>{label}</button>;
  return <button type="button" className="simple-pass-toggle" data-so-far aria-expanded={expanded}
    title={expanded ? "Hide the edits" : "Show the edits Scarlet has made so far, in order"}
    onClick={letGo(() => { if (!expanded) reveal(); setOpen(expanded ? undefined : "all"); })}>{expanded ? "Hide" : `See ${count} ${count === 1 ? "edit" : "edits"} so far`}</button>;
}

/**
 * The three tabs over a request's rows once it has something for the editor to review: For you, Working and Done.
 * Every edit and call is under exactly one of them. A count shows only when there is one: For you's in amber, since
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
    <button type="button" className="simple-review-tab simple-pass-need" aria-label="For you" aria-pressed={tab === "you"}
      title={need ? `${need} ${need === 1 ? "needs" : "need"} you` : undefined} onClick={letGo(showNeeded)}>
      For you{need > 0 && <span className="simple-review-tab-count" aria-hidden="true">{need}</span>}
    </button>
    <button type="button" className="simple-review-tab" aria-label="Working" aria-pressed={tab === "working"}
      title={working ? `${working} with Scarlet` : undefined} onClick={letGo(show("working"))}>Working{tally(working)}</button>
    <button type="button" className="simple-review-tab" aria-label="Done" aria-pressed={tab === "done"}
      title={done ? `${done} decided` : undefined} onClick={letGo(show("done"))}>Done{tally(done)}</button>
  </div>;
}

/**
 * The one quiet line under For you's rows: how many edits Scarlet didn't flag are still the editor's to keep or
 * ignore. Closed until pressed; open, those rows are listed under it.
 */
export function OptionalLine({ count, open, onToggle, inPass }: { count: number; open: boolean; onToggle(): void;
  /** Under a pass's rows, which start a little in from the block's edge. */
  inPass?: boolean }) {
  return <button type="button" className={inPass ? "simple-review-rest is-pass" : "simple-review-rest"} aria-expanded={open}
    title={open ? "Hide the edits Scarlet didn’t flag" : "Show the edits Scarlet didn’t flag, in order"} onClick={letGo(onToggle)}>
    <span className="simple-review-rest-chev" aria-hidden="true"><Icon name="chevron" size={11} /></span>{count} optional
  </button>;
}

/** What an empty tab says. For you says it only when it has no optional line either, so the tab is never blank. */
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
 * A list the editor opens is brought into view. The conversation sits at its latest message, so a list opened on the
 * last request grows downward, under the message box, and the click would seem to do nothing. Only a press asks for
 * it: a list that is open already when its block is drawn again moves nothing.
 */
function useReveal(open: unknown) {
  const host = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current) return;
    asked.current = false;
    if (open) {
      const rows = host.current?.querySelector(".simple-pass-list, .simple-edits");
      // When a row is already selected, useKeepSelectedInView keeps it in view; otherwise bring the first row in.
      if (rows && !rows.querySelector('[aria-current="true"]')) rows.querySelector(":scope > li > button")?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open]);
  return [host, () => { asked.current = true; }] as const;
}

/** What a request changed in the video: one sentence, its figures in bold, and on the same line the link that opens its edits. */
function Made({ parts, link }: { parts: readonly SentencePart[]; link?: ReactNode }) {
  if (!parts.length) return null;
  return <p className="simple-made-line"><span className="simple-made">{parts.map((part, i) => typeof part === "string" ? part : <b key={i}>{part.strong}</b>)}</span>{link}</p>;
}

/**
 * In the chat, a request with something waiting on the editor says so after what it made: For you and how many, which
 * opens the first of them. The rows themselves are in the column of edits.
 */
function NeedLink({ need, onOpen }: { need: number; onOpen(): void }) {
  if (!need) return null;
  return <button type="button" className="simple-pass-need simple-need-link" aria-label="For you" title={`${need} ${need === 1 ? "needs" : "need"} you`}
    onClick={letGo(onOpen)}>For you<span className="simple-review-tab-count" aria-hidden="true">{need}</span></button>;
}

/** One row of a pass's lists: an edit, a call, a rejected edit or a call decided before the pass applied. */
interface PassRow {
  key: string;
  /** The row by its first version, which a revision or a rejection doesn't change. */
  id: string;
  /** The rows this one took the place of: an edit's earlier versions. */
  was?: string[];
  at: number;
  displayAt: number;
  /** Where its marker lights on the timeline while the pointer is over the row. */
  mark?: number;
  hover?: HoveredReviewRow;
  label: string;
  /** A call's number; 0 for any other row. */
  n: number;
  num?: number;
  state?: string;
  decision?: string;
  value?: string;
  word?: string;
  revised: boolean;
  rejected: boolean;
  skipped: boolean;
  forYou: boolean;
  onlyForYou: boolean;
  busy: boolean;
  pending: boolean;
  needs: boolean;
  /** Scarlet stopped work on it to ask the editor something: the row waits on them again, and says Needs your answer. */
  asks: boolean;
  sentBack: boolean;
  decided: boolean;
  version: number;
  title?: string;
  on: boolean;
  open?: () => void;
  fresh: boolean;
}

/** A row as a list draws it: one edit or call, or a moment, with the tab it is under. */
interface Entry {
  key: string;
  row: PassRow;
  members?: PassRow[];
  more?: string;
  moment?: string;
  unfolded?: boolean;
  place: RowPlace;
  at: number;
  num?: number;
}

/**
 * What a dialogue pass made, as the rows of its block. Once it has something for the editor to review, its rows sit
 * under three tabs and each is under exactly one. For you, shown until another is pressed, lists what waits on the
 * editor: open calls and flagged edits, each by its number while the pass waits, with Scarlet's note. Pressed, it opens
 * the first one still waiting. A row the editor has just decided or sent back stays there a moment with its new word,
 * then fades and leaves. Under those rows one line counts the edits Scarlet didn't flag ("112 optional"); opened, it
 * lists them in timeline order, edits that play as one change on one row. Working has the rows Scarlet has, each with
 * the editor's request under it, and Done every decided row. A pass with nothing to review has one list of every edit,
 * behind See all. Once Scarlet is done, what the pass applied is one sentence above the list. A row is one line and
 * opens its edit or call in the card on the timeline, where Keep and Reject edit move on to the next that waits. A
 * request about one cut or edit that is still in the chat (`nests`) sits directly under that cut's or edit's row.
 * `aside` is what the run used, when that shows.
 */
export function PassSummary({ projectId, thread, edits, rejected = noRejected, actions, aside, list: listState, listedNeed, working, nests = noNests, spent = noSpent, linger: heldLinger, lastOpen: heldOpen }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[];
  /** Edits the editor rejected: out of the video, each keeps a row in the list of every edit, with a × and "Rejected". */
  rejected?: Omit<ThreadEdit, "at">[];
  actions: ChatActions; aside?: ReactNode; list: PassList; listedNeed: RefObject<Set<string>>; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** The rows just acted on and the edit last opened, held by the turn: see `ThreadResult`. */
  linger?: ReviewLinger; lastOpen?: RefObject<string | undefined> }) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const adding = useAdding(thread);
  const linger = useHeldRows(heldLinger);
  const [open, setOpen] = listState;
  const [host, reveal] = useReveal(open);
  // With a column of edits beside the chat, the rows are drawn there, every list at once, and none in the chat.
  const rail = useReviewRail();
  const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
  const openCalls = pass?.calls.filter(c => c.state === "open").length ?? 0;
  // Calls the editor decided before the pass applied are rows of Done: approved cuts link to their applied edit row,
  // and skipped calls (or approved keep proposals) are decided rows of their own.
  const { decidedCallEditKeys, decidedCallRows } = useMemo(
    () => decidedPassCalls(pass ? undefined : thread, edits, rejected),
    [pass, thread, edits, rejected],
  );
  const isForYouEdit = (e: Omit<ThreadEdit, "at">) => !!e.check || decidedCallEditKeys.has(editKey(e));
  const isForYouRejected = (e: Omit<ThreadEdit, "at">) => !!e.wasCheck || decidedCallEditKeys.has(editKey(e)) || listedBefore(listedNeed.current, e);
  const forYouEdits = edits.filter(isForYouEdit);
  const forYouRejected = rejected.filter(isForYouRejected);
  // What waits on the editor: an open call and a flagged edit not yet kept. One sent back for revision waits on Scarlet,
  // until its request stops to ask the editor something: then it is their turn again.
  const need = waitingPassRows(pass?.calls, edits, isForYouEdit, { reviewed, revising });
  // Whether the request has anything for the editor to review, now or decided: it then has the three tabs.
  const hasForYou = (pass?.calls.length ?? 0) > 0 || forYouEdits.length > 0 || forYouRejected.length > 0 || decidedCallRows.length > 0;
  const tabbed = hasForYou || !!rail;
  const tab = tabShown(open);
  const optionalOpen = tabbed && open === "all";
  // While the pass makes its final check of the finished cut, the fixes it applies are marked New in the list: nothing
  // else tells them from the cuts that went in before (2026-11-14).
  const rerun = working ? thread.tasks.find(t => !!t.repeatAudit?.returns && !!t.startedAt && isWorking(t.state)) : undefined;
  const fresh = useMemo(() => new Set(rerun ? thread.changes.filter(c => c.taskId === rerun.id && (c.createdAt ?? "") >= rerun.startedAt!).map(c => c.id) : []),
    [rerun, thread.changes]);
  // Edits that overlap on the timeline exactly are one row, a moment. Its own edits open under it on a press of
  // "+ 4 edits", and fold again on the next.
  const moments = useMemo(() => listMoments(edits), [edits]);
  const totalRows = edits.length + (pass?.calls.length ?? 0);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const single = !working && !pass?.running && totalRows === 1 ? edits[0] : undefined;
  // A single preview follows the open card. An explicitly opened list keeps the timeline on the whole pass.
  const fullList = open === "all" && edits.length > 0;
  // With nothing left in the video and nothing for the editor, the rejected edits' rows are all there is: they show
  // without a click or a tab, so a request whose only edit was rejected still says so (2026-11-23).
  const onlyRejected = !edits.length && rejected.length > 0 && !pass && !tabbed;
  const listed = fullList || onlyRejected || (!!single && !tabbed && open !== "need" && !!actions.showing && matchesEdit(actions.showing, single));
  // The For you list closes only if there are no For you items at all.
  useEffect(() => { if (open === "need" && !tabbed) setOpen(undefined); }, [open, tabbed]); // eslint-disable-line react-hooks/exhaustive-deps
  // A line mounted with its list already open is the same list, moved with its request between the conversation and
  // the place above the message box. It leaves the timeline where it is, so an edit of another request the editor has
  // open stays open. The list has the timeline back when that edit closes.
  const moved = useRef(fullList);
  useEffect(() => {
    if (!fullList) { moved.current = false; return; }
    actions.listOpen(thread.id, true, moved.current);
    return () => { actions.listOpen(thread.id, false); actions.lightMark(); };
  }, [fullList, thread.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A pass that has only just begun has nothing to sum up yet. Its rows appear with its first calls, or once it is done.
  // Every hook runs before the early return below so hooks stay stable when rows arrive.
  const empty = !edits.length && !pass && !decidedCallRows.length && !rejected.length;
  const count = edits.length || pass?.cuts || 0;
  // While Scarlet is still on a pass that has asked about no cut, nothing needs the editor. The block is the pass's
  // stages then: no count of the cuts staged so far, which would sit still between its parts, and nothing to schedule.
  const quiet = !!pass?.running && !pass.calls.length;
  // Every call is made but the pass isn't applied: it applies now or, while Scarlet still checks, when it finishes.
  // Under revision it waits for the revised cut to come back as a call. Before Scarlet has checked any staged cut there
  // is nothing to schedule: its calls haven't arrived. Only its calls hold it: a cut it already applied that asks for a
  // look is kept on its own card, and waits there whether or not the rest of the pass has gone in.
  const waiting = pass && !quiet && !openCalls && !pass.scheduled && !pass.revising && !pass.unchecked;
  const showing = actions.showing, listening = actions.listening;
  const editNumber = (e: Omit<ThreadEdit, "at">) => pass?.editNumbers.get(editKey(e))?.n
    ?? e.previous.map(p => pass?.editNumbers.get(editKey(p))?.n).find(n => n !== undefined);
  const rows: PassRow[] = [
    ...edits.flatMap((e): PassRow[] => {
      const key = editKey(e);
      const forYou = isForYouEdit(e);
      // A folded pass with nothing to review has no rows to draw.
      if (!tabbed && !listed) return [];
      const seen = reviewed(e);
      // A revision on its way: the row says so until the new version lands, whether or not the editor had kept the
      // edit. A cut the pass applied through its calls counts as kept, so a guard on that left its row as it was.
      const sent = revising(e);
      // One that came back revised with no reason from Scarlet says so until it is kept, as any other list's row does.
      const revised = e.check === REVISED_CHECK && !seen && !sent;
      const needs = !!e.check && !seen && !sent;
      const asks = asksEditor(sent);
      const sentBack = !!e.check && !seen && !!sent;
      // Ticked once the editor has kept it: any edit kept, an approved pass call, or a cut that went in with the pass
      // through its calls. That is what Keep's next row, the watch and the timeline's dots go by, so the tick agrees
      // with them (the editor's call, 2026-11-23).
      const decided = !needs && !sent && (seen || decidedCallEditKeys.has(key));
      const decision = decided ? (e.marker ? "Done" : "Kept") : undefined;
      // Where it stands, when it isn't simply waiting: the word a row among the calls ends on. In a list that leads
      // with times it takes the place of the row's amount.
      const word = sent ? revisionWord(sent, { rejecting: rejecting(e), adding: adding(e), nextQueuedId: actions.nextQueuedId }) : revised ? REVISED_CHECK : undefined;
      const at = (e as ThreadEdit).at ?? e.range.start;
      const displayAt = (!seen && !sent ? e.reviewRange?.start : undefined) ?? at;
      // Listed with the calls, it has the number it has among them. One that came back revised with a reason of
      // Scarlet's own ends on its version there, as a revised call does, until it is kept or sent back again.
      return [{ key, id: editKey(e.previous[0] ?? e), was: e.previous.map(editKey),
        at, displayAt, mark: displayAt, hover: { threadId: thread.id, editKey: key },
        label: (e.reason && e.summary) || e.label, n: 0, num: editNumber(e),
        state: word ?? decision ?? (e.previous.length ? `v${e.previous.length + 1}` : undefined), decision, value: editRemovedLabel(e) ?? editRowWord(e), word, revised, rejected: false, skipped: false,
        forYou, onlyForYou: false,
        // Scarlet is on that revision now, so its word moves; one still waiting its turn sits still.
        busy: !!sent && isWorking(sent.state), pending: !!sent, needs, asks, sentBack, decided,
        version: e.previous.length ? e.previous.length + 1 : 0, title: revised || e.reason ? undefined : e.check,
        on: !!showing && matchesEdit(showing, e), open: () => actions.openEdit(thread, e), fresh: fresh.has(e.changeId) }];
    }),
    // A call goes by its number, as on its card and on the timeline.
    ...(pass?.calls ?? []).map((c): PassRow => {
      const callWord = c.state === "revising" ? (revisionWord(c.run, { recheck: !!c.run && isRecheck(c.run), nextQueuedId: actions.nextQueuedId }) ?? "Revising…") : undefined;
      return { key: callRowKey(c), id: callRowKey(c), at: c.start, displayAt: c.start, mark: c.at,
        hover: { threadId: thread.id, call: c.index },
        label: c.summary, n: c.n, num: c.n, needs: c.state === "open", asks: c.state === "revising" && asksEditor(c.run), sentBack: c.state === "revising",
        decided: c.state === "approved" || c.state === "skipped", skipped: c.state === "skipped",
        decision: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : undefined,
        state: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? (c.version > 1 ? `v${c.version}` : undefined),
        value: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? c.tag,
        busy: c.state === "revising" && isWorking(c.run?.state), pending: c.state === "revising",
        version: c.version > 1 ? c.version : 0, title: c.earlier && `v${c.version - 1}: ${c.earlier.reason ?? "Scarlet’s earlier version."}${c.earlier.note ? `\nYou: “${c.earlier.note}”` : ""}`,
        on: listening?.changeId === pass!.change.id && listening.index === c.index, word: undefined, revised: false, rejected: false,
        forYou: true, onlyForYou: false, fresh: false,
        // In the column of edits a call sent back opens from its row in Working, as an edit sent back does: its card
        // says where its revision stands, and ↑ ↓ then step through Working's rows.
        open: c.state === "revising" && !rail ? undefined : () => pass!.openCall(c.index) };
    }),
    // An edit the editor rejected is out of the video. Its row stays, in Done or where it was in the list of every
    // edit, with a × where a kept one has its tick and "Rejected" where it said how much it took.
    ...rejected.flatMap((e): PassRow[] => {
      const forYou = isForYouRejected(e);
      if (!tabbed && !listed) return [];
      const key = editKey(e);
      return [{ key, id: editKey(e.previous[0] ?? e), was: e.previous.map(editKey), at: e.range.start, displayAt: e.range.start, mark: undefined,
        hover: { threadId: thread.id, editKey: key },
        label: e.label, n: 0, num: editNumber(e), state: "Rejected", decision: "Rejected",
        value: "Rejected", word: undefined, revised: false, rejected: true, skipped: false,
        forYou, onlyForYou: false, busy: false, pending: false, needs: false, asks: false, sentBack: false, decided: false, version: 0,
        title: undefined, on: !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)),
        open: () => actions.openEdit(thread, e), fresh: false }];
    }),
    // Calls decided before the pass applied that produced no applied edit (skipped cuts, or approved keep proposals).
    // A rejected one opens as a rejected edit's row does: lit, on the timeline where it was, with its note and Rejected.
    ...decidedCallRows.map((c): PassRow => {
      const ref = rejectedCallRef(c.changeId, c.index);
      return { key: c.key, id: c.key, at: c.at, displayAt: c.at, mark: undefined,
        hover: undefined,
        label: c.label, n: 0, num: undefined,
        state: c.approved ? "Kept" : "Rejected", decision: c.approved ? "Kept" : "Rejected",
        value: c.approved ? "Kept" : "Rejected", word: undefined,
        revised: false, rejected: !c.approved, skipped: false, forYou: true, onlyForYou: true, busy: false, pending: false, needs: false, asks: false, sentBack: false,
        decided: c.approved, version: 0, title: undefined, on: !c.approved && !!showing && matchesEdit(showing, ref),
        open: c.approved ? undefined : () => actions.openEdit(thread, ref), fresh: false };
    }),
  ].sort((a, b) => a.at - b.at);
  // The pass's calls and the edits that ask for a look: while any of them is listed the pass has something to say.
  const calls = pass ? rows.filter(r => r.n > 0 || r.forYou) : [];
  // Rows go by moments, at the time of the first of its edits. The moment's row stands for all of them: ticked once
  // they're all kept, Revising… while Scarlet is on one (or Up next / Queued while one waits its turn), and lit while
  // the moment is open. Its own edits show only once it is unfolded, or while one of them is open on its own, each
  // without a time: they all play in the moment's stretch. An edit that asks for a look and a call stay one a row.
  const momentOf = new Map<string, Moment<Omit<ThreadEdit, "at">>>();
  if (tabbed || listed) for (const m of moments) if (m.edits.length > 1) for (const e of m.edits) momentOf.set(editKey(e), m);
  const byKey = new Map(rows.map(row => [row.key, row]));
  // A request that itself waits on the editor (a question, or one that stopped early) keeps its row in For you.
  const asks = new Set(nests.flatMap(nest => nest.needs ? [nest.key] : []));
  const placeOf = (r: PassRow): RowPlace => r.needs || r.asks ? "you" : r.pending ? "working" : r.decided || r.rejected || r.onlyForYou ? "done" : "optional";
  const entries: Entry[] = [];
  const momentsDrawn = new Set<string>();
  for (const row of rows) {
    const moment = momentOf.get(row.key);
    if (!moment) { entries.push({ key: row.key, row, place: asks.has(row.key) ? "you" : placeOf(row), at: row.at, num: row.num }); continue; }
    if (momentsDrawn.has(moment.key)) continue;
    momentsDrawn.add(moment.key);
    const members = moment.members.flatMap(e => {
      const member = byKey.get(editKey(e));
      // One of its edits opened on its own from here is that edit alone: Keep and Revise are about it.
      return member ? [{ ...member, on: member.on && !!actions.showingSingle, open: member.open && (() => actions.openEdit(thread, e, undefined, true)) }] : [];
    });
    const main = byKey.get(moment.key) ?? row;
    const others = moment.edits.filter(e => e !== moment.main);
    const sent = members.find(m => m.asks) ?? members.find(m => m.busy) ?? members.find(m => m.word === "Up next") ?? members.find(m => m.pending);
    const more = others.length === 1 ? `+ ${(others[0]!.beforeCut ? "cut" : editKindWord(others[0] as ThreadEdit)?.toLowerCase()) ?? "1 edit"}` : `+ ${others.length} edits`;
    const allDecided = members.every(m => m.decided);
    entries.push({ key: main.key, row: { ...main, displayAt: Math.min(...members.map(m => m.displayAt)), on: main.on && !actions.showingSingle,
      decided: allDecided, decision: allDecided ? main.decision ?? "Kept" : undefined, word: sent?.word ?? main.word, asks: !!sent?.asks, busy: !sent?.asks && members.some(m => m.busy),
      revised: !sent && members.some(m => m.revised), pending: members.some(m => m.pending),
      was: members.flatMap(m => m.was ?? []), title: members.map(m => m.label).join("\n") }, members, more, moment: moment.key,
      unfolded: unfolded.has(moment.key) || members.some(m => m.on),
      place: members.some(m => asks.has(m.key)) ? "you" : rowPlace(members, { waits: m => m.needs || m.asks, sent: m => m.pending, kept: m => m.decided }),
      at: Math.min(...members.map(m => m.at)) });
  }
  // A row that has just left For you for Working or Done stays a moment where it was, with its new word.
  if (tabbed) linger.track(entries.map(e => ({ key: e.key, place: e.place, was: e.row.was })), optionalOpen && tab === "you");
  const heldFrom = (from: "you" | "optional") => entries.filter(e => (e.place === "working" || e.place === "done") && linger.of(e.key)?.from === from);
  const inPlace = (place: RowPlace) => entries.filter(e => e.place === place);
  // While the pass waits its rows go by their numbers, in the order each reached the editor; a list with a row that
  // has none goes by time, as the list of every edit does.
  const order: ListOrder = { numbers: !!pass?.calls.some(c => c.askOrder !== undefined) };
  const optional = inPlace("optional");
  // The lists on screen, top to bottom. With nothing to review there is the one list of every edit.
  type Drawn = { id: "all" | RowPlace; label: string; rows: Entry[] };
  const youLabel = pass && calls.length ? "Calls that need you" : "Edits that need you";
  const drawn: Drawn[] = rail ? [
      { id: "you", label: youLabel, rows: inListOrder([...inPlace("you"), ...heldFrom("you")], order) },
      ...(optionalOpen ? [{ id: "optional" as const, label: "Optional edits", rows: inListOrder([...optional, ...heldFrom("optional")], order) }] : []),
      { id: "working", label: "With Scarlet", rows: inListOrder(inPlace("working"), order) },
      { id: "done", label: "Decided", rows: inListOrder(inPlace("done"), order) },
    ] : !tabbed ? (listed ? [{ id: "all", label: "Every edit", rows: entries }] : [])
    : tab === "you" ? [
      { id: "you", label: pass && calls.length ? "Calls that need you" : "Edits that need you", rows: inListOrder([...inPlace("you"), ...heldFrom("you")], order) },
      ...(optionalOpen ? [{ id: "optional" as const, label: "Optional edits", rows: inListOrder([...optional, ...heldFrom("optional")], order) }] : []),
    ] : [{ id: tab, label: tab === "working" ? "With Scarlet" : "Decided", rows: inListOrder(inPlace(tab), order) }];
  for (const list of drawn) if (list.id === "you") for (const { row } of list.rows) if (row.forYou) listedNeed.current.add(row.key);
  // For you opens the first waiting row on the timeline, or leaves it open if the editor is already on one.
  const showNeeded = () => {
    setOpen(was => was === "all" ? was : undefined);
    if (!rows.some(row => row.on && row.needs)) inListOrder(inPlace("you"), order).find(e => e.row.needs)?.row.open?.();
  };
  // An edit or a call opened from somewhere else (the timeline, ⌘Z) shows the tab that holds it. One opened from the
  // list, stepped to or moved on to is in the tab shown already. The same one still open when the block is mounted
  // anew, between the conversation and the place above the message box, leaves the tabs as they were.
  const onEntry = tabbed ? entries.find(e => e.row.on || e.members?.some(m => m.on)) : undefined;
  const ownOpen = useRef<string>(undefined);
  const lastOpen = heldOpen ?? ownOpen;
  const openId = onEntry?.row.id;
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!onEntry || openId === was) return;
    // A row still in For you only for the moment after it was decided is Working's or Done's.
    const shown = tab === "you" ? onEntry.place === "you" || (onEntry.place === "optional" && optionalOpen) : onEntry.place === tab;
    if (!shown) setOpen(onEntry.place === "you" ? undefined : onEntry.place === "optional" ? "all" : onEntry.place);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  // While the pass's calls are listed, what is outside the list comes after it.
  const callsListed = hasForYou && !!pass && calls.length > 0;
  // What it came to, once Scarlet is done, while calls still wait too: what it applied so far, with the link that opens
  // every edit after it. Until its cuts are applied, a pass that finished with no call to make says how many it has ready.
  // The edits the sentence would name are said by their rows while the lists on screen have one for each of them.
  const named = (e: Omit<ThreadEdit, "at">) => !e.beforeCut && !e.marker && !e.elsewhere;
  const keysOf = ({ row, members }: Entry) => [row.key, ...members?.map(m => m.key) ?? []];
  const onScreen = new Set(drawn.flatMap(list => list.rows.flatMap(keysOf)));
  const rowsName = drawn.length > 0 && !(callsListed && !optionalOpen) && edits.filter(named).every(e => onScreen.has(editKey(e)));
  const made: SentencePart[] | undefined = edits.length ? working ? undefined : madeSentence(edits, lengthLabel, true, rowsName)
    : calls.length || quiet || decidedCallRows.length || rejected.length ? undefined : [{ strong: plural(count, "cut") }, " ready."];
  // Folded, a request about any of the moment's edits sits under the moment's row; unfolded, under its edit's.
  const under = ({ row, members, unfolded: momentOpen }: Entry) => nests.filter(nest => nest.key === row.key || (!momentOpen && !!members?.some(m => m.key === nest.key)));
  // The list follows the cut or edit that's open, so stepping with arrows or Keep never leaves its row out of sight.
  let selectedKey: string | undefined;
  if (!empty) {
    scan: for (const list of drawn) {
      let before = 0;
      for (const entry of list.rows) {
        const { row, members, unfolded: momentOpen } = entry;
        if (row.on) { selectedKey = `${list.id}:${before}:${row.key}`; break scan; }
        before += 1 + under(entry).length;
        if (momentOpen && members) for (const m of members) {
          if (m.on) { selectedKey = `${list.id}:${before}:member:${m.key}`; break scan; }
          before += 1 + nests.filter(nest => nest.key === m.key && m.key !== row.key).length;
        }
      }
    }
  }
  useKeepSelectedInView(host, selectedKey, ".simple-pass-list [aria-current=\"true\"]");
  // What the request has in each list of the column, and the way to its first and last row that waits.
  const waits = () => inListOrder(inPlace("you"), order).filter(e => e.row.needs || e.row.asks);
  useEffect(() => {
    rail?.report(thread.id, empty ? undefined : { you: need, optional: optional.length, working: inPlace("working").length, done: inPlace("done").length,
      openFirst: () => waits()[0]?.row.open?.(), openLast: () => waits().at(-1)?.row.open?.() });
  });
  useEffect(() => () => rail?.report(thread.id), [rail, thread.id]);
  if (empty) return null;
  // A request whose row is under a tab is drawn there, under that row, and nowhere else. One about a cut or edit with
  // no row at all still shows, under what the pass made.
  const placed = new Set((tabbed ? entries : drawn.flatMap(list => list.rows)).flatMap(keysOf));
  const fold = (key: string) => setUnfolded(was => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  const pastHour = drawn.some(list => list.rows.some(({ row }) => clockLabel(row.displayAt).length > 5));
  const rowList = ({ id, label, rows: list }: Drawn) => {
    // A list is its rows' numbers while the pass waits and each has one: a call is its number, Scarlet's note and,
    // once it's settled, sent back or revised, a word for where it stands, and an edit that asks for a look is listed
    // with them by its number too, counted on from the calls, so the list is one run of numbers. Any other list
    // leads with each row's time and keeps its version and amount: the time is bold amber on a tint while the row
    // needs the editor, and a decided row is ticked.
    const short = !!pass && id !== "all" && list.every(e => e.num !== undefined);
    // A list that leads with times widens their column for all its rows once one on screen is past an hour
    // ("1:02:07"), in the other list too: For you's rows and the optional ones under them keep one edge.
    const hours = !short && pastHour;
    return <ol key={id} className={short ? "simple-pass-list is-short" : hours ? "simple-pass-list has-hours" : "simple-pass-list"} aria-label={label}>
      {list.map(entry => {
        const { row, members, more, moment, unfolded: open } = entry;
        // Under the tabs a decided row says how it was decided; the list of every edit keeps its amount, ticked.
        const value = id === "all" ? row.value : row.decision ?? row.value;
        return <li key={row.key} className={linger.of(entry.key)?.leaving ? "is-leaving" : undefined}><button type="button" className={[row.on && "is-on", row.rejected && "is-rejected", row.asks && "is-asking", !row.on && !row.rejected && row.decided && "is-decided"].filter(Boolean).join(" ") || undefined} aria-current={row.on || undefined}
          data-log-control="open-pass-item" data-log-label={moment ? "Moment" : "Pass item"} disabled={!row.open} title={row.title || row.label} onClick={letGo(() => row.open?.())}
          aria-label={more ? `${clockLabel(row.displayAt)} ${row.label}, ${more.replace("+ ", "and ")}` : row.rejected ? `${clockLabel(row.displayAt)} ${row.label}, rejected` : undefined}
          onPointerEnter={() => actions.lightMark(row.mark, row.hover)} onPointerLeave={() => actions.lightMark()}>
          {short && row.rejected && !row.n
            ? <span className="edit-badge is-rejected" aria-hidden="true"><Icon name="x" size={9} /></span>
            : short
              ? <EditBadge n={row.num!} kept={row.decided && !row.skipped && !row.rejected} check={row.needs || row.asks} />
              : <span className={row.needs || row.asks ? "simple-pass-time is-need" : "simple-pass-time"}>{clockLabel(row.displayAt)}{(row.needs || row.asks) && <span>, needs you</span>}</span>}
          <span className="simple-pass-label">{short ? row.label : <>{(row.rejected || row.skipped) && <RejectedMark />}{row.decided && !row.skipped && !row.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-pass-words">{row.label}</span>
            {row.version > 0 && <EditVersion n={row.version} hover={spent.get(row.key)} />}{row.fresh && <small className="edit-version is-new">New</small>}
            {/* What else the moment holds, which unfolds its edits under the row and folds them again. */}
            {more && moment && <span className="simple-pass-more" aria-expanded={!!open} title={open ? "Hide its edits" : "Show its edits"}
              onClick={e => { e.stopPropagation(); fold(moment); }}>{more}</span>}</>}</span>
          {/* The word a row ends on (v2, Kept, Revising…) says on hover what the requests about its cut or edit took:
              their time and tokens, nothing else. The rest of the row keeps the row's own hover. */}
          {/* Every row ends on a word (2026-11-21, the editor's ask): where it stands once it has moved, or else what it is. */}
          {/* One whose request stopped to ask the editor something says Needs your answer, in amber and still: it is their turn. */}
          {short ? (row.state ?? row.value) && <span className={row.asks ? "simple-pass-value is-need" : row.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{row.state ?? row.value}</span>
            : row.word ? null
            : value && <span className={row.busy && !row.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{value}</span>}
          {/* An applied edit sent back, or come back revised, ends on that word in place of its amount: quiet while
              Scarlet is on it, amber once it is back and waits on the editor. One word a row, on the row's own line. */}
          {!short && row.word && <span className={`simple-pass-check${row.revised || row.asks ? "" : " is-kept"}${row.busy ? " working-text" : ""}`} title={spent.get(row.key)}>{row.word}</span>}
        </button>
        <AimRow on={!!row.on}>{short && row.rejected && !row.n
          ? <span className="edit-badge is-rejected" aria-hidden="true"><Icon name="x" size={9} /></span>
          : short ? <EditBadge n={row.num!} kept={row.decided && !row.skipped && !row.rejected} check={row.needs || row.asks} />
          : <span className={row.needs || row.asks ? "simple-pass-time is-need" : "simple-pass-time"}>{clockLabel(row.displayAt)}</span>}
          <span className="composer-aim-words">{row.label}</span></AimRow>
        {under(entry).map(nest => nest.node)}
        {open && members && <ol className="simple-pass-list is-moment" aria-label="Edits in this moment">
          {members.map(m => <li key={m.key}><button type="button" className={m.on ? "is-on" : m.decided ? "is-decided" : undefined} aria-current={m.on || undefined}
            data-log-control="open-pass-item" data-log-label="Edit in a moment" disabled={!m.open} title={m.title || m.label} onClick={letGo(() => m.open?.())}
            onPointerEnter={() => actions.lightMark(m.mark, m.hover)} onPointerLeave={() => actions.lightMark()}>
            <span className="simple-pass-label">{m.decided && !m.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-pass-words">{m.label}</span>
              {m.version > 0 && <EditVersion n={m.version} hover={spent.get(m.key)} />}</span>
            {m.value && !m.word && <span className={m.busy && !m.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(m.key)}>{m.value}</span>}
            {m.word && <span className={`simple-pass-check${m.revised || m.asks ? "" : " is-kept"}${m.busy ? " working-text" : ""}`} title={spent.get(m.key)}>{m.word}</span>}
          </button>{nests.filter(nest => nest.key === m.key && m.key !== row.key).map(nest => nest.node)}</li>)}
        </ol>}</li>;
      })}
    </ol>;
  };
  // The full list includes the pass's calls. A pass with no applied edits has only the calls to show.
  const soFar = (!!working || !!pass?.running) && !made;
  const canSeeAll = edits.length > 0;
  const seeProps = { thread, actions, single, rows: totalRows + rejected.length, count: totalRows, soFar, list: listState, reveal, column: !!rail };
  const seeEvery = (rail ? !!single : !tabbed) && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !rail && !tabbed && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const tabs = tabbed && <ReviewListTabs need={need} working={inPlace("working").length} done={inPlace("done").length} list={listState} reveal={reveal} showNeeded={showNeeded} />;
  const outsideList = <>
    {/* A request about a cut or edit that has no row still shows, under what the pass made. */}
    {nests.filter(nest => !placed.has(nest.key)).map(nest => nest.node)}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      {/* The pass goes in once its calls are decided and Scarlet finishes checking. */}
      {waiting && pass.deciding && <span className="simple-pass-ok">Applying…</span>}
      <span className="req-right">{aside}</span>
    </div>
  </>;
  if (rail) {
    const into = (section: RailSection, node: ReactNode) => { const at = rail.host(section, thread.id); return at && node ? createPortal(node, at) : null; };
    return <div ref={host} className="simple-pass" role="group" aria-label="Dialogue pass" data-thread={thread.id}>
      {made && <Made parts={made} link={seeEvery} />}
      <NeedLink need={need} onOpen={showNeeded} />
      {outsideList}
      {/* For you's place holds the rows that wait, then the one line that counts the edits Scarlet didn't flag, and those rows once it's open. */}
      {into("you", (drawn[0]!.rows.length > 0 || optional.length > 0) && <>
        {drawn[0]!.rows.length > 0 && rowList(drawn[0]!)}
        {optional.length > 0 && <OptionalLine inPass count={optional.length} open={optionalOpen} onToggle={() => setOpen(optionalOpen ? undefined : "all")} />}
        {drawn.filter(list => list.id === "optional" && list.rows.length > 0).map(rowList)}
      </>)}
      {drawn.filter(list => list.id === "working" || list.id === "done").map(list =>
        <Fragment key={list.id}>{into(list.id as RailSection, list.rows.length > 0 && rowList(list))}</Fragment>)}
      {pass?.error && <p className="simple-error" role="alert">{pass.error}
        {waiting && !pass.deciding && <button type="button" className="simple-link req-recover" onClick={pass.apply}>Retry</button>}</p>}
    </div>;
  }
  return <div ref={host} className="simple-pass" role="group" aria-label="Dialogue pass">
    {made && <Made parts={made} link={seeEvery} />}
    {!callsListed && outsideList}
    {seeTab}
    {tabs}
    {drawn.map((list, i) => <Fragment key={list.id}>
      {/* Under For you's rows, the edits Scarlet didn't flag are one line, closed until pressed. */}
      {list.id === "optional" && optional.length > 0 && <OptionalLine inPass count={optional.length} open onToggle={() => setOpen(undefined)} />}
      {list.rows.length > 0 ? rowList(list) : (list.id === "working" || list.id === "done" || (list.id === "you" && optional.length === 0)) && <p className="simple-review-empty">{EMPTY_TAB[list.id]}</p>}
      {list.id === "you" && i === drawn.length - 1 && optional.length > 0 && <OptionalLine inPass count={optional.length} open={false} onToggle={() => { reveal(); setOpen("all"); }} />}
    </Fragment>)}
    {callsListed && outsideList}
    {/* Only a failed apply offers Retry, after the reason, whichever list is on screen. */}
    {pass?.error && <p className="simple-error" role="alert">{pass.error}
      {waiting && !pass.deciding && <button type="button" className="simple-link req-recover" onClick={pass.apply}>Retry</button>}</p>}
  </div>;
}

/**
 * What any other request made, as the rows of its block: one sentence, then a link that opens the edits themselves,
 * numbered as on the timeline. Edits of one name that overlap exactly are one edit. Once Scarlet flagged one, the rows
 * sit under three tabs, as a pass's do, each with the number it has in the whole list: For you lists the flagged edits
 * not yet decided and counts them, with the edits Scarlet didn't flag behind one line under them ("3 optional");
 * Working has the ones sent back, each with its request under its row; Done has the ones kept or rejected. A row just
 * decided or sent back stays in For you a moment with its new word, then fades and leaves. A request about an edit
 * that is still in the chat (`nests`) sits directly under that edit's row.
 */
export function ThreadResult({ projectId, thread, edits, rejected, actions, aside, working, nests = noNests, spent = noSpent, list, listedNeed, wasShowing: heldShowing, linger: heldLinger, lastOpen: heldOpen }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[]; rejected?: Omit<ThreadEdit, "at">[]; actions: ChatActions;
  aside?: ReactNode; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** Which list is open and what For you has listed, held by the turn: the block is mounted anew when it moves
   *  between the conversation and the place above the message box, and a list the editor opened must not close then,
   *  nor turn into another. `wasShowing` is whether one of the edits was open when the block last drew, `lastOpen`
   *  which, and `linger` the rows just decided or sent back, which stay in For you a moment. */
  list: PassList; listedNeed: RefObject<Set<string>>; wasShowing?: RefObject<boolean>; linger?: ReviewLinger; lastOpen?: RefObject<string | undefined> }) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const linger = useHeldRows(heldLinger);
  const [open, setOpen] = list;
  const [host, reveal] = useReveal(open);
  const rail = useReviewRail();
  const gone = rejected ?? noRejected;
  const isForYou = (e: Omit<ThreadEdit, "at">) => e.rejected ? (!!e.wasCheck || listedBefore(listedNeed.current, e)) : !!e.check;
  // An edit open on the timeline shows in a list: the one that's open, or one that opens with it when none is.
  const showing = actions.showing;
  const shownEdit = showing && edits.find(e => matchesEdit(showing, e));
  const flagged = useMemo(() => edits.filter(e => e.check && !reviewed(e) && !revising(e)), [edits, reviewed, revising]);
  // Edits of one name that overlap exactly are one edit, on one row of the list: For you counts the rows that wait.
  const groups = useMemo(() => editGroups(edits), [edits]);
  // So does one sent back whose request has stopped to ask the editor something: it is their turn again.
  const need = useMemo(() => waitingRows(edits, { reviewed, revising }), [edits, reviewed, revising]);
  const forYouGroups = groups.filter(group => group.members.some(m => isForYou(m.edit)));
  const forYouRejected = gone.filter(isForYou);
  // Whether the request has anything for the editor to review, now or decided: it then has the three tabs.
  const hasForYou = forYouGroups.length > 0 || forYouRejected.length > 0;
  // Beside a column of edits every request has its rows under the lists, flagged or not.
  const tabbed = hasForYou || !!rail;
  const tab = tabShown(open);
  const optionalOpen = tabbed && open === "all";
  // Where each row is: every edit and every rejected one is under exactly one tab. A request that itself waits on the
  // editor (a question, or one that stopped early) keeps its row in For you.
  const asks = new Set(nests.flatMap(nest => nest.needs ? [nest.key] : []));
  const rowOf = new Map<string, string>(), placeOf = new Map<string, RowPlace>();
  const tracked: { key: string; place: RowPlace; was: string[] }[] = [];
  if (tabbed) {
    for (const { members } of groups) {
      const row = members.map(m => m.edit), key = editKey(row[0]!);
      const place = row.some(e => asks.has(editKey(e))) ? "you"
        : rowPlace(row, { waits: e => !!e.check && (asksEditor(revising(e)) || (!reviewed(e) && !revising(e))), sent: e => !!revising(e), kept: e => reviewed(e) });
      for (const e of row) rowOf.set(editKey(e), key);
      placeOf.set(key, place);
      tracked.push({ key, place, was: row.flatMap(e => e.previous.map(editKey)) });
    }
    for (const e of gone) {
      const key = editKey(e);
      rowOf.set(key, key);
      placeOf.set(key, "done");
      tracked.push({ key, place: "done", was: e.previous.map(editKey) });
    }
    // A row that has just left For you for Working or Done stays a moment where it was, with its new word.
    linger.track(tracked, optionalOpen && tab === "you");
  }
  const place = (e: Omit<ThreadEdit, "at">) => placeOf.get(rowOf.get(editKey(e)) ?? "");
  const held = (e: Omit<ThreadEdit, "at">) => (place(e) === "working" || place(e) === "done") ? linger.of(rowOf.get(editKey(e)) ?? "") : undefined;
  const inYou = (e: Omit<ThreadEdit, "at">) => place(e) === "you" || held(e)?.from === "you";
  const inOptional = (e: Omit<ThreadEdit, "at">) => place(e) === "optional" || held(e)?.from === "optional";
  const onScreen = (e: Omit<ThreadEdit, "at">) => tab === "you" ? inYou(e) || (optionalOpen && inOptional(e)) : place(e) === tab;
  const countOf = (at: RowPlace) => tracked.filter(row => row.place === at).length;
  const some = (only: (e: Omit<ThreadEdit, "at">) => boolean) => edits.some(only) || gone.some(only);
  // Every edit belongs to For you: For you already lists them all.
  const allForYou = hasForYou && forYouGroups.length === groups.length && forYouRejected.length === gone.length;
  const single = !working && groups.length === 1 ? shownEdit ?? edits[0] : undefined;
  const showingInList = !!shownEdit && (!single || allForYou);
  // With nothing to review, an edit opened on the timeline opens the list of every edit. Only an edit the editor has
  // just opened does that. The same edit still open when its request moves between the conversation and the place
  // above the message box, mounted anew, leaves the lists as they were.
  const ownShowing = useRef(false);
  const wasShowing = heldShowing ?? ownShowing;
  useEffect(() => {
    if (!tabbed && showingInList && !wasShowing.current) setOpen("all");
    wasShowing.current = showingInList;
  }, [showingInList]); // eslint-disable-line react-hooks/exhaustive-deps
  // Under the tabs, an edit opened from somewhere else (the timeline, ⌘Z) shows the tab that holds it: For you for one
  // that waits, with its optional line open for one Scarlet didn't flag, Working for one sent back, Done for one
  // decided. One opened from the list, stepped to or moved on to is in the tab shown already.
  const openEdit = showing && (shownEdit ?? gone.find(e => matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)));
  const openId = openEdit ? editKey(openEdit.previous[0] ?? openEdit) : undefined;
  const ownOpen = useRef<string>(undefined);
  const lastOpen = heldOpen ?? ownOpen;
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!tabbed || !openEdit || openId === was) return;
    const at = place(openEdit);
    // A row still in For you only for the moment after it was decided is Working's or Done's.
    const shown = tab === "you" ? at === "you" || (at === "optional" && optionalOpen) : at === tab;
    if (shown) { if (at === "you") setOpen(o => o ?? "need"); }
    else if (at) setOpen(at === "you" ? "need" : at === "optional" ? "all" : at);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The For you list closes only if there are no For you items at all.
  useEffect(() => { if (open === "need" && !tabbed) setOpen(undefined); }, [open, tabbed]); // eslint-disable-line react-hooks/exhaustive-deps
  if (tabbed && tab === "you") {
    for (const edit of edits) if (inYou(edit)) listedNeed.current.add(editKey(edit));
    for (const edit of gone) if (inYou(edit)) listedNeed.current.add(editKey(edit));
  }
  // With nothing left in the video and nothing for the editor, the rejected edits' rows are all there is: they show
  // without a click or a tab, so a request whose only edit was rejected still says so (2026-11-23).
  const onlyRejected = !edits.length && gone.length > 0 && !tabbed;
  const showsList = tabbed || open === "all" || onlyRejected || (!!single && !!shownEdit);
  // The edits the sentence would name are said by their rows while the lists on screen have one for each of them.
  const rowsName = tabbed ? edits.every(e => e.beforeCut || e.marker || e.elsewhere || onScreen(e)) : open === "all";
  const made = useMemo(() => {
    if (working) return undefined;
    const said = madeSentence(edits, lengthLabel, false, rowsName);
    // A request that only flagged an edit another one made has made nothing to say.
    return said.length ? said : undefined;
  }, [working, edits, rowsName]);
  // Edits that are one row have their requests under that row. Under the tabs a
  // request whose row is under any of them is drawn there and nowhere else; with one list, every row it shows counts.
  const listed = new Set(tabbed ? rowOf.keys() : showsList ? [...edits, ...gone].map(editKey) : []);
  const canSeeAll = open === "all" || edits.length > 0;
  const seeProps = { thread, actions, single, rows: groups.length + gone.length, count: groups.length, soFar: working && !made, list, reveal, column: !!rail };
  const seeEvery = (rail ? !!single : !tabbed) && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !rail && !tabbed && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const showNeeded = () => {
    setOpen(was => was === "all" ? was : undefined);
    if (flagged.length && !flagged.some(edit => !!actions.showing && matchesEdit(actions.showing, edit))) actions.openEdit(thread, flagged[0]!);
  };
  const rows = (label: string | undefined, only?: (e: Omit<ThreadEdit, "at">) => boolean) =>
    <ThreadEdits projectId={projectId} thread={thread} edits={edits} rejected={rejected} showing={actions.showing} only={only} label={label}
      leaving={only && (edit => !!held(edit)?.leaving)}
      nextQueuedId={actions.nextQueuedId}
      onPlay={ref => actions.openEdit(thread, ref)}
      onHover={ref => actions.lightMark(undefined, ref && { threadId: thread.id, editKey: editKey(ref) })}
      under={edit => nests.filter(nest => nest.key === editKey(edit)).map(nest => nest.node)} spent={edit => spent.get(editKey(edit))} />;
  const optional = countOf("optional");
  useEffect(() => {
    rail?.report(thread.id, { you: need, optional, working: countOf("working"), done: countOf("done"),
      openFirst: () => { if (flagged[0]) actions.openEdit(thread, flagged[0]); }, openLast: () => { const last = flagged.at(-1); if (last) actions.openEdit(thread, last); } });
  });
  useEffect(() => () => rail?.report(thread.id), [rail, thread.id]);
  if (rail) {
    const into = (section: RailSection, node: ReactNode) => { const at = rail.host(section, thread.id); return at && node ? createPortal(node, at) : null; };
    return <div ref={host} className="simple-pass" role="group" aria-label="Edits" data-thread={thread.id}>
      {made && <Made parts={made} link={seeEvery} />}
      <NeedLink need={need} onOpen={showNeeded} />
      <div className="simple-pass-line req-row">
        {!made && seeEvery}
        <span className="req-right">{aside}
          <ThreadAction projectId={projectId} thread={thread} edits={edits} onPlay={ref => actions.openEdit(thread, ref)} menuOnly menu={false} /></span>
      </div>
      {into("you", (some(inYou) || optional > 0) && <>
        {some(inYou) && rows("Edits that need you", inYou)}
        {optional > 0 && <OptionalLine count={optional} open={optionalOpen} onToggle={() => setOpen(optionalOpen ? undefined : "all")} />}
        {optionalOpen && some(inOptional) && rows("Optional edits", inOptional)}
      </>)}
      {into("working", countOf("working") > 0 && rows("With Scarlet", e => place(e) === "working"))}
      {into("done", countOf("done") > 0 && rows("Decided", e => place(e) === "done"))}
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
    {tabbed && <ReviewListTabs need={need} working={countOf("working")} done={countOf("done")} list={list} reveal={reveal} showNeeded={showNeeded} />}
    {seeTab}
    {!tabbed && showsList && rows(undefined)}
    {tabbed && tab === "you" && <>
      {some(inYou) ? rows("Edits that need you", inYou) : optional === 0 && <p className="simple-review-empty">{EMPTY_TAB.you}</p>}
      {/* Under For you's rows, the edits Scarlet didn't flag are one line, closed until pressed. */}
      {optional > 0 && <OptionalLine count={optional} open={optionalOpen} onToggle={() => { if (!optionalOpen) reveal(); setOpen(optionalOpen ? undefined : "all"); }} />}
      {optionalOpen && some(inOptional) && rows("Optional edits", inOptional)}
    </>}
    {tabbed && tab !== "you" && (countOf(tab) > 0 ? rows(tab === "working" ? "With Scarlet" : "Decided", e => place(e) === tab)
      : <p className="simple-review-empty">{EMPTY_TAB[tab]}</p>)}
    {nests.filter(nest => !listed.has(nest.key)).map(nest => nest.node)}
  </div>;
}
