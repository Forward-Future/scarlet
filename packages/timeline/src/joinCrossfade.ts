import { makeMediaClip, makeTrack } from "./builders.js";
import { applyOps, type TimelineOp } from "./ops.js";
import type { MediaAsset, MediaClip, Timeline, Track } from "./schema.js";
import { clipDuration, clipEnd } from "./time.js";

/**
 * Centered audio-only crossfades at dialogue joins. Each side of a join reaches half the overlap into its real source
 * handle and fades over the whole overlap, so the picture edit and the runtime stay as they were. A clip on a picture
 * track keeps its picture and goes silent; a copy of its sound on that track's dialogue track carries the fade.
 */

const EPS = 1e-6;

export interface ClipJoin { leftClipId: string; rightClipId: string }

/** A join that got the crossfade: where it is on the version the crossfade made, and the track its clips sit on. */
export interface JoinFade { at: number; trackId: string; duration?: number }

/** What the crossfade did at each join: joins faded, and joins left as a straight cut with why. */
export interface JoinFadeReport {
  faded: number[];
  plain: Array<{ at: number; reason: string }>;
}

type Placed = { clip: MediaClip; track: Track };
type Refusal = { clipId: string; reason: "fade" | "audio" | "handles" | "short" | "occupied" };

const REASON: Record<Refusal["reason"], string> = {
  fade: "already has a fade",
  audio: "has no confirmed audio",
  handles: "not enough recorded sound past the cut for the crossfade",
  short: "a clip at the join is too short for the crossfade",
  occupied: "the dialogue track already has sound there",
};

/** Audible clips on tracks that play sound, by id. */
function audibleClips(timeline: Timeline): Map<string, Placed> {
  const clips = new Map<string, Placed>();
  for (const track of timeline.tracks) {
    if (track.muted || track.kind === "caption") continue;
    for (const clip of track.clips) {
      if (clip.kind === "media" && clip.enabled && clip.volume > 0) clips.set(clip.id, { clip, track });
    }
  }
  return clips;
}

/** The dialogue track a picture track's sound goes to: reused when it is there, so passes don't stack new tracks. */
function dialogueTrackId(timeline: Timeline, track: Track): { id: string; exists: boolean } {
  let id = `${track.id}_dialogue`;
  for (;;) {
    const found = timeline.tracks.find(t => t.id === id);
    if (!found) return { id, exists: false };
    if (found.kind === "audio") return { id, exists: true };
    id += "_";
  }
}

/** Plans crossfades one join at a time. `assets` absent: replaying fades already checked against the media. */
function crossfadePlanner(timeline: Timeline, assets: Map<string, MediaAsset> | undefined) {
  const plans = new Map<string, { placed: Placed; pre: number; post: number }>();

  const extent = (placed: Placed, pre: number, post: number) =>
    ({ start: placed.clip.timelineIn - pre, end: clipEnd(placed.clip) + post });

  /** Why one side can't take its half of the overlap, with the half it would add. */
  const check = (placed: Placed, side: "pre" | "post", half: number): Refusal | undefined => {
    const { clip, track } = placed;
    const planned = plans.get(clip.id);
    const pre = side === "pre" ? half : planned?.pre ?? 0;
    const post = side === "post" ? half : planned?.post ?? 0;
    if ((side === "pre" ? clip.audioFadeIn || planned?.pre : clip.audioFadeOut || planned?.post)) return { clipId: clip.id, reason: "fade" };
    const asset = assets?.get(clip.mediaId);
    if (assets && (!asset || !(asset.kind === "audio" || asset.hasAudio))) return { clipId: clip.id, reason: "audio" };
    const sourceIn = clip.sourceIn - pre * clip.speed, sourceOut = clip.sourceOut + post * clip.speed;
    if (sourceIn < -EPS || clip.timelineIn - pre < -EPS || (post && assets && (asset!.duration === undefined || sourceOut > asset!.duration + EPS)))
      return { clipId: clip.id, reason: "handles" };
    const fadeIn = pre ? 2 * pre : clip.audioFadeIn, fadeOut = post ? 2 * post : clip.audioFadeOut;
    if (fadeIn + fadeOut > clipDuration(clip) + pre + post + EPS) return { clipId: clip.id, reason: "short" };
    if (track.kind !== "audio") {
      const target = dialogueTrackId(timeline, track);
      const span = extent(placed, pre, post);
      const existing = target.exists ? timeline.tracks.find(t => t.id === target.id)!.clips : [];
      if (existing.some(c => c.timelineIn < span.end - EPS && clipEnd(c) > span.start + EPS)) return { clipId: clip.id, reason: "occupied" };
    }
  };

  return {
    /** Plan the crossfade on one join, or say why it can't take one. Nothing is planned for a join that is refused. */
    add(left: Placed, right: Placed, duration: number): Refusal | undefined {
      const half = duration / 2;
      const refused = check(left, "post", half) ?? check(right, "pre", half);
      if (refused) return refused;
      const l = plans.get(left.clip.id) ?? { placed: left, pre: 0, post: 0 };
      const r = plans.get(right.clip.id) ?? { placed: right, pre: 0, post: 0 };
      plans.set(left.clip.id, { ...l, post: half });
      plans.set(right.clip.id, { ...r, pre: half });
    },
    ops(): TimelineOp[] {
      const ops: TimelineOp[] = [];
      const ids = new Set(timeline.tracks.flatMap(t => t.clips.map(c => c.id)));
      const added = new Set<string>();
      for (const { placed: { clip, track }, pre, post } of plans.values()) {
        const audioFadeIn = pre ? 2 * pre : clip.audioFadeIn;
        const audioFadeOut = post ? 2 * post : clip.audioFadeOut;
        const patch = { timelineIn: Math.max(0, clip.timelineIn - pre), sourceIn: Math.max(0, clip.sourceIn - pre * clip.speed),
          sourceOut: clip.sourceOut + post * clip.speed, audioFadeIn, audioFadeOut };
        if (track.kind === "audio") {
          ops.push({ op: "updateClip", clipId: clip.id, patch });
          continue;
        }
        const target = dialogueTrackId(timeline, track);
        if (!target.exists && !added.has(target.id)) {
          added.add(target.id);
          ops.push({ op: "addTrack", track: makeTrack("audio", `${track.name} dialogue`, target.id) });
        }
        let id = `${clip.id}_audio`;
        while (ids.has(id)) id += "_";
        ids.add(id);
        const copy = makeMediaClip(clip.mediaId, patch.sourceIn, patch.sourceOut, patch.timelineIn, {
          id, label: clip.label, speed: clip.speed, effects: clip.effects, volume: clip.volume, audioFadeIn, audioFadeOut,
        });
        ops.push({ op: "addClip", trackId: target.id, clip: copy }, { op: "updateClip", clipId: clip.id, patch: { volume: 0 } });
      }
      return ops;
    },
  };
}

/** Expand touching audio clips into real source handles, keeping the picture edit and total runtime intact. */
export function audioCrossfadeOps(timeline: Timeline, media: MediaAsset[], joins: ClipJoin[], duration: number): TimelineOp[] {
  const clips = audibleClips(timeline);
  const planner = crossfadePlanner(timeline, new Map(media.map(asset => [asset.id, asset])));
  for (const { leftClipId, rightClipId } of joins) {
    const left = clips.get(leftClipId);
    const right = clips.get(rightClipId);
    if (!left || !right || left === right || left.track !== right.track ||
        Math.abs(clipEnd(left.clip) - right.clip.timelineIn) > 1e-7) {
      throw new Error(`Choose touching audible clips on the same track: ${leftClipId}, ${rightClipId}`);
    }
    const refused = planner.add(left, right, duration);
    if (refused?.reason === "fade") throw new Error(`The join at ${rightClipId} already has a fade or is selected twice`);
    if (refused?.reason === "audio") throw new Error(`No confirmed audio on ${refused.clipId}`);
    if (refused?.reason === "occupied") throw new Error(`The dialogue track already has sound where ${refused.clipId}'s crossfade would go`);
    if (refused) throw new Error(`Insufficient audio handles on ${refused.clipId} for a ${duration} s crossfade; shorten it or leave this join intact`);
  }
  return planner.ops();
}

/** The audible clips that meet at a time with a cut between them, on each track. Sound that runs on through a time is no join. */
function joinsAt(clips: Placed[], at: number, trackId?: string): Array<{ left: Placed; right: Placed }> {
  const found: Array<{ left: Placed; right: Placed }> = [];
  const tracks = new Map<Track, Placed[]>();
  for (const placed of clips) {
    if (trackId !== undefined && placed.track.id !== trackId) continue;
    const list = tracks.get(placed.track);
    if (list) list.push(placed);
    else tracks.set(placed.track, [placed]);
  }
  for (const list of tracks.values()) {
    const left = list.find(p => Math.abs(clipEnd(p.clip) - at) < EPS);
    const right = list.find(p => p !== left && Math.abs(p.clip.timelineIn - at) < EPS);
    if (!left || !right) continue;
    const continuous = left.clip.mediaId === right.clip.mediaId && left.clip.speed === right.clip.speed &&
      Math.abs(left.clip.sourceOut - right.clip.sourceIn) < EPS;
    if (!continuous) found.push({ left, right });
  }
  return found;
}

/**
 * Crossfade the joins at these times, as far as each allows. A join that already has a fade, lacks recorded sound past
 * the cut or has a clip too short for it stays a straight cut, and the report says why. A time where no sound is cut
 * is not a join and isn't reported. `media` absent replays fades already checked: see `replayJoinFades`.
 */
export function crossfadeJoins(timeline: Timeline, media: MediaAsset[] | undefined, times: readonly number[], duration: number,
  { only, durations }: {
    /** Requested overlap at individual joins of a combined dialogue review. */
    durations?: ReadonlyMap<number, number>;
    /** Just these fades, on their own tracks. */
    only?: readonly JoinFade[];
  } = {}): { timeline: Timeline; fades: JoinFade[]; report: JoinFadeReport } {
  const report: JoinFadeReport = { faded: [], plain: [] };
  if (!times.length && !only?.length) return { timeline, fades: [], report };
  const clips = [...audibleClips(timeline).values()];
  const planner = crossfadePlanner(timeline, media && new Map(media.map(asset => [asset.id, asset])));
  const fades: JoinFade[] = [];
  const wanted = only ? only.map(f => ({ at: f.at, trackId: f.trackId as string | undefined, overlap: f.duration ?? duration }))
    : [...new Set(times)].sort((a, b) => a - b).map(at => ({ at, trackId: undefined as string | undefined, overlap: durations?.get(at) ?? duration }));
  for (const { at, trackId, overlap } of wanted) {
    if (!(overlap > 0)) continue;
    const pairs = joinsAt(clips, at, trackId);
    if (!pairs.length) continue;
    const reasons: string[] = [];
    for (const { left, right } of pairs) {
      const refused = planner.add(left, right, overlap);
      if (refused) reasons.push(REASON[refused.reason]);
      else fades.push({ at, trackId: left.track.id, ...(overlap !== duration && { duration: overlap }) });
    }
    if (reasons.length) report.plain.push({ at, reason: [...new Set(reasons)].join("; ") });
    else report.faded.push(at);
  }
  const ops = planner.ops();
  return { timeline: ops.length ? applyOps(timeline, ops) : timeline, fades, report };
}

/** Put recorded crossfades back on the timeline they were made on, as they were made. */
export function replayJoinFades(timeline: Timeline, fades: readonly JoinFade[], duration: number): Timeline {
  return crossfadeJoins(timeline, undefined, [], duration, { only: fades }).timeline;
}

/** Where ripple removals, applied in order, leave joins on the timeline they produce. */
export function rippleJoins(ops: ReadonlyArray<Record<string, unknown>>): number[] {
  let joins: number[] = [];
  for (const op of ops) {
    if (op.op !== "rippleDelete" || op.trackIds !== undefined || typeof op.start !== "number" || typeof op.end !== "number") continue;
    const { start, end } = op;
    joins = joins.map(j => j >= end ? j - (end - start) : j > start ? start : j);
    joins.push(start);
  }
  return joins.sort((a, b) => a - b).filter((j, i, all) => i === 0 || j - all[i - 1]! > EPS);
}

/**
 * Every clip edge on the tracks that play, as the cut is heard: a centered crossfade's two overlapping edges are the one
 * join at its centre, where its cut was.
 */
export function playedEdges(timeline: Timeline): number[] {
  const edges: number[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "caption") continue;
    const clips = track.clips;
    const inside = new Set<number>();
    for (let i = 0; i < clips.length; i++) {
      const left = clips[i]!;
      const leftEnd = clipEnd(left);
      for (let j = i + 1; left.kind === "media" && left.audioFadeOut && j < clips.length && clips[j]!.timelineIn < leftEnd - EPS; j++) {
        const right = clips[j]!;
        const overlap = leftEnd - right.timelineIn;
        if (right.kind !== "media" || right.timelineIn <= left.timelineIn + EPS || Math.abs(left.audioFadeOut - overlap) > EPS ||
            Math.abs(right.audioFadeIn - overlap) > EPS) continue;
        inside.add(i * 2 + 1).add(j * 2);
        edges.push(right.timelineIn + overlap / 2);
        break;
      }
    }
    clips.forEach((clip, i) => {
      if (!inside.has(i * 2)) edges.push(clip.timelineIn);
      if (!inside.has(i * 2 + 1)) edges.push(clipEnd(clip));
    });
  }
  return edges;
}
