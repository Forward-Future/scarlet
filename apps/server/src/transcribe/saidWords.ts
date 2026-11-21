/**
 * Words a transcript tidied away. Whisper writes what a speaker meant: "the logo, the Coco, the Coca-Cola logo" came
 * out "the logo, the Coca-Cola logo" with a second of "pause" where the second take was, a pass trimmed that pause as
 * quiet, and both takes played (2026-11-18). Read again with a prompt in hesitant speech, Whisper keeps restarts like
 * that one, but over a whole recording the same reading also loops on a sentence and drops others: on two of the
 * editor's recordings it wrote one line 40 times over a pause and left out a 27-word passage.
 *
 * So the recording decides, through the aligner that times the transcript. Where the second reading has words the
 * transcript doesn't, the stretch around them is explained once with the transcript's words and once with the reading's,
 * and the reading's go in when they explain the sound better and the aligner places each of them. They never take the
 * place of a word the aligner placed: a quiet line the aligner hears poorly would otherwise go for nothing.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTranscriptToken } from "@scarlet/shared";
import { newId, type TranscriptSegment, type TranscriptWord } from "@scarlet/timeline";
import { alignGroup, ctcPath, groupLabels, CLASSES, CTC_LETTERS, FRAME_SECONDS, MIN_SCORE, SAMPLE_RATE, type Emissions } from "./ctcAlign.js";
import { chunkEnd } from "./whispercpp.js";
import { decodedRecording } from "../services/recordingAudio.js";

/** The hesitant speech a reading is primed with, so Whisper writes restarts and fillers as said. */
export const VERBATIM_PROMPT = "Um, well, uh, I think, I think we should go ahead. Hmm. Yeah.";
/**
 * The reading goes a minute at a time, the length of a pass's scan page. Over two minutes the primed reading tidied
 * the "In fact, what it would do, it was, it would" restart away again, which minute pages kept.
 */
const PAGE_SECONDS = 60;
/**
 * Seconds of the transcript's words either side of a run that are explained with it. Over a few words the times a
 * transcript gave the words beside a restart decide the verdict: they cover the restart's sound. Over twelve seconds
 * either side the verdict no longer moves.
 */
const REACH = 12;
/** Audio either side of those words, so the first and last of them are whole. */
const PAD = 0.5;

const label = (text: string) => /^\s*[\[(*].*[\])*]\s*$/.test(text);
const token = (w: Pick<TranscriptWord, "text">) => label(w.text) ? "" : normalizeTranscriptToken(w.text);

/** A stretch where the reading has more words than the transcript: transcript words [i1, i2), reading words [j1, j2). */
export interface TidiedRun { i1: number; i2: number; j1: number; j2: number }

/** Where the reading says more than the transcript, by the longest run of words both have in order. */
export function tidiedRuns(base: readonly TranscriptWord[], said: readonly TranscriptWord[]): TidiedRun[] {
  const a = base.map(token), b = said.map(token);
  const n = a.length, m = b.length;
  // Longest common subsequence, from the end, so the walk below goes forward.
  const lcs = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[at(i, j)] = a[i] && a[i] === b[j] ? lcs[at(i + 1, j + 1)]! + 1 : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!);
  }
  const runs: TidiedRun[] = [];
  let i = 0, j = 0, i1 = 0, j1 = 0;
  const close = () => { if (j - j1 > i - i1 && b.slice(j1, j).some(Boolean)) runs.push({ i1, i2: i, j1, j2: j }); };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] && a[i] === b[j]) {
      close();
      i++; j++; i1 = i; j1 = j;
    } else if (j < m && (i >= n || lcs[at(i, j + 1)]! >= lcs[at(i + 1, j)]!)) j++;
    else i++;
  }
  close();
  return runs;
}

/** How well `words` explain the frames: a CTC path's log probability, or the frames as silence when there are none. */
function explained(em: Emissions, words: readonly TranscriptWord[]) {
  const { tokens } = groupLabels(words, CTC_LETTERS);
  if (!tokens.length) {
    let sum = 0;
    for (let f = 0; f < em.frames; f++) sum += em.logProbs[f * CLASSES]!;
    return sum;
  }
  return ctcPath(em.logProbs, 0, em.frames, tokens, CLASSES)?.score ?? -Infinity;
}

/** A minute of the recording read with the prompt, its words on the recording's clock. */
export interface SaidPage { from: number; to: number; words: TranscriptWord[] }

/** Words put back where they were said, and the unplaced words of the transcript they took the place of. */
export interface PutBack { words: TranscriptWord[]; replaced: TranscriptWord[] }

/**
 * The transcript with what the pages say and it doesn't, where the recording bears that out. `frames` gives the
 * aligner's emissions over a stretch of the recording, or nothing when it can't.
 *
 * The words beside a run take the times the aligner gives them with the run in place. The transcript had stretched
 * them over the take it dropped: its one "Coca-Cola" sat on the first take's "Coco", and with "Coco, the" back it moves
 * to the second take, where it was said.
 */
export async function putBackWords(segments: readonly TranscriptSegment[], pages: readonly SaidPage[],
  frames: (start: number, end: number) => Promise<Emissions | undefined>, signal?: AbortSignal): Promise<{ segments: TranscriptSegment[]; found: PutBack[] }> {
  // Copies of the transcript's words, retimed in place; each remembers its segment by place, not id: a segment split
  // where two windows' readings hand over keeps its id in both halves, and a word filed by id went into both (seen
  // on two recordings, 2026-11-20).
  const home = new Map<TranscriptWord, number>();
  const original = new Map<TranscriptWord, TranscriptWord>();
  segments.forEach((s, i) => { for (const w of s.words) {
    const copy = { ...w };
    home.set(copy, i);
    original.set(w, copy);
  } });
  const base = [...original.values()].filter(w => token(w)).sort((x, y) => x.start - y.start);
  // Each page is compared with the transcript's words over the same minute, and a little either side for a word
  // the two place on different sides of the page's edge.
  const runs = pages.flatMap(page => {
    const heard = page.words.filter(w => token(w)).sort((x, y) => x.start - y.start);
    const first = base.findIndex(w => (w.start + w.end) / 2 >= page.from - 1);
    if (first < 0 || !heard.length) return [];
    let last = first;
    while (last < base.length && (base[last]!.start + base[last]!.end) / 2 < page.to + 1) last++;
    return tidiedRuns(base.slice(first, last), heard).map(r => ({
      added: heard.slice(r.j1, r.j2), replaced: base.slice(first + r.i1, first + r.i2), after: base[first + r.i1 - 1] }));
  });
  const current = [...base];
  const found: PutBack[] = [];
  // Words beside a run that the aligner placed again with it, and those it couldn't, which kept their old times.
  const placed = new Set<TranscriptWord>(), unplaced = new Set<TranscriptWord>();
  for (const run of runs) {
    signal?.throwIfAborted();
    const { added, replaced } = run;
    const afterAt = !replaced.length && run.after ? current.indexOf(run.after) : -1;
    const at = replaced.length ? current.indexOf(replaced[0]!) : run.after ? (afterAt < 0 ? -1 : afterAt + 1) : 0;
    if (at < 0 || replaced.some((w, k) => current[at + k] !== w)) continue;
    const from = Math.min(added[0]!.start, replaced[0]?.start ?? Infinity), to = Math.max(added.at(-1)!.end, replaced.at(-1)?.end ?? -Infinity);
    let a = at;
    while (a > 0 && current[a - 1]!.start >= from - REACH) a--;
    let b = at + replaced.length;
    while (b < current.length && current[b]!.end <= to + REACH) b++;
    const before = current.slice(a, at), after = current.slice(at + replaced.length, b);
    const start = Math.max(0, Math.min(from, before[0]?.start ?? from) - PAD), end = Math.max(to, after.at(-1)?.end ?? to) + PAD;
    const em = await frames(start, end);
    if (!em) continue;
    const window = { start: em.origin, end: em.origin + em.frames * FRAME_SECONDS };
    // A word the transcript has that the aligner placed stays: the reading may only add.
    const kept = alignGroup(em, [...before, ...replaced, ...after], window.start, window.end).slice(before.length, before.length + replaced.length);
    if (kept.some(t => t && t.score >= MIN_SCORE)) continue;
    const withRun = [...before, ...added, ...after];
    const timed = alignGroup(em, withRun, window.start, window.end);
    if (timed.slice(before.length, before.length + added.length).some(t => !t || t.score < MIN_SCORE)) continue;
    if (explained(em, withRun) <= explained(em, [...before, ...replaced, ...after])) continue;
    const words = added.map((w, k) => {
      const t = timed[before.length + k]!;
      const put: TranscriptWord = { text: w.text, start: t.start, end: Math.max(t.start, t.end), ...(w.confidence !== undefined && { confidence: w.confidence }) };
      home.set(put, home.get(replaced[0] ?? run.after ?? after[0]!) ?? Math.max(0, segments.findIndex(s => s.words.length)));
      placed.add(put);
      return put;
    });
    [...before, ...after].forEach((w, k) => {
      const t = timed[k < before.length ? k : k + added.length];
      if (t && t.score >= MIN_SCORE) { w.start = t.start; w.end = Math.max(t.start, t.end); placed.add(w); }
      else unplaced.add(w);
    });
    current.splice(at, replaced.length, ...words);
    found.push({ words, replaced: replaced.slice() });
  }
  if (!found.length) return { segments: [...segments], found };
  // The order is the one the runs were put in, not the times: a word the aligner couldn't place kept its time, which
  // can now cover or sit past a neighbour it placed. Such a word goes between its neighbours, and takes no time where
  // they leave it none. Moving the placed words instead pushed a restart put back under a stale "When" to its end, at
  // no length: "When[60.36-60.86] when[0] you,[0] when[0]" (2026-11-20).
  const stale = (w: TranscriptWord) => unplaced.has(w) && !placed.has(w);
  current.forEach((w, k) => {
    if (!stale(w)) return;
    const lo = current[k - 1]?.end ?? -Infinity;
    const hi = Math.max(lo, current.slice(k + 1).find(n => !stale(n))?.start ?? Infinity);
    w.start = Math.min(Math.max(w.start, lo), hi);
    w.end = Math.min(Math.max(w.end, w.start), hi);
  });
  current.forEach((w, k) => {
    const previous = current[k - 1], next = current[k + 1];
    if (previous && w.start < previous.end) {
      w.start = previous.end;
      w.end = Math.max(w.start, next && next.start > w.start ? Math.min(w.end, next.start) : w.end);
    }
  });
  const order = new Map(current.map((w, k) => [w, k] as const));
  // A word with no place in the order (a label, a sound Whisper only named) keeps its place among the others by time.
  const rank = (w: TranscriptWord) => {
    const k = order.get(w);
    if (k !== undefined) return k;
    const next = current.findIndex(c => c.start > w.start);
    return (next < 0 ? current.length : next) - 0.5;
  };
  const gone = new Set(found.flatMap(f => f.replaced));
  const added = found.flatMap(f => f.words);
  const out = segments.map((s, i) => {
    const words = [...s.words.map(w => original.get(w)!).filter(w => !gone.has(w)), ...added.filter(w => home.get(w) === i)]
      .sort((x, y) => rank(x) - rank(y));
    return words.length
      ? { ...s, words, start: Math.min(s.start, words[0]!.start), end: Math.max(s.end, words.at(-1)!.end), text: words.map(w => w.text).join(" ") }
      : { ...s, words };
  }).filter((s, i) => s.words.length || !segments[i]!.words.length);
  return { segments: out.sort((x, y) => (x.words[0]?.start ?? x.start) - (y.words[0]?.start ?? y.start)), found };
}

/**
 * Read a recording again a minute at a time with the hesitant-speech prompt and put back what its transcript tidied
 * away. `read` transcribes one minute's WAV with the prompt; `frames` gives the aligner's emissions over a stretch.
 */
export async function putBackTidiedWords(input: { wav: string; segments: TranscriptSegment[]; tmpDir: string; signal: AbortSignal;
  read(wav: string, prompt: string): Promise<TranscriptSegment[]>;
  frames(start: number, end: number): Promise<Emissions | undefined>; log(message: string): void;
  /** How much of the recording has been read again, after each minute. */
  onProgress?(fraction: number): void }) {
  const { signal } = input;
  const started = Date.now();
  const audio = await decodedRecording(input.wav);
  const duration = audio.samples / SAMPLE_RATE;
  const pages: SaidPage[] = [];
  const page = join(input.tmpDir, newId("said") + ".wav");
  try {
    for (let from = 0; from < duration;) {
      signal.throwIfAborted();
      const to = await chunkEnd(audio, from, duration, PAGE_SECONDS);
      await audio.writeWindow(page, from, to);
      const segments = await input.read(page, VERBATIM_PROMPT);
      // Whisper's 10 ms times can round past the end of the minute it heard.
      const onClock = (t: number) => Math.min(to, Math.max(from, from + t));
      pages.push({ from, to, words: segments.flatMap(s => s.words.map(w => ({ ...w, start: onClock(w.start), end: onClock(w.end) }))) });
      from = to;
      input.onProgress?.(Math.min(1, from / duration));
    }
  } finally { await rm(page, { force: true }); }
  const { segments, found } = await putBackWords(input.segments, pages, input.frames, signal);
  const took = `${Math.round((Date.now() - started) / 1000)} s`;
  if (!found.length) {
    input.log(`[transcribe] read the recording again for words the transcript tidied away (${took}): none`);
    return input.segments;
  }
  const lines = found.map(f => `“${f.words.map(w => w.text).join(" ")}” at ${f.words[0]!.start.toFixed(1)} s`);
  input.log(`[transcribe] put back ${found.reduce((n, f) => n + f.words.length, 0)} words the transcript tidied away (${took}): ${lines.slice(0, 6).join(", ")}${lines.length > 6 ? ", …" : ""}`);
  return segments;
}
