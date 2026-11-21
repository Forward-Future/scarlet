/**
 * What the closing check of a pass lists about the picture, beside the dialogue: the places where the video switches
 * picture and back within a moment, and the places where a recording laid over the main picture is off it while it
 * still shows what it showed, with what is said there and any of its text read aloud.
 *
 * Both were already in each save's report (`briefPictures`, the framed report's `shownAfter`/`shownBefore`), and passes
 * read past them. A pass on project 88 laid the screen over the camera from 4:53, left 0.45 s of camera before the next
 * screen clip, then went back to the camera for 13 s while the speaker read his prompt off the screen and 4 s later its
 * reply, and showed 2 s of the model list he went on talking about at 5:38 between stretches of camera, with all of it
 * reported on its saves (2026-11-21). The closing check is the one list a pass works through to the end: each finding
 * is fixed or kept with a reason, as a repeat or a silence is. Whether a moment of a picture, or the camera while the
 * screen still shows what was being talked about, is right is the model's call; the skill says what the editor likes.
 */
import { clipEnd, type MediaClip, type Timeline } from "@scarlet/timeline";
import type { BriefPicture } from "./brief-pictures.js";
import type { FramedStretch } from "./framing-report.js";

// A type, not an interface: it travels as the check's passthrough findings.
export type PictureFinding = {
  /** Stays the same while the same footage plays there: a keep given by it holds across later saves elsewhere. */
  id: string;
  /**
   * `brief`: a picture on screen for under a second between two others. `offPicture`: a recording laid over the main
   * picture elsewhere is off picture here while it still shows what it showed beside it.
   */
  kind: "brief" | "offPicture";
  /** Timeline seconds. */
  from: number; to: number;
  /** For `brief`: the clips on screen through it, and the ones before and after it, top first. */
  shows?: string[]; before?: string[]; after?: string[];
  /** For `brief`: ends of it that are cuts in the recording itself, as `briefPictures` gives them. */
  recordingCuts?: BriefPicture["recordingCuts"];
  /** For `offPicture`: the recording off picture; the lines of its text still there (`showing`) or nothing in its frame changed (`unchanged`); the words heard; and the passages of its text read aloud word for word (`reads`). */
  mediaId?: string; showing?: string[]; unchanged?: true; said?: string;
  reads?: Array<{ from: number; to: number; said: string }>;
};

/** A word heard on the version: which recording and transcript index it is, where it plays. */
interface HeardWord { mediaId: string; index: number; start: number; end: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The picture findings on a version: its brief pictures, and the time beside its stretches of a recording laid over
 * another where that recording, off picture, still shows what it showed (the framed report of the whole version, with
 * no version before it). The time between two stretches of one recording is the one's after and the next one's
 * before: it is one finding.
 */
export function pictureFindings(tl: Timeline, brief: readonly BriefPicture[], framed: readonly FramedStretch[], words: readonly HeardWord[]): PictureFinding[] {
  const clips = new Map(tl.tracks.flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media").map(c => [c.id, c] as const)));
  const out: PictureFinding[] = [];
  for (const b of brief) {
    // Named by what plays: the picture on screen through it, at its source second there.
    const clip = clips.get(b.shows[0] ?? "");
    const at = (b.from + b.to) / 2;
    const key = clip && at >= clip.timelineIn && at <= clipEnd(clip)
      ? `${clip.mediaId}@${(clip.sourceIn + (at - clip.timelineIn) * (clip.speed ?? 1)).toFixed(1)}` : `${b.from.toFixed(1)}`;
    out.push({ id: `picture-brief:${key}`, kind: "brief", from: b.from, to: b.to, shows: b.shows, before: b.before, after: b.after,
      ...(b.recordingCuts?.length && { recordingCuts: b.recordingCuts }) });
  }
  const off: PictureFinding[] = [];
  for (const stretch of framed) for (const beside of [stretch.shownBefore, stretch.shownAfter]) {
    if (!beside) continue;
    const same = off.find(f => f.mediaId === stretch.mediaId && f.from < beside.to && beside.from < f.to);
    if (same) {
      // One gap seen from both sides: the wider reach, and the readings of both.
      same.from = Math.min(same.from, beside.from);
      same.to = Math.max(same.to, beside.to);
      if (beside.showing) same.showing = [...new Set([...same.showing ?? [], ...beside.showing])].slice(0, 3);
      if (beside.unchanged) same.unchanged = true;
      if (beside.said && (beside.said.length > (same.said?.length ?? 0))) same.said = beside.said;
      const reads = [...same.reads ?? [], ...beside.reads ?? []];
      if (reads.length) same.reads = [...new Map(reads.map(r => [`${r.from}-${r.to}`, r])).values()].sort((a, b) => a.from - b.from).slice(0, 5);
      continue;
    }
    off.push({ id: "", kind: "offPicture", from: beside.from, to: beside.to, mediaId: stretch.mediaId,
      ...(beside.showing && { showing: beside.showing }), ...(beside.unchanged && { unchanged: true as const }),
      ...(beside.said && { said: beside.said }), ...(beside.reads && { reads: beside.reads }) });
  }
  for (const f of off) {
    // Named by the first word heard there, in its transcript: it stays while the same words play beside the same recording.
    const first = words.find(w => w.start >= f.from - 0.05 && w.start < f.to);
    f.id = `picture-off:${f.mediaId}:${first ? `${first.mediaId}:${first.index}` : f.from.toFixed(1)}`;
    f.from = r2(f.from);
    f.to = r2(f.to);
  }
  return [...out, ...off].sort((a, b) => a.from - b.from);
}
