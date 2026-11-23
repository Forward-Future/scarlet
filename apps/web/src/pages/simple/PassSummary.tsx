import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { matchesEdit, REVISED_CHECK, type EditRef, type ThreadEdit } from "@scarlet/shared";
import { EditBadge, editGroups, EditVersion, RejectedMark, revisionWord, ThreadAction, ThreadEdits, useDeferred, useRejecting, useReviewed, useRevising } from "../../components/review/ThreadEdits";
import { Icon } from "../../components/ui/primitives";
import { editKindWord, editRowWord } from "../../lib/editKind";
import { listMoments, type Moment } from "../../lib/editMoments";
import { clock as clockLabel, editRemovedLabel, lengthLabel, plural } from "../../lib/format";
import { editKey, reviewKey, useKeptEdits } from "../../lib/keptEdits";
import { madeSentence, type SentencePart } from "../../lib/madeSentence";
import { decidedPassCalls } from "../../lib/passCalls";
import { isRecheck, type Thread } from "../../lib/threads";
import { callRowKey, isWorking, letGo, noNests, noRejected, noSpent, type ChatActions, type Nest, type PassList, type Spent } from "./types";

/**
 * A finished request with one result opens its edit on the timeline. A collection opens a list to choose from. One
 * edit, or the edits so far while Scarlet works, is a link after the sentence (`place` "inline"). A finished
 * collection is See all, a tab in the row where For you and See all sit when something waits on the editor
 * (`place` "tab"), so it is in the same place either way. Each place draws only its own.
 */
function EditResultLink({ thread, actions, single, count, soFar, list: [open, setOpen], reveal, place }: {
  thread: Thread; actions: ChatActions; single?: EditRef; count: number; soFar?: boolean; list: PassList; reveal(): void; place: "inline" | "tab";
}) {
  const expanded = open === "all";
  const current = !!single && !!actions.showing && matchesEdit(actions.showing, single);
  const isLink = (!!single && (!expanded || current)) || !!soFar;
  if (isLink !== (place === "inline")) return null;
  if (!soFar && !isLink) {
    const label = count === 2 ? "See both" : "See all";
    return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
      <button type="button" className="simple-review-tab" aria-pressed={expanded} title={expanded ? "Hide the edits" : "Show the edits in order"}
        onClick={letGo(() => { if (!expanded) reveal(); setOpen(expanded ? undefined : "all"); })}>{label}</button>
    </div>;
  }
  if (single && (!expanded || current)) {
    const toggleEdit = () => {
      if (!current) return actions.openEdit(thread, single);
      setOpen(undefined);
      actions.stopShowing();
    };
    return <button type="button" className="simple-pass-toggle" aria-current={current || undefined}
      title={current ? "Close this edit (Esc)" : "Show on the timeline"} onClick={letGo(toggleEdit)}>{current ? "Close edit" : "See edit"}</button>;
  }
  return <button type="button" className="simple-pass-toggle" data-so-far aria-expanded={expanded}
    title={expanded ? "Hide the edits" : "Show the edits Scarlet has made so far, in order"}
    onClick={() => { if (!expanded) reveal(); setOpen(expanded ? undefined : "all"); }}>{expanded ? "Hide" : `See ${count} ${count === 1 ? "edit" : "edits"} so far`}</button>;
}

function ReviewListTabs({ need, canSeeAll, list: [open, setOpen], reveal, showNeeded }: {
  need: number; canSeeAll: boolean; list: PassList; reveal(): void; showNeeded(): void;
}) {
  const all = open === "all";
  const showAll = () => {
    if (all) return;
    reveal();
    setOpen("all");
  };
  return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab simple-pass-need" aria-label="For you" aria-pressed={!all}
      title={need ? `${need} ${need === 1 ? "needs" : "need"} you` : undefined} onClick={letGo(showNeeded)}>
      For you{need > 0 && <span className="simple-review-tab-count" aria-hidden="true">{need}</span>}
    </button>
    {canSeeAll && <button type="button" className="simple-review-tab" aria-pressed={all} onClick={letGo(showAll)}>See all</button>}
  </div>;
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
      const row = rows?.querySelector(':scope > li > button[aria-current="true"]') ?? rows?.querySelector(":scope > li > button");
      row?.scrollIntoView?.({ block: "nearest" });
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
 * What a dialogue pass made, as the rows of its block. While its calls wait they are listed without a click, each by
 * its number with Scarlet's note and, once decided or sent back, a word for where it stands. For you shows that list
 * by default and opens the first one still waiting when pressed; decided items stay in For you, clearly marked as
 * handled, even once nothing waits. See all lists every edit, calls included, in timeline order. Once Scarlet is done,
 * what the pass applied is one sentence above the list. A row is one line and opens its edit or call in the card on the
 * timeline, where Keep and Reject edit move on to the next call. A request about one cut or edit that is still in the
 * chat (`nests`) sits directly under that cut's or edit's row. `aside` is what the run used, when that shows.
 */
export function PassSummary({ projectId, thread, edits, rejected = noRejected, actions, aside, list: listState, listedNeed, working, nests = noNests, spent = noSpent }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[];
  /** Edits the editor rejected: out of the video, each keeps a row in the list of every edit, with a × and "Rejected". */
  rejected?: Omit<ThreadEdit, "at">[];
  actions: ChatActions; aside?: ReactNode; list: PassList; listedNeed: RefObject<Set<string>>; working?: boolean; nests?: readonly Nest[]; spent?: Spent }) {
  const reviewed = useReviewed(projectId, thread);
  const deferred = useDeferred(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const kept = useKeptEdits(projectId, thread);
  const [open, setOpen] = listState;
  const [host, reveal] = useReveal(open);
  // The list follows the cut or edit that's open, so stepping with the arrows never leaves its row out of sight.
  const list = useRef<HTMLOListElement>(null);
  const onRow = actions.showing ? editKey(actions.showing) : actions.listening?.key;
  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [onRow, open]);
  const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
  // An edit sent back for revision waits on Scarlet, not on the editor; a to-do parked as Later stays in For you
  // without holding up the waiting count.
  const flagged = useMemo(() => edits.filter(e => e.check && !reviewed(e) && !deferred(e) && !revising(e)), [edits, reviewed, deferred, revising]);
  const openCalls = pass?.calls.filter(c => c.state === "open").length ?? 0;
  const need = openCalls + flagged.length;
  const totalRows = edits.length + (pass?.calls.length ?? 0);
  // Calls the editor decided before the pass applied stay in For you: approved cuts link to their applied edit row,
  // and skipped calls (or approved keep proposals) stay as decided rows.
  const { decidedCallEditKeys, decidedCallRows } = useMemo(
    () => decidedPassCalls(pass ? undefined : thread, edits, rejected),
    [pass, thread, edits, rejected],
  );
  const wasListed = (e: Omit<ThreadEdit, "at">) => listedNeed.current.has(editKey(e)) || e.previous.some(p => listedNeed.current.has(editKey(p)));
  const isForYouEdit = (e: Omit<ThreadEdit, "at">) => !!e.check || decidedCallEditKeys.has(editKey(e));
  const isForYouRejected = (e: Omit<ThreadEdit, "at">) => !!e.wasCheck || decidedCallEditKeys.has(editKey(e)) || wasListed(e);
  const forYouEdits = edits.filter(isForYouEdit);
  const forYouRejected = rejected.filter(isForYouRejected);
  const hasForYou = (pass?.calls.length ?? 0) > 0 || forYouEdits.length > 0 || forYouRejected.length > 0 || decidedCallRows.length > 0;
  // While the pass makes its final check of the finished cut, the fixes it applies are marked New in the list: nothing
  // else tells them from the cuts that went in before (2026-11-14).
  const rerun = working ? thread.tasks.find(t => !!t.repeatAudit?.returns && !!t.startedAt && isWorking(t.state)) : undefined;
  const fresh = useMemo(() => new Set(rerun ? thread.changes.filter(c => c.taskId === rerun.id && (c.createdAt ?? "") >= rerun.startedAt!).map(c => c.id) : []),
    [rerun, thread.changes]);
  // In the list of every edit, edits that play as one change are one row, a moment. Its own edits open under it on a
  // press of "+ 4 edits", and fold again on the next.
  const moments = useMemo(() => listMoments(edits), [edits]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const single = !working && !pass?.running && totalRows === 1 ? edits[0] : undefined;
  // A single preview follows the open card. An explicitly opened list keeps the timeline on the whole pass.
  const fullList = open === "all" && edits.length > 0;
  const listed = fullList || (!!single && !hasForYou && open !== "need" && !!actions.showing && matchesEdit(actions.showing, single));
  // The For you list closes only if there are no For you items at all.
  useEffect(() => { if (open === "need" && !hasForYou) setOpen(undefined); }, [open, hasForYou]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Every hook is above this line: the pass's first cuts arriving must not change how many hooks run.
  if (!edits.length && !pass && !decidedCallRows.length && !forYouRejected.length) return null;
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
  const rows = [
    ...edits.flatMap(e => {
      const key = editKey(e);
      const forYou = isForYouEdit(e);
      // A folded pass only needs rows that can appear in its call or For you list.
      if (!listed && !forYou) return [];
      const seen = reviewed(e);
      // A revision on its way: the row says so until the new version lands, whether or not the editor had kept the
      // edit. A cut the pass applied through its calls counts as kept, so a guard on that left its row as it was.
      const sent = revising(e);
      const later = !seen && !sent && deferred(e);
      // One that came back revised with no reason from Scarlet says so until it is kept, as any other list's row does.
      const revised = e.check === REVISED_CHECK && !seen && !sent;
      const needs = !!e.check && !seen && !later && !sent;
      const sentBack = !!e.check && !seen && !!sent;
      // Ticked once the editor has kept it: a flagged edit they reviewed, an approved pass call, or any edit kept.
      const decided = !needs && !sent && !later && ((!!e.check && seen) || kept.has(reviewKey(e)) || decidedCallEditKeys.has(key));
      const decision = decided ? (e.marker ? "Done" : "Kept") : later ? "Later" : undefined;
      // Where it stands, when it isn't simply waiting: the word a row among the calls ends on. In the list of every edit
      // it follows the row's amount, as in any other request's list, and the amount stays.
      const word = sent ? revisionWord(sent, { rejecting: rejecting(e), nextQueuedId: actions.nextQueuedId }) : revised ? REVISED_CHECK : undefined;
      const at = (e as ThreadEdit).at ?? e.range.start;
      const displayAt = (!seen && !sent ? e.reviewRange?.start : undefined) ?? at;
      // Listed with the calls, it has the number it has among them.
      return [{ key, at, displayAt, mark: displayAt as number | undefined, hover: { threadId: thread.id, editKey: key } as { threadId: string; editKey?: string; call?: number } | undefined,
        label: (e.reason && e.summary) || e.label, n: 0, num: editNumber(e),
        state: word ?? decision, decision, value: later ? "Later" : editRemovedLabel(e) ?? editRowWord(e), word, revised, rejected: false, skipped: false,
        forYou, onlyForYou: false,
        // Scarlet is on that revision now, so its word moves; one still waiting its turn sits still.
        busy: !!sent && isWorking(sent.state), pending: !!sent, needs, sentBack, decided,
        version: e.previous.length ? e.previous.length + 1 : 0, title: revised || e.reason ? undefined : e.check,
        on: !!showing && matchesEdit(showing, e), open: (() => actions.openEdit(thread, e)) as (() => void) | undefined, fresh: fresh.has(e.changeId) }];
    }),
    // A call goes by its number, as on its card and on the timeline.
    ...(pass?.calls ?? []).map(c => {
      const callWord = c.state === "revising" ? (revisionWord(c.run, { recheck: !!c.run && isRecheck(c.run), nextQueuedId: actions.nextQueuedId }) ?? "Revising…") : undefined;
      return { key: callRowKey(c), at: c.start, displayAt: c.start, mark: c.at,
        hover: { threadId: thread.id, call: c.index } as { threadId: string; editKey?: string; call?: number } | undefined,
        label: c.summary, n: c.n, num: c.n as number | undefined, needs: c.state === "open", sentBack: c.state === "revising",
        decided: c.state === "approved" || c.state === "skipped", skipped: c.state === "skipped",
        decision: (c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : undefined) as string | undefined,
        state: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? (c.version > 1 ? `v${c.version}` : undefined),
        value: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? c.tag,
        busy: c.state === "revising" && isWorking(c.run?.state), pending: c.state === "revising",
        version: c.version > 1 ? c.version : 0, title: c.earlier && `v${c.version - 1}: ${c.earlier.reason ?? "Scarlet’s earlier version."}${c.earlier.note ? `\nYou: “${c.earlier.note}”` : ""}`,
        on: listening?.changeId === pass!.change.id && listening.index === c.index, word: undefined, revised: false, rejected: false,
        forYou: true, onlyForYou: false, fresh: false,
        open: c.state === "revising" ? undefined : () => pass!.openCall(c.index) };
    }),
    // An edit the editor rejected is out of the video. Its row stays where it was in See all and, if it was a For you
    // item, in For you too — with a × where a kept one has its tick and "Rejected" where it said how much it took.
    ...rejected.flatMap(e => {
      const forYou = isForYouRejected(e);
      if (!listed && !forYou) return [];
      const key = editKey(e);
      return [{ key, at: e.range.start, displayAt: e.range.start, mark: undefined as number | undefined,
        hover: { threadId: thread.id, editKey: key } as { threadId: string; editKey?: string; call?: number } | undefined,
        label: e.label, n: 0, num: editNumber(e), state: "Rejected" as string | undefined, decision: "Rejected" as string | undefined,
        value: "Rejected" as string | undefined, word: undefined as string | undefined, revised: false, rejected: true, skipped: false,
        forYou, onlyForYou: false, busy: false, pending: false, needs: false, sentBack: false, decided: false, version: 0,
        title: undefined as string | undefined, on: !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)),
        open: (() => actions.openEdit(thread, e)) as (() => void) | undefined, fresh: false }];
    }),
    // Calls decided before the pass applied that produced no applied edit (skipped cuts, or approved keep proposals).
    ...decidedCallRows.map(c => ({ key: c.key, at: c.at, displayAt: c.at, mark: undefined as number | undefined,
      hover: undefined as { threadId: string; editKey?: string; call?: number } | undefined,
      label: c.label, n: 0, num: undefined as number | undefined,
      state: (c.approved ? "Kept" : "Rejected") as string | undefined, decision: (c.approved ? "Kept" : "Rejected") as string | undefined,
      value: (c.approved ? "Kept" : "Rejected") as string | undefined, word: undefined as string | undefined,
      revised: false, rejected: !c.approved, skipped: false, forYou: true, onlyForYou: true, busy: false, pending: false, needs: false, sentBack: false,
      decided: c.approved, version: 0, title: undefined as string | undefined, on: false, open: undefined as (() => void) | undefined, fresh: false })),
  ].sort((a, b) => a.at - b.at);
  // While the pass waits on the editor, its calls are listed: every one of them, along with every For you edit (whether
  // waiting, sent back, kept, or rejected), so nothing disappears when decided. N counts only what still waits.
  const calls = pass ? rows.filter(r => r.n > 0 || r.forYou) : [];
  // The short list keeps each published row in the order it reached the editor. The full list follows the timeline.
  if (pass?.calls.some(c => c.askOrder !== undefined)) calls.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity));
  // With no waiting pass calls, For you lists the thread's For you items (flagged edits and decided calls) — keeping
  // each item in place with its decision once handled.
  const filter = listed ? "all" : calls.length ? "calls" : open !== "all" && hasForYou ? "need" : undefined;
  const shown = filter === "calls" ? calls : filter === "need" ? rows.filter(r => r.forYou) : rows.filter(r => !r.onlyForYou);
  if (filter === "calls" || filter === "need") for (const row of shown) if (row.forYou) listedNeed.current.add(row.key);
  // For you opens the first waiting row on the timeline, or leaves it open if the editor is already on one.
  const showNeeded = () => {
    setOpen(undefined);
    if (!rows.some(row => row.on && row.needs)) (calls.length ? calls : rows).find(row => row.needs)?.open?.();
  };
  // What it came to, once Scarlet is done, while calls still wait too: what it applied so far, with the link that opens
  // every edit after it. Until its cuts are applied, a pass that finished with no call to make says how many it proposes.
  const made: SentencePart[] | undefined = edits.length ? working ? undefined : madeSentence(edits, lengthLabel, true)
    : calls.length || quiet || decidedCallRows.length || forYouRejected.length ? undefined : [{ strong: plural(count, "cut") }, " proposed."];
  // The list of every edit goes by moments, at the time of the first of its edits. The moment's row stands for all of
  // them: ticked once they're all kept, Revising… while Scarlet is on one (or Up next / Queued while one waits its
  // turn), and lit while the moment is open. Its own edits show only once it is unfolded, or while one of them is open
  // on its own, each without a time: they all play in the moment's stretch. For you and the calls stay one edit a row.
  type Row = (typeof rows)[number];
  const momentOf = new Map<string, Moment<Omit<ThreadEdit, "at">>>();
  if (filter === "all") for (const m of moments) if (m.edits.length > 1) for (const e of m.edits) momentOf.set(editKey(e), m);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const drawn: { row: Row; members?: Row[]; more?: string; moment?: string; unfolded?: boolean }[] = [];
  const momentsDrawn = new Set<string>();
  for (const row of shown) {
    const moment = momentOf.get(row.key);
    if (!moment) { drawn.push({ row }); continue; }
    if (momentsDrawn.has(moment.key)) continue;
    momentsDrawn.add(moment.key);
    const members = moment.members.flatMap(e => {
      const member = byKey.get(editKey(e));
      // One of its edits opened on its own from here is that edit alone: Keep and Revise are about it.
      return member ? [{ ...member, on: member.on && !!actions.showingSingle, open: member.open && (() => actions.openEdit(thread, e, undefined, true)) } as Row] : [];
    });
    const main = byKey.get(moment.key) ?? row;
    const others = moment.edits.filter(e => e !== moment.main);
    const sent = members.find(m => m.busy) ?? members.find(m => m.word === "Up next") ?? members.find(m => m.pending);
    const more = others.length === 1 ? `+ ${(others[0]!.beforeCut ? "cut" : editKindWord(others[0] as ThreadEdit)?.toLowerCase()) ?? "1 edit"}` : `+ ${others.length} edits`;
    drawn.push({ row: { ...main, displayAt: Math.min(...members.map(m => m.displayAt)), on: main.on && !actions.showingSingle,
      decided: members.every(m => m.decided), word: sent?.word ?? main.word, busy: members.some(m => m.busy),
      revised: !sent && members.some(m => m.revised), pending: members.some(m => m.pending),
      title: members.map(m => m.label).join("\n") } as Row, members, more, moment: moment.key,
      unfolded: unfolded.has(moment.key) || members.some(m => m.on) });
  }
  const placed = new Set(filter ? drawn.flatMap(({ row, members }) => [row.key, ...members?.map(m => m.key) ?? []]) : []);
  const fold = (key: string) => setUnfolded(was => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  // A list that leads with times widens their column for all its rows once one of them is past an hour ("1:02:07").
  const hours = filter !== "calls" && shown.some(row => clockLabel(row.displayAt).length > 5);
  const rowList = filter && <ol ref={list} className={filter === "calls" ? "simple-pass-list is-short" : hours ? "simple-pass-list has-hours" : "simple-pass-list"}
    aria-label={filter === "calls" ? "Calls that need you" : filter === "need" ? "Edits that need you" : "Every edit"}>
    {drawn.map(({ row, members, more, moment, unfolded: open }) => <li key={row.key}><button type="button" className={[row.on && "is-on", row.rejected && "is-rejected", !row.on && !row.rejected && row.decided && "is-decided"].filter(Boolean).join(" ") || undefined} aria-current={row.on || undefined}
      data-log-control="open-pass-item" data-log-label={moment ? "Moment" : "Pass item"} disabled={!row.open} title={row.title || row.label} onClick={letGo(() => row.open?.())}
      aria-label={more ? `${clockLabel(row.displayAt)} ${row.label}, ${more.replace("+ ", "and ")}` : row.rejected ? `${clockLabel(row.displayAt)} ${row.label}, rejected` : undefined}
      onPointerEnter={() => actions.lightMark(row.mark, row.hover)} onPointerLeave={() => actions.lightMark()}>
      {/* The calls are the short list: a call is its number, Scarlet's note and, once it's settled, sent back or
          revised, a word for where it stands. An edit that asks for a look is listed with them by its number too,
          counted on from the calls, so the list is one run of numbers. The full list keeps each row's time, version
          and amount: the time is bold amber on a tint while the row needs the editor, and a decided row is ticked. */}
      {filter === "calls" && row.rejected && !row.n
        ? <span className="edit-badge is-rejected" aria-hidden="true"><Icon name="x" size={9} /></span>
        : filter === "calls" && row.num
          ? <EditBadge n={row.num} kept={row.decided && !row.skipped && !row.rejected} check={row.needs} />
          : <span className={row.needs ? "simple-pass-time is-need" : "simple-pass-time"}>{clockLabel(row.displayAt)}{row.needs && <span>, needs you</span>}</span>}
      <span className="simple-pass-label">{filter === "calls" ? row.label : <>{row.rejected && <RejectedMark />}{row.decided && !row.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-pass-words">{row.label}</span>
        {row.version > 0 && <EditVersion n={row.version} hover={spent.get(row.key)} />}{row.fresh && <small className="edit-version is-new">New</small>}
        {/* What else the moment holds, which unfolds its edits under the row and folds them again. */}
        {more && moment && <span className="simple-pass-more" aria-expanded={!!open} title={open ? "Hide its edits" : "Show its edits"}
          onClick={e => { e.stopPropagation(); fold(moment); }}>{more}</span>}</>}</span>
      {/* The word a row ends on (v2, Kept, Revising…) says on hover what the requests about its cut or edit took:
          their time and tokens, nothing else. The rest of the row keeps the row's own hover. */}
      {/* Every row ends on a word (2026-11-21, the editor's ask): where it stands once it has moved, or else what it is, as See all says. */}
      {filter === "calls" ? (row.state ?? row.value) && <span className={row.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{row.state ?? row.value}</span>
        : filter === "need" ? (row.decision ?? row.value) && <span className={row.busy && !row.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{row.decision ?? row.value}</span>
        : row.value && <span className={row.busy && !row.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{row.value}</span>}
      {/* An applied edit sent back, or come back revised, says so after its amount, as a row of any other request's
          list does: amber once it is back and waits on the editor, quiet while Scarlet is on it. */}
      {filter !== "calls" && row.word && <span className={`simple-pass-check${row.revised ? "" : " is-kept"}${row.busy ? " working-text" : ""}`} title={spent.get(row.key)}>{row.word}</span>}
    </button>
    {/* Folded, a request about any of the moment's edits sits under the moment's row; unfolded, under its edit's. */}
    {nests.filter(nest => nest.key === row.key || (!open && !!members?.some(m => m.key === nest.key))).map(nest => nest.node)}
    {open && members && <ol className="simple-pass-list is-moment" aria-label="Edits in this moment">
      {members.map(m => <li key={m.key}><button type="button" className={m.on ? "is-on" : m.decided ? "is-decided" : undefined} aria-current={m.on || undefined}
        data-log-control="open-pass-item" data-log-label="Edit in a moment" disabled={!m.open} title={m.title || m.label} onClick={letGo(() => m.open?.())}
        onPointerEnter={() => actions.lightMark(m.mark, m.hover)} onPointerLeave={() => actions.lightMark()}>
        <span className="simple-pass-label">{m.decided && !m.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-pass-words">{m.label}</span>
          {m.version > 0 && <EditVersion n={m.version} hover={spent.get(m.key)} />}</span>
        {m.value && <span className={m.busy && !m.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(m.key)}>{m.value}</span>}
        {m.word && <span className={`simple-pass-check${m.revised ? "" : " is-kept"}${m.busy ? " working-text" : ""}`} title={spent.get(m.key)}>{m.word}</span>}
      </button>{nests.filter(nest => nest.key === m.key && m.key !== row.key).map(nest => nest.node)}</li>)}
    </ol>}</li>)}
  </ol>;
  // The full list includes the pass's calls. A pass with no applied edits has only the calls to show.
  const soFar = (!!working || !!pass?.running) && !made;
  const allInForYou = hasForYou && forYouEdits.length === edits.length && forYouRejected.length === rejected.length;
  const canSeeAll = edits.length > 0 && (fullList || !allInForYou);
  const hasReview = hasForYou;
  const seeProps = { thread, actions, single, count: totalRows, soFar, list: listState, reveal };
  const seeEvery = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const tabs = hasReview && <ReviewListTabs need={need} canSeeAll={canSeeAll} list={listState} reveal={reveal} showNeeded={showNeeded} />;
  const outsideList = <>
    {/* A request about a cut or edit whose row isn't listed right now still shows, under what the pass made. */}
    {nests.filter(nest => !placed.has(nest.key)).map(nest => nest.node)}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      {/* The pass goes in once its calls are decided and Scarlet finishes checking. Only a failed apply offers Retry. */}
      {waiting && pass.deciding && <span className="simple-pass-ok">Applying…</span>}
      {waiting && !pass.deciding && !!pass.error && <button type="button" className="simple-link" onClick={pass.apply}>Retry</button>}
      <span className="req-right">{aside}</span>
    </div>
  </>;
  return <div ref={host} className="simple-pass" role="group" aria-label="Dialogue pass">
    {made && <Made parts={made} link={seeEvery} />}
    {filter !== "calls" && outsideList}
    {filter !== "calls" && seeTab}
    {filter && <>{tabs}{rowList}</>}
    {filter === "calls" && outsideList}
    {pass?.error && <p className="simple-error" role="alert">{pass.error}</p>}
  </div>;
}

/**
 * What any other request made, as the rows of its block: one sentence, then a link that opens the edits themselves,
 * numbered as on the timeline. An edit made in several places is one edit. For you counts the flagged edits not yet
 * kept and lists them by default with their own numbers; once decided, each item stays in For you updated with its
 * decision. A request about an edit that is still in the chat (`nests`) sits directly under that edit's row.
 */
export function ThreadResult({ projectId, thread, edits, rejected, actions, aside, working, nests = noNests, spent = noSpent, list, listedNeed, wasShowing: heldShowing }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[]; rejected?: Omit<ThreadEdit, "at">[]; actions: ChatActions;
  aside?: ReactNode; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** Which list is open and what For you has listed, held by the turn: the block is mounted anew when it moves
   *  between the conversation and the place above the message box, and a list the editor opened must not close then,
   *  nor turn into the list of every edit. `wasShowing` is whether one of the edits was open when the block last drew. */
  list: PassList; listedNeed: RefObject<Set<string>>; wasShowing?: RefObject<boolean> }) {
  const reviewed = useReviewed(projectId, thread);
  const deferred = useDeferred(projectId, thread);
  const revising = useRevising(thread);
  const [open, setOpen] = list;
  const [host, reveal] = useReveal(open);
  const wasListed = (e: Omit<ThreadEdit, "at">) => listedNeed.current.has(editKey(e)) || e.previous.some(p => listedNeed.current.has(editKey(p)));
  const isForYou = (e: Omit<ThreadEdit, "at">) => e.rejected ? (!!e.wasCheck || wasListed(e)) : !!e.check;
  // An edit open on the timeline shows in a list: the one that's open, or one that opens with it when none is. For a
  // For you edit that is the For you list, where ↑ and ↓ step to the others that wait, as its card's "1 of N" says.
  // For any other edit it is every edit.
  const showing = actions.showing;
  const shownEdit = showing && edits.find(e => matchesEdit(showing, e));
  const flagged = useMemo(() => edits.filter(e => e.check && !reviewed(e) && !deferred(e) && !revising(e)), [edits, reviewed, deferred, revising]);
  // An edit made in several places is one edit, on one row of the list: For you counts the rows that wait.
  const groups = useMemo(() => editGroups(edits), [edits]);
  const need = useMemo(() => groups.filter(group => group.members.some(m => flagged.includes(m.edit))).length, [groups, flagged]);
  const forYouGroups = groups.filter(group => group.members.some(m => isForYou(m.edit)));
  const forYouRejected = (rejected ?? []).filter(isForYou);
  const hasForYou = forYouGroups.length > 0 || forYouRejected.length > 0;
  // Every edit belongs to For you: For you already lists them all.
  const allForYou = hasForYou && forYouGroups.length === groups.length && forYouRejected.length === (rejected?.length ?? 0);
  const single = !working && groups.length === 1 ? shownEdit ?? edits[0] : undefined;
  const showingInList = !!shownEdit && (!single || allForYou);
  // Only an edit the editor has just opened does that. The same edit still open when its request moves between the
  // conversation and the place above the message box, mounted anew, leaves the lists as they were.
  const ownShowing = useRef(false);
  const wasShowing = heldShowing ?? ownShowing;
  useEffect(() => {
    if (showingInList && !wasShowing.current) setOpen(o => isForYou(shownEdit!) ? o ?? "need" : "all");
    wasShowing.current = showingInList;
  }, [showingInList]); // eslint-disable-line react-hooks/exhaustive-deps
  // The For you list closes only if there are no For you items at all.
  useEffect(() => { if (open === "need" && !hasForYou) setOpen(undefined); }, [open, hasForYou]); // eslint-disable-line react-hooks/exhaustive-deps
  // For you items are listed without a click, until "See all" lists every edit in their place. Decided items stay in
  // For you, clearly marked as handled, even once nothing waits.
  const needing = open !== "all" && hasForYou;
  const only = needing ? isForYou : undefined;
  if (only) {
    for (const edit of edits) if (only(edit)) listedNeed.current.add(editKey(edit));
    for (const edit of rejected ?? []) if (only(edit)) listedNeed.current.add(editKey(edit));
  }
  const made = useMemo(() => {
    if (working) return undefined;
    const said = madeSentence(edits, lengthLabel);
    // A request that only flagged an edit another one made has made nothing to say.
    return said.length ? said : undefined;
  }, [working, edits]);
  const showsList = open === "all" || needing || (!!single && !!shownEdit && !allForYou);
  // An edit made in several places is one row, listed when any of its places is picked, and a request about any of
  // them sits under that row: every place of a row the list shows counts as listed, as the list itself picks its rows.
  const listed = new Set(showsList ? [
    ...groups.filter(group => !only || group.members.some(m => only(m.edit))).flatMap(group => group.members.map(m => editKey(m.edit))),
    ...(rejected ?? []).filter(e => !only || only(e)).map(editKey),
  ] : []);
  const canSeeAll = open === "all" || (edits.length > 0 && !allForYou);
  const hasReview = hasForYou;
  const seeProps = { thread, actions, single, count: groups.length, soFar: working && !made, list, reveal };
  const seeEvery = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const showNeeded = () => {
    setOpen(undefined);
    if (flagged.length && !flagged.some(edit => !!actions.showing && matchesEdit(actions.showing, edit))) actions.openEdit(thread, flagged[0]!);
  };
  return <div ref={host} className="simple-pass" role="group" aria-label="Edits">
    {made && <Made parts={made} link={seeEvery} />}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      <span className="req-right">{aside}
        {/* Undo these edits and File this thread have no place in the chat for now. What they reported still shows. */}
        <ThreadAction projectId={projectId} thread={thread} edits={edits} onPlay={ref => actions.openEdit(thread, ref)} menuOnly menu={false} /></span>
    </div>
    {showsList && hasReview && <ReviewListTabs need={need} canSeeAll={canSeeAll} list={list} reveal={reveal} showNeeded={showNeeded} />}
    {seeTab}
    {showsList && <ThreadEdits projectId={projectId} thread={thread} edits={edits} rejected={rejected} showing={actions.showing} only={only}
      nextQueuedId={actions.nextQueuedId}
      onPlay={ref => actions.openEdit(thread, ref)}
      onHover={ref => actions.lightMark(undefined, ref && { threadId: thread.id, editKey: editKey(ref) })}
      under={edit => nests.filter(nest => nest.key === editKey(edit)).map(nest => nest.node)} spent={edit => spent.get(editKey(edit))} />}
    {nests.filter(nest => !listed.has(nest.key)).map(nest => nest.node)}
  </div>;
}
