/** Dialogue-pass call numbering and waiting-call counting. */
import { isPublishedCall, mergeRanges, rangesOverlap, type Change, type TimeRange } from "@scarlet/timeline";
import type { Task } from "./tasks.js";
import { PENDING_STATES } from "./taskQueue.js";

/**
 * The order each call of a dialogue pass reached the editor in, by its cut's index. The window never shows it: a call
 * goes by its time there ("Cut at 2:47"). It tells which staged cuts are calls, and keeps their order steady.
 * Scarlet's asks go in the order it made them, as the engine numbers them (`askOrder`). The cuts it never checked
 * follow in timeline order once its run is over (`over`). A later ask about a cut earlier in the video, or the cuts
 * a pass hands over when it ends, never renumber the calls the editor has seen. A pass whose asks aren't numbered, as one saved before the engine
 * numbered them, has them all in timeline order, as every call was then. Once it numbers them, an ask without a number
 * is a cut no one checked that the editor sent back, and it stays among those. `cuts` is how many cuts the pass's
 * review lists: staged cuts that touch are one.
 */
export function callNumbers(pass: Pick<Change, "cutAssessments" | "cutChoices">, cuts: number, over: boolean): Map<number, number> {
  const assessed = pass.cutAssessments?.filter(a => !a.provisional) ?? [];
  const decided = new Set(pass.cutChoices?.map(c => c.index));
  const calls: Array<{ index: number; askOrder?: number }> = assessed.filter(a => isPublishedCall(a) || (a.askOrder !== undefined && decided.has(a.index)));
  if (over) {
    const checked = new Set(assessed.map(a => a.index));
    for (let index = 0; index < cuts; index++) if (!checked.has(index)) calls.push({ index });
  }
  calls.sort((a, b) => (a.askOrder ?? Infinity) - (b.askOrder ?? Infinity) || a.index - b.index);
  return new Map(calls.map((call, i) => [call.index, i + 1]));
}

/**
 * The run that staged a pass is over: it finished, or stopped before it did. Revising one cut replaces the pass under
 * the revision's own request, so the run is found back through the passes each revision replaced, and then at its
 * latest attempt.
 */
export function passRunOver(pass: Change, changes: readonly Change[], tasks: readonly Task[]): boolean {
  let run = tasks.find(t => t.id === pass.taskId);
  for (let hops = 0; run?.context.cutIndex !== undefined && run.context.changeId && hops < 50; hops++) {
    const replaced = changes.find(c => c.id === run!.context.changeId);
    const before = replaced && replaced.taskId !== run.id ? tasks.find(t => t.id === replaced.taskId) : undefined;
    if (!before) break;
    run = before;
  }
  for (let hops = 0; run?.retryTaskId && hops < 50; hops++) {
    const next = tasks.find(t => t.id === run!.retryTaskId);
    if (!next) break;
    run = next;
  }
  return run?.state === "done" || run?.state === "failed" || run?.state === "cancelled";
}

/**
 * Which of this pass's cuts a request about one cut means. A request sent while the pass ran waits its turn naming the
 * proposal the editor saw then, which later parts of the pass have replaced: the cut is followed from part to part by
 * its range, as the chat follows it, so the request is counted against the same call there. Undefined when the request
 * isn't about a cut of this pass, or its cut is no longer in it.
 */
export function cutInPass(pass: Change, { changeId, cutIndex }: Task["context"], changes: readonly Change[], tasks: readonly Task[]): number | undefined {
  if (!changeId || cutIndex === undefined) return undefined;
  if (changeId === pass.id) return cutIndex;
  const same = (a: TimeRange, b: TimeRange) => Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05;
  const staged = (c: Change) => mergeRanges((c.cutReasons ?? []).map(({ start, end }) => ({ start, end })));
  // The proposal that took one's place: the one named on it, or the one a revision of one of its cuts made from it.
  const after = (from: Change) => changes.find(c => c.id === from.replacedBy) ?? changes.find(c => c.id !== from.id && !!c.cutReasons
    && tasks.some(t => t.id === c.taskId && t.kind === "revise" && t.context.changeId === from.id && t.context.cutIndex !== undefined));
  let change = changes.find(c => c.id === changeId);
  let cut = change && staged(change)[cutIndex];
  let index = cutIndex;
  for (let hops = 0; change && cut && hops < 500; hops++) {
    if (change.id === pass.id) return index;
    const next = after(change);
    if (!next?.cutReasons) return undefined;
    const cuts = staged(next);
    // A cut published by this pass keeps its ask order across its replacements, even when both its slot and
    // its time change. Older passes without this identity still follow their footage.
    const order = change.cutAssessments?.find(a => a.index === index)?.askOrder;
    const published = order !== undefined && next.cutAssessments?.find(a => a.askOrder === order);
    if (published && cuts[published.index]) {
      change = next; index = published.index; cut = cuts[index];
      continue;
    }
    let found = cuts.findIndex(r => same(r, cut!));
    if (found < 0) {
      // The next part can stage a cut that touches this one, and the review then lists the two as one.
      const ranges = [cut, ...(change.cutReasons ?? []).filter(r => r.start >= cut!.start && r.end <= cut!.end)];
      const carried = next.cutReasons.filter(r => ranges.some(range => same(r, range)));
      found = cuts.findIndex(r => rangesOverlap(r, cut!) && carried.some(kept => kept.start >= r.start && kept.end <= r.end));
    }
    const at = found >= 0 ? found : index;
    const moved = cuts[at];
    if (!moved || !rangesOverlap(moved, cut)) return undefined;
    change = next; index = at; cut = moved;
  }
  return undefined;
}

/**
 * A dialogue pass's calls that still wait on the editor: the cuts Scarlet asked about, less the ones already called
 * or sent back for revision. Once the run is over, a staged cut it never checked is the editor's call too, whether the
 * run stopped early or finished without getting to it: nobody else will check it (2026-11-10). Staged cuts that touch
 * are one cut, as the pass's review numbers them.
 */
export function waitingCalls(pass: Change, { changes, tasks }: { changes: Change[]; tasks: Task[] }): number {
  const called = new Set(pass.cutChoices?.map(choice => choice.index));
  const sentBack = new Set(tasks.flatMap(t => {
    if (!PENDING_STATES.has(t.state)) return [];
    const index = cutInPass(pass, t.context, changes, tasks);
    return index === undefined ? [] : [index];
  }));
  const waits = (index: number) => !called.has(index) && !sentBack.has(index);
  const asked = pass.cutAssessments?.filter(a => isPublishedCall(a) && waits(a.index)).length ?? 0;
  if (!passRunOver(pass, changes, tasks)) return asked;
  const checked = new Set(pass.cutAssessments?.filter(a => !a.provisional).map(a => a.index));
  return asked + mergeRanges(pass.cutReasons ?? []).filter((_, index) => !checked.has(index) && waits(index)).length;
}
