/**
 * What a request's block in the chat shares between the two layouts: `PassSummary`/`ThreadResult` here and in
 * `beta/PassSummaryBeta`. The facts about a request's edits and calls, the rows they make, and the pieces of the block
 * drawn the same in both. Each layout keeps where it draws the rows: the default under the request's tabs, the beta in
 * its column of edits.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { continuousBrollSections, matchesEdit, REVISED_CHECK, type EditRef, type ThreadEdit } from "@scarlet/shared";
import { useProjectStore } from "../../stores/project";
import { useShownCut } from "../../stores/shownCut";
import { asksEditor, editGroups, revisionWord, useAdding, useCanUnkeep, useRejecting, useReviewed, useRevising, waitingPassRows, waitingRows } from "../../components/review/threadEditState";
import { editKindWord, editRowWord } from "../../lib/editKind";
import { listMoments, type Moment } from "../../lib/editMoments";
import { callRowTooltip, changeForEdit, cutRemovedSeconds, decidedCallRowTooltip, editRowTooltip, momentRowTooltip, type RowTooltipContext, type RowTooltipInfo } from "../../lib/editRowTooltip";
import { lengthLabel, plural } from "../../lib/format";
import { editKey, unkeepEdits } from "../../lib/keptEdits";
import { madeSentence, type SentencePart } from "../../lib/madeSentence";
import { decidedPassCalls, rejectedCallRef } from "../../lib/passCalls";
import { rowPlace, type RowPlace } from "../../lib/reviewTabs";
import { isRecheck, type Thread } from "../../lib/threads";
import { recordUndo } from "../../lib/undo";
import { useWorkingModel } from "../../lib/workingModel";
import { callRowKey, isWorking, letGo, listedBefore, noRejected, type ChatActions, type HoveredReviewRow, type Nest, type PassList } from "./types";

type Edit = Omit<ThreadEdit, "at">;

/**
 * A finished request with one result opens its edit on the timeline. A collection opens a list to choose from. Closed,
 * either is a link after the sentence (`place` "inline"): See edit for one, See both or See all for several, and the
 * edits so far while Scarlet works. Open, a finished collection's list is under its tab, in the row where Needs review,
 * Working and Done sit when there is something to review (`place` "tab"), and the tab pressed again closes it. Each
 * place draws only its own. The word counts the rows the list opens (`rows`), a rejected edit's too: See both is for two.
 */
export function EditResultLink({ thread, actions, single, rows, count, soFar, list: [open, setOpen], reveal, place, column }: {
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
 * A list the editor opens is brought into view. The conversation sits at its latest message, so a list opened on the
 * last request grows downward, under the message box, and the click would seem to do nothing. Only a press asks for
 * it: a list that is open already when its block is drawn again moves nothing.
 */
export function useReveal(open: unknown) {
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
export function Made({ parts, link }: { parts: readonly SentencePart[]; link?: ReactNode }) {
  if (!parts.length) return null;
  return <p className="simple-made-line"><span className="simple-made">{parts.map((part, i) => typeof part === "string" ? part : <b key={i}>{part.strong}</b>)}</span>{link}</p>;
}

/** One row of a pass's lists: an edit, a call, a rejected edit or a call decided before the pass applied. */
export interface PassRow {
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
  /** The order a call reached the editor in, never shown; 0 for any other row. */
  n: number;
  callIndex?: number;
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
  /** Take back Keep on this row from its hover control. */
  unkeep?: () => void;
  unkeepTip?: string;
  fresh: boolean;
  /** Structured hover tooltip content for the beta edits column. */
  tip?: RowTooltipInfo;
  /** Seconds removed when this row is a cut (used to sum removed time on grouped `+N` rows). */
  removedSeconds?: number;
}

/** A row as a list draws it: one edit or call, or a moment, with the tab it is under. */
export interface Entry {
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

interface RequestEdits {
  projectId: string; thread: Thread; edits: Edit[]; rejected: Edit[]; actions: ChatActions;
}

/** What a dialogue pass's block knows before it draws a row, the same in both layouts. */
export function usePassFacts({ projectId, thread, edits, rejected, actions, listedNeed, working }: RequestEdits & {
  listedNeed: RefObject<Set<string>>; working?: boolean;
}) {
  const reviewed = useReviewed(projectId, thread);
  const canUnkeep = useCanUnkeep(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const adding = useAdding(thread);
  const modelAt = useWorkingModel();
  const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
  const openCalls = pass?.calls.filter(c => c.state === "open").length ?? 0;
  // Calls the editor decided before the pass applied are rows of Done: approved cuts link to their applied edit row,
  // and skipped calls (or approved keep proposals) are decided rows of their own.
  const { decidedCallEditKeys, decidedCallRows } = useMemo(
    () => decidedPassCalls(pass ? undefined : thread, edits, rejected),
    [pass, thread, edits, rejected],
  );
  const isForYouEdit = (e: Edit) => !!e.check || decidedCallEditKeys.has(editKey(e));
  const isForYouRejected = (e: Edit) => !!e.wasCheck || decidedCallEditKeys.has(editKey(e)) || listedBefore(listedNeed.current, e);
  const forYouEdits = edits.filter(isForYouEdit);
  const forYouRejected = rejected.filter(isForYouRejected);
  // What waits on the editor: an open call and a flagged edit not yet kept. One sent back for revision waits on Scarlet,
  // until its request stops to ask the editor something: then it is their turn again.
  const need = waitingPassRows(pass?.calls, edits, isForYouEdit, { reviewed, revising });
  // Whether the request has anything for the editor to review, now or decided: it then has the three tabs.
  const hasForYou = (pass?.calls.length ?? 0) > 0 || forYouEdits.length > 0 || forYouRejected.length > 0 || decidedCallRows.length > 0;
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
  const fold = (key: string) => setUnfolded(was => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  const single = !working && !pass?.running && totalRows === 1 ? edits[0] : undefined;
  // A pass that has only just begun has nothing to sum up yet. Its rows appear with its first calls, or once it is done.
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
  return { reviewed, canUnkeep, revising, rejecting, adding, modelAt, pass, decidedCallEditKeys, decidedCallRows, isForYouEdit, isForYouRejected,
    need, hasForYou, fresh, moments, totalRows, unfolded, fold, single, empty, count, quiet, waiting };
}

export type PassFacts = ReturnType<typeof usePassFacts>;

/** How a layout wants a pass's rows built. */
interface PassRowOptions {
  /** Build the edits' rows and moments at all: a folded pass with nothing to review draws none. Calls always have rows. */
  drawRows: boolean;
  /** Rows carry the order the pass numbered its edits and calls in (`num`). */
  numbers?: boolean;
  /** Unkeep on an unflagged edit moves it back to Needs review, as under the tabs, instead of just unkeeping it. */
  backToReview: boolean;
  /** A call sent back for revision opens from its row, as in the column of edits' Working. */
  openRevising?: boolean;
  /** What the column of edits' hover tooltips need: rows then carry `tip` and `removedSeconds`. */
  rail?: Pick<RowTooltipContext, "timeline" | "media" | "fps">;
}

/**
 * A pass's rows, each by its time: its edits, calls, rejected edits and calls decided before it applied, then the
 * entries a list draws, with edits that play as one change folded into one row, a moment, each placed under one tab.
 */
export function passEntries(f: PassFacts, { projectId, thread, edits, rejected, actions, nests }: RequestEdits & { nests: readonly Nest[] }, opts: PassRowOptions) {
  const { reviewed, canUnkeep, revising, rejecting, adding, modelAt, pass, decidedCallEditKeys, decidedCallRows, isForYouEdit, isForYouRejected, fresh, moments, unfolded } = f;
  const { drawRows, numbers, backToReview, openRevising, rail } = opts;
  const showing = actions.showing, listening = actions.listening;
  const editNumber = (e: Edit) => !numbers ? undefined : pass?.editNumbers.get(editKey(e))?.n
    ?? e.previous.map(p => pass?.editNumbers.get(editKey(p))?.n).find(n => n !== undefined);
  const rows: PassRow[] = [
    ...edits.flatMap((e): PassRow[] => {
      const key = editKey(e);
      const forYou = isForYouEdit(e);
      if (!drawRows) return [];
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
      // Where it stands while Scarlet is actively working on it (Revising…, Up next, Queued, Needs your answer).
      // Once revised, v2 sits beside the title and the row keeps its type tag on the right.
      const word = sent ? revisionWord(sent, { rejecting: rejecting(e), adding: adding(e), nextQueuedId: actions.nextQueuedId }) : undefined;
      const at = (e as ThreadEdit).at ?? e.range.start;
      const displayAt = (!seen && !sent ? e.reviewRange?.start : undefined) ?? at;
      const unkeepable = decided && !e.marker && canUnkeep(e) && !(!e.check && decidedCallEditKeys.has(key));
      const label = (e.reason && e.summary) || e.label;
      const version = e.previous.length ? e.previous.length + 1 : 0;
      const editChange = rail ? changeForEdit(thread, e.changeId) : undefined;
      const removed = rail && (!!e.beforeCut || e.kind === "cut") ? cutRemovedSeconds(e, editChange) : undefined;
      const tip = rail ? editRowTooltip(e, { change: editChange, ...rail, version, status: word ?? decision, by: modelAt(sent) }) : undefined;
      return [{ key, id: editKey(e.previous[0] ?? e), was: e.previous.map(editKey),
        at, displayAt, mark: displayAt, hover: { threadId: thread.id, editKey: key },
        label, n: 0, num: editNumber(e),
        state: word ?? decision ?? (version ? `v${version}` : undefined), decision, value: editRowWord(e), word, revised, rejected: false, skipped: false,
        forYou, onlyForYou: false,
        // Scarlet is on that revision now, so its word moves; one still waiting its turn sits still.
        busy: !!sent && isWorking(sent.state), pending: !!sent, needs, asks, sentBack, decided,
        version, title: revised || e.reason ? undefined : e.check,
        on: !!showing && matchesEdit(showing, e), open: () => actions.openEdit(thread, e),
        ...(unkeepable && {
          unkeep: () => {
            actions.lightMark();
            unkeepEdits(projectId, thread.id, [e]);
            recordUndo({ kind: "unkeep", word: "Unkeep", projectId, threadId: thread.id, refs: [e], name: label });
          },
          unkeepTip: e.check || backToReview ? "Move back to Needs review" : "Unkeep",
        }),
        fresh: fresh.has(e.changeId), tip, removedSeconds: removed }];
    }),
    // A call goes by its time, as on its card and in the box's tag.
    ...(pass?.calls ?? []).map((c): PassRow => {
      const callWord = c.state === "revising" ? (revisionWord(c.run, { recheck: !!c.run && isRecheck(c.run), nextQueuedId: actions.nextQueuedId }) ?? "Revising…") : undefined;
      const tip = rail ? callRowTooltip({ summary: c.summary, reason: c.reason, tag: c.tag, length: c.length, state: c.state, version: c.version, earlier: c.earlier, word: callWord, by: modelAt(c.run) }) : undefined;
      return { key: callRowKey(c), id: callRowKey(c), at: c.start, displayAt: c.start, mark: c.at,
        hover: { threadId: thread.id, call: c.index },
        label: c.summary, n: c.n, callIndex: c.index, num: numbers ? c.n : undefined, needs: c.state === "open", asks: c.state === "revising" && asksEditor(c.run), sentBack: c.state === "revising",
        decided: c.state === "approved" || c.state === "skipped", skipped: c.state === "skipped",
        decision: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : undefined,
        state: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? (c.version > 1 ? `v${c.version}` : undefined),
        value: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? c.tag,
        busy: c.state === "revising" && isWorking(c.run?.state), pending: c.state === "revising",
        version: c.version > 1 ? c.version : 0, title: c.earlier && `v${c.version - 1}: ${c.earlier.reason ?? "Scarlet’s earlier version."}${c.earlier.note ? `\nYou: “${c.earlier.note}”` : ""}`,
        on: listening?.changeId === pass!.change.id && listening.index === c.index, word: undefined, revised: false, rejected: false,
        forYou: true, onlyForYou: false, fresh: false, tip, removedSeconds: rail && c.tag === "Cut" ? c.length : undefined,
        ...(c.state === "approved" && !pass!.deciding && pass!.unkeepCall && {
          unkeep: () => { actions.lightMark(); pass!.unkeepCall!(c.index); },
          unkeepTip: "Move back to Needs review",
        }),
        open: c.state === "revising" && !openRevising ? undefined : () => pass!.openCall(c.index) };
    }),
    // An edit the editor rejected is out of the video. Its row stays, in Done or where it was in the list of every
    // edit, with a × where a kept one has its tick and "Rejected" where it said how much it took.
    ...rejected.flatMap((e): PassRow[] => {
      const forYou = isForYouRejected(e);
      if (!drawRows) return [];
      const key = editKey(e);
      const tip = rail ? editRowTooltip(e, { change: changeForEdit(thread, e.changeId), ...rail }) : undefined;
      return [{ key, id: editKey(e.previous[0] ?? e), was: e.previous.map(editKey), at: e.range.start, displayAt: e.range.start, mark: undefined,
        hover: { threadId: thread.id, editKey: key },
        label: e.label, n: 0, num: editNumber(e), state: "Rejected", decision: "Rejected",
        value: "Rejected", word: undefined, revised: false, rejected: true, skipped: false,
        forYou, onlyForYou: false, busy: false, pending: false, needs: false, asks: false, sentBack: false, decided: false, version: 0,
        title: undefined, on: !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)),
        open: () => actions.openEdit(thread, e), fresh: false, tip }];
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
        open: c.approved ? undefined : () => actions.openEdit(thread, ref), fresh: false, tip: rail ? decidedCallRowTooltip(c) : undefined };
    }),
  ].sort((a, b) => a.at - b.at);
  // The pass's calls and the edits that ask for a look: while any of them is listed the pass has something to say.
  const calls = pass ? rows.filter(r => r.n > 0 || r.forYou) : [];
  // Rows go by moments, at the time of the first of its edits. The moment's row stands for all of them: ticked once
  // they're all kept, Revising… while Scarlet is on one (or Up next / Queued while one waits its turn), and lit while
  // the moment is open. Its own edits show only once it is unfolded, or while one of them is open on its own, each
  // without a time: they all play in the moment's stretch. An edit that asks for a look and a call stay one a row.
  const momentOf = new Map<string, Moment<Edit>>();
  if (drawRows) for (const m of moments) if (m.edits.length > 1) for (const e of m.edits) momentOf.set(editKey(e), m);
  const byKey = new Map(rows.map(row => [row.key, row]));
  // A request that itself waits on the editor (a question, or one that stopped early) keeps its row in Needs review.
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
    const unkeepMembers = allDecided ? moment.edits.filter(e => !e.marker && canUnkeep(e) && !(!e.check && decidedCallEditKeys.has(editKey(e)))) : [];
    const momentTip = rail ? momentRowTooltip(main.label, members.map(m => ({ label: m.label, value: m.value, kind: m.tip?.meta })),
      { start: Math.min(...moment.edits.map(e => e.range.start)), end: Math.max(...moment.edits.map(e => e.range.end)) },
      sent?.word ?? (allDecided ? main.decision ?? "Kept" : undefined)) : undefined;
    entries.push({ key: main.key, row: { ...main, displayAt: Math.min(...members.map(m => m.displayAt)), on: main.on && !actions.showingSingle,
      decided: allDecided, decision: allDecided ? main.decision ?? "Kept" : undefined, word: sent?.word ?? main.word, asks: !!sent?.asks, busy: !sent?.asks && members.some(m => m.busy),
      revised: !sent && members.some(m => m.revised), pending: members.some(m => m.pending),
      unkeep: unkeepMembers.length > 0 ? () => {
        actions.lightMark();
        unkeepEdits(projectId, thread.id, unkeepMembers);
        recordUndo({ kind: "unkeep", word: "Unkeep", projectId, threadId: thread.id, refs: unkeepMembers, name: main.label });
      } : undefined,
      unkeepTip: unkeepMembers.length > 0 ? (backToReview ? "Move back to Needs review" : "Unkeep") : undefined,
      was: members.flatMap(m => m.was ?? []), title: members.map(m => m.label).join("\n"), tip: momentTip }, members, more, moment: moment.key,
      unfolded: unfolded.has(moment.key) || members.some(m => m.on),
      place: members.some(m => asks.has(m.key)) ? "you" : rowPlace(members, { waits: m => m.needs || m.asks, sent: m => m.pending, kept: m => m.decided }),
      at: Math.min(...members.map(m => m.at)) });
  }
  return { rows, calls, entries };
}

/** Every row key an entry stands for: its own and its moment's edits'. */
export const entryKeys = ({ row, members }: Entry) => [row.key, ...members?.map(m => m.key) ?? []];

/** The requests drawn under an entry's row. Folded, one about any of the moment's edits sits under the moment's row; unfolded, under its edit's. */
export const nestsUnder = (nests: readonly Nest[], { row, members, unfolded: momentOpen }: Entry) =>
  nests.filter(nest => nest.key === row.key || (!momentOpen && !!members?.some(m => m.key === nest.key)));

/**
 * Which row of the lists on screen is open, by its list, the rows and requests above it and its key: the list follows
 * the cut or edit that's open, so stepping with arrows or Keep never leaves its row out of sight.
 */
export function selectedRowKey(drawn: readonly { id: string; rows: readonly Entry[] }[], nests: readonly Nest[]) {
  for (const list of drawn) {
    let before = 0;
    for (const entry of list.rows) {
      const { row, members, unfolded: momentOpen } = entry;
      if (row.on) return `${list.id}:${before}:${row.key}`;
      before += 1 + nestsUnder(nests, entry).length;
      if (momentOpen && members) for (const m of members) {
        if (m.on) return `${list.id}:${before}:member:${m.key}`;
        before += 1 + nests.filter(nest => nest.key === m.key && m.key !== row.key).length;
      }
    }
  }
  return undefined;
}

/**
 * A line mounted with its list already open is the same list, moved with its request between the conversation and
 * the place above the message box. It leaves the timeline where it is, so an edit of another request the editor has
 * open stays open. The list has the timeline back when that edit closes.
 */
export function useListOpen(actions: ChatActions, threadId: string, fullList: boolean) {
  const moved = useRef(fullList);
  useEffect(() => {
    if (!fullList) { moved.current = false; return; }
    actions.listOpen(threadId, true, moved.current);
    return () => { actions.listOpen(threadId, false); actions.lightMark(); };
  }, [fullList, threadId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * What the pass came to, once Scarlet is done, while calls still wait too: what it applied so far. Until its cuts are
 * applied, a pass that finished with no call to make says how many it has ready. `rowsName`: the lists on screen have a
 * row for each edit the sentence would name, so it leaves them to their rows.
 */
export function passMade(f: PassFacts, edits: readonly Edit[], rejected: readonly Edit[], calls: readonly PassRow[], working: boolean | undefined, rowsName: boolean): SentencePart[] | undefined {
  return edits.length ? working ? undefined : madeSentence(edits, lengthLabel, true, rowsName)
    : calls.length || f.quiet || f.decidedCallRows.length || rejected.length ? undefined : [{ strong: plural(f.count, "cut") }, " ready."];
}

/** The edits a pass's sentence would name. */
export const namedEdit = (e: Edit) => !e.beforeCut && !e.marker && !e.elsewhere;

/** What any other request's block knows before it places a row, the same in both layouts. */
export function useThreadFacts({ projectId, thread, edits, rejected, actions }: Omit<RequestEdits, "rejected"> & { rejected?: Edit[] }) {
  const reviewed = useReviewed(projectId, thread);
  const canUnkeep = useCanUnkeep(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const adding = useAdding(thread);
  const { timeline } = useShownCut();
  const media = useProjectStore(s => s.current?.media);
  const brollSections = useMemo(() => timeline ? continuousBrollSections(timeline, media) : undefined, [timeline, media]);
  const gone = rejected ?? noRejected;
  // An edit open on the timeline shows in a list: the one that's open, or one that opens with it when none is.
  const showing = actions.showing;
  const shownEdit = showing && edits.find(e => matchesEdit(showing, e));
  // Edits of one name that overlap exactly — and contiguous B-roll edits in one continuous section — are one row.
  const groups = useMemo(() => editGroups(edits, brollSections), [edits, brollSections]);
  // So does one sent back whose request has stopped to ask the editor something: it is their turn again.
  const need = useMemo(() => waitingRows(edits, { reviewed, revising }, brollSections), [edits, reviewed, revising, brollSections]);
  // The edit open, rejected or not, by its row's first version.
  const openEdit = showing && (shownEdit ?? gone.find(e => matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)));
  const openId = openEdit ? editKey(openEdit.previous[0] ?? openEdit) : undefined;
  return { reviewed, canUnkeep, revising, rejecting, adding, gone, showing, shownEdit, groups, need, openEdit, openId, brollSections };
}

/**
 * Where each of a request's rows is: every edit and every rejected one is under exactly one tab. A request that itself
 * waits on the editor (a question, or one that stopped early) keeps its row in Needs review. `rowOf` gives an edit's
 * row by its first edit's key, `placeOf` a row's tab, and `tracked` each row as a list's held rows follow it. With
 * `placeRows` off, no row has a place.
 */
export function threadRowPlaces({ groups, gone, revising, reviewed }: Pick<ReturnType<typeof useThreadFacts>, "groups" | "gone" | "revising" | "reviewed">, nests: readonly Nest[], placeRows = true) {
  const asks = new Set(nests.flatMap(nest => nest.needs ? [nest.key] : []));
  const rowOf = new Map<string, string>(), placeOf = new Map<string, RowPlace>();
  const tracked: { key: string; place: RowPlace; was: string[]; busy?: boolean }[] = [];
  if (!placeRows) return { rowOf, placeOf, tracked };
  for (const { members } of groups) {
    const row = members.map(m => m.edit), key = editKey(row[0]!);
    const place = row.some(e => asks.has(editKey(e))) ? "you"
      : rowPlace(row, { waits: e => asksEditor(revising(e)) || (!!e.check && !reviewed(e) && !revising(e)), sent: e => !!revising(e), kept: e => reviewed(e) });
    for (const e of row) rowOf.set(editKey(e), key);
    placeOf.set(key, place);
    const busy = row.some(e => { const r = revising(e); return !!r && isWorking(r.state); });
    tracked.push({ key, place, was: row.flatMap(e => e.previous.map(editKey)), busy });
  }
  for (const e of gone) {
    const key = editKey(e);
    rowOf.set(key, key);
    placeOf.set(key, "done");
    tracked.push({ key, place: "done", was: e.previous.map(editKey) });
  }
  return { rowOf, placeOf, tracked };
}
