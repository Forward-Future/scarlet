import { applyOps, clipEnd, planTransitions, type MediaAsset, type MediaClip, type Timeline, type TimelineOp, type Transition } from "@scarlet/timeline";

export interface TransitionJoinInput {
  /** The clip the transition leads into. */
  clipId?: string;
  /** Or the join, in timeline seconds. */
  at?: number;
  /** The video track to look on with `at`; the bottom one by default. */
  trackId?: string;
}

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60), s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

/** The clip each join leads into, from its id or the time of its join. */
export function findJoin(timeline: Timeline, join: TransitionJoinInput, fps: number): { clip: MediaClip; trackId: string } {
  if (join.clipId) {
    for (const track of timeline.tracks) {
      const clip = track.clips.find(c => c.id === join.clipId);
      if (!clip) continue;
      if (track.kind !== "video" || clip.kind !== "media") throw new Error(`Clip ${join.clipId} is not footage on a video track.`);
      return { clip, trackId: track.id };
    }
    throw new Error(`No clip ${join.clipId} on this version.`);
  }
  if (join.at === undefined) throw new Error("Give each join a clipId or the time it is at.");
  const track = join.trackId ? timeline.tracks.find(t => t.id === join.trackId) : timeline.tracks.find(t => t.kind === "video");
  if (!track || track.kind !== "video") throw new Error(join.trackId ? `No video track ${join.trackId}.` : "This version has no video track.");
  const near = 0.5 / fps;
  const at = join.at;
  const clips = track.clips.filter(c => c.enabled !== false);
  const clip = clips.find(c => c.kind === "media" && Math.abs(c.timelineIn - at) <= near && clips.some(o => o !== c && Math.abs(clipEnd(o) - c.timelineIn) <= 1e-3));
  if (clip?.kind === "media") return { clip, trackId: track.id };
  const joins = clips.filter(c => clips.some(o => o !== c && Math.abs(clipEnd(o) - c.timelineIn) <= 1e-3)).map(c => c.timelineIn);
  const nearest = joins.sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
  throw new Error(`No join on ${track.id} at ${clock(at)}.${nearest !== undefined ? ` The nearest is at ${clock(nearest)} (${nearest.toFixed(3)} s).` : ""}`);
}

/**
 * The ops that set (or, with no transition, take off) the transition at each join, and what each join will get: a
 * transition can only use the footage either side, so it may run shorter or stay a straight cut.
 */
export function transitionOps(before: Timeline, media: readonly MediaAsset[], fps: number, joins: TransitionJoinInput[], transition: Transition | null) {
  const targets = joins.map(join => findJoin(before, join, fps));
  const ops: TimelineOp[] = [...new Map(targets.map(t => [t.clip.id, { op: "updateClip" as const, clipId: t.clip.id, patch: { transitionIn: transition } }])).values()];
  if (!transition) return { ops, report: targets.map(t => `${clock(t.clip.timelineIn)}: straight cut`) };
  const plan = planTransitions(applyOps(before, ops), new Map(media.map(m => [m.id, m])), fps);
  const report = targets.map(t => {
    const got = plan.joins.find(j => j.clipId === t.clip.id);
    const length = got ? got.end - got.start : 0;
    return `${clock(t.clip.timelineIn)}: ${got?.note ?? `${transition.type} over ${length.toFixed(2)} s`}`;
  });
  return { ops, report };
}
