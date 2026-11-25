import type { MediaAsset } from "./mediaSchema.js";
import { applyOps, type TimelineOp } from "./ops.js";
import type { TimeRange } from "./schemaBase.js";
import { splitJoinOps } from "./splitJoin.js";
import { clipDuration, clipEnd, timelineDuration } from "./time.js";
import type { Clip, MediaClip, Timeline, Track, TransformKeyframe } from "./timelineSchema.js";

/** Everything about a media clip except its placement, source slice, and edge fades (matches `putBack.ts`). */
const clipLook = (clip: MediaClip) => JSON.stringify({
  ...clip, id: "", timelineIn: 0, sourceIn: 0, sourceOut: 0,
  audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0,
});

export type EditAdjustMode = "overlay" | "roll" | "dip" | "split";

/** Legal local edge-drag bounds for a non-cut edit on the working timeline. */
export interface EditAdjustBounds {
  mode: EditAdjustMode;
  minStart: number;
  maxStart: number;
  minEnd: number;
  maxEnd: number;
  /** Whether pulling both edges together to zero removes or reverts the edit cleanly. */
  canRemove: boolean;
  /** For split edits: which side of the picture join is free to drag. */
  splitSide?: "j" | "l";
}

export interface AdjustEditOptions {
  /** Classified edit kind (e.g. "text", "broll", "graphic", "overlay", "zoom", "reframe", "audio", "dip", "voice", "split"). */
  kind?: string;
  /** Clip IDs touched by the change that made this edit, used to disambiguate matching clips on the timeline. */
  clipIds?: readonly string[];
}

export interface AdjustEditResult {
  timeline: Timeline;
  ops: TimelineOp[];
  range: TimeRange;
  removed?: true;
}

const MEET = 1e-3;
const EPS = 1e-6;
/** Edit kinds that must not be adjusted by direct range dragging (cuts have their own path; speed/insert/etc. need model intent). */
const DISALLOWED_KINDS = new Set(["cut", "restore", "insert", "speed", "transition", "marker"]);
const ROLL_KINDS = new Set(["zoom", "reframe", "audio", "voice", "overlay"]);

function clampFades(clip: MediaClip, newDur: number): Partial<MediaClip> {
  const patch: Partial<MediaClip> = {};
  const aSum = clip.audioFadeIn + clip.audioFadeOut;
  if (aSum > newDur && aSum > EPS) {
    const scale = Math.max(0, (newDur - EPS) / aSum);
    patch.audioFadeIn = Math.max(0, clip.audioFadeIn * scale);
    patch.audioFadeOut = Math.max(0, clip.audioFadeOut * scale);
  }
  const vSum = clip.videoFadeIn + clip.videoFadeOut;
  if (vSum > newDur && vSum > EPS) {
    const scale = Math.max(0, (newDur - EPS) / vSum);
    patch.videoFadeIn = Math.max(0, clip.videoFadeIn * scale);
    patch.videoFadeOut = Math.max(0, clip.videoFadeOut * scale);
  }
  return patch;
}

/**
 * Simple zoom/reframe ramps have keyframes only near the start and/or end (at most 4 keys total).
 * Arbitrary mid-clip tracking keyframes are refused so rolling never misaligns tracked motion.
 */
function canRollKeyframes(clip: MediaClip): boolean {
  if (clip.volumeKeyframes?.length) return false;
  const keys = clip.keyframes;
  if (!keys?.length) return true;
  if (keys.length > 4) return false;
  const dur = clipDuration(clip);
  const rampMax = Math.min(1.5, dur / 2 + 1e-3);
  return keys.every(k => k.time <= rampMax || k.time >= dur - rampMax);
}

function retimedRollKeyframes(keys: readonly TransformKeyframe[] | undefined, oldDur: number, newDur: number): TransformKeyframe[] | undefined {
  if (!keys?.length) return undefined;
  const deltaDur = newDur - oldDur;
  const mid = oldDur / 2;
  return keys.map(k => ({
    ...k,
    time: k.time > mid ? Math.max(0, Math.min(newDur, k.time + deltaDur)) : Math.max(0, Math.min(newDur, k.time)),
  }));
}

interface SplitMatch {
  side: "j" | "l";
  joinAt: number;
  soundL: { track: Track; clip: MediaClip };
  soundR: { track: Track; clip: MediaClip };
  bounds: EditAdjustBounds;
}

function findSplitMatch(head: Timeline, range: TimeRange, fps: number, media?: readonly MediaAsset[]): SplitMatch | undefined {
  const near = 1.5 / fps;
  const assets = new Map((media ?? []).map(a => [a.id, a]));
  const totalDur = timelineDuration(head);
  for (const track of head.tracks) {
    if (track.kind !== "audio") continue;
    const sorted = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    for (let i = 0; i < sorted.length; i++) {
      const clip = sorted[i]!;
      if (clip.kind !== "media" || !clip.splitEdit) continue;
      if (clip.splitEdit.leads && clip.splitEdit.leads > EPS) {
        const start = clip.timelineIn;
        const joinAt = start + clip.splitEdit.leads;
        if (Math.abs(start - range.start) <= near && Math.abs(joinAt - range.end) <= near) {
          const soundL = findMeetingAudio(head, start, "left", clip.id);
          if (!soundL) continue;
          const prevOnTrack = i > 0 ? clipEnd(sorted[i - 1]!) : 0;
          const prevNonMeet = soundL.track.id === track.id ? (i > 1 ? clipEnd(sorted[i - 2]!) : 0) : prevOnTrack;
          const lMinKeep = Math.max(1 / fps, soundL.clip.audioFadeIn + soundL.clip.audioFadeOut + 1 / fps);
          const minByL = soundL.clip.timelineIn + lMinKeep;
          const minBySource = clip.timelineIn - clip.sourceIn / clip.speed;
          const minStart = Math.max(0, prevNonMeet, minByL, minBySource, joinAt - 5);
          if (minStart > joinAt + EPS) continue;
          return {
            side: "j",
            joinAt,
            soundL,
            soundR: { track, clip },
            bounds: { mode: "split", minStart: Math.min(minStart, start), maxStart: joinAt, minEnd: joinAt, maxEnd: joinAt, canRemove: true, splitSide: "j" },
          };
        }
      }
      if (clip.splitEdit.trails && clip.splitEdit.trails > EPS) {
        const end = clipEnd(clip);
        const joinAt = end - clip.splitEdit.trails;
        if (Math.abs(joinAt - range.start) <= near && Math.abs(end - range.end) <= near) {
          const soundR = findMeetingAudio(head, end, "right", clip.id);
          if (!soundR) continue;
          const nextOnTrack = i + 1 < sorted.length ? sorted[i + 1]!.timelineIn : totalDur;
          const nextNonMeet = soundR.track.id === track.id ? (i + 2 < sorted.length ? sorted[i + 2]!.timelineIn : totalDur) : nextOnTrack;
          const rMinKeep = Math.max(1 / fps, soundR.clip.audioFadeIn + soundR.clip.audioFadeOut + 1 / fps);
          const maxByR = clipEnd(soundR.clip) - rMinKeep;
          const assetL = assets.get(clip.mediaId);
          const maxBySource = assetL?.duration !== undefined ? end + Math.max(0, (assetL.duration - clip.sourceOut) / clip.speed) : end;
          const maxEnd = Math.min(totalDur, nextNonMeet, maxByR, maxBySource, joinAt + 5);
          if (maxEnd < joinAt - EPS) continue;
          return {
            side: "l",
            joinAt,
            soundL: { track, clip },
            soundR,
            bounds: { mode: "split", minStart: joinAt, maxStart: joinAt, minEnd: joinAt, maxEnd: Math.max(maxEnd, end), canRemove: true, splitSide: "l" },
          };
        }
      }
    }
  }
  return undefined;
}

function findMeetingAudio(head: Timeline, at: number, side: "left" | "right", excludeId: string): { track: Track; clip: MediaClip } | undefined {
  for (const track of head.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.id === excludeId) continue;
      const edge = side === "left" ? clipEnd(clip) : clip.timelineIn;
      if (Math.abs(edge - at) <= MEET) return { track, clip };
    }
  }
  return undefined;
}

interface DipMatch {
  clip: MediaClip;
  sortedKeys: NonNullable<MediaClip["volumeKeyframes"]>;
  index: number;
  matchedOuter: boolean;
  bounds: EditAdjustBounds;
}

function findDipMatch(head: Timeline, range: TimeRange, fps: number, clipIds?: readonly string[]): DipMatch | undefined {
  const near = 1.5 / fps;
  const preferred = clipIds?.length ? new Set(clipIds) : undefined;
  const candidates: MediaClip[] = [];
  for (const track of head.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "media" || !clip.volumeKeyframes || clip.volumeKeyframes.length < 4) continue;
      if (clip.timelineIn > range.end + near || clipEnd(clip) < range.start - near) continue;
      candidates.push(clip);
    }
  }
  candidates.sort((a, b) => Number(!!preferred?.has(b.id)) - Number(!!preferred?.has(a.id)));
  for (const clip of candidates) {
    const keys = [...clip.volumeKeyframes!].sort((a, b) => a.time - b.time);
    const cStart = clip.timelineIn, cEnd = clipEnd(clip);
    for (let i = 0; i <= keys.length - 4; i++) {
      const k0 = keys[i]!, k1 = keys[i + 1]!, k2 = keys[i + 2]!, k3 = keys[i + 3]!;
      if (Math.abs(k0.db) > 0.5 || k1.db > -3 || k2.db > -3 || Math.abs(k3.db) > 0.5) continue;
      const innerStart = cStart + k1.time, innerEnd = cStart + k2.time;
      const outerStart = cStart + k0.time, outerEnd = cStart + k3.time;
      const matchesInner = Math.abs(innerStart - range.start) <= near && Math.abs(innerEnd - range.end) <= near;
      const matchesOuter = !matchesInner && Math.abs(outerStart - range.start) <= near && Math.abs(outerEnd - range.end) <= near;
      if (!matchesInner && !matchesOuter) continue;
      const down = Math.max(0, k1.time - k0.time);
      const up = Math.max(0, k3.time - k2.time);
      const prevLimit = i > 0 ? cStart + keys[i - 1]!.time : cStart;
      const nextLimit = i + 4 < keys.length ? cStart + keys[i + 4]!.time : cEnd;
      const minStart = matchesInner ? Math.max(cStart, prevLimit + down) : Math.max(cStart, prevLimit);
      const maxEnd = matchesInner ? Math.min(cEnd, nextLimit - up) : Math.min(cEnd, nextLimit);
      return {
        clip,
        sortedKeys: keys,
        index: i,
        matchedOuter: matchesOuter,
        bounds: {
          mode: "dip",
          minStart: Math.min(minStart, range.start),
          maxStart: range.end,
          minEnd: range.start,
          maxEnd: Math.max(maxEnd, range.end),
          canRemove: true,
        },
      };
    }
  }
  return undefined;
}

interface OverlayMatch {
  items: { track: Track; clip: Clip }[];
  bounds: EditAdjustBounds;
}

function findOverlayMatch(head: Timeline, range: TimeRange, fps: number, media?: readonly MediaAsset[], opts?: AdjustEditOptions): OverlayMatch | undefined {
  const near = 1.5 / fps;
  const baseVideo = head.tracks.find(t => t.kind === "video")?.id;
  const preferred = opts?.clipIds?.length ? new Set(opts.clipIds) : undefined;
  const allMatches: { track: Track; clip: Clip }[] = [];
  for (const track of head.tracks) {
    if (track.id === baseVideo) continue;
    for (const clip of track.clips) {
      if (clip.kind === "media" && clip.splitEdit) continue;
      if (Math.abs(clip.timelineIn - range.start) <= near && Math.abs(clipEnd(clip) - range.end) <= near) {
        allMatches.push({ track, clip });
      }
    }
  }
  if (!allMatches.length) return undefined;
  let items = preferred ? allMatches.filter(m => preferred.has(m.clip.id)) : [];
  if (!items.length) {
    if (opts?.kind === "text") items = allMatches.filter(m => m.track.kind === "caption" || m.clip.kind === "caption");
    else if (opts?.kind === "audio" || opts?.kind === "voice") items = allMatches.filter(m => m.track.kind === "audio");
    else if (opts?.kind === "broll" || opts?.kind === "graphic" || opts?.kind === "overlay") {
      const visuals = allMatches.filter(m => m.track.kind === "video");
      const visualMedia = new Set(visuals.flatMap(v => v.clip.kind === "media" ? [v.clip.mediaId] : []));
      const pairedAudio = allMatches.filter(m => m.track.kind === "audio" && m.clip.kind === "media" && visualMedia.has(m.clip.mediaId));
      items = visuals.length ? [...visuals, ...pairedAudio] : allMatches;
    }
    if (!items.length) items = allMatches;
  }

  const assets = new Map((media ?? []).map(a => [a.id, a]));
  const totalDur = Math.max(timelineDuration(head), range.end);
  let minStart = 0;
  let maxEnd = totalDur;

  for (const { track, clip } of items) {
    const sorted = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    const idx = sorted.findIndex(c => c.id === clip.id);
    const prevEnd = idx > 0 ? clipEnd(sorted[idx - 1]!) : 0;
    const nextStart = idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1]!.timelineIn : totalDur;
    if (clip.kind === "caption" || clip.kind === "color") {
      minStart = Math.max(minStart, prevEnd);
      maxEnd = Math.min(maxEnd, nextStart);
    } else {
      const asset = assets.get(clip.mediaId);
      if (asset?.kind === "image") {
        minStart = Math.max(minStart, prevEnd);
        maxEnd = Math.min(maxEnd, nextStart);
      } else {
        const earlier = clip.sourceIn / clip.speed;
        const later = asset?.duration !== undefined ? Math.max(0, (asset.duration - clip.sourceOut) / clip.speed) : 0;
        minStart = Math.max(minStart, prevEnd, clip.timelineIn - earlier);
        maxEnd = Math.min(maxEnd, nextStart, clipEnd(clip) + later);
      }
    }
  }

  const bounds: EditAdjustBounds = {
    mode: "overlay",
    minStart: Math.min(minStart, range.start),
    maxStart: range.end,
    minEnd: range.start,
    maxEnd: Math.max(maxEnd, range.end),
    canRemove: true,
  };
  return { items, bounds };
}

interface RollMatch {
  track: Track;
  mid: MediaClip[];
  prev?: MediaClip;
  next?: MediaClip;
  canRollLeft: boolean;
  canRollRight: boolean;
  bounds: EditAdjustBounds;
}

function findRollMatch(head: Timeline, range: TimeRange, fps: number, opts?: AdjustEditOptions): RollMatch | undefined {
  if (opts?.kind && !ROLL_KINDS.has(opts.kind)) return undefined;
  const near = 1.5 / fps;
  const baseVideo = head.tracks.find(t => t.kind === "video")?.id;
  const candidateTracks = head.tracks.filter(t =>
    t.id === baseVideo || ((opts?.kind === "audio" || opts?.kind === "voice") && t.kind === "audio"),
  );
  const preferred = opts?.clipIds?.length ? new Set(opts.clipIds) : undefined;

  for (const track of candidateTracks) {
    const sorted = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    const startIdx = sorted.findIndex(c => c.kind === "media" && Math.abs(c.timelineIn - range.start) <= near);
    if (startIdx < 0) continue;
    const mid: MediaClip[] = [];
    let endIdx = -1;
    for (let i = startIdx; i < sorted.length; i++) {
      const c = sorted[i]!;
      if (c.kind !== "media") break;
      if (mid.length > 0 && Math.abs(c.timelineIn - clipEnd(mid.at(-1)!)) > MEET) break;
      mid.push(c);
      if (Math.abs(clipEnd(c) - range.end) <= near) {
        endIdx = i;
        break;
      }
      if (clipEnd(c) > range.end + near) break;
    }
    if (endIdx < 0 || !mid.length) continue;
    if (preferred && !mid.some(c => preferred.has(c.id))) continue;
    const first = mid[0]!;
    const last = mid.at(-1)!;
    if (!canRollKeyframes(first) || !canRollKeyframes(last)) continue;

    const prevRaw = startIdx > 0 ? sorted[startIdx - 1] : undefined;
    const nextRaw = endIdx + 1 < sorted.length ? sorted[endIdx + 1] : undefined;
    const prev = prevRaw?.kind === "media" && prevRaw.mediaId === first.mediaId && prevRaw.speed === first.speed
      && Math.abs(clipEnd(prevRaw) - first.timelineIn) <= MEET
      && Math.abs(prevRaw.sourceOut - first.sourceIn) <= 0.5 / fps * first.speed
      && !first.transitionIn
      && clipLook(prevRaw) !== clipLook(first)
      ? prevRaw : undefined;
    const next = nextRaw?.kind === "media" && nextRaw.mediaId === last.mediaId && nextRaw.speed === last.speed
      && Math.abs(clipEnd(last) - nextRaw.timelineIn) <= MEET
      && Math.abs(last.sourceOut - nextRaw.sourceIn) <= 0.5 / fps * last.speed
      && !nextRaw.transitionIn
      && clipLook(last) !== clipLook(nextRaw)
      ? nextRaw : undefined;

    if (!prev && !next) continue;
    const minKeep = (c: MediaClip) => Math.max(1 / fps, c.audioFadeIn + c.audioFadeOut + 1 / fps, c.videoFadeIn + c.videoFadeOut + 1 / fps);
    const minStart = prev ? Math.min(range.start, prev.timelineIn + minKeep(prev)) : range.start;
    const maxStart = prev ? (mid.length === 1 ? range.end : Math.max(range.start, clipEnd(first) - 1 / fps)) : range.start;
    const maxEnd = next ? Math.max(range.end, clipEnd(next) - minKeep(next)) : range.end;
    const minEnd = next ? (mid.length === 1 ? range.start : Math.min(range.end, last.timelineIn + 1 / fps)) : range.end;
    return {
      track,
      mid,
      prev,
      next,
      canRollLeft: !!prev,
      canRollRight: !!next,
      bounds: {
        mode: "roll",
        minStart,
        maxStart,
        minEnd,
        maxEnd,
        canRemove: mid.length === 1 && (!!prev || !!next),
      },
    };
  }
  return undefined;
}

function hasAnyMovement(bounds: EditAdjustBounds, range: TimeRange, fps: number): boolean {
  const half = 0.5 / fps;
  return bounds.minStart < range.start - half || bounds.maxStart > range.start + half
    || bounds.minEnd < range.end - half || bounds.maxEnd > range.end + half;
}

function resolveEditTarget(head: Timeline, range: TimeRange, fps: number, media?: readonly MediaAsset[], opts?: AdjustEditOptions) {
  if (!(range.end > range.start + 0.5 / fps)) return undefined;
  if (opts?.kind && DISALLOWED_KINDS.has(opts.kind)) return undefined;
  if (opts?.kind === "split") {
    const split = findSplitMatch(head, range, fps, media);
    return split && hasAnyMovement(split.bounds, range, fps) ? { kind: "split" as const, match: split } : undefined;
  }
  if (opts?.kind === "dip") {
    const dip = findDipMatch(head, range, fps, opts.clipIds);
    return dip && hasAnyMovement(dip.bounds, range, fps) ? { kind: "dip" as const, match: dip } : undefined;
  }
  const overlay = findOverlayMatch(head, range, fps, media, opts);
  if (overlay && hasAnyMovement(overlay.bounds, range, fps)) return { kind: "overlay" as const, match: overlay };
  const roll = findRollMatch(head, range, fps, opts);
  if (roll && hasAnyMovement(roll.bounds, range, fps)) return { kind: "roll" as const, match: roll };
  if (!opts?.kind) {
    const dip = findDipMatch(head, range, fps, opts?.clipIds);
    if (dip && hasAnyMovement(dip.bounds, range, fps)) return { kind: "dip" as const, match: dip };
    const split = findSplitMatch(head, range, fps, media);
    if (split && hasAnyMovement(split.bounds, range, fps)) return { kind: "split" as const, match: split };
  }
  return undefined;
}

/**
 * Legal local edge-drag bounds for any applied non-cut edit that can be adjusted directly by the engine with no model
 * thinking again: captions, B-roll, graphics, overlays, added audio clips, split-clip zooms/reframes/voice edits,
 * music dips, and J/L split edits. Returns `undefined` when the edit cannot be adjusted safely without Scarlet.
 */
export function editAdjustBounds(head: Timeline, range: TimeRange, fps: number, media?: readonly MediaAsset[], opts?: AdjustEditOptions): EditAdjustBounds | undefined {
  return resolveEditTarget(head, range, fps, media, opts)?.match.bounds;
}

/**
 * Adjust a non-cut edit's start and/or end edges directly on the timeline with no model round-trip.
 * Returns the updated validated timeline, the exact `TimelineOp[]` that produced it, and the resulting range
 * (or `removed: true` when both edges were pulled together to zero).
 */
export function adjustEdit(head: Timeline, range: TimeRange, nextRange: TimeRange, fps: number, media?: readonly MediaAsset[], opts?: AdjustEditOptions): AdjustEditResult | undefined {
  const target = resolveEditTarget(head, range, fps, media, opts);
  if (!target) return undefined;
  const { bounds } = target.match;
  const eps = 1e-3;
  const nextStart = Math.max(bounds.minStart, Math.min(bounds.maxStart, nextRange.start));
  const nextEnd = Math.max(bounds.minEnd, Math.min(bounds.maxEnd, nextRange.end));
  if (nextRange.start < bounds.minStart - eps || nextRange.start > bounds.maxStart + eps) return undefined;
  if (nextRange.end < bounds.minEnd - eps || nextRange.end > bounds.maxEnd + eps) return undefined;
  if (nextEnd < nextStart - eps) return undefined;

  const deltaStart = nextStart - range.start;
  const deltaEnd = nextEnd - range.end;
  const half = 0.5 / fps;
  if (Math.abs(deltaStart) < half && Math.abs(deltaEnd) < half) return undefined;
  const pullsToZero = nextEnd - nextStart <= half;
  const assets = new Map((media ?? []).map(a => [a.id, a]));

  if (target.kind === "split") {
    const { side, joinAt } = target.match;
    const shift = pullsToZero ? 0 : side === "j" ? -(joinAt - nextStart) : nextEnd - joinAt;
    try {
      const { ops } = splitJoinOps(head, media ?? [], fps, [{ at: joinAt, shift }]);
      const timeline = applyOps(head, ops);
      return { timeline, ops, range: { start: Math.min(joinAt, joinAt + shift), end: Math.max(joinAt, joinAt + shift) }, ...(pullsToZero && { removed: true }) };
    } catch {
      return undefined;
    }
  }

  if (target.kind === "dip") {
    const { clip, sortedKeys, index, matchedOuter } = target.match;
    if (pullsToZero) {
      const nextKeys = [...sortedKeys.slice(0, index), ...sortedKeys.slice(index + 4)];
      const ops: TimelineOp[] = [{ op: "updateClip", clipId: clip.id, patch: { volumeKeyframes: nextKeys.length ? nextKeys : [] } }];
      const timeline = applyOps(head, ops);
      return { timeline, ops, range: { start: nextStart, end: nextStart }, removed: true };
    }
    const cDur = clipDuration(clip);
    const loRel = index > 0 ? sortedKeys[index - 1]!.time : 0;
    const hiRel = index + 4 < sortedKeys.length ? sortedKeys[index + 4]!.time : cDur;
    const clampRel = (t: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, t));
    const k0 = sortedKeys[index]!, k1 = sortedKeys[index + 1]!, k2 = sortedKeys[index + 2]!, k3 = sortedKeys[index + 3]!;
    const down = Math.max(0, k1.time - k0.time);
    const up = Math.max(0, k3.time - k2.time);
    let t0: number, t1: number, t2: number, t3: number;
    if (matchedOuter) {
      t0 = clampRel(k0.time + deltaStart, loRel, hiRel);
      t3 = clampRel(k3.time + deltaEnd, t0, hiRel);
      t1 = clampRel(t0 + down, t0, t3);
      t2 = clampRel(t3 - up, t0, t3);
      if (t1 > t2) { const mid = (t1 + t2) / 2; t1 = mid; t2 = mid; }
    } else {
      t1 = clampRel(k1.time + deltaStart, loRel, hiRel);
      t2 = clampRel(k2.time + deltaEnd, t1, hiRel);
      t0 = clampRel(t1 - down, loRel, t1);
      t3 = clampRel(t2 + up, t2, hiRel);
    }
    const nextKeys = sortedKeys.map((k, i) => {
      if (i === index) return { ...k, time: t0 };
      if (i === index + 1) return { ...k, time: t1 };
      if (i === index + 2) return { ...k, time: t2 };
      if (i === index + 3) return { ...k, time: t3 };
      return { ...k };
    });
    const ops: TimelineOp[] = [{ op: "updateClip", clipId: clip.id, patch: { volumeKeyframes: nextKeys } }];
    const timeline = applyOps(head, ops);
    return { timeline, ops, range: { start: nextStart, end: nextEnd } };
  }

  if (target.kind === "overlay") {
    const { items } = target.match;
    if (pullsToZero) {
      const ops: TimelineOp[] = items.map(({ clip }) => ({ op: "removeClip", clipId: clip.id }));
      const timeline = applyOps(head, ops);
      return { timeline, ops, range: { start: nextStart, end: nextStart }, removed: true };
    }
    const newDur = nextEnd - nextStart;
    const ops: TimelineOp[] = [];
    for (const { clip } of items) {
      if (clip.kind === "caption" || clip.kind === "color") {
        ops.push({ op: "updateClip", clipId: clip.id, patch: { timelineIn: nextStart, timelineOut: nextEnd } });
      } else {
        const asset = assets.get(clip.mediaId);
        const isImage = asset?.kind === "image";
        const clipDeltaStart = nextStart - clip.timelineIn;
        const clipDeltaEnd = nextEnd - clipEnd(clip);
        const nextSourceIn = isImage ? clip.sourceIn : Math.max(0, clip.sourceIn + clipDeltaStart * clip.speed);
        const nextSourceOut = isImage ? clip.sourceIn + newDur * clip.speed : clip.sourceOut + clipDeltaEnd * clip.speed;
        if (nextSourceOut <= nextSourceIn + EPS) return undefined;
        const patch: Record<string, unknown> = {
          timelineIn: nextStart,
          sourceIn: nextSourceIn,
          sourceOut: nextSourceOut,
          ...clampFades(clip, newDur),
          ...(clip.keyframes?.length && Math.abs(clipDeltaStart) > EPS && {
            keyframes: clip.keyframes.map(k => ({ ...k, time: k.time - clipDeltaStart })),
          }),
          ...(clip.volumeKeyframes?.length && Math.abs(clipDeltaStart) > EPS && {
            volumeKeyframes: clip.volumeKeyframes.map(k => ({ ...k, time: k.time - clipDeltaStart })),
          }),
        };
        ops.push({ op: "updateClip", clipId: clip.id, patch });
      }
    }
    const timeline = applyOps(head, ops);
    return { timeline, ops, range: { start: nextStart, end: nextEnd } };
  }

  // Mode: "roll" (adjacent continuous clips of the same recording on the main track or audio track).
  const { mid, prev, next } = target.match;
  const ops: TimelineOp[] = [];
  if (pullsToZero && mid.length === 1) {
    const only = mid[0]!;
    const canMergePrevNext = !!prev && !!next && clipLook(prev) === clipLook(next)
      && !prev.keyframes?.length && !prev.volumeKeyframes?.length
      && !next.keyframes?.length && !next.volumeKeyframes?.length;
    if (canMergePrevNext) {
      ops.push(
        { op: "removeClip", clipId: only.id },
        { op: "removeClip", clipId: next.id },
        { op: "updateClip", clipId: prev.id, patch: { sourceOut: next.sourceOut, audioFadeOut: next.audioFadeOut, videoFadeOut: next.videoFadeOut } },
      );
    } else if (prev) {
      ops.push(
        { op: "removeClip", clipId: only.id },
        { op: "updateClip", clipId: prev.id, patch: { sourceOut: only.sourceOut } },
      );
    } else if (next) {
      const shiftNext = next.timelineIn - only.timelineIn;
      ops.push(
        { op: "removeClip", clipId: only.id },
        {
          op: "updateClip",
          clipId: next.id,
          patch: {
            timelineIn: only.timelineIn,
            sourceIn: only.sourceIn,
            ...(next.keyframes?.length && { keyframes: next.keyframes.map(k => ({ ...k, time: k.time + shiftNext })) }),
            ...(next.volumeKeyframes?.length && { volumeKeyframes: next.volumeKeyframes.map(k => ({ ...k, time: k.time + shiftNext })) }),
          },
        },
      );
    } else {
      return undefined;
    }
    const timeline = applyOps(head, ops);
    return { timeline, ops, range: { start: nextStart, end: nextStart }, removed: true };
  }

  const first = mid[0]!;
  const last = mid.at(-1)!;
  if (Math.abs(deltaStart) >= half && prev) {
    const nextPrevOut = prev.sourceOut + deltaStart * prev.speed;
    const nextFirstIn = first.sourceIn + deltaStart * first.speed;
    if (nextPrevOut <= prev.sourceIn + EPS || nextFirstIn < -EPS) return undefined;
    const firstEnd = mid.length === 1 ? nextEnd : clipEnd(first);
    const nextFirstDur = firstEnd - nextStart;
    if (nextFirstDur < 1 / fps - EPS) return undefined;
    ops.push({ op: "updateClip", clipId: prev.id, patch: { sourceOut: nextPrevOut } });
    if (mid.length > 1 || Math.abs(deltaEnd) < half) {
      const kf = retimedRollKeyframes(first.keyframes, clipDuration(first), nextFirstDur);
      ops.push({
        op: "updateClip",
        clipId: first.id,
        patch: {
          timelineIn: nextStart,
          sourceIn: Math.max(0, nextFirstIn),
          ...clampFades(first, nextFirstDur),
          ...(kf && { keyframes: kf }),
        },
      });
    }
  }
  if (Math.abs(deltaEnd) >= half && next) {
    const nextLastOut = last.sourceOut + deltaEnd * last.speed;
    const nextAfterIn = next.sourceIn + deltaEnd * next.speed;
    if (nextAfterIn >= next.sourceOut - EPS || nextAfterIn < -EPS) return undefined;
    const lastStart = mid.length === 1 ? nextStart : last.timelineIn;
    const nextLastDur = nextEnd - lastStart;
    if (nextLastDur < 1 / fps - EPS) return undefined;
    const kf = retimedRollKeyframes(last.keyframes, clipDuration(last), nextLastDur);
    const lastPatch: Record<string, unknown> = {
      sourceOut: nextLastOut,
      ...clampFades(last, nextLastDur),
      ...(kf && { keyframes: kf }),
      ...(mid.length === 1 && Math.abs(deltaStart) >= half && prev && {
        timelineIn: nextStart,
        sourceIn: Math.max(0, first.sourceIn + deltaStart * first.speed),
      }),
    };
    const nextDelta = nextEnd - next.timelineIn;
    ops.push(
      { op: "updateClip", clipId: last.id, patch: lastPatch },
      {
        op: "updateClip",
        clipId: next.id,
        patch: {
          timelineIn: nextEnd,
          sourceIn: Math.max(0, nextAfterIn),
          ...(next.keyframes?.length && Math.abs(nextDelta) > EPS && { keyframes: next.keyframes.map(k => ({ ...k, time: k.time - nextDelta })) }),
          ...(next.volumeKeyframes?.length && Math.abs(nextDelta) > EPS && { volumeKeyframes: next.volumeKeyframes.map(k => ({ ...k, time: k.time - nextDelta })) }),
        },
      },
    );
  }
  if (!ops.length) return undefined;
  const timeline = applyOps(head, ops);
  return { timeline, ops, range: { start: nextStart, end: nextEnd } };
}
