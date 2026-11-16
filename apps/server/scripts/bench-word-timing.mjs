// Where a transcript's word times and the recording's quiet disagree: quiet inside words, pauses the words hide, and
// gaps between words that hold speech. Scarlet places cut edges in measured quiet and trims pauses from where the words
// say they are, so a word stretched over a pause hides that pause from everything that reads the transcript.
// Whisper transcribes each recording as the engine does, and the engine's aligner places its words. Nothing leaves
// this machine. Run after building the workspace:
//
//   MODELS=<a Scarlet model cache> WHISPER=<whisper-cli> \
//     node apps/server/scripts/bench-word-timing.mjs <recording>... [--out dir]
//
// --out keeps each recording's Whisper words (<name>.whisper.json), which a later run reads instead of transcribing
// again, and the aligned transcript (<name>.aligned.json), to compare two builds word by word.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { QUIET_PEAK, QUIET_RMS } from "@scarlet/mcp/gap-sound";
import { speechActivityOf } from "@scarlet/render";
import { extractWav } from "../dist/render/ffmpeg.js";
import { WhisperCppProvider } from "../dist/transcribe/whispercpp.js";
import { WordAligner } from "../dist/transcribe/wordAlign.js";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt < 0 ? undefined : args.splice(outAt, 2)[1];
assert(process.env.MODELS && args.length, "Set MODELS, and name at least one recording.");
const whisperModel = join(process.env.MODELS, "ggml-large-v3-turbo-q5_0.bin");
const scratch = await mkdtemp(join(tmpdir(), "scarlet-bench-words-"));
if (out) await mkdir(out, { recursive: true });

const RATE = 16000, STEP = 0.01, FRAME = RATE * STEP;
/** Where the recording is quiet, frame by frame: Scarlet's quiet, the quiet cut edges go in. */
async function quietFrames(wav) {
  const buffer = await readFile(wav);
  let at = 12, data = 0, bytes = 0;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString("ascii", at, at + 4), size = buffer.readUInt32LE(at + 4);
    if (id === "data") { data = at + 8; bytes = Math.min(size, buffer.length - data); break; }
    at += 8 + size + (size % 2);
  }
  const pcm = new Int16Array(buffer.buffer.slice(buffer.byteOffset + data, buffer.byteOffset + data + bytes - (bytes % 2)));
  const frames = Math.floor(pcm.length / FRAME);
  const quiet = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0, peak = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) { const v = pcm[i] / 32768; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    quiet[f] = Number(Math.sqrt(sum / FRAME) <= QUIET_RMS && peak <= QUIET_PEAK);
  }
  for (let from = 0; from < pcm.length / RATE; from += 60) {
    const to = Math.min(pcm.length / RATE, from + 60), start = Math.max(0, from - 0.3);
    for (const span of await speechActivityOf(pcm.subarray(Math.round(start * RATE), Math.round(to * RATE)), start, from, to)) {
      for (let f = Math.floor(span.start / STEP); f < Math.min(frames, Math.ceil(span.end / STEP)); f++) quiet[f] = 0;
    }
  }
  return quiet;
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3) : null;
};

function score(transcript, quiet) {
  const words = transcript.segments.flatMap(s => s.words).filter(w => /[\p{L}\p{N}]/u.test(w.text) && w.end > w.start).sort((a, b) => a.start - b.start);
  const sound = (a, b) => {
    let n = 0;
    for (let f = Math.max(0, Math.floor(a / STEP)); f < Math.min(quiet.length, Math.ceil(b / STEP)); f++) n += 1 - quiet[f];
    return n * STEP;
  };
  const pauses = [];
  for (let f = 0, start = -1; f <= quiet.length; f++) {
    if (f < quiet.length && quiet[f]) { if (start < 0) start = f; continue; }
    if (start >= 0 && (f - start) * STEP >= 0.25) pauses.push({ start: start * STEP, end: f * STEP });
    start = -1;
  }
  let quietInWords = 0, hidden = 0, next = 0;
  const wordEndToQuiet = [], quietToWordStart = [];
  for (const pause of pauses) {
    while (next < words.length && words[next].end <= pause.start - 2) next++;
    let covered = 0;
    const near = [];
    for (let j = next; j < words.length && words[j].start < pause.end + 2; j++) {
      near.push(words[j]);
      covered += Math.max(0, Math.min(words[j].end, pause.end - 0.05) - Math.max(words[j].start, pause.start + 0.05));
    }
    quietInWords += covered;
    if (pause.end - pause.start >= 0.4 && covered > 0.5 * (pause.end - pause.start - 0.1)) hidden++;
    const before = near.filter(w => w.start < pause.start).at(-1), after = near.find(w => w.end > pause.end);
    if (before && after && before !== after && pause.start - before.end < 1 && after.start - pause.end < 1) {
      wordEndToQuiet.push(pause.start - before.end);
      quietToWordStart.push(after.start - pause.end);
    }
  }
  let gapsWithSpeech = 0;
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].end, b = words[i].start;
    if (b - a >= 0.4 && sound(a, b) > 0.5 * (b - a)) gapsWithSpeech++;
  }
  return {
    words: words.length,
    /** Words that hold no sound at all. */
    wordsOnQuiet: words.filter(w => w.end - w.start >= 0.1 && sound(w.start, w.end) < 0.03).length,
    /** Seconds of quiet (runs of 0.25 s or more) inside word spans, past 50 ms at either edge. */
    quietInsideWords: +quietInWords.toFixed(2),
    pauses: pauses.length,
    /** Pauses of 0.4 s or more the words cover most of: the transcript shows no pause there. */
    hiddenPauses: hidden,
    /** Gaps between words of 0.4 s or more that are mostly sound. */
    gapsWithSpeech,
    /** From the end of the word before a pause to where the quiet begins, and from where it ends to the next word. */
    wordEndToQuiet: { median: percentile(wordEndToQuiet, 0.5), p10: percentile(wordEndToQuiet, 0.1), p90: percentile(wordEndToQuiet, 0.9) },
    quietToWordStart: { median: percentile(quietToWordStart, 0.5), p10: percentile(quietToWordStart, 0.1), p90: percentile(quietToWordStart, 0.9) },
  };
}

const results = [];
try {
  for (const recording of args) {
    const name = basename(recording, extname(recording));
    const wav = join(scratch, `${name}.wav`);
    await extractWav(recording, wav);
    const kept = out && join(out, `${name}.whisper.json`);
    let whisper;
    if (kept && existsSync(kept)) whisper = JSON.parse(await readFile(kept, "utf8"));
    else {
      assert(process.env.WHISPER, "Set WHISPER to whisper-cli to transcribe a recording.");
      const provider = new WhisperCppProvider({ binary: process.env.WHISPER, model: whisperModel, language: "en" });
      whisper = await provider.transcribe({ path: recording, tmpDir: scratch, language: "en", checkpoint: { through: 0, result: { segments: [] }, save: () => {} } });
      if (kept) await writeFile(kept, JSON.stringify(whisper));
    }
    const segments = whisper.segments.map((s, i) => ({ id: `seg${i}`, ...s }));
    const started = performance.now();
    let placed;
    const aligned = await new WordAligner(process.env.MODELS).align(wav, segments, { language: "en", signal: new AbortController().signal,
      emissions: { file: join(scratch, `${name}.emissions.bin`), wav: async () => wav }, onPlaced: (count, total) => { placed = `${count} of ${total}`; } });
    const seconds = +((performance.now() - started) / 1000).toFixed(1);
    if (out) await writeFile(join(out, `${name}.aligned.json`), JSON.stringify({ segments: aligned }));
    const quiet = await quietFrames(wav);
    const result = { recording: name, minutes: +(quiet.length * STEP / 60).toFixed(1), alignSeconds: seconds, placed,
      whisper: score({ segments }, quiet), aligned: score({ segments: aligned }, quiet) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
