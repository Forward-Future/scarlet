import { z } from "zod/v3";
import {
  clipDuration,
  clipEnd,
  ProposedOp,
  type LouderDoubledSound,
  type MediaClip,
  type Timeline,
} from "@scarlet/timeline";
import { audibleClipsByTrack, audibleMediaClips } from "./analysis.js";
import { dialogueAudioStream } from "./dialogue-join.js";

/**
 * The audible clip edges a saved timeline cuts at that the version it replaces did not: each start (`in`) and end
 * (`out`) of a clip, in its own recording's seconds. An edge the old version already had is no new cut and is left
 * out. So are the first and last instants of a recording, and an edge where another clip of the recording plays straight
 * on from that second, on its track or another: the halves of a split, or a copy that takes over where one is silenced.
 * Whatever made the edge counts: a ripple, a trimmed or added clip, a whole new timeline. A pass that built its
 * video from added clips skipped every edge check there was, and a revision that trimmed one clip by a frame did too.
 */
export function newClipEdges(before: Timeline | null, next: Timeline, media: ReadonlyArray<{ id: string; duration?: number }>):
  Array<{ clipId: string; mediaId: string; stream?: number; side: "in" | "out"; source: number }> {
  const old = before ? audibleMediaClips(before) : [];
  const seen = new Set<string>();
  const edges: ReturnType<typeof newClipEdges> = [];
  const clips = audibleClipsByTrack(next).flat();
  for (const clip of clips) {
    const length = media.find(m => m.id === clip.mediaId)?.duration, stream = dialogueAudioStream(clip), ends = clip.timelineIn + clipDuration(clip);
    for (const [side, source] of [["in", clip.sourceIn], ["out", clip.sourceOut]] as const) {
      const key = `${clip.mediaId}/${stream ?? ""}/${side}/${source.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (source < .05 || (length !== undefined && source > length - .05)) continue;
      if (old.some(c => c.mediaId === clip.mediaId && Math.abs((side === "in" ? c.sourceIn : c.sourceOut) - source) < 1e-3)) continue;
      if (clips.some(c => c !== clip && c.mediaId === clip.mediaId && dialogueAudioStream(c) === stream && (side === "out"
        ? Math.abs(c.sourceIn - source) < 1e-3 && Math.abs(c.timelineIn - ends) < 1e-3
        : Math.abs(c.sourceOut - source) < 1e-3 && Math.abs(c.timelineIn + clipDuration(c) - clip.timelineIn) < 1e-3))) continue;
      edges.push({ clipId: clip.id, mediaId: clip.mediaId, ...(stream !== undefined && { stream }), side, source });
    }
  }
  return edges;
}

export const DOUBLED_SOUND = "Nothing was saved. Copies of one moment in sync add up in the mix, so that stretch would play louder than the edit started. Make the change named for it, which turns down the copy the edit added or changed, and another when that one alone can't, over that stretch alone and leaves the mix the edit started from everywhere else, and propose the edit again with that change. Pass layeredSound: true instead only if the editor asked to hear it layered.";

/**
 * A louder stretch as the refusal names it, with the change that turns down each copy it names there alone: split off
 * just that stretch of it, so what it plays before and after stays as it was.
 */
export function doubledSoundText(d: LouderDoubledSound, next: Timeline): string {
  const clips = new Map(next.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)));
  const t = (n: number) => String(+n.toFixed(6));
  const { start: from, end: to } = d.overlap;
  const copies = d.copies.length > 2 ? `${d.copies.slice(0, -1).join(", ")} and ${d.copies.at(-1)} all` : `${d.clipIds[0]} and ${d.clipIds[1]} both`;
  const pair = `clips ${copies} play ${d.mediaId} from ${t(d.source.start)} to ${t(d.source.end)} s, at ${t(from)}–${t(to)} s on the timeline, where their volumes add up to ${t(d.level.after)} and the edit started at ${t(d.level.before)}`;
  const turnDown = ({ clipId, volume: v }: LouderDoubledSound["turnDown"][number]) => {
    const quiet = clips.get(clipId) as MediaClip;
    const volume = t(v);
    // An id for a piece split off it that no clip has yet.
    const fresh = (name: string) => { let id = `${quiet.id}-${name}`; for (let n = 2; clips.has(id); n++) id = `${quiet.id}-${name}-${n}`; return id; };
    const before = quiet.timelineIn < from - 1e-6, after = clipEnd(quiet) > to + 1e-6;
    if (!before && !after) return `${quiet.id} plays only there, so set its volume to ${volume}`;
    if (!before) {
      const rest = fresh("after");
      return `${quiet.id} plays on after that, so splitClip ${quiet.id} at ${t(to)} with newClipId ${rest}, which keeps the part after it as ${rest} with its sound, and set ${quiet.id}'s volume to ${volume}`;
    }
    const louder = fresh("louder");
    if (!after) return `${quiet.id} plays before that as the edit started, so splitClip ${quiet.id} at ${t(from)} with newClipId ${louder}, which keeps the part before it as it was, and set ${louder}'s volume to ${volume}`;
    const rest = fresh("after");
    return `${quiet.id} plays on either side of that, so splitClip ${quiet.id} at ${t(from)} with newClipId ${louder}, then splitClip ${louder} at ${t(to)} with newClipId ${rest}, which keeps the parts either side as they were, and set ${louder}'s volume to ${volume}`;
  };
  // Turned down to 0, the first copy can still leave the stretch louder, as three copies where the base played one:
  // the next is named too, so the fix done as it says is the whole fix.
  return `${pair}: ${d.turnDown.map(turnDown).join("; and ")}`;
}

export const OPS_DOC = `Op types (all times are seconds; timeline times are positions in the edit, source times are positions in the media file):
- addClip: {"op":"addClip","trackId":"v1","clip":{"id":"clip_x","kind":"media","mediaId":"m1","sourceIn":12.5,"sourceOut":20,"timelineIn":0}} — place a media clip (also kind "caption" {timelineOut,text} or "color" {timelineOut,color}). Clip duration on the timeline = (sourceOut-sourceIn)/speed.
- removeClip: {"op":"removeClip","clipId":"clip_x"} — remove a clip, leaving a gap (use rippleDelete to close gaps).
- updateClip: {"op":"updateClip","clipId":"clip_x","patch":{"audioFadeIn":0.066,"audioFadeOut":0.066}} — patch any clip fields (sourceIn/sourceOut to trim, volume, speed, opacity, transform, label, enabled, effects, text/style for captions).
- moveClip: {"op":"moveClip","clipId":"clip_x","timelineIn":42.0,"trackId":"v2"} — move to a timeline position (and optionally another track).
- splitClip: {"op":"splitClip","clipId":"clip_x","at":30.0,"newClipId":"clip_y"} — split at a timeline time into two clips.
- rippleDelete: {"op":"rippleDelete","start":30.0,"end":31.2} — remove a timeline range from every track (or "trackIds") and close the gap; clips spanning the range are trimmed/split. All tracks stay in sync. Several run in order, each in the times of the edit the ones before it leave as you gave them. Each goes inward onto whole frames (one that runs to the end of the edit keeps its end), and a later one first moves by what earlier ones left in, so it removes the footage you meant: onWholeFrames lists each that changed, with what was removed and movedBy. To remove dialogue, dialogue_apply_cuts places each edge in the recording's measured quiet and reports what it moved.
- rippleInsertGap: {"op":"rippleInsertGap","at":30.0,"duration":2.0} — push everything after the given time later.
- splitJoin: {"op":"splitJoin","leftClipId":"clip_a","rightClipId":"clip_b","leads":0.25} — a J cut: the sound at the join of two video clips starts that many seconds before the picture cut ("trails": an L cut, carrying on past it; 0: back on the cut). Picture and runtime stay; the sound moves to the dialogue track. The result's \`Split joins\` says when each voice comes in and goes out (voiceIn, voiceOut) and the words now heard or no longer heard.
- addTrack: {"op":"addTrack","track":{"id":"v2","kind":"video","name":"B-roll","clips":[]}} — kinds: video | audio | caption.
- removeTrack: {"op":"removeTrack","trackId":"v2"}
- updateTrack: {"op":"updateTrack","trackId":"a1","patch":{"muted":true}}
- addMarker: {"op":"addMarker","marker":{"id":"mk1","time":12.0,"kind":"todo","text":"needs b-roll"}} — a note on the timeline; it changes nothing the editor sees or hears. An edit that only leaves "todo" markers waits on the editor, its card asking what their text says, until they mark it done.
- removeMarker: {"op":"removeMarker","markerId":"mk1"}
- updateMarker: {"op":"updateMarker","markerId":"mk1","patch":{"resolved":true}}
- setTimeline: {"op":"setTimeline","patch":{"name":"Short v2","background":"#000000","captionStyle":{"fontSize":0.06}}}
- duckUnderSpeech: {"op":"duckUnderSpeech","clipId":"music1"} — dips a clip, such as music, under the speech transcribed on the other clips: sets its volumeKeyframes, replacing earlier ones, to go down depthDb (default -18) over fadeDown s (0.3) as each line starts and back up over fadeUp s (0.8) after it, rising only in pauses of minGap s (2) or more. ranges [[start, end], …] in timeline seconds dips under those instead. The result's musicDips lists the dips and any speech still over the clip at full level (speechNotUnder).

Clip fields:
- volume is linear gain (1 = unchanged, 0 = mute). Fades (audioFadeIn/Out, videoFadeIn/Out) are seconds. volumeKeyframes: [{time, db, ease}] move a media clip's level over time, db on top of volume, with time in seconds from the clip's start and ease as for keyframes; the level holds the first key's db before it and the last's after it.
- speed plays a media clip faster (above 1) or slower, its sound kept at pitch. A speed change keeps sourceIn and sourceOut, so the clip gets shorter or longer and the clips after it don't move. To play a stretch of the edit faster with every track in sync: splitClip each clip that plays through it at both ends, set speed on each middle piece, then rippleDelete from the stretch's start plus its new length to its old end.
- transform: A patch replaces the whole transform, so include the framing you want to keep. x and y are offsets from the center as fractions of the canvas width and height, scale 1 fits the cropped source to the canvas, rotation is degrees clockwise, cropLeft/Right/Top/Bottom are fractions of the source. cornerRadius rounds the cropped layer's corners (0–0.5 of its shorter side, 0 for square). keyframes: [{time, transform, ease}] animate x, y and scale, with time in seconds from the clip's start and ease linear | easeIn | easeOut | easeInOut | hold. A crop that isn't the canvas's shape leaves the timeline's background beside the picture, and keyframes don't animate a crop: to zoom in on an area of a picture, or move from one area to another, use timeline_framing.
- effects: [{type, params, enabled}]. A patch replaces the whole array, so include the stages you keep. Audio types: denoise {amount dB, noiseFloor dBFS}, expander {thresholdDb, rangeDb, ratio, attack ms, release ms}, eq {highpass Hz, lowpass Hz, bands [{frequency, gain dB, width Q}]}, compressor {thresholdDb, ratio, attack ms, release ms, makeupDb}, limiter {limitDb, attack ms, release ms}, loudnorm {i LUFS, tp dBTP, lra LU}, voiceCleanup {mix 0–1, default 1: how much of the cleaned sound plays}, which separates the voice from noise and the room with a speech model. Put voiceCleanup on only when the editor asked for it, in their words or in a skill of theirs; never on your own initiative.
- A later video track composites on top of an earlier one. A caption clip can carry a title or label.`;

/** Validate a list of ops and return readable errors instead of throwing. */
export function validateOps(ops: unknown): { ok: true; ops: ProposedOp[] } | { ok: false; error: string } {
  if (!Array.isArray(ops)) return { ok: false, error: "ops must be an array of op objects" };
  const parsed = z.array(ProposedOp).safeParse(ops);
  if (parsed.success) return { ok: true, ops: parsed.data };
  const lines = parsed.error.issues.slice(0, 20).map((i) => {
    const idx = typeof i.path[0] === "number" ? i.path[0] : undefined;
    const opName = idx !== undefined ? (ops[idx] as { op?: unknown })?.op : undefined;
    const where = idx !== undefined ? `ops[${idx}]${opName ? ` (${String(opName)})` : ""}` : "ops";
    const field = i.path.slice(1).join(".");
    return `- ${where}${field ? `.${field}` : ""}: ${i.message}`;
  });
  return { ok: false, error: `Invalid ops:\n${lines.join("\n")}\n\n${OPS_DOC}` };
}
