import { matchesEdit, requestText, type Task, type ThreadEdit } from "@scarlet/shared";
import { canStartCutReview, isPublishedCall, rebaseOp, RebaseConflict, reviewCutSummaries, reviewReasons, type Change, type CutAssessment, type CutReview, type TimeMap, type TimeRange, type Timeline } from "@scarlet/timeline";
import { editKey } from "./editMoments";
import { requestRoots, stagingTask } from "./requestRuns";
import { runIsActive } from "./taskRun";
import { isRecheck, stagedCuts, type Thread } from "./threads";

/**
 * Where a cut staged on its pass's version sits on the working cut. The pass stays on the version it was staged on,
 * and a request in its own thread (an undo, a revision of an applied cut) can move the working cut on while its calls
 * wait. The cut is anchored in its footage and carried by the engine's own rule for a cut (`rebaseOp`), so it is
 * placed exactly where applying the pass would take it out. `onto` is the working cut, with the map that reads a time
 * on the pass's version as the same footage there. With none, the two are one version.
 * Undefined when footage inside the cut changed, so it isn't on the working cut as it was staged. The engine also
 * refuses a pass when footage within a quarter of a second of an approved cut changed. Such a cut still has all of
 * its own footage, and is placed.
 */
export function cutOnWorkingCut(cut: TimeRange, onto: { map: TimeMap; timeline: Timeline } | undefined, fps: number): TimeRange | undefined {
  if (!onto) return cut;
  try {
    const carried = rebaseOp({ op: "rippleDelete", start: cut.start, end: cut.end }, onto.map, onto.timeline, 0, fps);
    return carried.op === "rippleDelete" ? { start: carried.start, end: carried.end } : undefined;
  } catch (err) {
    if (err instanceof RebaseConflict) return undefined;
    throw err;
  }
}

export type CutChoice = "keep" | "cut";
export const savedChoices = (change: Change): Record<number, CutChoice> =>
  Object.fromEntries((change.cutChoices ?? []).map(c => [c.index, c.choice]));
/** A cut the editor can call now. Unchecked: staged while the pass runs, before Scarlet has looked at it again. */
export type Call = CutAssessment & { unchecked?: boolean };

/**
 * The calls the editor can make now: the cuts Scarlet asked about. Once the pass's run is over, the staged cuts it never
 * checked are the editor's calls too, whether it stopped early or finished without getting to them: nothing else will
 * check them, and Apply would put them in unseen (2026-11-10). While the pass runs they are still Scarlet's to check,
 * and it settles most of them itself, so they aren't calls yet: a call listed then would be gone again a moment later.
 * A requested revision keeps its earlier call on screen until the author finishes it.
 */
export function reviewCalls(change: Change, cuts: ReadonlyArray<Pick<CutReview["cuts"][number], "removed">> | undefined, over: boolean, prior?: Call): Call[] {
  const assessments = change.cutAssessments ?? [];
  const decided = new Set(change.cutChoices?.map(c => c.index));
  const summaries = cuts && reviewCutSummaries(change, cuts);
  const calls: Call[] = assessments.filter(a => isPublishedCall(a) || (!a.provisional && a.askOrder !== undefined && decided.has(a.index)));
  if (over) {
    for (const a of assessments) if (a.provisional && a.verdict === "ask") calls.push({ ...a, unchecked: true });
    if (cuts && cuts.length > assessments.length) {
      const assessed = new Set(assessments.map(a => a.index));
      const reasons = reviewReasons(change, cuts);
      cuts.forEach(({ removed }, index) => {
        if (!assessed.has(index)) calls.push({ ...removed, index, verdict: "ask", unchecked: true,
          reason: reasons[index]?.filter(text => text !== change.description).join(" ") || "No note was saved for this cut." });
      });
    }
  }
  if (prior) {
    const at = calls.findIndex(c => c.index === prior.index);
    if (at >= 0) calls[at] = prior;
    else calls.push(prior);
  }
  return calls.map(call => call.summary || !summaries?.[call.index] ? call : { ...call, summary: summaries[call.index] })
    .sort((a, b) => (a.askOrder ?? Infinity) - (b.askOrder ?? Infinity) || a.index - b.index);
}

const editAt = (e: ThreadEdit) => e.at ?? e.range.start;
const rowAt = (row: readonly ThreadEdit[]) => Math.min(...row.map(editAt));

type Stop<C> = { at: number; after: boolean; next: { edit: ThreadEdit } | { call: C } };

/** The first stop past `from` in time order, wrapping to the earliest. A stop at `from` itself counts when it comes `after`. */
function nextInTime<C>(stops: Stop<C>[], from: number) {
  stops.sort((a, b) => a.at - b.at);
  return (stops.find(n => n.at > from || (n.at === from && n.after)) ?? stops[0])?.next;
}

/** Where Keep goes from an edit on `rows[shown]` in a request's one list of every edit: the next row of the list in
 * time order, past the shown one and wrapping to earlier ones, with an edit that `still` waits or a call that does. A
 * row is one edit made in several places (or a moment), and goes by its first place that still waits. */
export function keepGoesTo<C>(rows: readonly (readonly ThreadEdit[])[], shown: number, still: (e: ThreadEdit) => boolean,
  calls: readonly { call: C; at: number }[]): { edit: ThreadEdit } | { call: C } | undefined {
  const here = rows[shown];
  if (!here?.length) return;
  const from = rowAt(here);
  return nextInTime([
    ...rows.flatMap((row, i) => {
      const edit = i === shown ? undefined : row.find(still);
      return edit ? [{ at: rowAt(row), after: i > shown, next: { edit } }] : [];
    }),
    ...calls.map(c => ({ at: c.at, after: c.at >= from, next: { call: c.call } })),
  ], from);
}

export type PassForYouItem<C, E extends Omit<ThreadEdit, "at"> = ThreadEdit> =
  | { kind: "call"; call: C; at: number; num?: number; waiting: boolean }
  | { kind: "edit"; edit: E; at: number; num?: number; waiting: boolean };

/**
 * The waiting pass's calls and flagged edits, decided or not, in the order they reached the editor: by stable
 * publication number (`num`) when any call carries `askOrder`, else by timeline position (`at`). For you lists the
 * ones that still wait in this order.
 */
export function passForYouOrder<C, E extends Omit<ThreadEdit, "at">>(
  calls: readonly { call: C; at: number; num?: number; waiting: boolean }[],
  edits: readonly { edit: E; at: number; num?: number; waiting: boolean }[],
  byNumber: boolean,
): PassForYouItem<C, E>[] {
  const items: PassForYouItem<C, E>[] = [
    ...edits.map(e => ({ kind: "edit" as const, ...e })),
    ...calls.map(c => ({ kind: "call" as const, ...c })),
  ].sort((a, b) => a.at - b.at);
  if (byNumber) items.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity));
  return items;
}

/**
 * A call the editor rejected before its pass went in made no edit, so the engine's list has no row for it. Its row in
 * the chat opens it as a rejected edit's does, under a spot no edit has: below zero, by its call.
 */
export const rejectedCallRef = (changeId: string, index: number) => ({ changeId, spot: -1 - index });
/** Which call of its pass a rejected call's stand-in edit is, or none for an edit of the engine's list. */
export const rejectedCallIndex = (edit: { spot: number }) => edit.spot < 0 ? -1 - edit.spot : undefined;

/** A call decided before its pass went in that made no edit: where it was, Scarlet's words for it, and what was decided. */
export interface DecidedCallRow {
  key: string;
  changeId: string;
  /** Its index among the pass's cuts. */
  index: number;
  at: number;
  /** How much footage the cut would have taken out, when the footage stayed in the video. */
  length?: number;
  label: string;
  /** Scarlet's note on the cut, for its card. */
  note?: string;
  approved: boolean;
}

/**
 * Calls the editor decided before a dialogue pass applied: approved cuts linked to their applied edit keys,
 * and skipped calls (or approved keep proposals) that produced no applied edit.
 */
export function decidedPassCalls(
  thread: Pick<Thread, "changes"> | undefined,
  edits: readonly Omit<ThreadEdit, "at">[],
  listedRejected: readonly Omit<ThreadEdit, "at">[] = [],
) {
  const decidedCallEditKeys = new Set<string>();
  const decidedCallRows: DecidedCallRow[] = [];
  if (!thread) return { decidedCallEditKeys, decidedCallRows };
  // A rejected call's stand-in is no edit a call could have made.
  const rejected = listedRejected.filter(e => rejectedCallIndex(e) === undefined);
  for (const change of thread.changes) {
    if (change.state !== "approved" || !change.cutChoices?.length) continue;
    const joins = change.appliedReview?.joins;
    const hasReviewIndex = !!joins?.some(j => j.reviewIndex !== undefined);
    for (const choice of change.cutChoices) {
      const assessment = change.cutAssessments?.find(a => a.index === choice.index);
      const approved = choice.choice === (assessment?.proposes === "keep" ? "keep" : "cut");
      let matched: Omit<ThreadEdit, "at"> | undefined;
      if (joins?.length && hasReviewIndex) {
        const spot = joins.findIndex(j => j.reviewIndex === choice.index);
        if (spot >= 0) {
          matched = edits.find(e => matchesEdit(e, { changeId: change.id, spot }))
            ?? rejected.find(e => matchesEdit(e, { changeId: change.id, spot }));
        }
      }
      if (!matched && choice.choice === "cut" && choice.start !== undefined) {
        // A call's start is on the video before the pass, and an applied edit's is where its join landed after it,
        // earlier by all the footage cut before it. The join that took out the call's footage links the two.
        const spot = joins?.findIndex(j => Math.abs(j.removed.start - choice.start!) < 0.05) ?? -1;
        const at = spot >= 0 ? joins![spot]!.at : joins?.length ? undefined : choice.start;
        const here = (e: Omit<ThreadEdit, "at">) => (spot >= 0 && matchesEdit(e, { changeId: change.id, spot }))
          || (e.changeId === change.id && at !== undefined && Math.abs(e.range.start - at) < 0.05);
        matched = edits.find(here) ?? rejected.find(here);
      }
      if (matched) {
        decidedCallEditKeys.add(editKey(matched));
        continue;
      }
      const cutReason = change.cutReasons?.[choice.index];
      // Its time is on the video before the pass. The list is on the video as it is now, so the row moves earlier by
      // the footage the pass took out ahead of it, as the pass's applied cuts did.
      const before = assessment?.start ?? choice.start ?? cutReason?.start ?? 0;
      const gone = (joins ?? []).reduce((sum, j) => j.removed.end <= before + 0.05 ? sum + (j.removed.end - j.removed.start) : sum, 0);
      const span = assessment ?? cutReason;
      decidedCallRows.push({
        key: `choice/${change.id}/${choice.index}`,
        changeId: change.id,
        index: choice.index,
        at: Math.max(0, before - gone),
        // Left in the video, its footage still plays there.
        ...(choice.choice === "keep" && span && span.end > span.start && { length: span.end - span.start }),
        label: assessment?.summary || assessment?.reason || cutReason?.summary || cutReason?.reason || "Cut",
        note: assessment?.reason || cutReason?.reason,
        approved,
      });
    }
  }
  return { decidedCallEditKeys, decidedCallRows };
}

/**
 * The calls the editor rejected before their pass went in, each as an edit that isn't in the video, so a press on its
 * row shows it as a rejected edit's row does: lit, on the timeline where it was, with Scarlet's note and Rejected. Its
 * place is the row's: the call's time moved earlier by what the pass took out ahead of it.
 */
export function rejectedCallEdits(thread: Pick<Thread, "changes"> | undefined, edits: readonly Omit<ThreadEdit, "at">[], rejected: readonly Omit<ThreadEdit, "at">[] = []): ThreadEdit[] {
  return decidedPassCalls(thread, edits, rejected).decidedCallRows.flatMap((row): ThreadEdit[] => row.approved ? [] : [{
    ...rejectedCallRef(row.changeId, row.index), label: row.label, range: { start: row.at, end: row.at + (row.length ?? 0) }, previous: [],
    rejected: true, wasCheck: true, ...(row.note && { reason: row.note }),
  }]);
}

export type Revision = { reason?: string; note?: string };
export const noRevisions: Revision[] = [];

/**
 * The pass a request about one cut took the place of, and which of its cuts it revised. A revision started from the
 * cut's card names its cut, and the pass it was sent about, which stays marked as revising with nothing on it to
 * follow. A request sent while the pass still ran waited its turn as an edit of its own: it names the
 * proposal the editor saw then, which later parts may have replaced and renumbered. For that one the engine marks the
 * pass it replaced, and the cuts it revised are the ones that differ there.
 */
export function revisedFrom(made: Change, task: Task, changes: readonly Change[]): { previous?: Change; indices: number[] } {
  // Back through this request's own earlier attempts to the pass it began from: a run that saves its cut a second
  // time replaces its first attempt, which is no earlier version of the pass.
  let previous: Change | undefined = made;
  for (let hops = 0; previous && hops < 50; hops++) {
    const at: Change = previous;
    previous = changes.find(c => c.replacedBy === at.id && !!c.cutReasons?.length);
    if (previous?.taskId !== task.id) break;
  }
  // A revision picked up again after another cut was revised still names the pass it was sent about. The engine has it
  // revise the pass that waits by then, and marks that one as replaced by what the revision made.
  if (task.kind === "revise") return { previous: previous ?? changes.find(c => c.id === task.context.changeId),
    indices: task.context.cutIndex === undefined ? [] : [task.context.cutIndex] };
  if (!previous) return { indices: [] };
  const before = stagedCuts(previous), after = stagedCuts(made);
  const moved = before.length !== after.length ? [] : after.flatMap((cut, i) => Math.abs(cut.start - before[i]!.start) > 1e-6 || Math.abs(cut.end - before[i]!.end) > 1e-6 ? [i] : []);
  // A cut saved again where it was is still that request's cut, when it names this very pass.
  return { previous, indices: moved.length || previous.id !== task.context.changeId || task.context.cutIndex === undefined ? moved : [task.context.cutIndex] };
}

/**
 * The revisions each call went through, by call, oldest first: what Scarlet proposed then and the note the editor sent back.
 * A pass revised at one call is a new pass, so this walks back once through the requests that made it, whichever kind
 * of run each was.
 */
export function callRevisions(pass: Change, tasks: readonly Task[], changes: readonly Change[]) {
  const byCall = new Map<number, Revision[]>();
  let change: Change | undefined = pass;
  for (let hops = 0; change && hops < 50; hops++) {
    const task = tasks.find(t => t.id === change!.taskId);
    if (!task?.context.changeId || (task.kind !== "revise" && task.context.cutIndex === undefined)) break;
    const { previous, indices } = revisedFrom(change, task, changes);
    for (const index of indices) {
      const revisions = byCall.get(index) ?? [];
      const staged = previous && reviewReasons(previous, stagedCuts(previous).map(removed => ({ removed })))[index]?.join(" ");
      // A recheck Scarlet asked for itself has no words of the editor's to show.
      revisions.unshift({ note: isRecheck(task) ? undefined : requestText(task),
        reason: previous?.cutAssessments?.find(a => a.index === index)?.reason ?? (staged || undefined) });
      byCall.set(index, revisions);
    }
    change = previous;
  }
  return byCall;
}

/** A dialogue pass stages the cuts it doubted. Other proposals simply play. */
export function isDialoguePass(change: Change) {
  return canStartCutReview(change) && !!(change.cutAssessments?.length || change.cutReasons?.length);
}

export function revisionCut(task: Task) {
  const conflict = task.cutConflict;
  return conflict?.changeId && conflict.index !== undefined ? { changeId: conflict.changeId, cutIndex: conflict.index } : task.context;
}

/** The revision Scarlet is running on a pass, if any: the editor can keep calling the pass's other cuts meanwhile. */
export function passRevision(change: Change, tasks: readonly Task[]) {
  if (change.state !== "revising" || change.intent !== "suggestion" || !change.cutReasons?.length) return undefined;
  return tasks.find(t => runIsActive(t) && (t.id === change.revisionFrom?.taskId || (t.kind === "revise" && revisionCut(t).changeId === change.id)));
}

/** A dialogue pass still waiting on the editor, including while Scarlet revises one of its cuts. */
export function isOpenPass(change: Change, tasks: readonly Task[]) {
  return isDialoguePass(change) || passRevision(change, tasks)?.context.cutIndex !== undefined;
}

/**
 * The dialogue pass of a request that still waits on the editor. It need not be the request's latest proposal: a pass
 * can leave a suggestion of its own after staging its calls, and the engine holds the next request until those calls
 * are made, whichever came last (2026-11-08: such a pass showed no calls, and the request queued behind it never started).
 */
export function openPass(thread: Thread, tasks: readonly Task[]) {
  // Only a staged suggestion holds the queue. A part of the pass on its way to being applied is "ready" for a moment too.
  const waiting = thread.changes.filter(c => c.intent === "suggestion" && isOpenPass(c, tasks));
  const latest = waiting.at(-1);
  // A new part is announced before its assessments are carried across. The pass the editor is reading is still
  // open at this point. Keep it until the successor has its own calls to show.
  if (latest && latest.cutAssessments === undefined && waiting.length > 1) {
    const root = stagingTask(latest, thread.changes, tasks);
    const previous = root && waiting.slice(0, -1).findLast(c => c.cutAssessments?.length &&
      stagingTask(c, thread.changes, tasks)?.id === root.id);
    if (previous) return previous;
  }
  return latest ?? (thread.latest && isOpenPass(thread.latest, tasks) ? thread.latest : undefined);
}

/**
 * Whether a proposal waits for the editor to play it: it is the thread's latest. A pass that left a suggestion of its own
 * and then saved another part has that part as the latest, but a part of a pass is calls to make, not a suggestion to
 * play: the suggestion the same request left before it still waits, as one left after the calls does (2026-11-10: it
 * read as plain words, with no way to play it, until the pass was applied).
 */
export function waitsToPlay(change: Change, thread: Thread) {
  if (change.state !== "ready") return false;
  const latest = thread.latest;
  if (change.id === latest?.id) return true;
  if (latest?.state !== "ready" || !isDialoguePass(latest) || change.intent !== "suggestion" || isDialoguePass(change)) return false;
  const rootOf = requestRoots(thread.tasks);
  // The request that staged the pass. A revision of one of its calls makes the pass again under the revision's own
  // request, so it is found back through the pass each revision replaced.
  const staged = stagingTask(latest, thread.changes, thread.tasks);
  const pass = staged && rootOf(staged);
  const request = (c: Change) => { const task = thread.tasks.find(t => t.id === c.taskId); return task && rootOf(task); };
  return !!pass && change.id === thread.changes.findLast(c => c.state === "ready" && c.intent === "suggestion" && !isDialoguePass(c) && request(c) === pass)?.id;
}
