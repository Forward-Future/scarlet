import type { JoinCrossfades } from "@scarlet/shared";
import { crossfadeJoins, type Change, type CutReview, type JoinFades, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";

export type FadedJoin = { at: number; duration: number };
export type CutReason = NonNullable<Change["cutReasons"]>[number];

/** The record of an applied version whose joins carry no crossfade. */
export const noFades = (): JoinFades => ({ duration: 0, fades: [], plain: [] });

/** A pre-upgrade dialogue proposal recorded one overlap for all its joins. */
export function cutCrossfade(change: Change, range: TimeRange): number {
  const reasons = change.cutReasons ?? [];
  return Math.max(0, ...reasons.filter(r => r.end > range.start + 1e-6 && r.start < range.end - 1e-6)
    .map(r => r.crossfade ?? change.joinFades?.duration ?? 0));
}

/** Adjacent removals make one join. Apply the longer requested overlap once, using real source handles. */
export function fadeJoins(ctx: Ctx, projectId: string, timeline: Timeline, joins: readonly FadedJoin[]): { timeline: Timeline; joinFades?: JoinFades } {
  const durations = new Map<number, number>();
  for (const { at, duration } of joins) {
    if (duration > 0) durations.set(at, Math.max(durations.get(at) ?? 0, duration));
  }
  if (!durations.size) return { timeline };
  const duration = durations.values().next().value!;
  const sources = new Set<string>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind === "media") sources.add(clip.mediaId);
  }
  const faded = crossfadeJoins(timeline, ctx.repos.projects.assets(projectId, sources), [...durations.keys()], duration, { durations });
  if (!faded.fades.length && !faded.report.plain.length) return { timeline };
  return { timeline: faded.timeline, joinFades: { duration, fades: faded.fades, plain: faded.report.plain } };
}

/** The chosen cuts as placed on `head`, each join with its cut's crossfade. Placing nothing leaves `head` as it is. */
export function fadePlaced(
  ctx: Ctx,
  change: Change,
  review: CutReview,
  placed: { timeline: Timeline; applied: NonNullable<Change["appliedReview"]> },
  head: Timeline,
): { timeline: Timeline; joinFades?: JoinFades } {
  if (placed.timeline === head) return { timeline: head };
  return fadeJoins(ctx, change.projectId, placed.timeline, placed.applied.joins.map(j => ({ at: j.at, duration: cutCrossfade(change, review.cuts[j.reviewIndex!]!.removed) })));
}

/** Reasons are stored in chronological order on the base timeline. */
export function proposalJoins(reasons: CutReason[]): FadedJoin[] {
  let shift = 0;
  let previousEnd = -1, previousAt = 0;
  return reasons.map(cut => {
    const at = Math.abs(cut.start - previousEnd) < 1e-6 ? previousAt : cut.start - shift;
    previousAt = at;
    previousEnd = cut.end;
    shift += cut.end - cut.start;
    return { at, duration: cut.crossfade ?? 0 };
  });
}

export function reviewedJoins(change: Change, review: CutReview, restored: readonly number[]): FadedJoin[] {
  const kept = new Set(restored);
  // Older passes deferred the fade on an applied cut touching a staged cut. A restored
  // cut can expose that join again on its boundary.
  const legacy = !!change.joinFades && !change.cutReasons?.some(r => r.crossfade !== undefined);
  let shift = 0;
  return review.cuts.flatMap((cut, i) => {
    const at = cut.at + shift;
    const duration = cutCrossfade(change, cut.removed);
    if (!kept.has(i)) return [{ at, duration }];
    shift += cut.removed.end - cut.removed.start;
    return legacy ? [{ at, duration }, { at: at + cut.removed.end - cut.removed.start, duration }] : [];
  });
}

/** What the requested crossfades did on the joins these dialogue changes made, for the agent that made them. */
export function joinCrossfadeReport(frames: number, changes: readonly Change[]): JoinCrossfades | undefined {
  if (!changes.length) return;
  let faded = 0;
  const plain: JoinCrossfades["plain"] = [];
  for (const change of changes) {
    const record = change.joinFades;
    if (!record) continue;
    const held = new Set(record.plain.map(p => p.at));
    faded += new Set(record.fades.map(f => f.at).filter(at => !held.has(at))).size;
    plain.push(...record.plain.map(p => ({ version: change.toVersion, ...p })));
  }
  return { frames, faded, plain };
}
