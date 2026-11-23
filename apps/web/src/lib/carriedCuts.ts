/**
 * Finding a pass's cut again once the pass has moved on: carried across the edits applied since, into the pass's next
 * part, or through a revision of one of its cuts.
 */
import type { Task } from "@scarlet/shared";
import { isPublishedCall, makeTimeMap, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import { stagingTask } from "./requestRuns";
import { stagedCuts } from "./threads";

/** The call a cut is found by: the proposal that staged it, its number there and its range. */
interface Listening { changeId: string; index: number; cut: TimeRange }

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
