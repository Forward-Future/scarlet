/// <reference path="../../packages/render/src/vad-embedded.d.ts" />
/** Inference-only bridge for freeze_aligned_case.py. stdout is one JSON result. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseWhisperJson } from "../../apps/server/src/transcribe/whispercpp.ts";
import { alignmentVersion, runAlignWorker, WordAligner, type AlignRequest } from "../../apps/server/src/transcribe/wordAlign.ts";
import { MIN_SCORE } from "../../apps/server/src/transcribe/ctcAlign.ts";
import type { TranscriptSegment, TranscriptWord } from "../../packages/timeline/src/index.ts";

interface Request { words: TranscriptWord[]; segments?: string; wav: string; model: string; scratch: string }
const request: Request = JSON.parse(readFileSync(0, "utf8"));
const {words} = request;
const segments: TranscriptSegment[] = request.segments
  ? parseWhisperJson(JSON.parse(readFileSync(request.segments, "utf8")))
  : [{ id: "frozen", start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? 0, words, text: words.map(w => w.text).join(" ") }];
// Older frozen cases omitted untimed decoder tokens. Recover their original
// segment boundaries only when removing exactly those tokens restores the case.
if (request.segments && segments.reduce((n, s) => n + s.words.length, 0) !== words.length) {
  for (const segment of segments) segment.words = segment.words.filter(w => w.end > w.start);
}
const original = segments.flatMap(s => s.words);
if (original.length !== words.length || original.some((w,i) => {
  const frozen = words[i]!;
  return w.text !== frozen.text || w.start !== frozen.start || w.end !== frozen.end;
})) throw new Error("The decoder segments and frozen source words differ.");
// Run Scarlet's ordinary alignment service, including turn grouping, confidence
// handling and fitting words between neighbors. Only the worker transport changes.
const placedWordIndices: number[] = [];
let offset = 0;
const aligner = new WordAligner(dirname(request.model), async (job, { signal, onProgress }) => {
  signal.throwIfAborted();
  const batch: AlignRequest = JSON.parse(readFileSync(job.request, "utf8"));
  const rows = await runAlignWorker(job.wav, job.model, job.request, onProgress);
  for (const [i, group] of batch.groups.entries()) {
    for (let j = 0; j < group.words.length; j++) {
      const timing = rows[i]?.[j];
      if (timing && timing.score >= MIN_SCORE && timing.end >= timing.start) placedWordIndices.push(offset + j);
    }
    offset += group.words.length;
  }
  return rows;
});
const result = await aligner.align(request.wav, segments, {
  language: "en",
  signal: new AbortController().signal,
  emissions: { file: join(request.scratch, "emissions.bin"), wav: async () => request.wav },
  onPlaced: (count) => {
    if (count !== placedWordIndices.length) throw new Error("Alignment receipt count differs from Scarlet.");
  },
});
const aligned = result.flatMap(s => s.words);
console.log(JSON.stringify({ alignmentVersion, placedWordIndices,
  words: words.map((w, i) => ({ ...w, start: aligned[i]!.start, end: aligned[i]!.end })) }));
