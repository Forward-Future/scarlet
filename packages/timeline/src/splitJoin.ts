import { detachedAudioClip, makeTrack } from "./builders.js";
import { applyOps, type ProposedOp, type TimelineOp } from "./ops.js";
import type { TimeRange } from "./schemaBase.js";
import type { MediaAsset } from "./mediaSchema.js";
import type { MediaClip, Timeline, Track } from "./timelineSchema.js";
import { clipEnd, sourceAt, uniqueId } from "./time.js";
import { plays, type Placed } from "./audible.js";

/**
 * Split edits: a join whose sound cuts at another moment than its picture. With a J cut the next shot's sound starts
 * a little before its picture does; with an L cut a shot's sound carries on a little after the picture has changed.
 *
 * The sound of each side plays from an audio track apart from its picture, as an audio crossfade or a picture sync
 * already puts it: a picture clip that played its own sound hands a copy of it to the dialogue track below its track
 * and goes silent, and the two sounds meet at the new moment. The picture, the runtime and every other join stay as
 * they were, and render, playback and export need nothing new: they play what is on the tracks. The moved sound
 * carries `splitEdit`, which only says what the edit did.
 *
 * Code keeps it safe and nothing else: a sound can't reach past what was recorded, or shrink to nothing, or overlap
 * other sound on its track. Whether a new sound edge cuts a word while it sounds is measured by the caller, which has
 * the recordings (`timeline_propose`, which measures every new sound edge). How far, and at which joins, is the
 * model's call from the editor's skill.
 */

const EPS = 1e-6;
/** Two clip edges this close meet: rounding in stored times, far under a frame. */
const MEET = 1e-3;

export interface SplitJoinTarget {
  /** The picture clip the join leads into. */
  clipId?: string;
  /** The picture clip the join leads out of, checked against the one that meets `clipId`. */
  leftClipId?: string;
  /** Or the join's time on the picture track, timeline seconds. */
  at?: number;
  /** The video track to look on with `at`; the bottom one by default. */
  trackId?: string;
}

/** What one join got. */
export interface SplitJoinPlaced {
  /** The picture cut, timeline seconds. */
  at: number;
  trackId: string;
  leftClipId: string;
  rightClipId: string;
  /** Where the sound cut before, and where it cuts now, as seconds from the picture cut: negative before it. */
  was: number;
  shift: number;
  /** The sound clips that meet at the new moment, after the change, with the source second each now ends or starts on. */
  left: { clipId: string; mediaId: string; trackId: string; sourceOut: number };
  right: { clipId: string; mediaId: string; trackId: string; sourceIn: number };
}

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60), s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

/** The two picture clips that meet at a join, from the clip it leads into or its time on a video track. */
function pictureJoin(timeline: Timeline, target: SplitJoinTarget, fps: number): { left: Placed; right: Placed } {
  let right: Placed | undefined;
  if (target.clipId) {
    for (const track of timeline.tracks) {
      const clip = track.clips.find(c => c.id === target.clipId);
      if (!clip) continue;
      if (track.kind !== "video" || clip.kind !== "media") throw new Error(`Clip ${target.clipId} is not footage on a video track.`);
      right = { clip, track };
    }
    if (!right) throw new Error(`No clip ${target.clipId} on this version.`);
  } else {
    if (target.at === undefined) throw new Error("Give each join the clipId it leads into or the time it is at.");
    const track = target.trackId ? timeline.tracks.find(t => t.id === target.trackId) : timeline.tracks.find(t => t.kind === "video");
    if (!track || track.kind !== "video") throw new Error(target.trackId ? `No video track ${target.trackId}.` : "This version has no video track.");
    const at = target.at, near = 0.5 / fps;
    const clips = track.clips.filter(c => c.enabled);
    const meets = (c: typeof clips[number]) => clips.some(o => o !== c && Math.abs(clipEnd(o) - c.timelineIn) <= MEET);
    const clip = clips.find(c => c.kind === "media" && Math.abs(c.timelineIn - at) <= near && meets(c));
    if (clip?.kind !== "media") {
      const nearest = clips.filter(meets).map(c => c.timelineIn).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
      throw new Error(`No join on ${track.id} at ${clock(at)}.${nearest !== undefined ? ` The nearest is at ${clock(nearest)} (${nearest.toFixed(3)} s).` : ""}`);
    }
    right = { clip, track };
  }
  const { clip, track } = right;
  const before = track.clips.find(c => c !== clip && c.enabled && Math.abs(clipEnd(c) - clip.timelineIn) <= MEET);
  if (before?.kind !== "media") throw new Error(`Nothing on ${track.id} cuts to ${clip.id} at ${clock(clip.timelineIn)}: a split edit needs two shots that meet.`);
  if (target.leftClipId && before.id !== target.leftClipId) throw new Error(`${target.leftClipId} doesn't cut to ${clip.id}: ${before.id} does, at ${clock(clip.timelineIn)}.`);
  if (before.mediaId === clip.mediaId && before.speed === clip.speed && Math.abs(before.sourceOut - clip.sourceIn) < MEET)
    throw new Error(`The footage runs on at ${clock(clip.timelineIn)}: there is no cut there to split.`);
  return { left: { clip: before, track }, right };
}

/** Where a clip's source clock sits against the timeline: two clips with the same are in sync. */
const syncOf = (clip: MediaClip) => clip.sourceIn - clip.timelineIn * clip.speed;

/**
 * The sound that plays with a picture clip next to its join: the clip itself while it plays its own sound, or a clip of
 * the same recording in sync with it on an audio track, the one whose edge is nearest the join.
 */
function soundOf(timeline: Timeline, picture: Placed, side: "left" | "right", at: number): Placed | undefined {
  if (plays(picture.track, picture.clip)) return picture;
  const { clip } = picture;
  const sync = syncOf(clip);
  const edge = (c: MediaClip) => side === "left" ? clipEnd(c) : c.timelineIn;
  let best: Placed | undefined;
  for (const track of timeline.tracks) {
    if (track.kind !== "audio") continue;
    for (const c of track.clips) {
      if (c.kind !== "media" || c.mediaId !== clip.mediaId || c.speed !== clip.speed || !plays(track, c) || Math.abs(syncOf(c) - sync) > MEET * c.speed) continue;
      // Its sound has to play beside this side's picture, up to the join.
      if (side === "left" ? !(c.timelineIn < at - EPS && clipEnd(c) > clip.timelineIn + EPS) : !(clipEnd(c) > at + EPS && c.timelineIn < clipEnd(clip) - EPS)) continue;
      if (!best || Math.abs(edge(c) - at) < Math.abs(edge(best.clip) - at)) best = { clip: c, track };
    }
  }
  return best;
}

/**
 * The ops that put the sound cut at each join `shift` seconds from its picture cut: negative, the incoming sound leads
 * (a J cut); positive, the outgoing sound carries on (an L cut); zero, the sound cuts with the picture again. The shift
 * is set, not added, so a second call replaces the first. Joins go one after another, each on the timeline the ones
 * before it left, so one clip can take a J cut at its start and an L cut at its end.
 */
export function splitJoinOps(timeline: Timeline, media: readonly Pick<MediaAsset, "id" | "kind" | "hasAudio" | "duration">[], fps: number,
  joins: ReadonlyArray<SplitJoinTarget & { shift: number }>): { ops: TimelineOp[]; joins: SplitJoinPlaced[] } {
  const assets = new Map(media.map(m => [m.id, m]));
  const ops: TimelineOp[] = [];
  const placedJoins: SplitJoinPlaced[] = [];
  let tl = timeline;
  for (const target of joins) {
    const { left: picL, right: picR } = pictureJoin(tl, target, fps);
    const at = picR.clip.timelineIn, shift = target.shift;
    if (!Number.isFinite(shift)) throw new Error(`Give the join at ${clock(at)} a finite amount.`);
    const sounds = { left: soundOf(tl, picL, "left", at), right: soundOf(tl, picR, "right", at) };
    for (const side of ["left", "right"] as const) {
      const picture = side === "left" ? picL : picR, sound = sounds[side];
      if (!sound) throw new Error(`No sound of ${picture.clip.id}'s own plays beside it at ${clock(at)}: there is no sound to split from its picture.`);
      const asset = assets.get(sound.clip.mediaId);
      if (!asset || !(asset.kind === "audio" || asset.hasAudio)) throw new Error(`${picture.clip.mediaId} has no recorded sound to split from its picture.`);
    }
    const soundL = sounds.left!, soundR = sounds.right!;
    const meetsAt = clipEnd(soundL.clip);
    if (Math.abs(meetsAt - soundR.clip.timelineIn) > MEET)
      throw new Error(`The sound at ${clock(at)} isn't a straight cut (${meetsAt > soundR.clip.timelineIn ? "a crossfade overlaps it" : "there is a gap in it"}). Take that off first, or leave this join as it is.`);
    const cut = at + shift;
    const was = meetsAt - at;
    // What each sound becomes: the left one ends at the new moment, the right one starts there.
    const lOut = sourceAt(soundL.clip, cut), rIn = sourceAt(soundR.clip, cut);
    const durL = assets.get(soundL.clip.mediaId)?.duration;
    if (lOut > soundL.clip.sourceOut + EPS && (durL === undefined || lOut > durL + EPS))
      throw new Error(`${soundL.clip.mediaId} was recorded only to ${durL === undefined ? "a length not known yet" : `${durL.toFixed(3)} s`}: its sound can carry on at most ${durL === undefined ? 0 : Math.max(0, (durL - soundL.clip.sourceOut) / soundL.clip.speed + was).toFixed(3)} s past the cut at ${clock(at)}.`);
    if (rIn < -EPS || cut < -EPS)
      throw new Error(`${soundR.clip.mediaId} has no recording before its start: its sound can lead the cut at ${clock(at)} by at most ${Math.max(0, Math.min(soundR.clip.sourceIn / soundR.clip.speed - was, at)).toFixed(3)} s.`);
    if (cut - soundL.clip.timelineIn < 1 / fps - EPS)
      throw new Error(`${soundL.clip.id}'s sound starts at ${clock(soundL.clip.timelineIn)}: too soon to stop ${(-shift).toFixed(3)} s before the cut at ${clock(at)}.`);
    if (clipEnd(soundR.clip) - cut < 1 / fps - EPS)
      throw new Error(`${soundR.clip.id}'s sound ends at ${clock(clipEnd(soundR.clip))}: too soon to start ${shift.toFixed(3)} s after the cut at ${clock(at)}.`);
    const fadeShort = (clip: MediaClip, length: number) => clip.audioFadeIn + clip.audioFadeOut > length + EPS;
    if (fadeShort(soundL.clip, cut - soundL.clip.timelineIn) || fadeShort(soundR.clip, clipEnd(soundR.clip) - cut))
      throw new Error(`The fades on the sound at ${clock(at)} are longer than the sound would be.`);

    // The record of what this join's split did, on the sound that moved; the other side's record of this join goes.
    const leftRecord = { ...soundL.clip.splitEdit }, rightRecord = { ...soundR.clip.splitEdit };
    delete leftRecord.trails;
    delete rightRecord.leads;
    if (shift > EPS) leftRecord.trails = shift;
    if (shift < -EPS) rightRecord.leads = -shift;
    const record = (r: { leads?: number; trails?: number }) => Object.keys(r).length ? r : null;

    const ids = new Set(tl.tracks.flatMap(t => t.clips.map(c => c.id)));
    const step: TimelineOp[] = [];
    /** Sound placed on each track by this join, so both sides can go on one dialogue track. */
    const placed = new Map<string, TimeRange[]>();
    const joining = new Set([soundL.clip.id, soundR.clip.id]);
    const free = (trackId: string, span: TimeRange) => ![...(tl.tracks.find(t => t.id === trackId)?.clips ?? []).filter(c => !joining.has(c.id))
      .map(c => ({ start: c.timelineIn, end: clipEnd(c) })), ...placed.get(trackId) ?? []]
      .some(b => b.start < span.end - EPS && b.end > span.start + EPS);
    const take = (trackId: string, span: TimeRange) => placed.set(trackId, [...placed.get(trackId) ?? [], span]);
    /** The unmuted audio track below a picture track that its sound goes to: its dialogue track, or the next free one. */
    const dialogueTrack = (picture: Track, span: TimeRange) => {
      for (let id = `${picture.id}_dialogue`; ; id += "_") {
        const found = tl.tracks.find(t => t.id === id);
        if ((found && (found.kind !== "audio" || found.muted)) || !free(id, span)) continue;
        if (!found && !step.some(op => op.op === "addTrack" && op.track.id === id))
          step.push({ op: "addTrack", track: makeTrack("audio", `${picture.name} dialogue`, id) });
        take(id, span);
        return id;
      }
    };
    /** Move one side's sound edge to the new moment; returns where that sound now is. */
    const moveSound = (sound: Placed, side: "left" | "right") => {
      const edge = side === "left" ? { sourceOut: lOut } : { timelineIn: cut, sourceIn: rIn };
      const span = side === "left" ? { start: sound.clip.timelineIn, end: cut } : { start: cut, end: clipEnd(sound.clip) };
      const splitEdit = record(side === "left" ? leftRecord : rightRecord);
      if (sound.track.kind === "audio") {
        if (!free(sound.track.id, span)) throw new Error(`Other sound on ${sound.track.id} is where ${sound.clip.id} would play at ${clock(at)}.`);
        take(sound.track.id, span);
        const keyframes = side === "right" && sound.clip.keyframes?.length
          ? { keyframes: sound.clip.keyframes.map(k => ({ ...k, time: k.time - (cut - sound.clip.timelineIn) })) } : {};
        step.push({ op: "updateClip", clipId: sound.clip.id, patch: { ...edge, ...keyframes, splitEdit } });
        return { clipId: sound.clip.id, mediaId: sound.clip.mediaId, trackId: sound.track.id };
      }
      // A picture that plays its own sound hands a copy of it to a dialogue track and goes silent.
      const trackId = dialogueTrack(sound.track, span);
      const id = uniqueId(`${sound.clip.id}_audio`, ids);
      ids.add(id);
      const copy: MediaClip = { ...detachedAudioClip(sound.clip, id, edge), ...(splitEdit && { splitEdit }) };
      step.push({ op: "addClip", trackId, clip: copy }, { op: "updateClip", clipId: sound.clip.id, patch: { volume: 0 } });
      return { clipId: id, mediaId: sound.clip.mediaId, trackId };
    };
    const left = { ...moveSound(soundL, "left"), sourceOut: lOut };
    const right = { ...moveSound(soundR, "right"), sourceIn: rIn };
    tl = applyOps(tl, step);
    ops.push(...step);
    placedJoins.push({ at, trackId: picR.track.id, leftClipId: picL.clip.id, rightClipId: picR.clip.id, was, shift, left, right });
  }
  return { ops, joins: placedJoins };
}

/**
 * Proposed ops with each `splitJoin` step expanded into the clip ops that make it, worked out on the timeline the ops
 * before it leave, and where each join's sound now cuts. Ops without one come back as they were.
 */
export function expandSplitJoins(timeline: Timeline, media: readonly Pick<MediaAsset, "id" | "kind" | "hasAudio" | "duration">[], fps: number,
  proposed: readonly ProposedOp[]): { ops: TimelineOp[]; joins: SplitJoinPlaced[] } {
  if (!proposed.some(op => op.op === "splitJoin")) return { ops: proposed as TimelineOp[], joins: [] };
  const ops: TimelineOp[] = [], joins: SplitJoinPlaced[] = [];
  let tl = timeline, pending: TimelineOp[] = [];
  for (const [i, op] of proposed.entries()) {
    if (op.op !== "splitJoin") { pending.push(op as TimelineOp); continue; }
    tl = applyOps(tl, pending);
    ops.push(...pending);
    pending = [];
    if (op.leads && op.trails) throw new Error(`ops[${i}] (splitJoin): give leads or trails, not both: its sound cuts once.`);
    if (op.leads === undefined && op.trails === undefined) throw new Error(`ops[${i}] (splitJoin): give leads or trails, in seconds (0 puts the sound back on the cut).`);
    try {
      const made = splitJoinOps(tl, media, fps, [{ clipId: op.rightClipId, leftClipId: op.leftClipId, shift: (op.trails ?? 0) - (op.leads ?? 0) }]);
      tl = applyOps(tl, made.ops);
      ops.push(...made.ops);
      joins.push(...made.joins);
    } catch (e) {
      throw new Error(`ops[${i}] (splitJoin): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  ops.push(...pending);
  return { ops, joins };
}

/** What a split edit set at one join, read from a sound clip's record: J leads, L trails. */
export function splitEditWords(split: MediaClip["splitEdit"], fps?: number): string[] {
  if (!split) return [];
  const amount = (seconds: number) => {
    const frames = fps ? seconds * fps : NaN;
    // Under a second reads in frames where the frame rate is known and the amount is whole frames.
    if (fps && seconds < 1 && Math.abs(frames - Math.round(frames)) < 0.05 && Math.round(frames) >= 1) {
      const n = Math.round(frames);
      return `${n} ${n === 1 ? "frame" : "frames"}`;
    }
    return `${Math.round(seconds * 100) / 100} s`;
  };
  const words: string[] = [];
  if (split.leads) words.push(`Sound leads by ${amount(split.leads)}`);
  if (split.trails) words.push(`Sound carries ${amount(split.trails)} past the cut`);
  return words;
}

const TIMING = new Set(["sourceIn", "sourceOut", "timelineIn", "keyframes"]);
const SPLIT_KEYS = new Set([...TIMING, "volume", "splitEdit"]);
const sameTiming = (a: MediaClip, b: MediaClip) => Math.abs(a.timelineIn - b.timelineIn) < EPS && Math.abs(a.sourceIn - b.sourceIn) < EPS && Math.abs(a.sourceOut - b.sourceOut) < EPS;

/**
 * The timeline with one split edit put back, with no model: the sound at each join in `range` cuts with its picture
 * again, as it did on `before`. A sound copy the split handed to a dialogue track goes, and its picture plays its own
 * sound again, once neither of its ends is split any more; a sound already on an audio track gets its old ends back.
 *
 * It answers nothing where the change did anything but split sound (`ops`), or where a later edit has changed a sound
 * or picture it touched since (`after` is the version the change made), so the caller can ask Scarlet instead.
 */
export function putBackSplit(head: Timeline, before: Timeline, after: Timeline, ops: ReadonlyArray<Record<string, unknown>>, range: TimeRange): Timeline | undefined {
  const added = new Map<string, string>(); // sound copy id -> track id
  const updated = new Set<string>(), muted = new Set<string>(), tracks = new Set<string>();
  for (const op of ops) {
    if (op.op === "addTrack") {
      const track = op.track as Partial<Track> | undefined;
      if (track?.kind !== "audio" || !track.id) return;
      tracks.add(track.id);
    } else if (op.op === "addClip") {
      const clip = op.clip as Partial<MediaClip> | undefined;
      if (clip?.kind !== "media" || typeof clip.id !== "string" || typeof op.trackId !== "string") return;
      added.set(clip.id, op.trackId);
    } else if (op.op === "updateClip" && typeof op.clipId === "string" && op.patch && typeof op.patch === "object") {
      const keys = Object.keys(op.patch);
      if (keys.some(k => !SPLIT_KEYS.has(k))) return;
      if (keys.length === 1 && keys[0] === "volume" && (op.patch as { volume?: unknown }).volume === 0) muted.add(op.clipId);
      else if (keys.includes("splitEdit")) updated.add(op.clipId);
      else return;
    } else return;
  }
  if (!added.size && !updated.size) return;
  const placed = (tl: Timeline) => new Map(tl.tracks.flatMap(track => track.clips.map(clip => [clip.id, { clip, track }] as const)));
  const was = placed(before), made = placed(after);
  const tl = structuredClone(head);
  const now = placed(tl);
  const slack = 0.5;
  const inRange = (t: number) => t >= range.start - slack && t <= range.end + slack;
  let undone = 0;
  // A copy the change added and then moved again (a shot split at both ends) is one sound, read as added.
  for (const id of [...added.keys(), ...[...updated].filter(u => !added.has(u))]) {
    const after = made.get(id)?.clip, current = now.get(id);
    if (after?.kind !== "media" || current?.clip.kind !== "media") return;
    // The sound before the split: the clip itself, or the picture it was copied from, in sync and of the same recording.
    const origin = !added.has(id) ? was.get(id)?.clip : [...muted].map(m => was.get(m)?.clip)
      .find((c): c is MediaClip => c?.kind === "media" && c.mediaId === after.mediaId && c.speed === after.speed &&
        Math.abs(syncOf(c) - syncOf(after)) < MEET * c.speed && c.timelineIn < clipEnd(after) && clipEnd(c) > after.timelineIn);
    if (origin?.kind !== "media") return;
    const moved = { in: Math.abs(after.timelineIn - origin.timelineIn) > EPS, out: Math.abs(clipEnd(after) - clipEnd(origin)) > EPS };
    const back = { in: moved.in && inRange(after.timelineIn), out: moved.out && inRange(clipEnd(after)) };
    if (!back.in && !back.out) continue;
    // A later edit changed this sound since: what it did isn't the split's to take back.
    if (!sameTiming(current.clip, after)) return;
    const clip = current.clip as MediaClip;
    const record = { ...clip.splitEdit };
    if (back.in) {
      Object.assign(clip, { timelineIn: origin.timelineIn, sourceIn: origin.sourceIn });
      if (origin.keyframes) clip.keyframes = structuredClone(origin.keyframes); else delete clip.keyframes;
      if (origin.volumeKeyframes) clip.volumeKeyframes = structuredClone(origin.volumeKeyframes); else delete clip.volumeKeyframes;
      if (origin.splitEdit?.leads !== undefined && !added.has(id)) record.leads = origin.splitEdit.leads; else delete record.leads;
    }
    if (back.out) {
      clip.sourceOut = origin.sourceOut;
      if (origin.splitEdit?.trails !== undefined && !added.has(id)) record.trails = origin.splitEdit.trails; else delete record.trails;
    }
    if (Object.keys(record).length) clip.splitEdit = record; else delete clip.splitEdit;
    undone++;
    // A copy back at both of its picture's ends is the picture's own sound again: it goes, and the picture plays it.
    if (added.has(id) && sameTiming(clip, origin)) {
      const picture = now.get(origin.id);
      if (picture?.clip.kind !== "media" || picture.clip.volume !== 0 || !sameTiming(picture.clip, origin)) return;
      picture.clip.volume = origin.volume;
      current.track.clips = current.track.clips.filter(c => c.id !== id);
    }
  }
  if (!undone) return;
  // A dialogue track the split added and nothing plays on any more goes too.
  tl.tracks = tl.tracks.filter(t => !(tracks.has(t.id) && t.clips.length === 0));
  return tl;
}
