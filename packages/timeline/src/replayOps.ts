/** Op rebasing and footage/overlap invariants across timeline versions. */
import { CaptionWord } from "./timelineSchema.js";
import type { TimeRange } from "./schemaBase.js";
import type { Clip, Marker, MediaClip, Timeline, Track } from "./timelineSchema.js";
import { applyOp, applyOpInPlace, shiftClip, type TimelineOp } from "./ops.js";
import { clipEnd, findClip, sourceAt, sourceToTimeline, subtractRanges } from "./time.js";
import { indexBySource, intervalCandidates } from "./intervals.js";
import { sameJson, stableStringify } from "./ids.js";
import { makeTimeMap, REBASE_EPS, sameFrame, sameTracks, sourceTimeMap, type TimeMap } from "./timeMap.js";

export class RebaseConflict extends Error {
  constructor(
    message: string,
    public readonly opIndex?: number,
    public readonly at?: number,
  ) {
    super(message);
    this.name = "RebaseConflict";
  }
}

/** Re-express one op, written against `from`, for timeline `onto`, using `map` (from → onto). */
export function rebaseOp(op: TimelineOp, map: TimeMap, onto: Timeline, index = 0, fps = 30, from?: Timeline): TimelineOp {
  const need = (t: number, side?: "left" | "right") => {
    const m = map(t, side);
    if (m === null) throw new RebaseConflict(`the moment at ${t.toFixed(2)} s was cut in the current version`, index, t);
    return m;
  };
  const needClip = (id: string) => {
    if (!findClip(onto, id)) throw new RebaseConflict(`clip ${id} no longer exists in the current version`, index);
  };
  // A zero-length range moves with its start, including at an inserted gap.
  const markerEndSide = (end: number, start?: number) => end === start ? "right" : "left";
  const placeClip = (clip: Clip) => {
    const shift = need(clip.timelineIn, "right") - clip.timelineIn;
    const end = clipEnd(clip);
    if (end > clip.timelineIn && !sameFrame(need(end, "left"), end + shift, fps)) {
      throw new RebaseConflict(`the footage under clip ${clip.id} changed since`, index, clip.timelineIn);
    }
    return shiftClip(clip, shift);
  };
  switch (op.op) {
    case "rippleDelete": {
      const start = need(op.start, "right");
      const end = need(op.end, "left");
      if (Math.abs(end - start - (op.end - op.start)) > 1 / fps + 0.01) {
        throw new RebaseConflict(`the part at ${op.start.toFixed(2)}–${op.end.toFixed(2)} s was edited since`, index, op.start);
      }
      return { ...op, start, end };
    }
    case "rippleInsertGap":
      return { ...op, at: need(op.at) };
    case "splitClip":
      needClip(op.clipId);
      return { ...op, at: need(op.at) };
    case "moveClip":
      needClip(op.clipId);
      return { ...op, timelineIn: need(op.timelineIn, "right") };
    case "addClip": {
      if (findClip(onto, op.clip.id)) throw new RebaseConflict(`clip ${op.clip.id} already exists`, index);
      return { ...op, clip: placeClip(op.clip) };
    }
    case "updateClip": {
      needClip(op.clipId);
      const patch = { ...op.patch };
      if (typeof patch.timelineIn === "number") patch.timelineIn = need(patch.timelineIn, "right");
      if (typeof patch.timelineOut === "number") patch.timelineOut = need(patch.timelineOut, "left");
      // Caption word timings are timeline seconds too, so they move with the footage under them.
      if (Array.isArray(patch.words)) {
        patch.words = CaptionWord.array().parse(patch.words).map((w) =>
          ({ ...w, start: need(w.start, "right"), end: need(w.end, markerEndSide(w.end, w.start)) }));
      }
      return { ...op, patch };
    }
    case "removeClip":
      needClip(op.clipId);
      return op;
    case "addMarker": {
      const time = need(op.marker.time, "right");
      const end = op.marker.end !== undefined ? need(op.marker.end, markerEndSide(op.marker.end, op.marker.time)) : undefined;
      return { ...op, marker: { ...op.marker, time, ...(end !== undefined ? { end } : {}) } };
    }
    case "removeMarker":
    case "updateMarker": {
      const current = onto.markers.find(m => m.id === op.markerId);
      if (!current) throw new RebaseConflict(`marker ${op.markerId} no longer exists`, index);
      const original = from?.markers.find(m => m.id === op.markerId);
      if (original) {
        const keys = new Set(Object.keys(op.op === "removeMarker" ? { ...original, ...current } : op.patch) as Array<keyof Marker>);
        if (keys.has("time") || keys.has("end")) { keys.add("time"); keys.add("end"); }
        for (const key of keys) {
          const before = original[key], now = current[key];
          if (before === now) continue;
          if ((key === "time" || key === "end") && typeof before === "number" && typeof now === "number") {
            const moved = map(before, key === "time" ? "right" : markerEndSide(before, original.time));
            if (moved !== null && sameFrame(moved, now, fps)) continue;
          }
          throw new RebaseConflict(`marker ${op.markerId} changed since (${key})`, index);
        }
      }
      if (op.op === "removeMarker") return op;
      const patch = { ...op.patch };
      if (typeof patch.end === "number") patch.end = need(patch.end, markerEndSide(patch.end, patch.time ?? original?.time));
      if (typeof patch.time === "number") patch.time = need(patch.time, "right");
      return { ...op, patch };
    }
    case "addTrack":
      if (onto.tracks.some((t) => t.id === op.track.id)) throw new RebaseConflict(`track ${op.track.id} already exists`, index);
      return { ...op, track: { ...op.track, clips: op.track.clips.map(placeClip) } };
    case "removeTrack":
    case "updateTrack":
      if (!onto.tracks.some((t) => t.id === op.trackId)) throw new RebaseConflict(`track ${op.trackId} no longer exists`, index);
      return op;
    case "setTimeline":
      return op;
  }
}

const FOOTAGE_KEYS = ["mediaId", "sourceIn", "sourceOut", "speed"] as const;

/** A trim, a speed change or another recording: an edit that sets the footage of a clip. */
function isFootagePatch(op: TimelineOp): op is Extract<TimelineOp, { op: "updateClip" }> {
  return op.op === "updateClip" && FOOTAGE_KEYS.some(key => op.patch[key] !== undefined);
}

/** An edit that can make the timeline play footage it didn't: a new clip or track, a trim, or a clip turned back on. */
function addsFootage(op: TimelineOp): boolean {
  if (op.op === "addClip") return op.clip.kind === "media";
  if (op.op === "addTrack") return op.track.clips.some(c => c.kind === "media");
  return op.op === "updateClip" && (op.patch.enabled === true || isFootagePatch(op));
}

/** Pictures and sound are cut apart: a cut of the picture alone leaves the sound playing what it cut. */
const playsAs = (track: Track) => track.kind === "audio" ? "sound" : "picture";

/**
 * Each recording's source ranges that `before` plays on some enabled clip of a picture (or sound) track and `after`
 * plays on none of that kind, keyed by kind and recording.
 */
function footageCut(before: Timeline, after: Timeline): Map<string, TimeRange[]> {
  const played = (tl: Timeline) => {
    const ranges = new Map<string, TimeRange[]>();
    for (const track of tl.tracks) for (const c of track.clips) {
      if (c.kind !== "media" || c.enabled === false) continue;
      const key = `${playsAs(track)}|${c.mediaId}`;
      const range = { start: c.sourceIn, end: c.sourceOut };
      const group = ranges.get(key);
      if (group) group.push(range);
      else ranges.set(key, [range]);
    }
    return ranges;
  };
  const kept = played(after);
  return new Map([...played(before)].map(([key, ranges]) => [key, subtractRanges(ranges, kept.get(key) ?? [])]));
}

/**
 * The clips the edits that went in made or changed must play none of the footage the current version cut since for
 * more than half a frame, on the kind of track it was cut from. Clips the current version already had play none of
 * it there, so checking every clip is the same.
 */
function assertCutFootageStaysOut(base: Timeline, onto: Timeline, cur: Timeline, fps: number, opIndex: number) {
  const cut = new Map([...footageCut(base, onto)].map(([key, ranges]) =>
    [key, intervalCandidates(ranges, r => r.start, r => r.end)]));
  for (const track of cur.tracks) for (const clip of track.clips) {
    if (clip.kind !== "media" || clip.enabled === false) continue;
    const played = (r: TimeRange) => (Math.min(r.end, clip.sourceOut) - Math.max(r.start, clip.sourceIn)) / (clip.speed ?? 1);
    if (cut.get(`${playsAs(track)}|${clip.mediaId}`)?.(clip.sourceIn, clip.sourceOut).some(r => played(r) > 0.5 / fps)) {
      throw new RebaseConflict(`the footage under clip ${clip.id} changed since`, opIndex, clip.timelineIn);
    }
  }
}

/** Every two enabled clips of a track that play over each other, with how long they do, the later-starting one second. */
function overlappingPairs(track: Track): Array<{ seconds: number; clips: [Clip, Clip] }> {
  const pairs = new Map<string, { seconds: number; clips: [Clip, Clip] }>();
  const clips = track.clips.filter(c => c.enabled !== false);
  const near = intervalCandidates(clips, c => c.timelineIn, clipEnd);
  for (const a of clips) for (const b of near(a.timelineIn, clipEnd(a))) {
    const seconds = Math.min(clipEnd(a), clipEnd(b)) - Math.max(a.timelineIn, b.timelineIn);
    if (b === a || seconds <= 0) continue;
    // Each two are found from both of them.
    pairs.set(JSON.stringify([a.id, b.id].sort()), { seconds, clips: b.timelineIn > a.timelineIn ? [a, b] : [b, a] });
  }
  return [...pairs.values()];
}

/** Index the enabled clips by recording for repeated footage matches on one track. */
function indexClipsPlaying(track: Track | undefined, fps: number) {
  const clips = track?.clips.filter(c => c.enabled !== false) ?? [];
  const near = indexBySource(clips.filter((c): c is MediaClip => c.kind === "media"), c => c);
  return (clip: Clip, from: number, to: number): Clip[] => {
    if (clip.kind !== "media") return clips.filter(c => c.id === clip.id && c.kind === clip.kind);
    const speed = clip.speed ?? 1;
    const slack = 0.5 / fps * speed;
    const start = sourceAt(clip, from) + slack;
    const end = sourceAt(clip, to) - slack;
    return (near.get(clip.mediaId)?.(Math.min(start, end), Math.max(start, end)) ?? []).filter(c =>
      (c.speed ?? 1) === speed && c.sourceIn <= start && c.sourceOut >= end);
  };
}

/** When `match` plays what `clip` plays at `t`. */
function placed(clip: Clip, match: Clip, t: number): number {
  return clip.kind === "media" && match.kind === "media" ? sourceToTimeline(match, sourceAt(clip, t)) : match.timelineIn + t - clip.timelineIn;
}

function sameFootage(before: Clip | undefined, now: Clip | undefined, map: () => TimeMap, fps: number): boolean {
  if (before?.kind !== "media" || now?.kind !== "media") return false;
  if (now.mediaId !== before.mediaId || now.speed !== before.speed) return false;
  if (Math.abs(now.sourceIn - before.sourceIn) > REBASE_EPS || Math.abs(now.sourceOut - before.sourceOut) > REBASE_EPS) return false;
  // The map follows the first layer at that time, which can be another track's clip.
  if (sameFrame(before.timelineIn, now.timelineIn, fps)) return true;
  const placedAt = map()(before.timelineIn, "right");
  return placedAt != null && sameFrame(placedAt, now.timelineIn, fps);
}

/** A footage patch's clip must hold the same footage on the version it was written for as on the current one. */
function assertFootageUnchanged(clipId: string, from: Timeline, cur: Timeline, fps: number, opIndex: number) {
  const before = findClip(from, clipId);
  const now = findClip(cur, clipId);
  if ((before?.kind === "media" || now?.kind === "media") && !sameFootage(before, now, () => makeTimeMap(from, cur, fps), fps)) {
    throw new RebaseConflict(`the footage under clip ${clipId} changed since`, opIndex, before?.timelineIn);
  }
}

/**
 * Replay `ops` (written in sequence against `base`) onto `onto`, translating
 * every time through the footage. `include(i)` skips ops; later ops are still
 * translated correctly because each op is mapped from "where the original
 * sequence was" to "where we actually are".
 */
export function replayOps(base: Timeline, ops: TimelineOp[], onto: Timeline, include: (i: number) => boolean = () => true, fps = 30, translatedOps?: TimelineOp[]): Timeline {
  // Each lineage below (the original sequence, the replay and the replay on `base`) is copied once, on its first op,
  // and then changed in place: a copy and two serializations per op made 300 cuts on an hour-long cut take seconds.
  // `base` and `onto` are never changed, and a lineage no op went into is still the caller's object.
  const owned = new WeakSet<Timeline>();
  const step = (tl: Timeline, op: TimelineOp) => {
    const draft = applyOpInPlace(owned.has(tl) ? tl : structuredClone(tl), op);
    owned.add(draft);
    return draft;
  };
  let orig = base;
  let cur = onto;
  // The last included footage patch, and the included ops replayed onto `base` too, kept only to check them.
  const lastFootagePatch = onto === base ? -1 : ops.findLastIndex((op, i) => isFootagePatch(op) && include(i));
  // The last included edit that can bring footage back, which footage cut since must not.
  const lastAddition = onto === base ? -1 : ops.findLastIndex((op, i) => addsFootage(op) && include(i));
  let selectedOnBase = lastFootagePatch >= 0 ? base : undefined;
  // Marker and canvas edits leave both footage clocks intact across successive operations.
  type Mapping = { tracksSame: boolean; time?: TimeMap };
  let workingMap: Mapping | undefined;
  // Map `op` from where the original sequence was to `at`, and apply it there.
  const replay = (at: Timeline, op: TimelineOp, i: number, reuse = false): [Timeline, TimelineOp] => {
    // makeTimeMap would compare both track lists again to decide the same thing.
    const mapping: Mapping = (reuse && workingMap) || { tracksSame: sameTracks(orig, at) };
    if (reuse) workingMap = mapping;
    const same = mapping.tracksSame && sameJson(orig.markers, at.markers);
    let translated = op;
    if (!same) {
      mapping.time ??= mapping.tracksSame ? (t => t) : sourceTimeMap(orig, at, fps);
      translated = rebaseOp(op, mapping.time, at, i, fps, orig);
    }
    // A translated op can hold parts of `at`, which the next op changes in place.
    if (translated !== op) translated = structuredClone(translated);
    try {
      return [step(at, translated), translated];
    } catch (e) {
      throw new RebaseConflict(`edit ${i + 1} no longer applies: ${(e as Error).message}`, i);
    }
  };
  ops.forEach((op, i) => {
    if (include(i)) {
      let translated: TimelineOp;
      try {
        // A footage patch is written for the footage the clip held. The clip is compared as the edits that go in
        // left it on the version the change was made on and on the current one, since those edits can split or make it.
        if (selectedOnBase && isFootagePatch(op)) assertFootageUnchanged(op.clipId, selectedOnBase, cur, fps, i);
        [cur, translated] = replay(cur, op, i, true);
        // While every edit so far went in, the replay on `base` is the original sequence, and follows it below.
        if (selectedOnBase && selectedOnBase !== orig) selectedOnBase = replay(selectedOnBase, op, i)[0];
      } catch (e) {
        // An op that doesn't apply where it was written fails as itself, before anything is replayed.
        applyOp(orig, op);
        throw e;
      }
      const following = selectedOnBase === orig;
      orig = step(orig, op);
      if (following) selectedOnBase = orig;
      translatedOps?.push(translated);
    } else {
      // Left out, the original sequence goes on without the replay on `base`, which keeps the version it had.
      orig = selectedOnBase === orig ? applyOp(orig, op) : step(orig, op);
      owned.add(orig);
    }
    if (op.op !== "addMarker" && op.op !== "updateMarker" && op.op !== "removeMarker" && op.op !== "setTimeline") workingMap = undefined;
  });
  if (lastAddition >= 0) assertCutFootageStaysOut(base, onto, cur, fps, lastAddition);
  if (selectedOnBase) assertOverlapsAllowed(selectedOnBase, onto, cur, fps, lastFootagePatch);
  return cur;
}

/**
 * Each overlap the replay leaves must already pair the same footage on its track in the included base replay or in
 * `onto`. Any two distinct matches can prove it, regardless of IDs. At both endpoints, their mapped times must agree
 * within half a frame and lie within both matches' spans; the pair can have moved on the timeline. Refusal names the
 * changed clip if the other is unchanged on `onto`; otherwise it names the later-starting one.
 */
function assertOverlapsAllowed(selectedOnBase: Timeline, onto: Timeline, cur: Timeline, fps: number, opIndex: number) {
  const asItIs = (clip: Clip) => stableStringify(findClip(onto, clip.id) ?? null) === stableStringify(clip);
  const half = 0.5 / fps;
  const plays = (clip: Clip, t: number) => clip.timelineIn - half <= t && t <= clipEnd(clip) + half;
  for (const track of cur.tracks) {
    const pairs = overlappingPairs(track);
    if (!pairs.some(({ seconds }) => seconds > half)) continue;
    const allowedTracks = [selectedOnBase, onto].map(tl =>
      indexClipsPlaying(tl.tracks.find(t => t.id === track.id), fps));
    for (const { seconds, clips: [earlier, later] } of pairs) {
      if (seconds <= half) continue;
      const [from, to] = [later.timelineIn, Math.min(clipEnd(earlier), clipEnd(later))];
      const allowed = allowedTracks.some(matches => {
        const bs = matches(later, from, to);
        return matches(earlier, from, to).some(a => bs.some(b => a !== b && [from, to].every(t => {
          const [ta, tb] = [placed(earlier, a, t), placed(later, b, t)];
          return Math.abs(ta - tb) <= half && plays(a, ta) && plays(b, tb);
        })));
      });
      if (allowed) continue;
      const clip = asItIs(later) && !asItIs(earlier) ? earlier : later;
      throw new RebaseConflict(`the footage under clip ${clip.id} changed since`, opIndex, clip.timelineIn);
    }
  }
}
