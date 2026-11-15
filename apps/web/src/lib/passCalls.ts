import { requestText, type Task, type ThreadEdit } from "@scarlet/shared";
import { canStartCutReview, isPublishedCall, makeTimeMap, rebaseOp, RebaseConflict, reviewReasons, type Change, type CutAssessment, type CutReview, type TimeMap, type TimeRange, type Timeline } from "@scarlet/timeline";
import { requestRoots, stagingTask } from "./requestRuns";
import { runIsActive } from "./taskRun";
import { isRecheck, stagedCuts, type Thread } from "./threads";

/** The call a cut is found by: the proposal that staged it, its number there and its range. */
interface Listening { changeId: string; index: number; cut: TimeRange }

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
  return calls.sort((a, b) => (a.askOrder ?? Infinity) - (b.askOrder ?? Infinity) || a.index - b.index);
}

/** Where Keep goes from an edit Scarlet didn't flag, the one on `rows[shown]`: the next row of the list in time order,
 * past the shown one and wrapping to earlier ones, with an edit that `still` waits or a call that does. A row is
 * one edit made in several places, and goes by its first place that still waits. */
export function keepGoesTo<C>(rows: readonly (readonly ThreadEdit[])[], shown: number, still: (e: ThreadEdit) => boolean,
  calls: readonly { call: C; at: number }[]): { edit: ThreadEdit } | { call: C } | undefined {
  const timeOf = (e: ThreadEdit) => e.at ?? e.range.start;
  const here = rows[shown]?.[0];
  if (!here) return;
  const from = timeOf(here);
  const items = [
    ...rows.flatMap((row, i) => {
      const edit = i === shown ? undefined : row.find(still);
      return edit ? [{ at: timeOf(row[0]!), after: i > shown, next: { edit } }] : [];
    }),
    ...calls.map(c => ({ at: c.at, after: c.at > from, next: { call: c.call } })),
  ].sort((a, b) => a.at - b.at);
  return (items.find(n => n.at > from || (n.at === from && n.after)) ?? items[0])?.next;
}

/** The timelines of the versions a pass's cuts are carried across, as far as the window has them, and the frame rate to read them at. */
export interface Footage { at: (version: string) => Timeline | undefined; fps: number }

/** A part's confident cuts move the footage after them earlier by their length, which their reasons give. */
const shiftsByCuts = (change: Change) => change.intent !== "suggestion" && !!change.cutReasons?.length;

/** The approved edits that took the video from one version to another, in order. Undefined when it didn't get there by them. */
function editsBetween(from: string, to: string, changes: readonly Change[]): Change[] | undefined {
  const steps: Change[] = [];
  for (let version = from; version !== to;) {
    const applied = steps.length < 100 ? changes.find(c => c.state === "approved" && (c.appliedOnto ?? c.fromVersion) === version) : undefined;
    if (!applied) return undefined;
    steps.push(applied);
    version = applied.appliedVersion ?? applied.toVersion;
  }
  return steps;
}

/**
 * Where the footage of a cut of an earlier proposal sits on the version this pass starts from: earlier by the length of
 * every confident cut the parts since applied before it. Any other edit between the parts, such as Scarlet's crossfades
 * on the joins it made, is crossed as the engine crosses it: by the cut's footage, read on the timelines either side.
 * Undefined when a part applied that very footage, an edit since changed the length of the cut's footage, or the edit
 * moved on some other way.
 */
function carriedRange(pass: Change, from: Pick<Listening, "changeId" | "cut">, changes: readonly Change[], footage: Footage): TimeRange | undefined {
  const before = changes.find(c => c.id === from.changeId);
  const steps = before && editsBetween(before.fromVersion, pass.fromVersion, changes);
  if (!steps) return undefined;
  let { start, end } = from.cut;
  for (const applied of steps) {
    if (shiftsByCuts(applied)) {
      // A part that applied this very footage has taken the cut out of the pass.
      if (applied.cutReasons!.some(r => r.start < end - 1e-6 && r.end > start + 1e-6)) return undefined;
      const shift = applied.cutReasons!.reduce((sum, r) => r.end <= start + 0.05 ? sum + (r.end - r.start) : sum, 0);
      start -= shift;
      end -= shift;
      continue;
    }
    const was = footage.at(applied.appliedOnto ?? applied.fromVersion), now = footage.at(applied.appliedVersion ?? applied.toVersion);
    if (!was || !now) return undefined;
    const map = makeTimeMap(was, now, footage.fps);
    const movedStart = map(start, "right"), movedEnd = map(end, "left");
    // As in the engine, a cut whose footage the edit lengthened or shortened isn't the cut that was staged.
    if (movedStart === null || movedEnd === null || Math.abs(movedEnd - movedStart - (end - start)) > 1 / footage.fps) return undefined;
    start = movedStart;
    end = movedEnd;
  }
  return { start, end };
}

/**
 * The versions whose timelines carry a pass's earlier proposals onto it: either side of each edit between them that
 * isn't a part's confident cuts. Usually none.
 */
export function carryingVersions(pass: Change | undefined, earlier: readonly Change[], changes: readonly Change[]): string[] {
  if (!pass) return [];
  const versions = new Set<string>();
  for (const part of earlier) {
    // Only a proposal a call can still name is carried: an applied part, or anything else in a long thread, would ask
    // for the timelines of every edit since.
    if (part.id === pass.id || part.state === "approved" || part.intent !== "suggestion" || !part.cutReasons?.length) continue;
    for (const step of editsBetween(part.fromVersion, pass.fromVersion, changes) ?? []) {
      if (!shiftsByCuts(step)) versions.add(step.appliedOnto ?? step.fromVersion).add(step.appliedVersion ?? step.toVersion);
    }
  }
  return [...versions].sort();
}

/**
 * Where a cut of an earlier proposal of this pass sits in the proposal waiting now: the pass saved its next part, or one
 * of its cuts came back revised. The cut keeps its place in the footage but can get a new number, and it sits earlier by
 * the length of every confident cut the parts since applied before it. Undefined when the cut isn't in this pass as it
 * was, or the edit moved on some other way.
 */
export function carriedCall(pass: Change, from: Pick<Listening, "changeId" | "index" | "cut">, changes: readonly Change[], tasks: readonly Task[], footage: Footage): Pick<Listening, "index" | "cut"> | undefined {
  // A new batch can follow ordinary edits that changed the project's clock. The carried publication number
  // identifies the exact call on the new version, including after a retry or a requested revision.
  const previous = changes.find(c => c.id === from.changeId);
  const order = previous?.cutAssessments?.find(a => a.index === from.index)?.askOrder;
  if (previous && previous.state !== "approved" && order !== undefined) {
    const origin = stagingTask(previous, changes, tasks), current = stagingTask(pass, changes, tasks);
    if (origin && current && (origin.resumeRootId ?? origin.id) === (current.resumeRootId ?? current.id)) {
      const call = pass.cutAssessments?.find(a => a.askOrder === order &&
        (isPublishedCall(a) || pass.cutChoices?.some(c => c.index === a.index)));
      if (call) return { index: call.index, cut: { start: call.start, end: call.end } };
    }
  }
  const at = carriedRange(pass, from, changes, footage);
  if (!at) return undefined;
  const { start, end } = at;
  // The nearest cut within a twentieth of a second: very short cuts can sit closer together than that.
  const off = (r: TimeRange) => Math.abs(r.start - start) + Math.abs(r.end - end);
  const cuts = stagedCuts(pass);
  const index = cuts.reduce((best, r, i) => Math.abs(r.start - start) < 0.05 && Math.abs(r.end - end) < 0.05 && (best < 0 || off(r) < off(cuts[best]!)) ? i : best, -1);
  return index < 0 ? undefined : { index, cut: cuts[index]! };
}

/**
 * The call in this pass that a request about one cut means. A request sent while the pass ran names the proposal it saw;
 * the pass has since carried that cut into later parts, or come back with a cut revised, which may be that very cut.
 * `earlier` are the pass's own request's proposals: a request that names any other isn't about this pass.
 */
export function callNow(pass: Change, named: { changeId?: string; cutIndex?: number }, earlier: readonly Change[], changes: readonly Change[], tasks: readonly Task[], footage: Footage) {
  const { changeId, cutIndex } = named;
  if (!changeId || cutIndex === undefined) return undefined;
  if (changeId === pass.id) return cutIndex;
  const part = earlier.find(c => c.id === changeId);
  const cut = part && stagedCuts(part)[cutIndex];
  if (!cut) return undefined;
  const carried = carriedCall(pass, { changeId, index: cutIndex, cut }, changes, tasks, footage);
  if (carried) return carried.index;
  // The cut itself came back revised since. Walk back through the revisions that made this pass to the one that
  // revised it: the request is about the revised cut, wherever later revisions left it.
  for (let made: Change | undefined = pass, hops = 0; made && hops < 50; hops++) {
    const run = tasks.find(t => t.id === made!.taskId);
    if (run?.kind !== "revise" || !run.context.changeId) break;
    if (run.context.changeId === changeId && run.context.cutIndex === cutIndex) {
      const revised = stagedCuts(made)[cutIndex];
      const index = made === pass ? cutIndex : revised && carriedCall(pass, { changeId: made.id, index: cutIndex, cut: revised }, changes, tasks, footage)?.index;
      if (index !== undefined) return index;
      break;
    }
    made = earlier.find(c => c.id === run.context.changeId);
  }
  // A request that waited its turn revises the cut under its own run, after parts may have renumbered it, and a part can
  // decide the same footage again. The footage says which cut the request means then: the cut of the pass that takes in
  // the most of what the named cut removed.
  const at = carriedRange(pass, { changeId, cut }, changes, footage);
  if (!at) return undefined;
  let most = 1e-6, index: number | undefined;
  stagedCuts(pass).forEach((c, i) => {
    const shared = Math.min(c.end, at.end) - Math.max(c.start, at.start);
    if (shared > most) { most = shared; index = i; }
  });
  return index;
}

/**
 * Where the call that's open sits in a pass that came back because that very cut was revised: on the revised cut. Any
 * other cut keeps its place in the footage and is found by it. This one changed, so the request that revised it says
 * which cut it is.
 */
export function revisedCall(pass: Change, open: Pick<Listening, "changeId" | "index">, earlier: readonly Change[], changes: readonly Change[], tasks: readonly Task[], footage: Footage) {
  const maker = tasks.find(t => t.id === pass.taskId);
  if (!maker || maker.context.cutIndex === undefined) return undefined;
  const mine = callNow(pass, { changeId: open.changeId, cutIndex: open.index }, earlier, changes, tasks, footage);
  if (mine === undefined || mine !== callNow(pass, maker.context, earlier, changes, tasks, footage)) return undefined;
  const cut = stagedCuts(pass)[mine];
  return cut && { index: mine, cut };
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
