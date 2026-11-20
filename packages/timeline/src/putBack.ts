import type { Clip, MediaClip, Timeline, TimeRange } from "./schema.js";
import { crossfadeOverlap, shiftClip, straightenCrossfades } from "./ops.js";
import { clipEnd } from "./time.js";

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

const TIMING = new Set(["sourceIn", "sourceOut", "timelineIn", "timelineOut", "speed", "id", "kind", "mediaId"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Consecutive split pieces of one clip play forward through the recording. A centered audio crossfade overlaps the two
 * pieces' ends by its fade length so the sound blends across the join, which lets the second piece start that much
 * earlier in the recording than the first one ends.
 */
function isMonotonicSource(clips: readonly MediaClip[], eps: number): boolean {
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1]!, curr = clips[i]!;
    const overlap = crossfadeOverlap(prev, curr);
    const allowedOverlap = overlap ? (overlap / 2) * (prev.speed + curr.speed) : 0;
    if (curr.sourceIn < prev.sourceOut - allowedOverlap - eps || curr.sourceOut <= prev.sourceOut + eps) return false;
  }
  return true;
}

/**
 * Find the clip or split pieces on `nowClips` that came from this one use of the footage (`afterClips[madeIdx]`),
 * leaving other uses of the same recording alone. It answers nothing where the clip has joined outside footage or
 * where surviving neighbours no longer tell repeated uses apart.
 */
function resolveOccurrence(
  made: MediaClip,
  madeIdx: number,
  afterClips: readonly Clip[],
  nowClips: readonly Clip[],
  nowIndex: ReadonlyMap<string, number>,
  allAfterIds: ReadonlySet<string>,
  eps: number,
): MediaClip[] | undefined {
  const overlapsMade = (c: Clip): c is MediaClip =>
    c.kind === "media" && c.mediaId === made.mediaId && c.sourceOut > made.sourceIn + eps && c.sourceIn < made.sourceOut - eps;
  const withinMade = (c: MediaClip) =>
    c.sourceIn >= made.sourceIn - eps && c.sourceOut <= made.sourceOut + eps;

  const neighbour = (step: -1 | 1, accept: (idx: number) => boolean): { afterIdx: number; nowIdx: number } => {
    for (let j = madeIdx + step; j >= 0 && j < afterClips.length; j += step) {
      const idx = nowIndex.get(afterClips[j]!.id);
      if (idx !== undefined && accept(idx)) return { afterIdx: j, nowIdx: idx };
    }
    return step < 0 ? { afterIdx: -1, nowIdx: -1 } : { afterIdx: afterClips.length, nowIdx: nowClips.length };
  };
  const freshBetween = (lo: number, hi: number, requireWithin: boolean): MediaClip[] | undefined => {
    const found: MediaClip[] = [];
    for (let i = lo + 1; i < hi; i++) {
      const c = nowClips[i]!;
      if (allAfterIds.has(c.id) || !overlapsMade(c)) continue;
      if (requireWithin && !withinMade(c)) return;
      found.push(c);
    }
    return found;
  };
  const afterOverlaps = (lo: number, hi: number): boolean => {
    for (let j = lo + 1; j < hi; j++) {
      if (j !== madeIdx && overlapsMade(afterClips[j]!)) return true;
    }
    return false;
  };

  let chain: MediaClip[];
  const anchorIdx = nowIndex.get(made.id);
  if (anchorIdx !== undefined) {
    const anchor = nowClips[anchorIdx]!;
    if (!overlapsMade(anchor) || !withinMade(anchor)) return;
    if (anchor.sourceIn <= made.sourceIn + eps && anchor.sourceOut >= made.sourceOut - eps) return [anchor];
    if (anchor.sourceIn > made.sourceIn + eps) {
      const left = neighbour(-1, idx => idx < anchorIdx);
      if (freshBetween(left.nowIdx, anchorIdx, false)!.length) return;
    }
    if (anchor.sourceOut >= made.sourceOut - eps) return [anchor];
    const right = neighbour(1, idx => idx > anchorIdx);
    const fresh = freshBetween(anchorIdx, right.nowIdx, true);
    if (!fresh) return;
    if (!fresh.length) return [anchor];
    if (afterOverlaps(madeIdx, right.afterIdx)) return;
    chain = [anchor, ...fresh];
  } else {
    const left = neighbour(-1, () => true);
    const right = neighbour(1, () => true);
    if (left.nowIdx >= right.nowIdx) return;
    const fresh = freshBetween(left.nowIdx, right.nowIdx, true);
    if (!fresh) return;
    if (!fresh.length) return [];
    if (afterOverlaps(left.afterIdx, right.afterIdx)) return;
    chain = fresh;
  }
  if (!isMonotonicSource(chain, eps)) return;
  return chain;
}

/**
 * The timeline with one edit's look taken off again: an edit of a change that only set how clips look or sound (a
 * punch-in's framing, a level), and moved nothing in time. `before` and `after` are the versions the change was made on
 * and made; `range` is the edit's stretch on `after`. Each clip the change touched there goes back to how it was before,
 * following only that occurrence of the footage (including any pieces a later split made of it), a property at a time,
 * and only where it still is as the change left it: what a later edit set since stays.
 *
 * It answers nothing where the change did more than that, where it also set clips outside the edits it named (`named`:
 * a pass of punch-ins that framed every other shot to match, where "as it was before" would leave this stretch framed
 * unlike its neighbours), where the clip moved to another track, where the footage has since joined other footage in one
 * clip, where repeated uses of the same footage can't be told apart, or where nothing of the edit is left to take off,
 * so the caller can ask Scarlet instead.
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
  const allAfterIds = new Set(after.tracks.flatMap(t => t.clips.map(c => c.id)));
  const tl = structuredClone(head);
  const headClipTrack = new Map(tl.tracks.flatMap(t => t.clips.map(c => [c.id, t.id] as const)));
  const near = 1 / fps;
  let undone = 0;
  for (const track of after.tracks) {
    const afterClips = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    const now = tl.tracks.find(t => t.id === track.id);
    const nowClips = [...(now?.clips ?? [])].sort((a, b) => a.timelineIn - b.timelineIn);
    const nowIndex = new Map(nowClips.map((c, i) => [c.id, i] as const));
    for (let madeIdx = 0; madeIdx < afterClips.length; madeIdx++) {
      const made = afterClips[madeIdx]!;
      const keys = patched.get(made.id);
      if (!keys) continue;
      // A clip belongs to the edit its middle plays in: one clip is never part of two edits.
      const middle = (made.timelineIn + clipEnd(made)) / 2;
      if (!named.some(r => middle >= r.start && middle <= r.end)) return;
      if (made.kind !== "media" || middle < range.start || middle > range.end) continue;
      const old = was.get(made.id);
      if (!old || old.kind !== "media") return;
      const set = made as unknown as Record<string, unknown>, prior = old as unknown as Record<string, unknown>;
      const movedTo = headClipTrack.get(made.id);
      if (movedTo !== undefined && movedTo !== track.id) return;
      const targets = resolveOccurrence(made, madeIdx, afterClips, nowClips, nowIndex, allAfterIds, near * made.speed);
      if (!targets) return;
      for (const clip of targets) {
        const open = clip as unknown as Record<string, unknown>;
        for (const key of keys) {
          if (!same(open[key], set[key]) || same(open[key], prior[key])) continue;
          if (prior[key] === undefined) delete open[key]; else open[key] = structuredClone(prior[key]);
          undone++;
        }
      }
    }
  }
  return undone ? tl : undefined;
}
