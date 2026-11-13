/** Synthetic recordings and timelines. Never put real project data in this directory. */
import type { MediaClip, Timeline } from "../../packages/timeline/src/index.ts";
import type { Levels, MediaEvidence, Word } from "../src/metrics.ts";
import type { MediaInfo } from "../src/timeline.ts";

export const FLOOR_DB = -86;
export const SPEECH_DB = -28;
export const BREATH_DB = -60;
export const STEP = 0.02;

/** Words at fixed times; levels are speech inside words, a breath where asked, room floor elsewhere. */
export function recording(mediaId: string, duration: number, spoken: Array<[string, number, number]>, breaths: Array<[number, number]> = []): MediaEvidence {
  const words: Word[] = spoken.map(([text, start, end]) => ({ text, start, end }));
  const db: number[] = [];
  for (let i = 0; i < Math.round(duration / STEP); i++) {
    const a = i * STEP, b = a + STEP;
    const inWord = words.some(w => w.start < b && a < w.end);
    const inBreath = breaths.some(([s, e]) => s < b && a < e);
    db.push(inWord ? SPEECH_DB : inBreath ? BREATH_DB : FLOOR_DB);
  }
  const levels: Levels = { from: 0, step: STEP, db };
  return { mediaId, duration, words, levels };
}

/** A talking-head line every 2 s: "Line n." spoken from 2n+0.5 to 2n+1.5 s, as two words. */
export function lines(mediaId: string, count: number): MediaEvidence {
  const spoken: Array<[string, number, number]> = [];
  for (let n = 0; n < count; n++) {
    spoken.push([`Line`, 2 * n + 0.5, 2 * n + 1.0], [`${n}.`, 2 * n + 1.0, 2 * n + 1.5]);
  }
  return recording(mediaId, 2 * count, spoken);
}

export const media = (id = "med_mic", duration = 20): MediaInfo => ({ id, kind: "video", hasAudio: true, duration });

function clip(id: string, mediaId: string, timelineIn: number, sourceIn: number, sourceOut: number, volume = 1): MediaClip {
  return { id, kind: "media", mediaId, timelineIn, sourceIn, sourceOut, speed: 1, opacity: 1, volume, audioFadeIn: 0, audioFadeOut: 0,
    videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true };
}

/** A timeline that plays `keep` source ranges back to back, plus a silent screen track over the whole program. */
export function cut(version: string, mediaId: string, keep: Array<[number, number]>): Timeline {
  let at = 0;
  const clips = keep.map(([s, e], i) => {
    const c = clip(`c${i}`, mediaId, at, s, e);
    at += e - s;
    return c;
  });
  return {
    version, parent: null, projectId: "prj_test", name: "Main", markers: [], background: "#000000",
    tracks: [
      { id: "screen", kind: "video", name: "Screen", muted: false, hidden: false, clips: [clip("s0", "med_screen", 0, 0, at, 0)] },
      { id: "cam", kind: "video", name: "Camera", muted: false, hidden: false, clips },
    ],
  };
}
