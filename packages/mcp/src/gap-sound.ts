/**
 * What the recording holds between two transcript words. A transcript says nothing there, and a pass that reads only
 * the transcript takes every such stretch for a pause: on one pass "You can <1.7 s> see" was trimmed as a pause that
 * held two bursts of speech the transcript had missed, a first "see" and a second "you can", and half the restart
 * stayed in the cut. An editor cutting by ear and waveform sees it at once. Scarlet measures; the model decides.
 */
import type { TimeRange } from "@scarlet/timeline";
import { dbfs } from "./analysis.js";

export interface GapLevels { from: number; to: number; rms: number[] }
export interface GapSound { seconds: number; runs: TimeRange[] }

/** A gap between two words is described from this length. */
export const GAP_SECONDS = 0.4;
/** Sound counts when it is within this of the level speech sits at. A sibilant's hiss and room tone fall well under it. */
const BELOW_SPEECH_DB = 12;
/** In a stretch with little speech the 85th percentile is room tone. Nothing quieter than this counts as sound. */
const QUIETEST_SOUND_DBFS = -45;
const MIN_RUN = 0.1;
/** A word's sound runs a little past its timing either way. */
const WORD_EDGE = 0.05;

/** The level speech sits at in a stretch of a recording: the 85th percentile of its levels, in dBFS. */
export function speakingLevel(levels: GapLevels): number {
  const sorted = levels.rms.map(dbfs).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.85)] ?? -99;
}

/**
 * Sound at speaking level between two words: every run of a tenth of a second or more, clear of each word's own
 * edge. A stretch that does not end on words, such as a range being removed, is read whole with `edge` 0. Undefined
 * when the levels do not cover the gap.
 */
export function gapSound(levels: GapLevels, gap: TimeRange, speechDb = speakingLevel(levels), edge = WORD_EDGE): GapSound | undefined {
  const step = (levels.to - levels.from) / levels.rms.length;
  const start = gap.start + edge, end = gap.end - edge;
  if (!levels.rms.length || step <= 0 || gap.start < levels.from - 1e-6 || gap.end > levels.to + 1e-6) return undefined;
  const floor = Math.max(speechDb - BELOW_SPEECH_DB, QUIETEST_SOUND_DBFS);
  const runs: TimeRange[] = [];
  let open: number | undefined;
  const close = (at: number) => {
    if (open !== undefined && at - open >= MIN_RUN - 1e-6) runs.push({ start: Math.round(open * 100) / 100, end: Math.round(at * 100) / 100 });
    open = undefined;
  };
  for (let i = Math.max(0, Math.floor((start - levels.from) / step)); i < levels.rms.length; i++) {
    const from = Math.max(start, levels.from + i * step), to = Math.min(end, levels.from + (i + 1) * step);
    if (to <= from) break;
    if (dbfs(levels.rms[i]!) >= floor) open ??= from;
    else close(from);
  }
  close(end);
  return { seconds: Math.round(runs.reduce((sum, r) => sum + r.end - r.start, 0) * 100) / 100, runs };
}

/** One clause for the model: how much of a gap is sound, and where. */
export function describeGapSound(sound: GapSound): string {
  return sound.runs.length
    ? `${sound.seconds.toFixed(2)} s of it sound at speaking level that no word explains (${sound.runs.map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(", ")})`
    : "quiet";
}
