import { clipDuration, timelineToSource, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { dialogueAudioStream, dialogueClips, type JoinPage } from "./dialogue-join.js";
import { gapSound } from "./gap-sound.js";

type PauseWord = { text: string; mediaId: string; sourceEnd: number; timelineEnd: number };
type PausePlacement = { status: "moved" | "already-at-target"; start: number; end: number; word: PauseWord; beforeSeconds: number; afterSeconds: number }
  | { status: "unavailable"; reason: string };

/** Place the outgoing edge on the earliest whole frame that keeps the aligned word and the requested pause. */
export function resolveOutgoingPause(tl: Timeline, project: Project, current: TimeRange, pages: JoinPage[], leave = 0): PausePlacement {
  const { clips, streams } = dialogueClips(tl, project);
  const epsilon = 1e-6;
  const outgoing = clips.filter(c => c.timelineIn < current.start && c.timelineIn + clipDuration(c) >= current.start - epsilon);
  let last: PauseWord | undefined;
  const forClip = (mediaId: string, stream: number | undefined) => pages.filter(p => p.mediaId === mediaId && (p.audioStream ?? 0) === stream && p.edges);
  for (const clip of outgoing) {
    const edge = timelineToSource(clip, current.start);
    for (const page of forClip(clip.mediaId, dialogueAudioStream(clip) ?? streams.get(clip.mediaId))) {
      for (const word of page.edges!.words) {
        if (word.start >= edge - epsilon || word.end <= clip.sourceIn || word.start >= clip.sourceOut) continue;
        if (word.end > edge + epsilon) return { status: "unavailable", reason: `The current cut already intersects “${word.text.trim()}”. Inspect its ending before moving it earlier.` };
        const timelineEnd = clip.timelineIn + (word.end - clip.sourceIn) / clip.speed;
        if (!last || timelineEnd > last.timelineEnd) last = { text: word.text.trim(), mediaId: clip.mediaId, sourceEnd: word.end, timelineEnd };
      }
    }
  }
  if (!last) return { status: "unavailable", reason: "No aligned last word could be located on the outgoing dialogue." };
  const fps = project.settings.fps;
  const target = Math.ceil((last.timelineEnd + leave) * fps - 1e-7) / fps;
  const start = Math.min(target, current.start);
  const beforeSeconds = Math.max(0, current.start - last.timelineEnd);
  // A source ending inside the new removal also needs checking, even when it does not reach the old edge.
  for (const clip of clips) {
    const from = timelineToSource(clip, Math.max(start, clip.timelineIn));
    const to = timelineToSource(clip, Math.min(current.start, clip.timelineIn + clipDuration(clip)));
    if (to <= from + epsilon) continue;
    const readings = forClip(clip.mediaId, dialogueAudioStream(clip) ?? streams.get(clip.mediaId)).sort((a, b) => a.start - b.start);
    let through = from;
    for (const page of readings) {
      const levels = page.edges!.levels;
      if (!levels || page.start > through + epsilon || page.end <= through) continue;
      const end = Math.min(page.end, to);
      if (page.edges!.words.some(w => w.end > from + epsilon && w.start < to - epsilon))
        return { status: "unavailable", reason: "Another word plays in the requested trim." };
      const loudness = { from: levels.from, to: levels.from + levels.step * levels.db.length, rms: levels.db.map(db => 10 ** (db / 20)) };
      const sound = gapSound(loudness, { start: Math.max(from, page.start), end }, undefined, 0);
      if (!sound || sound.runs.length)
        return { status: "unavailable", reason: "The interval after the word contains unmeasured audio or sound at speaking level. Inspect it before trimming." };
      through = end;
      if (through >= to - epsilon) break;
    }
    if (through < to - epsilon) return { status: "unavailable", reason: "The recording does not cover the whole requested pause." };
  }
  return { status: start < current.start - epsilon ? "moved" : "already-at-target", start, end: current.end, word: last,
    beforeSeconds, afterSeconds: Math.max(0, start - last.timelineEnd) };
}
