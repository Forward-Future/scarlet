/**
 * Timeline operations. Agents propose changes as a list of ops (or a full
 * replacement timeline). Ops are applied immutably and validated.
 */
import { z } from "zod/v3";
import { duplicateClipId, WritableTimeline, Clip, Marker, Track, Timeline, Seconds, Id, CaptionStyle, RenderColor } from "./schema.js";
import type { CaptionClip } from "./schema.js";
import { clipEnd } from "./time.js";

/** Two times this close are the same instant: far under a sample, far over floating-point error. */
const MEET = 1e-9;
/** A piece of a clip shorter than this is never wanted: a time this near a clip's edge means the edge. */
const SLIVER = 0.001;
import { newId } from "./ids.js";

export const AddClipOp = z.object({
  op: z.literal("addClip"),
  trackId: Id,
  clip: Clip,
});

export const RemoveClipOp = z.object({
  op: z.literal("removeClip"),
  clipId: Id,
});

export const UpdateClipOp = z.object({
  op: z.literal("updateClip"),
  clipId: Id,
  /** Shallow patch of clip fields. `kind` and `id` cannot change. */
  patch: z.record(z.unknown()),
});

export const MoveClipOp = z.object({
  op: z.literal("moveClip"),
  clipId: Id,
  timelineIn: Seconds,
  /** Optionally move to another track. */
  trackId: Id.optional(),
});

/** Split a clip at a timeline time into two clips. */
export const SplitClipOp = z.object({
  op: z.literal("splitClip"),
  clipId: Id,
  at: Seconds,
  /** Id for the new right-hand clip (generated if omitted). */
  newClipId: Id.optional(),
});

/**
 * Remove a timeline range from every track (or the listed tracks) and close
 * the gap. This is the "cut out the false start" primitive.
 */
export const RippleDeleteOp = z.object({
  op: z.literal("rippleDelete"),
  start: Seconds,
  end: Seconds,
  trackIds: z.array(Id).optional(),
});

/** Insert a gap (push everything after `at` later by `duration`). */
export const RippleInsertGapOp = z.object({
  op: z.literal("rippleInsertGap"),
  at: Seconds,
  duration: Seconds,
  trackIds: z.array(Id).optional(),
});

export const AddTrackOp = z.object({
  op: z.literal("addTrack"),
  track: Track,
  /** Insert position; appended if omitted. */
  index: z.number().int().min(0).optional(),
});

export const RemoveTrackOp = z.object({
  op: z.literal("removeTrack"),
  trackId: Id,
});

export const UpdateTrackOp = z.object({
  op: z.literal("updateTrack"),
  trackId: Id,
  patch: Track.omit({ id: true, clips: true }).partial(),
});

export const AddMarkerOp = z.object({
  op: z.literal("addMarker"),
  marker: Marker,
});

export const RemoveMarkerOp = z.object({
  op: z.literal("removeMarker"),
  markerId: Id,
});

export const UpdateMarkerOp = z.object({
  op: z.literal("updateMarker"),
  markerId: Id,
  patch: Marker.omit({ id: true }).partial(),
});

export const SetTimelineOp = z.object({
  op: z.literal("setTimeline"),
  patch: z.object({
    name: z.string().optional(),
    background: RenderColor.optional(),
    captionStyle: CaptionStyle.partial().optional(),
  }),
});

export const TimelineOp = z.discriminatedUnion("op", [
  AddClipOp,
  RemoveClipOp,
  UpdateClipOp,
  MoveClipOp,
  SplitClipOp,
  RippleDeleteOp,
  RippleInsertGapOp,
  AddTrackOp,
  RemoveTrackOp,
  UpdateTrackOp,
  AddMarkerOp,
  RemoveMarkerOp,
  UpdateMarkerOp,
  SetTimelineOp,
]);
export type TimelineOp = z.infer<typeof TimelineOp>;

export class OpError extends Error {
  constructor(
    message: string,
    public readonly op: TimelineOp,
  ) {
    super(message);
    this.name = "OpError";
  }
}

function findClip(tl: Timeline, clipId: string): { track: Track; index: number; clip: Clip } | null {
  for (const track of tl.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: track.clips[index]! };
  }
  return null;
}

function sortClips(track: Track) {
  track.clips.sort((a, b) => a.timelineIn - b.timelineIn);
}

/** Apply ops to a timeline and return a new validated timeline. */
export function applyOps(timeline: Timeline, ops: TimelineOp[]): Timeline {
  return WritableTimeline.parse(replayOnCopy(timeline, ops));
}

/** Replay on a private copy. Comparing old versions must preserve their original clip geometry. */
export function replayOnCopy(timeline: Timeline, ops: TimelineOp[]): Timeline {
  let tl = structuredClone(timeline);
  // Effect parameters can contain arbitrary nested data shared by multiple ops.
  for (const op of ops) tl = applyToDraft(tl, structuredClone(op));
  return tl;
}

export function applyOp(input: Timeline, op: TimelineOp): Timeline {
  return applyToDraft(structuredClone(input), op);
}

function applyToDraft(tl: Timeline, op: TimelineOp): Timeline {
  switch (op.op) {
    case "addClip": {
      const track = tl.tracks.find((t) => t.id === op.trackId);
      if (!track) throw new OpError(`track ${op.trackId} not found`, op);
      if (findClip(tl, op.clip.id)) throw new OpError(`clip ${op.clip.id} already exists`, op);
      if (!clipFitsTrack(op.clip, track)) {
        throw new OpError(`clip kind ${op.clip.kind} cannot go on ${track.kind} track`, op);
      }
      track.clips.push(Clip.parse(op.clip));
      sortClips(track);
      return tl;
    }
    case "removeClip": {
      const found = findClip(tl, op.clipId);
      if (!found) throw new OpError(`clip ${op.clipId} not found`, op);
      found.track.clips.splice(found.index, 1);
      return tl;
    }
    case "updateClip": {
      const found = findClip(tl, op.clipId);
      if (!found) throw new OpError(`clip ${op.clipId} not found`, op);
      const patch = { ...op.patch };
      delete patch.id;
      delete patch.kind;
      const merged = Clip.parse({ ...found.clip, ...patch });
      found.track.clips[found.index] = merged;
      sortClips(found.track);
      return tl;
    }
    case "moveClip": {
      const found = findClip(tl, op.clipId);
      if (!found) throw new OpError(`clip ${op.clipId} not found`, op);
      const clip = shiftClip(found.clip, op.timelineIn - found.clip.timelineIn);
      found.track.clips.splice(found.index, 1);
      const target = op.trackId ? tl.tracks.find((t) => t.id === op.trackId) : found.track;
      if (!target) throw new OpError(`track ${op.trackId} not found`, op);
      if (!clipFitsTrack(clip, target)) {
        throw new OpError(`clip kind ${clip.kind} cannot go on ${target.kind} track`, op);
      }
      target.clips.push(clip);
      sortClips(target);
      return tl;
    }
    case "splitClip": {
      const found = findClip(tl, op.clipId);
      if (!found) throw new OpError(`clip ${op.clipId} not found`, op);
      const { clip } = found;
      const end = clipEnd(clip);
      if (op.at <= clip.timelineIn || op.at >= end) {
        throw new OpError(`split point ${op.at} outside clip [${clip.timelineIn}, ${end})`, op);
      }
      const rightId = op.newClipId ?? newId("clip");
      if (findClip(tl, rightId)) throw new OpError(`clip ${rightId} already exists`, op);
      const [left, right] = splitClip(clip, op.at, rightId);
      found.track.clips.splice(found.index, 1, left, right);
      sortClips(found.track);
      return tl;
    }
    case "rippleDelete": {
      if (op.end <= op.start) throw new OpError("end must be > start", op);
      const dur = op.end - op.start;
      for (const track of tl.tracks) {
        if (op.trackIds && !op.trackIds.includes(track.id)) continue;
        straightenCrossfades(track, op.start, op.end);
        const next: Clip[] = [];
        for (const clip of track.clips) {
          const cStart = clip.timelineIn;
          const cEnd = clipEnd(clip);
          // Times that meet meet: after a few ripples a clip's edge and a cut's can differ in the thirteenth decimal,
          // and the difference used to stay in the timeline as a clip of no length.
          if (cEnd <= op.start + MEET) {
            next.push(clip); // entirely before
          } else if (cStart >= op.end - MEET) {
            next.push(shiftClip(clip, -dur)); // entirely after: shift left
          } else if (cStart >= op.start - MEET && cEnd <= op.end + MEET) {
            // entirely inside: drop
          } else if (cStart < op.start - MEET && cEnd > op.end + MEET) {
            // spans the range: split into two, trim both, shift the right part
            const [l, r] = splitClip(clip, op.start, newId("clip"));
            const rTrimmed = trimHead(r, op.end);
            next.push(l, shiftClip(rTrimmed, -dur));
          } else if (cStart < op.start - MEET) {
            // overlaps start: trim tail
            next.push(trimTail(clip, op.start));
          } else {
            // overlaps end, or starts where the range does: trim head then shift
            next.push(shiftClip(trimHead(clip, op.end), -dur));
          }
        }
        track.clips = next;
        sortClips(track);
      }
      for (const m of tl.markers) {
        if (m.time >= op.end) m.time -= dur;
        else if (m.time > op.start) m.time = op.start;
        if (m.end !== undefined) {
          if (m.end >= op.end) m.end -= dur;
          else if (m.end > op.start) m.end = op.start;
        }
      }
      return tl;
    }
    case "rippleInsertGap": {
      for (const track of tl.tracks) {
        if (op.trackIds && !op.trackIds.includes(track.id)) continue;
        const next: Clip[] = [];
        for (const clip of track.clips) {
          // A gap asked for where two clips meet opens between them. Times are read to four decimals, so the request
          // can miss the join by a few microseconds, and splitting there left a clip of that length on each track.
          if (clip.timelineIn >= op.at - SLIVER) next.push(shiftClip(clip, op.duration));
          else if (clipEnd(clip) > op.at + SLIVER) {
            const [l, r] = splitClip(clip, op.at, newId("clip"));
            next.push(l, shiftClip(r, op.duration));
          } else next.push(clip);
        }
        track.clips = next;
      }
      for (const m of tl.markers) {
        if (m.end !== undefined && (m.end > op.at || m.time >= op.at)) m.end += op.duration;
        if (m.time >= op.at) m.time += op.duration;
      }
      return tl;
    }
    case "addTrack": {
      if (tl.tracks.some((t) => t.id === op.track.id)) {
        throw new OpError(`track ${op.track.id} already exists`, op);
      }
      const track = Track.parse(op.track);
      const duplicate = duplicateClipId([...tl.tracks, track]);
      if (duplicate !== undefined) throw new OpError(`clip ${duplicate} already exists`, op);
      if (op.index === undefined) tl.tracks.push(track);
      else tl.tracks.splice(op.index, 0, track);
      return tl;
    }
    case "removeTrack": {
      const i = tl.tracks.findIndex((t) => t.id === op.trackId);
      if (i < 0) throw new OpError(`track ${op.trackId} not found`, op);
      tl.tracks.splice(i, 1);
      return tl;
    }
    case "updateTrack": {
      const track = tl.tracks.find((t) => t.id === op.trackId);
      if (!track) throw new OpError(`track ${op.trackId} not found`, op);
      Object.assign(track, withCaptionStyle(track.captionStyle, op.patch));
      return tl;
    }
    case "addMarker": {
      if (tl.markers.some((m) => m.id === op.marker.id)) {
        throw new OpError(`marker ${op.marker.id} already exists`, op);
      }
      tl.markers.push(Marker.parse(op.marker));
      tl.markers.sort((a, b) => a.time - b.time);
      return tl;
    }
    case "removeMarker": {
      const i = tl.markers.findIndex((m) => m.id === op.markerId);
      if (i < 0) throw new OpError(`marker ${op.markerId} not found`, op);
      tl.markers.splice(i, 1);
      return tl;
    }
    case "updateMarker": {
      const m = tl.markers.find((m) => m.id === op.markerId);
      if (!m) throw new OpError(`marker ${op.markerId} not found`, op);
      Object.assign(m, op.patch);
      return tl;
    }
    case "setTimeline": {
      Object.assign(tl, withCaptionStyle(tl.captionStyle, op.patch));
      return tl;
    }
  }
}

/**
 * A caption style in a patch changes only the settings it names. Naming the style with no value still clears it.
 */
function withCaptionStyle<P extends { captionStyle?: Partial<CaptionStyle> }>(current: Partial<CaptionStyle> | undefined, patch: P): P {
  return patch.captionStyle ? { ...patch, captionStyle: { ...current, ...patch.captionStyle } } : patch;
}

/**
 * A centered audio crossfade a removal reaches goes back to the straight cut at its centre first: two clips on one track
 * that overlap by exactly the fades they carry there. Cut through as it is, the overlap would leave one side fading out
 * over nothing and a sliver of the other fading in after it. The removal's own join can take a crossfade again.
 */
function straightenCrossfades(track: Track, start: number, end: number) {
  const clips = track.clips;
  for (let i = 0; i < clips.length; i++) {
    const left = clips[i]!;
    if (left.timelineIn > end + MEET) break;
    const leftEnd = clipEnd(left);
    if (left.kind !== "media" || !left.audioFadeOut || leftEnd < start - MEET) continue;
    for (let j = i + 1; j < clips.length && clips[j]!.timelineIn < leftEnd - MEET; j++) {
      const right = clips[j]!;
      const overlap = leftEnd - right.timelineIn;
      if (right.kind !== "media" || right.timelineIn <= left.timelineIn + MEET || Math.abs(left.audioFadeOut - overlap) > 1e-6 ||
          Math.abs(right.audioFadeIn - overlap) > 1e-6 || start > leftEnd + MEET || end < right.timelineIn - MEET) continue;
      const join = right.timelineIn + overlap / 2;
      clips[i] = { ...trimTail(left, join), audioFadeOut: 0 };
      clips[j] = { ...trimHead(right, join), audioFadeIn: 0 };
      break;
    }
  }
}

function clipFitsTrack(clip: Clip, track: Track): boolean {
  if (track.kind === "caption") return clip.kind === "caption";
  if (clip.kind === "caption") return false;
  return true;
}

/** Keep the words audible in a trimmed caption, including partial boundary words. */
function trimCaption(clip: CaptionClip, start: number, end: number): CaptionClip {
  const out = { ...clip, timelineIn: start, timelineOut: end };
  if (!clip.words?.length) return out;
  out.words = clip.words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({ ...w, start: Math.max(start, w.start), end: Math.min(end, w.end) }));
  out.text = out.words.map((w) => w.text).join(" ");
  return out;
}

export function shiftClip<T extends Clip>(clip: T, delta: number): T;
export function shiftClip(clip: Clip, delta: number): Clip {
  const timelineIn = Math.max(0, clip.timelineIn + delta);
  if (clip.kind === "media") return { ...clip, timelineIn };
  const timelineOut = Math.max(0, clip.timelineOut + delta);
  if (clip.kind === "caption" && clip.words) {
    const words = clip.words.map((w) => ({ ...w, start: w.start + delta, end: w.end + delta }));
    const shifted = { ...clip, timelineIn, timelineOut, words };
    return clip.timelineIn + delta < 0 ? trimCaption(shifted, timelineIn, timelineOut) : shifted;
  }
  return { ...clip, timelineIn, timelineOut };
}

/** Trim the start of a clip so it begins at timeline time `at`. */
export function trimHead<T extends Clip>(clip: T, at: number): T {
  const delta = at - clip.timelineIn;
  if (delta <= 0) return clip;
  if (clip.kind === "media") {
    return { ...clip, timelineIn: at, sourceIn: clip.sourceIn + delta * (clip.speed ?? 1),
      ...(clip.keyframes?.length && { keyframes: clip.keyframes.map(key => ({ ...key, time: key.time - delta })) }),
    } as T;
  }
  if (clip.kind === "caption") return trimCaption(clip, at, clip.timelineOut) as T;
  return { ...clip, timelineIn: at } as T;
}

/** Trim the end of a clip so it ends at timeline time `at`. */
export function trimTail<T extends Clip>(clip: T, at: number): T {
  const end = clipEnd(clip);
  if (at >= end) return clip;
  if (clip.kind === "media") {
    const keep = at - clip.timelineIn;
    return { ...clip, sourceOut: clip.sourceIn + keep * (clip.speed ?? 1) } as T;
  }
  if (clip.kind === "caption") return trimCaption(clip, clip.timelineIn, at) as T;
  return { ...clip, timelineOut: at } as T;
}

export function splitClip(clip: Clip, at: number, newId: string): [Clip, Clip] {
  const left = trimTail(clip, at);
  const right = { ...trimHead(clip, at), id: newId } as Clip;
  // fades belong to the outer edges only
  if (left.kind === "media") {
    left.audioFadeOut = 0;
    left.videoFadeOut = 0;
  }
  if (right.kind === "media") {
    right.audioFadeIn = 0;
    right.videoFadeIn = 0;
  }
  return [left, right];
}
