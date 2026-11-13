/**
 * Speech a transcript left out. Whisper reads thirty seconds at a time, and after a long wait it can skip a short
 * remark and resume at the next sentence: on one recording “I don’t know. That’s kind of cute.” had no words at all,
 * ten seconds of the transcript read as a pause, and a cut resumed inside “cute” because nothing said a word was
 * there. The recording says where that happened: sound at speaking level that no word explains. Those stretches are
 * laid end to end, read once more on their own, and the words heard go back where they were said.
 */
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gapSound, speakingLevel, type GapLevels } from "@scarlet/mcp/gap-sound";
import { normalizeTranscriptToken } from "@scarlet/shared";
import { newId, type TimeRange, type TranscriptSegment, type TranscriptWord } from "@scarlet/timeline";
import { SAMPLE_RATE } from "./ctcAlign.js";
import { openWav } from "./wordAlign.js";

/** A stretch without words is read again from this length. Shorter ones are the pauses inside a sentence. */
export const HOLE_GAP = 1;
/** Sound at speaking level this long in all, with one run of at least HOLE_RUN, is more than a breath or a click. */
const HOLE_SOUND = 0.4, HOLE_RUN = 0.25;
/** Read this much either side of the sound, inside the gap. */
const HOLE_PAD = 0.3;
/** Silence laid between two stretches, so Whisper ends one before it begins the next. */
const SPACER = 1;
/** Levels are read in 20 ms steps, as the waveform a pass measures edges on. */
const STEP = 0.02;
/** The level speech sits at is taken five minutes at a time: a recording's level drifts over an hour. */
const LEVEL_CHUNK = 300;

const label = (text: string) => /^\s*[\[(*].*[\])*]\s*$/.test(text);
const spoken = (w: Pick<TranscriptWord, "text" | "start" | "end">) => w.end > w.start && !label(w.text) && !!normalizeTranscriptToken(w.text);

/** RMS of a 16 kHz mono WAV in 20 ms steps. */
export async function wavLevels(path: string, signal?: AbortSignal): Promise<GapLevels> {
  const wav = await openWav(path);
  try {
    const size = Math.round(STEP * SAMPLE_RATE), count = Math.floor(wav.samples / size);
    const rms = new Array<number>(count);
    const block = 3000;
    for (let from = 0; from < count; from += block) {
      signal?.throwIfAborted();
      const to = Math.min(count, from + block);
      const pcm = await wav.read(from * size, to * size);
      for (let i = from; i < to; i++) {
        let sum = 0;
        for (let k = (i - from) * size, end = k + size; k < end; k++) sum += pcm[k]! * pcm[k]!;
        rms[i] = Math.sqrt(sum / size);
      }
    }
    return { from: 0, to: count * STEP, rms };
  } finally { await wav.close(); }
}

/**
 * The stretches of a recording that hold sound at speaking level between two transcript words a second or more
 * apart, before the first word or after the last. Word times must be the aligned ones: Whisper's own stretch a word
 * across the wait beside it, which hides exactly these.
 */
export function transcriptHoles(segments: TranscriptSegment[], levels: GapLevels): TimeRange[] {
  const words = segments.flatMap(s => s.words).filter(spoken).sort((a, b) => a.start - b.start);
  const step = levels.rms.length ? (levels.to - levels.from) / levels.rms.length : 0;
  if (!step) return [];
  const speech = new Map<number, number>();
  const speechAt = (t: number) => {
    const chunk = Math.floor(t / LEVEL_CHUNK);
    let db = speech.get(chunk);
    if (db === undefined) {
      const from = Math.max(0, Math.floor((chunk * LEVEL_CHUNK - levels.from) / step)), to = Math.min(levels.rms.length, Math.ceil(((chunk + 1) * LEVEL_CHUNK - levels.from) / step));
      db = speakingLevel({ from: 0, to: 1, rms: levels.rms.slice(from, to) });
      speech.set(chunk, db);
    }
    return db;
  };
  const holes: TimeRange[] = [];
  const consider = (start: number, end: number) => {
    if (end - start < HOLE_GAP) return;
    const sound = gapSound(levels, { start, end }, speechAt(start));
    if (!sound || sound.seconds < HOLE_SOUND || !sound.runs.some(r => r.end - r.start >= HOLE_RUN)) return;
    holes.push({ start: Math.max(start, sound.runs[0]!.start - HOLE_PAD), end: Math.min(end, sound.runs.at(-1)!.end + HOLE_PAD) });
  };
  let cursor = levels.from;
  for (const w of words) {
    consider(cursor, Math.min(w.start, levels.to));
    cursor = Math.max(cursor, w.end);
  }
  if (words.length) consider(cursor, levels.to);
  return holes;
}

/** Where a stretch of the recording sits in the audio laid end to end. */
export interface HolePiece { source: number; at: number; length: number }

/** Lay the holes end to end in one 16 kHz mono WAV, silence between them. */
export async function writeHoleAudio(wavPath: string, holes: TimeRange[], out: string): Promise<HolePiece[]> {
  const wav = await openWav(wavPath);
  try {
    const pieces: HolePiece[] = [];
    const parts: Buffer[] = [];
    const spacer = Buffer.alloc(Math.round(SPACER * SAMPLE_RATE) * 2);
    let samples = 0;
    for (const hole of holes) {
      const from = Math.max(0, Math.round(hole.start * SAMPLE_RATE)), to = Math.min(wav.samples, Math.round(hole.end * SAMPLE_RATE));
      if (to <= from) continue;
      const pcm = await wav.read(from, to);
      const bytes = Buffer.alloc(pcm.length * 2);
      for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * 32768))), i * 2);
      parts.push(spacer, bytes);
      samples += spacer.length / 2;
      pieces.push({ source: from / SAMPLE_RATE, at: samples / SAMPLE_RATE, length: pcm.length / SAMPLE_RATE });
      samples += pcm.length;
    }
    parts.push(spacer);
    const data = Buffer.concat(parts);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
    const handle = await open(out, "w");
    try { await writeFile(handle, Buffer.concat([header, data])); } finally { await handle.close(); }
    return pieces;
  } finally { await wav.close(); }
}

/**
 * The words read from the laid-out audio, each back at the time it was said, one segment for each hole that held
 * any. A sound Whisper only labels is no word. A word that only repeats the one beside the hole is that word's own
 * tail or onset, read twice.
 */
export function heardInHoles(read: TranscriptSegment[], pieces: HolePiece[], segments: TranscriptSegment[]): TranscriptSegment[] {
  const existing = segments.flatMap(s => s.words).filter(spoken).sort((a, b) => a.start - b.start);
  const byPiece = new Map<HolePiece, TranscriptWord[]>();
  for (const w of read.flatMap(s => s.words)) {
    if (!spoken(w)) continue;
    const middle = (w.start + w.end) / 2;
    // The nearest stretch: a time Whisper put in the silence between two belongs to the one it is closer to.
    let piece: HolePiece | undefined, distance = Infinity;
    for (const p of pieces) {
      const d = middle < p.at ? p.at - middle : middle > p.at + p.length ? middle - (p.at + p.length) : 0;
      if (d < distance) { piece = p; distance = d; }
    }
    if (!piece || distance > SPACER / 2) continue;
    const inside = (t: number) => piece!.source + Math.min(piece!.length, Math.max(0, t - piece!.at));
    const start = inside(w.start), end = Math.max(inside(w.end), start + 0.02);
    byPiece.set(piece, [...(byPiece.get(piece) ?? []), { ...w, start, end }]);
  }
  const found: TranscriptSegment[] = [];
  for (const piece of pieces) {
    let words = (byPiece.get(piece) ?? []).sort((a, b) => a.start - b.start);
    const before = existing.filter(w => w.end <= piece.source + 0.05).at(-1), after = existing.find(w => w.start >= piece.source + piece.length - 0.05);
    const same = (a: TranscriptWord, b?: TranscriptWord) => !!b && normalizeTranscriptToken(a.text) === normalizeTranscriptToken(b.text);
    if (words.length && before && same(words[0]!, before) && piece.source - before.end < 0.5) words = words.slice(1);
    if (words.length && after && same(words.at(-1)!, after) && after.start - (piece.source + piece.length) < 0.5) words = words.slice(0, -1);
    if (!words.length) continue;
    found.push({ id: newId("seg"), start: words[0]!.start, end: words.at(-1)!.end, text: words.map(w => w.text).join(" "), words });
  }
  return found;
}

/** The transcript with the found words in it, in the order said. Words found inside a segment's own span join that segment. */
export function withHoleWords(segments: TranscriptSegment[], found: TranscriptSegment[]): TranscriptSegment[] {
  const out = segments.map(s => ({ ...s, words: [...s.words] }));
  for (const f of found) {
    const host = out.find(s => s.words.some(w => w.end <= f.start + 1e-6) && s.words.some(w => w.start >= f.end - 1e-6));
    if (host) {
      host.words = [...host.words, ...f.words].sort((a, b) => a.start - b.start);
      host.text = host.words.map(w => w.text).join(" ");
    } else out.push(f);
  }
  return out.sort((a, b) => (a.words[0]?.start ?? a.start) - (b.words[0]?.start ?? b.start));
}

/**
 * Read the holes of an aligned transcript once more and return it with the words found. `read` transcribes the
 * laid-out audio and `align` places the found words on the recording, as the caller does for the transcript itself.
 */
export async function fillTranscriptHoles(input: { wav: string; segments: TranscriptSegment[]; tmpDir: string; signal: AbortSignal;
  read(wav: string): Promise<TranscriptSegment[]>; align(found: TranscriptSegment[]): Promise<TranscriptSegment[]>; log(message: string): void }) {
  const { wav, segments, signal } = input;
  const holes = transcriptHoles(segments, await wavLevels(wav, signal));
  if (!holes.length) return segments;
  const laid = join(input.tmpDir, newId("holes") + ".wav");
  try {
    const pieces = await writeHoleAudio(wav, holes, laid);
    signal.throwIfAborted();
    const heard = heardInHoles(await input.read(laid), pieces, segments);
    const seconds = holes.reduce((sum, h) => sum + h.end - h.start, 0);
    if (!heard.length) {
      input.log(`[transcribe] read ${holes.length} stretches without words again (${seconds.toFixed(0)} s): no speech in them`);
      return segments;
    }
    const placed = (await input.align(heard)).filter(s => s.words.length);
    input.log(`[transcribe] read ${holes.length} stretches without words again (${seconds.toFixed(0)} s) and found ${placed.reduce((n, s) => n + s.words.length, 0)} words in ${placed.length} of them`);
    return withHoleWords(segments, placed);
  } finally { await rm(laid, { force: true }); }
}
