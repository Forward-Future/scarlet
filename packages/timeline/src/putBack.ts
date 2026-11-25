import type { MediaAsset } from "./mediaSchema.js";
import type { TimeRange } from "./schemaBase.js";
import type { Clip, MediaClip, Timeline, Track } from "./timelineSchema.js";
import { crossfadeJoins, type JoinFade } from "./joinCrossfade.js";
import { shiftClip, straightenCrossfades } from "./ops.js";
import { clipDuration, clipEnd, timelineDuration } from "./time.js";

/** Everything about a clip but where it sits, what footage it plays and the fades at its ends. */
const look = (clip: MediaClip) => JSON.stringify({ ...clip, id: "", timelineIn: 0, sourceIn: 0, sourceOut: 0,
  audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0 });

/**
 * The timeline with the footage a cut took out put back at its join, and every other edit as it was. A cut leaves two
 * clips of one recording meeting at `at`, the second starting `length` seconds of footage after the first ends; that
 * footage goes back between them, and everything after the join moves along. Clips that look the same either side are
 * one clip again, as before the cut; where a later edit gave them different looks they stay two, and the footage put
 * back takes the look of the clip before it.
 *
 * It answers nothing where the join isn't that simple (a clip laid across it since, another recording after it, a
 * transition on it), so the caller can ask Scarlet instead.
 */
export function putBackCut(head: Timeline, at: number, length: number, fps: number): Timeline | undefined {
  const tl = structuredClone(head);
  const near = 0.5 / fps;
  let restored = 0;
  for (const track of tl.tracks) {
    // A crossfade on the join goes back to the straight cut at its centre, which is where the cut is.
    straightenCrossfades(track, at, at);
    const ends: Clip[] = [], starts: Clip[] = [];
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (Math.abs(clip.timelineIn - at) <= near) starts.push(clip);
      else if (Math.abs(end - at) <= near) ends.push(clip);
      else if (clip.timelineIn < at && end > at) return;
    }
    if (ends.length > 1 || starts.length > 1) return;
    const left = ends[0], right = starts[0];
    let joined: MediaClip | undefined, dropped: Clip | undefined;
    if (left && right) {
      if (left.kind !== "media" || right.kind !== "media" || left.mediaId !== right.mediaId || left.speed !== right.speed || right.transitionIn) return;
      if (Math.abs((right.sourceIn - left.sourceOut) / left.speed - length) > 1 / fps) return;
      restored++;
      if (look(left) === look(right) && !left.keyframes?.length) {
        joined = { ...left, sourceOut: right.sourceOut, audioFadeOut: right.audioFadeOut, videoFadeOut: right.videoFadeOut };
        dropped = right;
      } else {
        joined = { ...left, sourceOut: right.sourceIn, audioFadeOut: 0, videoFadeOut: 0 };
      }
    }
    track.clips = track.clips.flatMap(clip => {
      if (clip === dropped) return [];
      if (clip === left && joined) return [joined];
      if (clip.timelineIn < at - near) return [clip];
      const moved = shiftClip(clip, length);
      // The clip after the join starts where the footage put back ends, with no fade in: the picture and sound run on.
      return [clip === right && joined && moved.kind === "media" ? { ...moved, timelineIn: clipEnd(joined), audioFadeIn: 0, videoFadeIn: 0 } : moved];
    });
  }
  if (!restored) return;
  for (const m of tl.markers) {
    if (m.end !== undefined && (m.end > at + near || m.time >= at - near)) m.end += length;
    if (m.time >= at - near) m.time += length;
  }
  return tl;
}

/** How far each edge of an applied cut at `at` can move locally without crossing another clip or edit. */
export interface CutAdjustBounds {
  /** Most negative delta allowed on the cut's start edge (trimming left clip shorter), in seconds. */
  minStartDelta: number;
  /** Most positive delta allowed on the cut's start edge (restoring cut footage), in seconds. */
  maxStartDelta: number;
  /** Most negative delta allowed on the cut's end edge (restoring cut footage), in seconds. */
  minEndDelta: number;
  /** Most positive delta allowed on the cut's end edge (trimming right clip shorter), in seconds. */
  maxEndDelta: number;
}

const FADE_MEET = 1e-3;

/** Find a centered audio crossfade overlapping `at` on `track`, before `straightenCrossfades` removes it. */
function findCrossfadeAt(track: Track, at: number): number | undefined {
  const clips = track.clips;
  for (let i = 0; i < clips.length; i++) {
    const left = clips[i]!;
    if (left.timelineIn > at + FADE_MEET) break;
    const leftEnd = clipEnd(left);
    if (left.kind !== "media" || !left.audioFadeOut || leftEnd < at - FADE_MEET) continue;
    for (let j = i + 1; j < clips.length && clips[j]!.timelineIn < leftEnd - FADE_MEET; j++) {
      const right = clips[j]!;
      const overlap = leftEnd - right.timelineIn;
      if (right.kind !== "media" || right.timelineIn <= left.timelineIn + FADE_MEET) continue;
      if (Math.abs(left.audioFadeOut - overlap) > 1e-6 || Math.abs(right.audioFadeIn - overlap) > 1e-6) continue;
      const join = right.timelineIn + overlap / 2;
      if (Math.abs(join - at) <= 0.5 / 24 + FADE_MEET) return overlap;
    }
  }
  return undefined;
}

interface JoinTrackInfo {
  track: Track;
  left?: MediaClip;
  right?: MediaClip;
  fade?: number;
}

/** Inspect a timeline at cut join `at` with removed duration `length`, returning affected tracks or undefined if unsafe. */
function inspectCutJoin(tl: Timeline, at: number, length: number, fps: number): JoinTrackInfo[] | undefined {
  if (!(length > 0)) return;
  const near = 0.5 / fps;
  const duration = timelineDuration(tl);
  const opening = at <= near;
  const closing = duration > near && Math.abs(at - duration) <= near;
  const infos: JoinTrackInfo[] = [];
  let matched = 0;

  for (const track of tl.tracks) {
    const fade = findCrossfadeAt(track, at);
    straightenCrossfades(track, at, at);
    const ends: Clip[] = [], starts: Clip[] = [];
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (Math.abs(clip.timelineIn - at) <= near) starts.push(clip);
      else if (Math.abs(end - at) <= near) ends.push(clip);
      else if (clip.timelineIn < at && end > at) return;
    }
    if (ends.length > 1 || starts.length > 1) return;
    const left = ends[0], right = starts[0];
    if (left && right) {
      if (left.kind !== "media" || right.kind !== "media" || left.mediaId !== right.mediaId || left.speed !== right.speed || right.transitionIn) return;
      if (Math.abs((right.sourceIn - left.sourceOut) / left.speed - length) > 1 / fps) return;
      matched++;
      infos.push({ track, left, right, fade });
    } else if (opening && !left && right) {
      if (right.kind !== "media" || right.transitionIn) return;
      if (right.sourceIn / right.speed < length - 1 / fps) return;
      matched++;
      infos.push({ track, right });
    } else if (closing && left && !right) {
      if (left.kind !== "media") return;
      matched++;
      infos.push({ track, left });
    } else if (left || right) {
      // One track has an unrelated clip ending/starting at `at` with no matching cut pair.
      infos.push({ track });
    } else {
      infos.push({ track });
    }
  }
  return matched > 0 ? infos : undefined;
}

/**
 * Legal local edge-drag bounds for an applied cut at `at` (with removed duration `length`), or undefined when
 * another edit spans the join or the join isn't a clean local cut (same safety contract as `putBackCut`).
 */
export function cutAdjustBounds(head: Timeline, at: number, length: number, fps: number, media?: readonly MediaAsset[]): CutAdjustBounds | undefined {
  const tl = structuredClone(head);
  const infos = inspectCutJoin(tl, at, length, fps);
  if (!infos) return;
  const minClip = 1 / fps;
  const assets = media ? new Map(media.map(a => [a.id, a])) : undefined;
  let minStartDelta = -Infinity, maxStartDelta = Infinity;
  let minEndDelta = -Infinity, maxEndDelta = Infinity;
  let hasLeft = false, hasRight = false;

  for (const { left, right } of infos) {
    if (left) {
      hasLeft = true;
      const dur = clipDuration(left);
      const minKeep = Math.max(minClip, (left.audioFadeIn ?? 0) + (left.audioFadeOut ?? 0) + minClip, (left.videoFadeIn ?? 0) + (left.videoFadeOut ?? 0) + minClip);
      const maxTrimLeft = Math.max(0, dur - minKeep);
      minStartDelta = Math.max(minStartDelta, -maxTrimLeft);
      if (right) {
        maxStartDelta = Math.min(maxStartDelta, length);
      } else {
        const assetDur = assets?.get(left.mediaId)?.duration;
        const avail = assetDur !== undefined ? Math.max(0, (assetDur - left.sourceOut) / left.speed) : length;
        maxStartDelta = Math.min(maxStartDelta, Math.min(length, avail));
      }
    }
    if (right) {
      hasRight = true;
      const dur = clipDuration(right);
      const minKeep = Math.max(minClip, (right.audioFadeIn ?? 0) + (right.audioFadeOut ?? 0) + minClip, (right.videoFadeIn ?? 0) + (right.videoFadeOut ?? 0) + minClip);
      const maxTrimRight = Math.max(0, dur - minKeep);
      maxEndDelta = Math.min(maxEndDelta, maxTrimRight);
      if (left) {
        minEndDelta = Math.max(minEndDelta, -length);
      } else {
        minEndDelta = Math.max(minEndDelta, -Math.min(length, right.sourceIn / right.speed));
      }
    }
  }
  if (!hasLeft) { minStartDelta = 0; maxStartDelta = 0; }
  if (!hasRight) { minEndDelta = 0; maxEndDelta = 0; }
  if (minStartDelta > maxStartDelta + 1e-6 || minEndDelta > maxEndDelta + 1e-6) return;
  return {
    minStartDelta: Math.min(0, minStartDelta),
    maxStartDelta: Math.max(0, maxStartDelta),
    minEndDelta: Math.min(0, minEndDelta),
    maxEndDelta: Math.max(0, maxEndDelta),
  };
}

/**
 * Adjust an applied cut's left and/or right edge directly on the timeline, without invoking a model.
 * `deltaStart > 0` restores footage onto the end of the clip before the join; `deltaStart < 0` trims more off it.
 * `deltaEnd < 0` restores footage onto the start of the clip after the join; `deltaEnd > 0` trims more off it.
 * Pulling both edges together (remaining cut <= half a frame) puts back the whole cut, matching `putBackCut`.
 */
export function adjustCut(head: Timeline, at: number, length: number, deltaStart: number, deltaEnd: number, fps: number, media?: readonly MediaAsset[]): Timeline | undefined {
  const newLength = length + deltaEnd - deltaStart;
  const near = 0.5 / fps;
  if (newLength <= near) {
    // Pulled all the way to zero: restore full footage for interior, opening, or closing cuts.
    const interior = putBackCut(head, at, length, fps);
    if (interior) return interior;
  }
  const bounds = cutAdjustBounds(head, at, length, fps, media);
  if (!bounds) return;
  const eps = 1e-4;
  if (deltaStart < bounds.minStartDelta - eps || deltaStart > bounds.maxStartDelta + eps) return;
  if (deltaEnd < bounds.minEndDelta - eps || deltaEnd > bounds.maxEndDelta + eps) return;

  const tl = structuredClone(head);
  const infos = inspectCutJoin(tl, at, length, fps);
  if (!infos) return;
  const shift = deltaStart - deltaEnd;
  const newJoin = Math.max(0, at + deltaStart);
  const fadesToReplay: JoinFade[] = [];

  for (const { track, left, right, fade } of infos) {
    let nextLeft: MediaClip | undefined;
    let nextRight: MediaClip | undefined;
    if (left) {
      const nextSourceOut = left.sourceOut + deltaStart * left.speed;
      if (nextSourceOut <= left.sourceIn + 1e-6) return;
      nextLeft = { ...left, sourceOut: nextSourceOut };
    }
    if (right) {
      const nextSourceIn = right.sourceIn + deltaEnd * right.speed;
      if (nextSourceIn < -1e-6 || nextSourceIn >= right.sourceOut - 1e-6) return;
      const keyShift = -deltaEnd;
      nextRight = {
        ...right,
        timelineIn: nextLeft ? clipEnd(nextLeft) : Math.max(0, right.timelineIn + deltaStart),
        sourceIn: Math.max(0, nextSourceIn),
        ...(right.keyframes?.length && {
          keyframes: right.keyframes.map(k => ({ ...k, time: k.time + keyShift })),
        }),
        ...(right.volumeKeyframes?.length && {
          volumeKeyframes: right.volumeKeyframes.map(k => ({ ...k, time: k.time + keyShift })),
        }),
      };
    }
    if (left && right && fade && newLength > near) {
      fadesToReplay.push({ at: newJoin, trackId: track.id, duration: fade });
    }
    track.clips = track.clips.map(clip => {
      if (clip === left && nextLeft) return nextLeft;
      if (clip === right && nextRight) return nextRight;
      if (clip.timelineIn < at - near) return clip;
      return shiftClip(clip, shift);
    });
  }

  for (const m of tl.markers) {
    if (m.end !== undefined) {
      if (m.end >= at - near) m.end = Math.max(newJoin, m.end + shift);
      else if (deltaStart < 0 && m.end > newJoin) m.end = newJoin;
    }
    if (m.time >= at - near) m.time = Math.max(newJoin, m.time + shift);
    else if (deltaStart < 0 && m.time > newJoin) m.time = newJoin;
  }

  if (fadesToReplay.length) {
    return crossfadeJoins(tl, media ? [...media] : undefined, [], fadesToReplay[0]!.duration!, { only: fadesToReplay }).timeline;
  }
  return tl;
}

const TIMING = new Set(["sourceIn", "sourceOut", "timelineIn", "timelineOut", "speed", "id", "kind", "mediaId"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Clip fields whose items are timed from the clip's start. */
const KEYED = new Set(["keyframes", "volumeKeyframes"]);

/**
 * The timeline with one edit's look taken off again: an edit of a change that only set how clips look or sound (a
 * punch-in's framing, a level), and moved nothing in time. `before` and `after` are the versions the change was made on
 * and made; `range` is the edit's stretch on `after`. Each clip the change touched there goes back to how it was before,
 * wherever its footage is in the video now, a property at a time, and only where it still is as the change left it: what
 * a later edit set since stays.
 *
 * It answers nothing where the change did more than that, where it also set clips outside the edits it named (`named`:
 * a pass of punch-ins that framed every other shot to match, where "as it was before" would leave this stretch framed
 * unlike its neighbours), where the footage has since joined other footage in one clip, or where nothing of the edit
 * is left to take off, so the caller can ask Scarlet instead.
 */
export function putBackLooks(head: Timeline, before: Timeline, after: Timeline, ops: ReadonlyArray<Record<string, unknown>>, range: TimeRange,
  named: readonly TimeRange[], fps: number): Timeline | undefined {
  const patched = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.op !== "updateClip" || typeof op.clipId !== "string" || !op.patch || typeof op.patch !== "object") return;
    const keys = Object.keys(op.patch);
    if (keys.some(key => TIMING.has(key))) return;
    const had = patched.get(op.clipId) ?? new Set<string>();
    for (const key of keys) had.add(key);
    patched.set(op.clipId, had);
  }
  const was = new Map(before.tracks.flatMap(track => track.clips.map(clip => [clip.id, clip] as const)));
  const tl = structuredClone(head);
  const near = 1 / fps;
  let undone = 0;
  for (const track of after.tracks) for (const made of track.clips) {
    const keys = patched.get(made.id);
    if (!keys) continue;
    // A clip belongs to the edit its middle plays in: one clip is never part of two edits.
    const middle = (made.timelineIn + clipEnd(made)) / 2;
    if (!named.some(r => middle >= r.start && middle <= r.end)) return;
    if (made.kind !== "media" || middle < range.start || middle > range.end) continue;
    const old = was.get(made.id);
    if (!old || old.kind !== "media") return;
    const now = tl.tracks.find(t => t.id === track.id);
    for (const clip of now?.clips ?? []) {
      if (clip.kind !== "media" || clip.mediaId !== made.mediaId || clip.sourceOut <= made.sourceIn + near * made.speed || clip.sourceIn >= made.sourceOut - near * made.speed) continue;
      // Footage that has since joined footage from outside the edit in one clip can't take the look back alone.
      if (clip.sourceIn < made.sourceIn - near * made.speed || clip.sourceOut > made.sourceOut + near * made.speed) return;
      const open = clip as unknown as Record<string, unknown>, set = made as unknown as Record<string, unknown>, prior = old as unknown as Record<string, unknown>;
      // Keyframes are timed from a clip's start, so a piece of the clip a later cut split off times the same keys
      // differently: they are compared, and put back, on the recording's clock.
      const value = (key: string, of: MediaClip, at: Record<string, unknown>) => KEYED.has(key) && Array.isArray(at[key])
        ? (at[key] as { time: number }[]).map(k => ({ ...k, time: Math.round((of.sourceIn + k.time * of.speed) * 1e6) / 1e6 })) : at[key];
      for (const key of keys) {
        if (!same(value(key, clip, open), value(key, made, set)) || same(value(key, clip, open), value(key, old, prior))) continue;
        if (prior[key] === undefined) delete open[key];
        else open[key] = KEYED.has(key) && Array.isArray(prior[key])
          ? (prior[key] as { time: number }[]).map(k => ({ ...k, time: (old.sourceIn + k.time * old.speed - clip.sourceIn) / clip.speed }))
          : structuredClone(prior[key]);
        undone++;
      }
    }
  }
  return undone ? tl : undefined;
}

/**
 * The timeline with the markers one edit left taken off again: a to-do the change marked for the editor, which changed
 * nothing in the video there. `before` and `after` are the versions the change was made on and made; `range` is the
 * edit's stretch on `after`. Each marker the change added there comes off by its id, wherever later edits moved it.
 *
 * It answers nothing where the change added no marker there, or none of them is on the timeline any more, so the caller
 * can ask Scarlet instead.
 */
export function putBackMarkers(head: Timeline, before: Timeline, after: Timeline, range: TimeRange, fps: number): Timeline | undefined {
  const had = new Set(before.markers.map(m => m.id));
  const near = 1 / fps;
  const added = new Set(after.markers.filter(m => !had.has(m.id) && m.time >= range.start - near && m.time <= range.end + near).map(m => m.id));
  if (!head.markers.some(m => added.has(m.id))) return;
  return { ...head, markers: head.markers.filter(m => !added.has(m.id)) };
}
