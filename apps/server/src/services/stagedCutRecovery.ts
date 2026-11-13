import { applyReviewRemovals, makeStagedCutMapper, timelineDuration, type Change, type CutReview, type Project,
  type StagedCutMapping, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import type { StagedCutRevision, Task } from "@scarlet/shared";
import { resolveTimeline } from "./timeline.js";

/** The pass keeps its original slots. An individually reinspected slot can refer to a newer recording or take. */
export function currentCutRanges(ctx: Ctx, project: Project, change: Change, review: CutReview, head: Timeline) {
  const mappers = new Map<string, ReturnType<typeof makeStagedCutMapper>>();
  const overrides = new Map(change.cutEdits?.map(e => [e.index, e]));
  return (index: number, replacement?: { version: string; range: TimeRange }): StagedCutMapping => {
    const edit = replacement ?? overrides.get(index);
    const range = edit?.range ?? review.cuts[index]!.removed;
    const version = edit?.version ?? change.fromVersion;
    if (range.start === range.end) return { kind: "gone", at: range.start };
    if (version === head.version) return { kind: "exact", range };
    let map = mappers.get(version);
    if (!map) {
      const from = version === change.fromVersion ? review.original : resolveTimeline(ctx, project, version);
      map = makeStagedCutMapper(from, head, project.settings.fps);
      mappers.set(version, map);
    }
    return map(range);
  };
}

type PlacedCut = { index: number; range: TimeRange };
type CutConflict = Extract<StagedCutMapping, { kind: "conflict" }> & { index: number };

type CutEdit = NonNullable<Change["cutEdits"]>[number];
type RevisionPlacement = { slot: TimeRange; edit?: CutEdit; keep: boolean } | { conflict: Extract<StagedCutMapping, { kind: "conflict" }> };

/** Keep review slots in their original order while attaching a recovered decision to the footage it actually uses. */
export function placeRevision(ctx: Ctx, project: Project, change: Change, review: CutReview, index: number,
  body: StagedCutRevision, range: TimeRange, task: Task | null, scoped: boolean, inputVersion: string): RevisionPlacement {
  const old = review.cuts[index]!.removed;
  const previous = change.cutEdits?.find(e => e.index === index);
  const named = body.version ?? inputVersion;
  const originalClock = named === change.fromVersion;
  const rechecked = !!body.version && (!originalClock || !!previous || !!task?.cutConflict);
  if (body.keep && task && !scoped) throw badRequest("wrong_cut", "Keep the passage from the cut being revised.");
  const head = resolveTimeline(ctx, project);
  const input = originalClock ? review.original : named === head.version ? head : resolveTimeline(ctx, project, named);
  if (range.end <= range.start || range.end > timelineDuration(input) + 1e-6)
    throw badRequest("invalid_cuts", "Choose a range inside the timeline.");
  const slot = originalClock && !rechecked && !body.keep ? range : old;
  const gap = 1 / project.settings.fps;
  const near = (a: TimeRange, b: TimeRange) => a.start < b.end + gap - 1e-6 && b.start < a.end + gap - 1e-6;
  if (scoped && originalClock && !rechecked && !body.keep && !near(old, range))
    throw badRequest("wrong_cut", "The new range must touch the passage selected for revision.");
  const before = review.cuts[index - 1]?.removed, after = review.cuts[index + 1]?.removed;
  if (before && slot.start < before.end + gap - 1e-6 || after && slot.end > after.start - gap + 1e-6)
    throw badRequest("invalid_cuts", "Keep the cut clear of its neighbors.");
  // Keeping a call never writes to the working timeline, even if the passage no longer has a unique location.
  if (body.keep) return { slot: old, edit: previous, keep: true };
  if (originalClock && head.version === named && !previous && !rechecked) return { slot, keep: false };
  const current = currentCutRanges(ctx, project, change, review, head);
  const target = current(index);
  const requested = current(index, { version: named, range });
  if (requested.kind === "conflict") return { conflict: requested };
  if (requested.kind === "gone") return { slot, keep: true, edit: { index, version: head.version, range: { start: requested.at, end: requested.at } } };
  if (!rechecked && (target.kind === "conflict" || previous && previous.version !== named || target.kind === "gone" && requested.kind === "exact"))
    return { conflict: target.kind === "conflict" ? target : { kind: "conflict", reason: "This cut was rechecked on newer footage.",
      range: target.kind === "gone" ? undefined : target.range } };
  if (rechecked || !originalClock) {
    // An inspected version is evidence about this call, never permission to remove an unrelated part of the edit.
    const recorded = scoped && task?.cutConflict?.version === head.version ? task.cutConflict.range : undefined;
    const located = recorded ?? (target.kind === "gone" ? undefined : target.range);
    const answered = scoped && task?.cutConflict?.version === named && task.cutConflict.answered;
    if (located ? !near(located, requested.range) : !answered)
      return { conflict: { kind: "conflict", reason: "The inspected passage cannot be matched to this call.", range: located } };
    if (located && !answered && (requested.range.start < located.start - 1e-6 || requested.range.end > located.end + 1e-6)) {
      // A new trim may extend into adjacent words. Prove their source still leads into this call,
      // even when a replacement take inside the call itself has no match on the original version.
      const source = previous ? resolveTimeline(ctx, project, previous.version) : review.original;
      const original = previous?.range ?? old;
      const back = makeStagedCutMapper(head, source, project.settings.fps);
      const left = requested.range.start < located.start - 1e-6 ? back({ start: requested.range.start, end: located.start }) : undefined;
      const right = requested.range.end > located.end + 1e-6 ? back({ start: located.end, end: requested.range.end }) : undefined;
      if (left && (left.kind !== "exact" || Math.abs(left.range.end - original.start) > gap) ||
          right && (right.kind !== "exact" || Math.abs(right.range.start - original.end) > gap))
        return { conflict: { kind: "conflict", reason: "The revised trim would include another changed passage.", range: located } };
    }
    for (const [i] of review.cuts.entries()) {
      if (i === index) continue;
      const other = current(i);
      if (other.kind !== "gone" && other.range && near(other.range, requested.range))
        throw badRequest("invalid_cuts", "Keep the revised passage clear of the neighboring cut.");
    }
  }
  return { slot, keep: false, edit: { index, version: head.version, range: requested.range } };
}

/** Map only the removals the editor actually chose, in one snapshot of the current timeline. */
export function reviewedCutsOnHead(ctx: Ctx, project: Project, change: Change, review: CutReview, head: Timeline,
  restored: number[]): { conflict: CutConflict } | { timeline: Timeline; applied: NonNullable<Change["appliedReview"]> } {
  const keep = new Set(restored);
  if (keep.size !== restored.length || restored.some(i => !Number.isInteger(i) || i < 0 || i >= review.cuts.length))
    throw badRequest("invalid_cut_selection", "Unknown or duplicate cut in review.");
  const place = currentCutRanges(ctx, project, change, review, head);
  const selected: PlacedCut[] = [];
  for (const [index] of review.cuts.entries()) {
    if (keep.has(index)) continue;
    const location = place(index);
    if (location.kind === "conflict") return { conflict: { ...location, index } };
    if (location.kind !== "gone") selected.push({ index, range: location.range });
  }
  selected.sort((a, b) => a.range.start - b.range.start);
  let removed = 0;
  const joins: NonNullable<Change["appliedReview"]>["joins"] = [];
  for (const [i, { index, range }] of selected.entries()) {
    if (i && range.start < selected[i - 1]!.range.end - 1e-6)
      return { conflict: { kind: "conflict", index, range, reason: "Two proposed cuts now cover the same footage." } };
    joins.push({ at: range.start - removed, removed: range, reviewIndex: index });
    removed += range.end - range.start;
  }
  const timeline = applyReviewRemovals(head, selected.map(c => c.range), change.toVersion);
  return { timeline, applied: { originalVersion: head.version, originalDuration: timelineDuration(head), duration: timelineDuration(timeline), joins } };
}
