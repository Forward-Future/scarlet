/**
 * What the recording holds between two transcript words. A transcript says nothing there, and a pass that reads only
 * the transcript takes every such stretch for a pause: on one pass "You can <1.7 s> see" was trimmed as a pause that
 * held two bursts of speech the transcript had missed, a first "see" and a second "you can", and half the restart
 * stayed in the cut. An editor cutting by ear and waveform sees it at once. Scarlet measures; the model decides.
 */
import type { TimeRange, TranscriptWord } from "@scarlet/timeline";
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
  return typicalLevel([...levels.rms]);
}

function typicalLevel(samples: number[]) {
  samples.sort((a, b) => a - b);
  return dbfs(samples[Math.floor(samples.length * 0.85)] ?? 0);
}

export interface QuietPhrase extends TimeRange {
  text: string;
  fromWord: number;
  toWord: number;
  /** 85th-percentile RMS during the timed words, in dBFS. The comparisons use the nearest two seconds of each phrase. */
  levelDbfs: number;
  beforeDbfs: number;
  afterDbfs: number;
}

const NEIGHBOR_SECONDS = 2, MAX_NEIGHBOR_GAP = 12, MAX_PHRASE_SECONDS = 8;
const isSpoken = (text: string) => !!text.trim() && !/^\s*\[.*\]\s*$/.test(text);
/** Enough overlap to compare a phrase at the boundary of two level readings. */
export const QUIET_PHRASE_CONTEXT = MAX_PHRASE_SECONDS + MAX_NEIGHBOR_GAP + NEIGHBOR_SECONDS;

/** Short transcribed phrases between pauses that are very soft on this recording compared with the words on both sides. */
export function quietPhrases(words: readonly TranscriptWord[], levels: GapLevels, settledThrough = Infinity): QuietPhrase[] {
  const step = (levels.to - levels.from) / levels.rms.length;
  if (!(step > 0 && step <= .031)) return [];
  const until = Math.min(levels.to, settledThrough);
  type Phrase = TimeRange & { fromWord: number; toWord: number };
  const phrases: Phrase[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.start >= until) break;
    if (w.start < levels.from || w.end > until || w.end < w.start || !isSpoken(w.text)) continue;
    const previous = phrases.at(-1);
    if (previous && w.start - previous.end < GAP_SECONDS - 1e-6) {
      previous.toWord = i;
      previous.end = Math.max(previous.end, w.end);
    } else phrases.push({ fromWord: i, toWord: i, start: w.start, end: w.end });
  }
  // Count each measured bucket inside a word once. The waits between words cannot lower the phrase's level.
  const measure = (p: Phrase, from: number, to: number) => {
    const samples: number[] = [];
    const index = (t: number) => Math.ceil((t - levels.from) / step - .5);
    let next = Math.max(0, index(from));
    for (let i = p.fromWord; i <= p.toWord; i++) {
      const w = words[i]!;
      if (!isSpoken(w.text)) continue;
      next = Math.max(next, index(w.start));
      const until = Math.min(index(Math.min(to, w.end)), levels.rms.length);
      while (next < until) samples.push(levels.rms[next++]!);
    }
    return samples.length * step >= MIN_RUN - 1e-6 ? typicalLevel(samples) : undefined;
  };
  const found: QuietPhrase[] = [];
  for (let i = 1; i < phrases.length - 1; i++) {
    const p = phrases[i]!, before = phrases[i - 1]!, after = phrases[i + 1]!;
    if (p.end - p.start > MAX_PHRASE_SECONDS || p.start - before.end > MAX_NEIGHBOR_GAP || after.start - p.end > MAX_NEIGHBOR_GAP) continue;
    const levelDbfs = measure(p, p.start, p.end);
    if (levelDbfs === undefined || levelDbfs > QUIETEST_SOUND_DBFS) continue;
    const beforeDbfs = measure(before, before.end - NEIGHBOR_SECONDS, before.end);
    const afterDbfs = measure(after, after.start, after.start + NEIGHBOR_SECONDS);
    // At least eight times quieter in amplitude than both neighboring deliveries.
    if (beforeDbfs === undefined || afterDbfs === undefined || Math.min(beforeDbfs, afterDbfs) - levelDbfs < 18) continue;
    const text = words.slice(p.fromWord, p.toWord + 1).filter(w => isSpoken(w.text)).map(w => w.text.trim()).join(" ");
    found.push({ ...p, text, levelDbfs, beforeDbfs, afterDbfs });
  }
  return found;
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
