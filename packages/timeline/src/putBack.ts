import type { Clip, MediaClip, Timeline, TimeRange } from "./schema.js";
import { shiftClip, straightenCrossfades } from "./ops.js";
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
