import { clipEnd, indexClipsAt, planTransitions, sourceToTimeline, type MediaClip, type Timeline } from "@scarlet/timeline";
import type { TimelineJoin } from "./timeline-perception.js";

type SpokenWord = { text: string; start: number; end: number };
type Side = TimelineJoin["tracks"][number];
type Media = { id: string; kind: string; duration?: number };
const epsilon = 1e-6;
const millis = (t: number) => Math.round(t * 1000);
const sourceAt = (c: MediaClip, t: number) => c.sourceIn + (t - c.timelineIn) * (c.speed ?? 1);

export interface PictureEntrance {
  status: "measured" | "word-trimmed" | "onset-in-fade" | "unavailable";
  reason?: string;
  pictureAt?: number;
  firstWord?: string;
  wordIndex?: number;
  previousWordIndex?: number;
  wordAt?: number;
  gapMs?: number;
  onsetTrimMs?: number;
  endTrimMs?: number;
  fadeOverOnsetMs?: number;
}

/** Match an audible splice to a hard cut on the visible presenter footage by both source clocks.
 * A cut to a different camera, a dissolve or a covered layer cannot establish this measurement. */
export function pictureEntranceReader(timeline: Timeline, media: readonly Media[], fps: number) {
  const assets = new Map(media.map(m => [m.id, m]));
  const clips = new Map<string, MediaClip>();
  const frames = new Set<number>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind === "media") clips.set(clip.id, clip);
    if (track.kind !== "video" || track.hidden || !clip.enabled || clip.kind === "caption" || clip.opacity <= 0) continue;
    for (const t of [clip.timelineIn, clipEnd(clip)]) if (t > 0) frames.add(Math.ceil(t * fps - epsilon));
  }
  const transitions = planTransitions(timeline, assets, fps);
  const hits = indexClipsAt(transitions.timeline);
  function picture(frame: number) {
    const t = frame / fps + epsilon;
    const visible = hits(t).findLast(({ track, clip }) => track.kind === "video" && !track.hidden && clip.enabled &&
      clip.kind !== "caption" && clip.opacity > 0 && (clip.kind === "color" || assets.get(clip.mediaId)?.kind !== "audio"))?.clip;
    if (visible?.kind !== "media" || assets.get(visible.mediaId)?.kind !== "video" ||
        transitions.layers.has(visible.id) || transitions.motions.get(visible.id)?.some(m => m.start <= t && t < m.end)) return;
    return visible;
  }
  const cuts: { at: number; out: MediaClip; inn: MediaClip }[] = [];
  for (const frame of frames) {
    if (frame < 1) continue;
    const out = picture(frame - 1), inn = picture(frame);
    if (!out || !inn || out.id === inn.id || out.videoFadeOut > 0 || inn.videoFadeIn > 0) continue;
    // Require two abutting shots. Revealing a lower shot under an overlay is a different kind of edit.
    if (Math.abs(clipEnd(out) - inn.timelineIn) > epsilon) continue;
    if (out.mediaId === inn.mediaId && Math.abs(out.sourceOut - inn.sourceIn) < epsilon) continue;
    cuts.push({ at: frame / fps, out, inn });
  }

  function sameTake(video: MediaClip, audio: MediaClip, t: number) {
    return video.mediaId === audio.mediaId && video.speed === audio.speed &&
      Math.min(clipEnd(audio), clipEnd(video)) > Math.max(audio.timelineIn, video.timelineIn) &&
      Math.abs(sourceAt(video, t) - sourceAt(audio, t)) < .001;
  }
  const spoken = (w: SpokenWord) => w.end > w.start && /[\p{L}\p{N}]/u.test(w.text) && !/^\s*\[.*\]\s*$/.test(w.text);
  return (side: Side, inWords?: readonly SpokenWord[] | null, outWords?: readonly SpokenWord[] | null,
          settledThrough = Infinity): PictureEntrance => {
    const a = clips.get(side.out.clipId), b = clips.get(side.in.clipId);
    const match = a && b ? cuts.filter(c => sameTake(c.out, a, c.at) && sameTake(c.inn, b, c.at)) : [];
    if (!b || !a || match.length !== 1) return { status: "unavailable", reason: "No unique visible cut matching both audible takes" };
    const pictureAt = match[0]!.at;
    const intersects = (w: SpokenWord, c: MediaClip) => spoken(w) && w.end > c.sourceIn + epsilon && w.start < c.sourceOut - epsilon;
    const i = inWords?.findIndex(w => intersects(w, b)) ?? -1;
    const word = inWords?.[i];
    if (!word || word.end > settledThrough) return { status: "unavailable", pictureAt, reason: "No settled incoming word in this clip" };
    const previous = outWords?.findLastIndex(w => intersects(w, a));
    const identity = { pictureAt, firstWord: word.text.trim(), wordIndex: i, previousWordIndex: previous === -1 ? undefined : previous };
    if (word.start < b.sourceIn - epsilon || word.end > b.sourceOut + epsilon) {
      return { status: "word-trimmed", ...identity, onsetTrimMs: millis(Math.max(0, b.sourceIn - word.start) / b.speed),
        endTrimMs: millis(Math.max(0, word.end - b.sourceOut) / b.speed) };
    }
    const wordAt = sourceToTimeline(b, word.start);
    const end = clipEnd(b);
    const inFadeOut = b.audioFadeOut > 0 && wordAt >= Math.max(b.timelineIn, end - b.audioFadeOut) - epsilon;
    const fadeEnd = inFadeOut ? end : Math.min(end, b.timelineIn + (b.audioFadeIn ?? 0));
    const fadeOverOnset = fadeEnd - wordAt;
    if (fadeOverOnset > epsilon) return { status: "onset-in-fade", ...identity, wordAt, fadeOverOnsetMs: millis(fadeOverOnset) };
    return { status: "measured", ...identity, wordAt, gapMs: millis(wordAt - pictureAt) };
  };
}
