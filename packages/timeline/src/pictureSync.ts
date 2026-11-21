import { makeMediaClip, makeTrack } from "./builders.js";
import type { TimelineOp } from "./ops.js";
import type { MediaAsset, MediaClip, Timeline, Track } from "./schema.js";
import { clipEnd } from "./time.js";

/**
 * Put a recording's picture in time with its own sound. Its sound stays where it is, so every cut placed by ear stays
 * where it was and every recording synced to it by sound stays synced; its picture plays from `soundLeads` seconds
 * later in the recording, so a mouth moves with the words. A clip that plays its own sound first hands the sound to
 * the dialogue track below it (as an audio crossfade does) and goes silent, so its picture can move on its own.
 *
 * The offset is set, not added: a clip that plays beside its own sound is put at `soundLeads` from it whatever it
 * was before, so a second call with another value replaces the first and 0 puts the picture back. A clip with none of
 * its own sound playing beside it has nothing to measure from and moves by the whole of `soundLeads`.
 */

const EPS = 1e-6;

export interface PictureSyncReport {
  /** Clips whose picture moved, and by how much (source seconds, later positive). */
  moved: Array<{ clipId: string; by: number }>;
  /** Clips that handed their sound to a dialogue track. */
  soundMoved: string[];
  /** Clips with none of the recording's sound beside them: moved by the whole offset. */
  pictureOnly: string[];
  /** Clips already at the offset. */
  unchanged: number;
  /** Clips shortened because the recording's picture ends (or starts) before the moved clip would: seconds of picture lost and where. */
  shortened: Array<{ clipId: string; seconds: number; at: number }>;
}

type Placed = { clip: MediaClip; track: Track };

const plays = (track: Track, clip: MediaClip) => !track.muted && track.kind !== "caption" && clip.enabled && clip.volume > 0;

/** Where on the recording a clip is at a timeline time. */
const sourceAt = (clip: MediaClip, at: number) => clip.sourceIn + (at - clip.timelineIn) * clip.speed;

export function pictureSyncOps(timeline: Timeline, media: readonly MediaAsset[], mediaId: string, soundLeads: number): { ops: TimelineOp[]; report: PictureSyncReport } {
  const asset = media.find(m => m.id === mediaId);
  if (!asset) throw new Error(`Media ${mediaId} is not in this project.`);
  if (asset.kind !== "video") throw new Error(`Media ${mediaId} is ${asset.kind}: only a video has a picture to put in time with its sound.`);
  if (!asset.hasAudio) throw new Error(`Media ${mediaId} has no sound of its own to put its picture in time with.`);
  const duration = asset.duration;
  if (!duration) throw new Error(`Media ${mediaId} is still being prepared.`);

  const all: Placed[] = timeline.tracks.flatMap(track => track.clips.flatMap(clip =>
    clip.kind === "media" && clip.mediaId === mediaId ? [{ clip, track }] : []));
  const pictures = all.filter(p => p.track.kind === "video" && p.clip.enabled);
  if (!pictures.length) throw new Error(`No clip of ${mediaId} shows its picture in this version.`);
  /** The recording's own sound playing from a clip other than a picture clip that will hand its sound on. */
  const sounds = all.filter(p => p.track.kind === "audio" && plays(p.track, p.clip));

  const report: PictureSyncReport = { moved: [], soundMoved: [], pictureOnly: [], unchanged: 0, shortened: [] };
  const ops: TimelineOp[] = [];
  const ids = new Set(timeline.tracks.flatMap(t => t.clips.map(c => c.id)));
  /** Sound copies placed by this call, by the track they go on. */
  const placed = new Map<string, Array<{ start: number; end: number }>>();
  const addedTracks = new Set<string>();

  /** The unmuted audio track below a picture track that its sound goes to: its dialogue track, or the next free one after it. */
  const soundTrackFor = (track: Track, start: number, end: number) => {
    for (let id = `${track.id}_dialogue`; ; id += "_") {
      const found = timeline.tracks.find(t => t.id === id);
      if (found && (found.kind !== "audio" || found.muted)) continue;
      const busy = [...(found?.clips ?? []).map(c => ({ start: c.timelineIn, end: clipEnd(c) })), ...(placed.get(id) ?? [])];
      if (busy.some(b => b.start < end - EPS && b.end > start + EPS)) continue;
      if (!found && !addedTracks.has(id)) {
        addedTracks.add(id);
        ops.push({ op: "addTrack", track: makeTrack("audio", `${track.name} dialogue`, id) });
      }
      placed.set(id, [...(placed.get(id) ?? []), { start, end }]);
      return id;
    }
  };

  for (const { clip, track } of pictures) {
    const middle = (clip.timelineIn + clipEnd(clip)) / 2;
    let current: number | undefined;
    if (plays(track, clip)) {
      // Its sound goes on a track of its own, from where it is now, and the picture goes silent.
      const to = soundTrackFor(track, clip.timelineIn, clipEnd(clip));
      let id = `${clip.id}_audio`;
      while (ids.has(id)) id += "_";
      ids.add(id);
      ops.push({ op: "addClip", trackId: to, clip: makeMediaClip(clip.mediaId, clip.sourceIn, clip.sourceOut, clip.timelineIn, {
        id, label: clip.label, speed: clip.speed, effects: clip.effects, volume: clip.volume, audioFadeIn: clip.audioFadeIn, audioFadeOut: clip.audioFadeOut,
      }) });
      report.soundMoved.push(clip.id);
      current = 0;
    } else {
      const beside = sounds.find(s => s.clip.speed === clip.speed && s.clip.timelineIn <= middle + EPS && clipEnd(s.clip) >= middle - EPS);
      if (beside) current = sourceAt(clip, middle) - sourceAt(beside.clip, middle);
      else report.pictureOnly.push(clip.id);
    }
    const by = current === undefined ? soundLeads : soundLeads - current;
    const silent = report.soundMoved.at(-1) === clip.id ? { volume: 0 } : {};
    if (Math.abs(by) < EPS) {
      if (silent.volume === 0) ops.push({ op: "updateClip", clipId: clip.id, patch: silent });
      else report.unchanged++;
      continue;
    }
    let sourceIn = clip.sourceIn + by, sourceOut = clip.sourceOut + by, timelineIn = clip.timelineIn;
    let keyframes = clip.keyframes;
    if (sourceIn < 0) {
      // The recording's picture starts too late for the clip's first frames: the clip starts later.
      const lost = -sourceIn / clip.speed;
      report.shortened.push({ clipId: clip.id, seconds: lost, at: clip.timelineIn });
      timelineIn += lost;
      sourceIn = 0;
      keyframes = keyframes?.map(k => ({ ...k, time: k.time - lost }));
    }
    if (sourceOut > duration) {
      report.shortened.push({ clipId: clip.id, seconds: (sourceOut - duration) / clip.speed, at: clipEnd(clip) });
      sourceOut = duration;
    }
    if (!(sourceOut - sourceIn > EPS)) throw new Error(`Clip ${clip.id} would have no picture left once moved ${by.toFixed(3)} s.`);
    ops.push({ op: "updateClip", clipId: clip.id, patch: { ...silent, sourceIn, sourceOut, timelineIn, ...(keyframes && { keyframes }) } });
    report.moved.push({ clipId: clip.id, by });
  }
  return { ops, report };
}
