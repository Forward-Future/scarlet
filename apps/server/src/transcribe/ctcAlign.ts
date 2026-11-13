/**
 * CTC forced alignment of transcript words against wav2vec2 character emissions.
 * Pure functions: the worker in wordAlign.ts runs the model and calls these.
 */
import type { TranscriptSegment } from "@scarlet/timeline";

export const SAMPLE_RATE = 16000;
/** wav2vec2's feature encoder emits one frame per 320 samples (20 ms) from a 400-sample receptive field. */
export const FRAME_SAMPLES = 320;
const RECEPTIVE_SAMPLES = 400;
export const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;
export const CLASSES = 32;
export const BLANK = 0;
export const SEPARATOR = 4;
/** Spoken but not spellable in the model's alphabet (numbers, symbols, other scripts). Matches any character. */
export const WILDCARD = -1;
// facebook/wav2vec2-base-960h vocabulary: <pad>=0 (CTC blank), <s>, </s>, <unk>, "|"=4, then these from 5.
export const CTC_LETTERS = "ETAONIHSRDLUMWCFGYPBVK'XJQZ";
const APOSTROPHE = 5 + CTC_LETTERS.indexOf("'");

/** Frames the model emits for `samples` of audio. */
export function framesFor(samples: number): number {
  return samples < RECEPTIVE_SAMPLES ? 0 : Math.floor((samples - RECEPTIVE_SAMPLES) / FRAME_SAMPLES) + 1;
}

/**
 * Character labels for one transcript word. `null` when the text is not speech (punctuation, bracketed sound
 * tags). A single WILDCARD when the word is spoken but cannot be spelled in A–Z (its own times are kept,
 * but it still occupies audio between its neighbors).
 */
export function wordLabels(text: string): number[] | null {
  const raw = text.trim();
  if (!raw || /^[[(*♪].*[\])*♪]$/u.test(raw)) return null;
  const s = raw.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[‘’ʼ`´]/g, "'").toUpperCase();
  const out: number[] = [];
  const letter = (ch: string | undefined) => !!ch && ch !== "'" && CTC_LETTERS.includes(ch);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (letter(ch)) out.push(5 + CTC_LETTERS.indexOf(ch));
    else if (ch === "'") {
      // Contractions keep their apostrophe; quotes around a word do not.
      if (letter(s[i - 1]) && letter(s[i + 1])) out.push(APOSTROPHE);
    } else if (/[-–—/]/.test(ch)) {
      if (out.length && out.at(-1) !== SEPARATOR && letter(s[i + 1])) out.push(SEPARATOR);
    } else if (/[\p{L}\p{N}$%&@+#=€£]/u.test(ch)) return [WILDCARD];
  }
  return out.length ? out : null;
}

/** Measured on a gated close mic against energy onsets: the first letter's frame lags the onset by ~20 ms. */
const ONSET_LEAD = 0.02;
/** At most 300 ms of a following separator counts as the word's tail; longer is a pause. */
const MAX_TAIL_FRAMES = 15;

export interface AlignWord { text: string; start: number; end: number }
export interface WordTiming { start: number; end: number; score: number }

/** Labels for a run of words, a word separator after each spoken word. The model emits the separator as
 * the word's sound ends, so it marks word ends better than the last letter's emission spike. */
export function groupLabels(words: readonly AlignWord[]) {
  const tokens: number[] = [];
  const owner: number[] = [];
  let spoken = 0, spelled = 0;
  words.forEach((w, i) => {
    const labels = wordLabels(w.text);
    if (!labels) return;
    spoken++;
    if (labels[0] !== WILDCARD) spelled++;
    for (const t of labels) { tokens.push(t); owner.push(i); }
    tokens.push(SEPARATOR);
    owner.push(-1);
  });
  return { tokens, owner, spoken, spelled };
}

/**
 * Viterbi path through the CTC topology (optional blanks around every label, a blank required between
 * repeated labels) over frames [from, to) of a (frames × CLASSES) log-probability matrix.
 * Returns each label's first and last frame, or null when the frames cannot hold the labels.
 */
export function ctcAlign(logProbs: Float32Array, from: number, to: number, tokens: readonly number[]): Array<[number, number]> | null {
  const T = to - from, L = tokens.length, S = 2 * L + 1;
  let required = L;
  for (let k = 1; k < L; k++) if (tokens[k] === tokens[k - 1] && tokens[k] !== WILDCARD) required++;
  if (!L || T < required || T * S > 64e6) return null;
  const wild = tokens.includes(WILDCARD) ? new Float32Array(T) : undefined;
  if (wild) {
    for (let t = 0; t < T; t++) {
      let best = -Infinity;
      for (let c = 5; c < CLASSES; c++) best = Math.max(best, logProbs[(from + t) * CLASSES + c]!);
      wild[t] = best;
    }
  }
  const emit = (t: number, s: number) => {
    const token = s % 2 === 0 ? BLANK : tokens[(s - 1) / 2]!;
    return token === WILDCARD ? wild![t]! : logProbs[(from + t) * CLASSES + token]!;
  };
  // A label can be entered from the previous blank, or directly from the previous label when they differ.
  const skip = new Uint8Array(S);
  for (let s = 3; s < S; s += 2) {
    const a = tokens[(s - 1) / 2], b = tokens[(s - 3) / 2];
    skip[s] = Number(a !== b || a === WILDCARD);
  }
  const back = new Uint8Array(T * S);
  let prev = new Float64Array(S).fill(-Infinity), cur = new Float64Array(S);
  prev[0] = emit(0, 0);
  if (S > 1) prev[1] = emit(0, 1);
  for (let t = 1; t < T; t++) {
    // States that can still finish by the last frame, and that are reachable by now.
    const lo = Math.max(0, S - 2 * (T - t)), hi = Math.min(S - 1, 2 * t + 1);
    cur.fill(-Infinity);
    for (let s = lo; s <= hi; s++) {
      let best = prev[s]!, arg = 0;
      if (s >= 1 && prev[s - 1]! > best) { best = prev[s - 1]!; arg = 1; }
      if (skip[s] && prev[s - 2]! > best) { best = prev[s - 2]!; arg = 2; }
      if (best === -Infinity) continue;
      cur[s] = best + emit(t, s);
      back[t * S + s] = arg;
    }
    [prev, cur] = [cur, prev];
  }
  let s = S > 1 && prev[S - 2]! > prev[S - 1]! ? S - 2 : S - 1;
  if (prev[s] === -Infinity) return null;
  const spans: Array<[number, number]> = new Array(L);
  for (let t = T - 1; t >= 0; t--) {
    if (s % 2) {
      const k = (s - 1) / 2;
      const span = spans[k];
      if (span) span[0] = from + t;
      else spans[k] = [from + t, from + t];
    }
    if (t) s -= back[t * S + s]!;
  }
  return spans;
}

/** Peak probability of a label within its aligned frames. */
function peak(logProbs: Float32Array, token: number, [first, last]: [number, number]) {
  let best = -Infinity;
  for (let t = first; t <= last; t++) best = Math.max(best, logProbs[t * CLASSES + token]!);
  return Math.exp(best);
}

export interface Emissions {
  /** (frames × CLASSES) log probabilities. */
  logProbs: Float32Array;
  frames: number;
  /** Seconds of frame 0, in the caller's time base. */
  origin: number;
}

/**
 * Align one run of words inside the window [start, end) seconds. A word's score is the mean peak probability
 * of its letters; wildcard and unspoken words get no timing.
 */
export function alignGroup(em: Emissions, words: readonly AlignWord[], start: number, end: number): Array<WordTiming | undefined> {
  const out: Array<WordTiming | undefined> = new Array(words.length).fill(undefined);
  const { tokens, owner, spoken, spelled } = groupLabels(words);
  // Mostly unspellable text (another language, numbers) gives the aligner too little to anchor on.
  if (!spelled || spelled < 0.6 * spoken) return out;
  const from = Math.max(0, Math.floor((start - em.origin) / FRAME_SECONDS));
  const to = Math.min(em.frames, Math.ceil((end - em.origin) / FRAME_SECONDS));
  if (to <= from) return out;
  const spans = ctcAlign(em.logProbs, from, to, tokens);
  if (!spans) return out;
  const time = (frame: number) => em.origin + frame * FRAME_SECONDS;
  let k = 0, previousEnd = -Infinity;
  while (k < tokens.length) {
    const word = owner[k]!;
    if (word < 0) { k++; continue; }
    const first = k;
    let total = 0, letters = 0;
    for (; k < tokens.length && owner[k] === word; k++) {
      if (tokens[k]! >= 5) { total += peak(em.logProbs, tokens[k]!, spans[k]!); letters++; }
    }
    if (!letters) continue;
    // A letter is emitted shortly after its sound begins. The lead never reaches back past zero, where the caller's
    // audio starts: a transcript can't hold a negative time.
    const end = Math.min(spans[k]![1] + 1, spans[k - 1]![1] + 1 + MAX_TAIL_FRAMES);
    out[word] = { start: Math.max(0, previousEnd, time(spans[first]![0]) - ONSET_LEAD), end: time(end), score: total / letters };
    previousEnd = time(end);
  }
  return out;
}

/**
 * Inference windows of at most `size` samples, overlapping by at least `overlap`. Starts are frame-aligned so
 * frames line up globally; each frame is kept from the window whose center it is nearest ([keep[0], keep[1])
 * in global frames).
 */
export function planChunks(samples: number, size = 30 * SAMPLE_RATE, overlap = 2 * SAMPLE_RATE) {
  const total = framesFor(samples);
  const chunks: Array<{ start: number; length: number; keep: [number, number] }> = [];
  if (!total) return chunks;
  const stride = Math.max(FRAME_SAMPLES, Math.floor((size - overlap) / FRAME_SAMPLES) * FRAME_SAMPLES);
  for (let start = 0; ; start += stride) {
    // Keep the last window full length so it has as much context as the others.
    const last = start + size >= samples;
    if (last) start = Math.max(0, Math.ceil((samples - size) / FRAME_SAMPLES) * FRAME_SAMPLES);
    const length = Math.min(size, samples - start);
    const first = start / FRAME_SAMPLES;
    const previous = chunks.at(-1);
    let keep = first;
    if (previous) {
      keep = Math.floor((first + previous.start / FRAME_SAMPLES + framesFor(previous.length)) / 2);
      previous.keep[1] = keep;
    }
    chunks.push({ start, length, keep: [keep, first + framesFor(length)] });
    if (last) break;
  }
  return chunks;
}

/** Join per-window model outputs ((frames × CLASSES) each) into one matrix for the planned range. */
export function stitchChunks(chunks: ReturnType<typeof planChunks>, outputs: readonly Float32Array[]): Float32Array {
  const frames = chunks.length ? chunks.at(-1)!.keep[1] : 0;
  const out = new Float32Array(frames * CLASSES);
  chunks.forEach((chunk, i) => {
    const first = chunk.start / FRAME_SAMPLES;
    const [from, to] = chunk.keep;
    out.set(outputs[i]!.subarray((from - first) * CLASSES, (to - first) * CLASSES), from * CLASSES);
  });
  return out;
}

/** In-place log-softmax over each frame's classes. */
export function logSoftmax(logits: Float32Array): Float32Array {
  for (let at = 0; at < logits.length; at += CLASSES) {
    let max = -Infinity;
    for (let c = 0; c < CLASSES; c++) max = Math.max(max, logits[at + c]!);
    let sum = 0;
    for (let c = 0; c < CLASSES; c++) sum += Math.exp(logits[at + c]! - max);
    const norm = max + Math.log(sum);
    for (let c = 0; c < CLASSES; c++) logits[at + c] = logits[at + c]! - norm;
  }
  return logits;
}

/** Mean letter peak probability below which a word keeps its original time. Spoken words score ~1; text the
 * audio does not contain (Whisper's repetition loops, words invented over silence) scores near 0. */
export const MIN_SCORE = 0.2;

/**
 * Consecutive segments joined into runs of at most `maxSeconds` (Whisper's segment edges are themselves
 * approximate). A longer segment splits between words. `index` holds each word's position in the flat
 * word order of `segments`. A resumed alignment starts a fresh group at its first unfinished word.
 */
export function alignmentGroups(segments: readonly TranscriptSegment[], maxSeconds = 30, fromWord = 0) {
  type Group = { start: number; end: number; words: AlignWord[]; index: number[] };
  const groups: Group[] = [];
  let current: Group | undefined;
  let flat = 0;
  for (const seg of segments) {
    const skipped = Math.min(seg.words.length, Math.max(0, fromWord - flat));
    flat += skipped;
    const words = skipped ? seg.words.slice(skipped) : seg.words;
    if (!words.length) continue;
    const lo = skipped ? words[0]!.start : Math.min(seg.start, words[0]!.start);
    const hi = words.reduce((end, w) => Math.max(end, w.end), seg.end);
    if (!current || hi - current.start > maxSeconds) {
      current = undefined;
      for (const w of words) {
        if (!current || w.end - current.start > maxSeconds) groups.push(current = { start: current ? w.start : lo, end: w.end, words: [], index: [] });
        current.words.push({ text: w.text, start: w.start, end: w.end });
        current.index.push(flat++);
        current.end = Math.max(current.end, w.end);
      }
    } else {
      for (const w of words) {
        current.words.push({ text: w.text, start: w.start, end: w.end });
        current.index.push(flat++);
      }
    }
    current!.end = Math.max(current!.end, hi);
  }
  return groups;
}

/**
 * New segments with confident aligned times (by flat word index). Other words keep their own times, fitted
 * into the gap between their aligned neighbors so that word order holds. Segment bounds widen to cover
 * their words.
 */
export function applyTimings(segments: readonly TranscriptSegment[], timings: ReadonlyArray<WordTiming | null | undefined>, minScore = MIN_SCORE, fixedPrefix = 0): TranscriptSegment[] {
  const words = segments.flatMap(s => s.words);
  const times = words.map((w, i) => {
    const t = timings[i];
    return t && t.score >= minScore && t.end >= t.start ? { start: t.start, end: t.end, aligned: true } : { start: w.start, end: w.end, aligned: i < fixedPrefix };
  });
  for (let i = 0; i < times.length;) {
    if (times[i]!.aligned) { i++; continue; }
    const first = i;
    while (i < times.length && !times[i]!.aligned) i++;
    const run = times.slice(first, i);
    const lo = first > 0 ? times[first - 1]!.end : -Infinity;
    const hi = i < times.length ? times[i]!.start : Infinity;
    if (lo === -Infinity && hi === Infinity) continue;
    const rs = run.reduce((v, t) => Math.min(v, t.start), Infinity), re = run.reduce((v, t) => Math.max(v, t.end), -Infinity);
    if (rs >= lo && re <= hi) continue;
    if (lo === -Infinity || hi === Infinity || hi <= lo) {
      for (const t of run) {
        t.start = Math.min(Math.max(t.start, lo), hi);
        t.end = Math.min(Math.max(t.end, t.start), hi);
      }
      continue;
    }
    // Keep the part of the original span inside the gap, or the whole gap when they do not meet.
    const a = Math.max(lo, rs), b = Math.min(hi, re);
    const [to0, to1] = b > a ? [a, b] : [lo, hi];
    const scale = re > rs ? (to1 - to0) / (re - rs) : 0;
    for (const t of run) {
      t.start = to0 + (t.start - rs) * scale;
      t.end = Math.max(t.start, to0 + (t.end - rs) * scale);
    }
  }
  let at = 0;
  return segments.map(seg => {
    const next = seg.words.map(w => {
      const t = times[at++]!;
      return t.start === w.start && t.end === w.end ? w : { ...w, start: round(t.start), end: round(t.end) };
    });
    if (!next.length) return seg;
    return { ...seg, start: Math.min(seg.start, next[0]!.start), end: next.reduce((end, w) => Math.max(end, w.end), seg.end), words: next };
  });
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
