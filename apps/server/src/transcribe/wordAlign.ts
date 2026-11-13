import { randomUUID } from "node:crypto";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TimeRange, TranscriptSegment } from "@scarlet/timeline";
import { humanDuration } from "../logText.js";
import { extractWav } from "../render/ffmpeg.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { audioLane, type AudioLane, type AudioWork } from "../services/audioWork.js";
import {
  alignGroup, applyTimings, alignmentGroups, CLASSES, FRAME_SAMPLES, framesFor, groupLabels, logSoftmax, MIN_SCORE,
  planChunks, SAMPLE_RATE, stitchChunks, type AlignWord, type Emissions, type WordTiming,
} from "./ctcAlign.js";
import { audioWorker } from "./audioWorker.js";
import { EmissionFile } from "./emissions.js";
import { LocalWhisperModel } from "./localModel.js";
import { loadRuntime, webgpuAvailable, withInference, type Sessions } from "./uhm.js";

// English wav2vec2 CTC (facebook/wav2vec2-base-960h, Apache-2.0), ONNX export for Transformers.js. On recorded
// dialogue the fp16 export matched it but ran ~25% slower on CPU; the 8-bit export left ~3× as many starts in silence.
const weights = {
  name: "wav2vec2-base-960h-e4661427.onnx",
  url: "https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/a19f851b3d42865797e410752b4c570c871e4825/onnx/model.onnx",
  size: 377887594, sha256: "e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d",
};
/**
 * The feature encoder's strided convolutions, which ONNX Runtime 1.22's WebGPU path computes wrongly (any one of
 * them on the GPU changed the top letter in 2,379 of 5,996 frames). With these six on the CPU and the rest of the
 * model on the GPU, a 30 s window took 480 ms against 780-880 ms on eight cores, with the same top letter in every
 * frame and logits within 0.005 (M5 Max, 2026-11-07). The first window of each run is still checked against the CPU.
 */
const WEBGPU_CPU_NODES = [1, 2, 3, 4, 5, 6].map(layer => `/wav2vec2/feature_extractor/conv_layers.${layer}/conv/Conv`);
/** A GPU's logits may differ from the CPU's by this much, and name another top class in this share of frames. */
const GPU_LOGIT_TOLERANCE = 0.05, GPU_FLIP_TOLERANCE = 0.001;

/** Bump with the model or the algorithm so cached word-timed results are rebuilt. */
export const alignmentVersion = 3;
/** Audio searched on each side of a run's Whisper times. */
const MARGIN = 0.5;
/** Seconds of audio one worker aligns before yielding its turn. */
const BATCH_SECONDS = 300;
/**
 * The same for a recording a dialogue pass is reading. A scan page advances 58 s and runs between two turns, so a
 * turn covers more than a page (runs are at most 30 s, so 90 to 120 s): alignment stays ahead of the pages the
 * pass reads, the first turn included, and no page waits longer than one short turn.
 */
const SHARED_BATCH_SECONDS = 120;

/**
 * `after`: where the previous request's confident words end. Runs never reach back over them.
 * `store`: the recording's saved emissions (emissions.ts). The request's times start `offset` seconds into the
 * recording and span `duration`, and the worker's audio is then the whole recording, read only for windows the
 * store lacks.
 */
export interface AlignRequest { measure?: TimeRange[]; groups: Array<{ start: number; end: number; words: AlignWord[] }>; after?: number;
  store?: { file: string; offset: number; duration?: number } }
/** Where a recording's emissions are kept, for audio that starts `offset` seconds into it and lasts `duration`
 * (by default, the whole recording). `wav` decodes the whole recording (16 kHz mono, as extractWav writes it) when
 * a window has to be inferred. */
export interface EmissionSource { file: string; offset?: number; duration?: number; wav: () => Promise<string> }
export type AlignResponse = Array<Array<WordTiming | null>>;

export interface AlignmentCheckpoint {
  /** End of the last confidently placed word in source seconds. */
  through: number;
  /** First word still to check, in the saved transcript's flat word order. Older transcripts kept only `through`. */
  nextWord?: number;
  /** Share of the whole alignment covered by completed turns. */
  fraction?: number;
  /** All turns are finished. A local recording may still need its reread of gaps in speech. */
  complete?: boolean;
}

type AlignmentTurn = (segments: TranscriptSegment[], through: number, checkpoint: AlignmentCheckpoint) => void;

/** Whisper's English codes and names; an unknown language is attempted and rejected per run when unspellable. */
export function alignsLanguage(language?: string) {
  return !language?.trim() || /^en(glish)?([-_].*)?$/i.test(language.trim());
}

/** Refines word times in place of Whisper's estimates. Words keep their text, and keep their times wherever
 * the alignment is not confident. Runs in bounded worker turns shared by every caller of one model directory.
 * With `work`, each turn takes its place in the engine's audio lane instead, so a scan page can run between
 * two turns of a long transcript. `onTurn` gets the result so far after each turn but the last, with how far
 * it is final: words that end before `through` won't move, since no later run reaches back over them.
 * `onPlaced` gets, once the last turn is done, how many of the words took their times from the audio. */
export class WordAligner {
  private readonly model: LocalWhisperModel;
  private readonly turns = new AnalysisCache<AlignResponse>(() => 0, 0, 1);

  constructor(directory: string) { this.model = new LocalWhisperModel(directory, weights); }

  /** Fill missing recording windows for free decoding, without supplying any expected words. */
  async measure(source: EmissionSource, ranges: TimeRange[], signal: AbortSignal) {
    const wav = await source.wav();
    const model = await this.model.get(signal);
    const request = `${source.file}.${randomUUID()}.part`;
    try {
      await writeFile(request, JSON.stringify({ groups: [], measure: ranges, store: { file: source.file, offset: 0 } } satisfies AlignRequest));
      await audioWorker.request({ kind: "align", wav, model, request }, { signal });
    } finally { await rm(request, { force: true }); }
  }

  /** `wav`: 16 kHz mono PCM (as extractWav writes it) in the same time base as `segments`. With `emissions` it is
   * not read: the model's output comes from the recording's store, which infers what it lacks from its own decode. */
  async align(wav: string, segments: TranscriptSegment[], opts: { language?: string; signal: AbortSignal; lane?: { lane: AudioLane; work: AudioWork };
    emissions?: EmissionSource; resume?: AlignmentCheckpoint;
    /** Asked before each turn: something this alignment should let finish first, or nothing. */
    hold?: () => Promise<unknown> | undefined;
    onProgress?: (fraction: number) => void; onTurn?: AlignmentTurn;
    onPlaced?: (placed: number, words: number) => void }) {
    opts.signal.throwIfAborted();
    if (!alignsLanguage(opts.language)) return segments;
    const words = segments.flatMap(s => s.words);
    const { resume } = opts;
    const through = resume?.through ?? 0;
    const cursor = resume?.nextWord;
    const hasCursor = cursor !== undefined && Number.isInteger(cursor) && cursor >= 0 && cursor <= words.length;
    // The saved snapshot fixes every word up to its last confident placement. Later unchecked times, including
    // estimates from a completed turn, can still be fitted into the gap when the next confident word is found.
    let fixedPrefix = 0;
    if (through > 0) {
      const limit = hasCursor ? cursor : words.length;
      while (fixedPrefix < limit && words[fixedPrefix]!.end <= through) {
        const end = words[fixedPrefix++]!.end;
        // On older snapshots an unchecked estimate can have been clipped to the exact end of that word.
        if (end === through) break;
      }
    }
    const nextWord = hasCursor ? cursor : fixedPrefix;
    const groups = alignmentGroups(segments, undefined, nextWord);
    if (!groups.some(g => groupLabels(g.words).spelled)) return segments;
    const timings: Array<WordTiming | undefined> = [];
    let after = through > 0 ? through : undefined;
    // Progress is how far into the speech alignment has reached. A turn covers up to five minutes of speech,
    // so its worker also reports each 30 s window it finishes.
    const start = Math.min(segments.find(s => s.words.length)!.start, words[0]!.start);
    const span = groups.at(-1)!.end - start;
    const reached = (index: number) => span <= 0 ? 0 : (groups[index]!.start - start) / span;
    let reported = 0;
    const report = (fraction: number) => {
      if (!Number.isFinite(fraction) || fraction <= reported) return;
      reported = Math.min(1, fraction);
      opts.onProgress?.(reported);
    };
    if (nextWord > 0) report(resume?.fraction ?? reached(0));
    for (let first = 0; first < groups.length;) {
      await opts.hold?.();
      opts.signal.throwIfAborted();
      const { lane } = opts;
      // Read each turn: a pass can start reading the recording while its transcript is under way.
      const shared = lane?.lane.focusedOn(lane.work.mediaId) ?? false;
      const seconds = shared ? SHARED_BATCH_SECONDS : BATCH_SECONDS;
      let last = first + 1;
      while (last < groups.length && groups[last]!.end - groups[first]!.start <= seconds) last++;
      const batch = groups.slice(first, last);
      const turn = async (signal: AbortSignal) => {
        const model = await this.model.get(signal);
        const { emissions } = opts;
        const runs = batch.map(({ start, end, words }) => ({ start, end, words }));
        // The recording is decoded only when the store lacks a window these words need.
        const audio = !emissions ? wav : await storeCovers(emissions, runs) ? "" : await emissions.wav();
        // Beside the store the request ends in .part, which the leftover sweep clears from a project's folder.
        const request = emissions ? `${emissions.file}.${randomUUID()}.part` : `${wav}.${randomUUID()}.align.json`;
        try {
          await writeFile(request, JSON.stringify({ groups: runs, after,
            ...(emissions && { store: { file: emissions.file, offset: emissions.offset ?? 0, duration: emissions.duration } }) } satisfies AlignRequest));
          const from = reached(first), to = last >= groups.length ? 1 : reached(last);
          return await audioWorker.request<AlignResponse>({ kind: "align", wav: audio, model, request }, { signal,
            onProgress: done => { if (done >= 0 && done <= 1) report(from + (to - from) * done); } });
        } finally { await rm(request, { force: true }); }
      };
      const response = lane
        ? await lane.lane.run(lane.work, opts.signal, () => turn(opts.signal), { more: !shared && last < groups.length })
        : await this.turns.get(randomUUID(), turn, { signal: opts.signal });
      batch.forEach((group, g) => group.index.forEach((flat, i) => {
        const timing = timings[flat] = response[g]?.[i] ?? undefined;
        if (timing && timing.score >= MIN_SCORE) after = Math.max(after ?? -Infinity, timing.end);
      }));
      first = last;
      report(first >= groups.length ? 1 : reached(first));
      if (first < groups.length && opts.onTurn) {
        const checkpoint = { through: after ?? 0, nextWord: groups[first]!.index[0]!, fraction: reported };
        opts.onTurn(applyTimings(segments, timings, MIN_SCORE, fixedPrefix), checkpoint.through, checkpoint);
      }
    }
    opts.onPlaced?.(timings.filter(t => t && t.score >= MIN_SCORE && t.end >= t.start).length, words.length - nextWord);
    return applyTimings(segments, timings, MIN_SCORE, fixedPrefix);
  }
}

const aligners = new Map<string, WordAligner>();

function recordingAligner(ctx: { paths: { root: string } }) {
  const directory = join(ctx.paths.root, "models");
  let aligner = aligners.get(directory);
  if (!aligner) aligners.set(directory, aligner = new WordAligner(directory));
  return aligner;
}

export function measureRecordingWords(ctx: { paths: { root: string } }, mediaId: string, source: EmissionSource, ranges: TimeRange[], signal: AbortSignal) {
  return audioLane(ctx).run({ mediaId, kind: "page" }, signal, () => recordingAligner(ctx).measure(source, ranges, signal));
}

/**
 * Align `segments` (Whisper or cloud ASR output, times relative to `wav`) to the audio in `wav`.
 * Returns new segments with the same text. Non-English input is returned unchanged. Throws when the
 * aligner model cannot be prepared or the worker fails; callers may keep the original segments.
 */
export function alignWords(ctx: { paths: { root: string } }, wav: string, segments: TranscriptSegment[],
  opts: { language?: string; signal: AbortSignal; work?: AudioWork; emissions?: EmissionSource; resume?: AlignmentCheckpoint; hold?: () => Promise<unknown> | undefined;
    onProgress?: (fraction: number) => void; onTurn?: AlignmentTurn;
    onPlaced?: (placed: number, words: number) => void }): Promise<TranscriptSegment[]> {
  const { work, ...rest } = opts;
  return recordingAligner(ctx).align(wav, segments, { ...rest, ...(work && { lane: { lane: audioLane(ctx), work } }) });
}

/**
 * Saved transcripts from any provider. Every provider transcribes the source's default audio stream, so
 * align against that: the caller's retained Whisper decode when there is one, else a fresh decode.
 * Keeps the provider's times when the aligner cannot run, and the words it had placed when it fails part way.
 */
export async function alignTranscript(ctx: { paths: { root: string; tmp: string }; log(message: string): void },
  input: { source: string; wav?: string; language?: string; segments: TranscriptSegment[]; signal: AbortSignal; work?: AudioWork;
    /** Where this recording's emissions are kept, so its scan pages and a later transcript reuse them. */
    emissions?: string; resume?: AlignmentCheckpoint;
    /** Asked before each turn: something this alignment should let finish first, or nothing. */
    hold?: () => Promise<unknown> | undefined;
    onProgress?: (fraction: number) => void; onTurn?: AlignmentTurn }) {
  const { source, language, segments, signal, work, onProgress, hold } = input;
  if (!alignsLanguage(language) || !segments.some(s => s.words.length)) return segments;
  let placed = segments;
  const onTurn: AlignmentTurn | undefined = input.onTurn && ((soFar, through, checkpoint) => {
    placed = soFar;
    input.onTurn!(soFar, through, checkpoint);
  });
  const wav = input.wav ?? join(ctx.paths.tmp, `${randomUUID()}.wav`);
  const started = Date.now();
  const onPlaced = (count: number, words: number) =>
    ctx.log(`[align] ${basename(source)}: placed ${count} of ${words} words in ${humanDuration(Date.now() - started)}`);
  try {
    if (!input.wav) await extractWav(source, wav, { signal });
    const emissions = input.emissions === undefined ? undefined : { file: input.emissions, wav: async () => wav };
    return await alignWords(ctx, wav, segments, { language, signal, work, emissions, resume: input.resume, hold, onProgress, onTurn, onPlaced });
  } catch (error) {
    signal.throwIfAborted();
    ctx.log(`[align] ${basename(source)}: ${(error as Error).message}`);
    return placed;
  } finally {
    if (!input.wav) await rm(wav, { force: true });
  }
}

/** 16 kHz mono 16-bit PCM WAV, read by sample range. FFmpeg may write LIST chunks before the data. */
export async function openWav(path: string) {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const size = (await handle.stat()).size;
    let format: Buffer | undefined;
    for (let at = 12; at + 8 <= bytesRead;) {
      const id = head.toString("ascii", at, at + 4), bytes = head.readUInt32LE(at + 4), start = at + 8;
      if (id === "fmt ") format = head.subarray(start, start + 16);
      if (id === "data") {
        if (!format || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== SAMPLE_RATE || format.readUInt16LE(14) !== 16) break;
        const samples = Math.floor(Math.min(bytes, size - start) / 2);
        return {
          samples,
          async read(from: number, to: number) {
            from = Math.max(0, from); to = Math.min(samples, to);
            const pcm = Buffer.alloc(Math.max(0, to - from) * 2);
            if (pcm.length) await handle.read(pcm, 0, pcm.length, start + from * 2);
            const out = new Float32Array(pcm.length / 2);
            for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
            return out;
          },
          close: () => handle.close(),
        };
      }
      at = start + bytes + bytes % 2;
    }
    throw new Error("Word alignment requires 16 kHz mono PCM audio.");
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The audio each group's search reads, a margin either side of its Whisper times, joined where runs nearly touch. */
function searchRegions(groups: AlignRequest["groups"], duration: number) {
  const order = groups.map((_, i) => i).sort((a, b) => groups[a]!.start - groups[b]!.start);
  // Contiguous speech shares one emission pass; long pauses between runs are not inferred.
  const regions: Array<{ start: number; end: number; groups: number[] }> = [];
  for (const g of order) {
    const start = Math.max(0, groups[g]!.start - MARGIN), end = Math.min(duration, groups[g]!.end + MARGIN);
    if (end <= start) continue;
    const region = regions.at(-1);
    if (region && start <= region.end + 1) {
      region.end = Math.max(region.end, end);
      region.groups.push(g);
    } else regions.push({ start, end, groups: [g] });
  }
  return regions;
}

/** Whether the store already holds every frame these groups' searches read. */
async function storeCovers(source: EmissionSource, groups: AlignRequest["groups"]) {
  const store = await EmissionFile.open(source.file).catch(() => null);
  if (!store) return false;
  try {
    const offset = source.offset ?? 0;
    return searchRegions(groups, source.duration ?? store.samples / SAMPLE_RATE)
      .every(region => !store.missing(...store.frameRange(region.start + offset, region.end + offset)).length);
  } finally { await store.close(); }
}

/** Runs in the audio helper: onnxruntime-node blocks its thread for each inference window.
 * `onProgress` gets the share of this request's audio inferred so far, after each window. */
export async function runAlignWorker(wav: string, model: string, requestFile: string, onProgress?: (done: number) => void,
  sessions?: Sessions): Promise<AlignResponse> {
  const { groups, after, store, measure } = JSON.parse(await readFile(requestFile, "utf8")) as AlignRequest;
  if (store) return alignFromStore(wav, model, groups, after, store, onProgress, sessions, measure);
  // Before the audio is opened: a missing runtime throws here, with no file left open.
  const ort = loadRuntime();
  const audio = await openWav(wav);
  // On the GPU when there is one. A run that fails there starts again on the CPU, so it builds its result afresh.
  try { return await withInference(ort, model, async session => {
    const out: AlignResponse = groups.map(g => g.words.map(() => null));
    const regions = searchRegions(groups, audio.samples / SAMPLE_RATE);
    let previousEnd = after ?? -Infinity;
    const seconds = regions.reduce((sum, r) => sum + (r.end - r.start), 0);
    let emitted = 0;
    for (const region of regions) {
      const from = Math.floor(region.start * SAMPLE_RATE / FRAME_SAMPLES) * FRAME_SAMPLES;
      const samples = await audio.read(from, Math.ceil(region.end * SAMPLE_RATE));
      const length = region.end - region.start;
      const emissions = await emit(ort, session, samples, part => onProgress?.(seconds > 0 ? (emitted + length * part) / seconds : 1));
      emitted += length;
      previousEnd = place({ ...emissions, origin: from / SAMPLE_RATE }, groups, region.groups, previousEnd, out);
    }
    return out;
  }, { sessions }); } finally {
    await audio.close();
  }
}

/** Align one region's groups against its emissions, never reaching back over words the previous run placed. */
function place(em: Emissions, groups: AlignRequest["groups"], indices: number[], previousEnd: number, out: AlignResponse) {
  for (const g of indices) {
    const group = groups[g]!;
    const timings = alignGroup(em, group.words, Math.max(group.start - MARGIN, previousEnd), group.end + MARGIN);
    timings.forEach((t, i) => {
      if (!t) return;
      out[g]![i] = { start: round(t.start), end: round(t.end), score: round(t.score) };
      if (t.score >= MIN_SCORE) previousEnd = Math.max(previousEnd, t.end);
    });
  }
  return previousEnd;
}

/**
 * The same alignment from the recording's emission store. Windows the store lacks are inferred from `wav`, the whole
 * recording, and saved; when it has them all, no audio is read and the model is never loaded.
 */
async function alignFromStore(wav: string, model: string, groups: AlignRequest["groups"], after: number | undefined,
  { file, offset, duration }: NonNullable<AlignRequest["store"]>, onProgress?: (done: number) => void, sessions?: Sessions, measure?: TimeRange[]): Promise<AlignResponse> {
  const audio = wav ? await openWav(wav) : undefined;
  let store: EmissionFile | null | undefined;
  try {
    store = await EmissionFile.open(file, audio?.samples);
    if (!store) throw new Error("The recording's alignment store is missing.");
    const saved = store;
    const regions = searchRegions(groups, duration ?? saved.samples / SAMPLE_RATE).map(region =>
      ({ ...region, frames: saved.frameRange(region.start + offset, region.end + offset) }));
    const frames = measure ? measure.map(r => saved.frameRange(r.start, r.end)) : regions.map(r => r.frames);
    const missing = [...new Set(frames.flatMap(range => saved.missing(...range)))].sort((a, b) => a - b);
    if (missing.length) {
      if (!audio) throw new Error("The recording's alignment store lacks audio it was not given.");
      const ort = loadRuntime();
      // On Apple silicon the helper tries WebGPU, where it keeps the session: preparing it for one turn costs more
      // than it saves. A window is saved as soon as it is inferred, so a run that fails on the GPU continues on the
      // CPU where it stopped.
      const gpu = sessions && webgpuAvailable() ? { gpu: "webgpu" as const, cpuNodes: WEBGPU_CPU_NODES } : {};
      await withInference(ort, model, async (session, provider) => {
        for (const [done, index] of missing.entries()) {
          if (saved.missing(saved.chunks[index]!.keep[0], saved.chunks[index]!.keep[1]).includes(index)) {
            const chunk = saved.chunks[index]!;
            const part = await audio.read(chunk.start, chunk.start + chunk.length);
            const logits = await infer(ort, session, part);
            if (provider === "webgpu" && sessions && !sessions.verified.has(model)) {
              const expected = await withInference(ort, model, cpu => infer(ort, cpu, part), { sessions, gpu: false });
              const { worst, flips } = compareLogits(expected, logits);
              if (!(worst <= GPU_LOGIT_TOLERANCE && flips <= GPU_FLIP_TOLERANCE)) {
                throw new Error(`The GPU's aligner output differs from the CPU's (${worst.toFixed(3)}, ${(100 * flips).toFixed(1)}% of frames).`);
              }
              sessions.verified.add(model);
              await sessions.drop(`cpu:${model}`);
            }
            const first = chunk.start / FRAME_SAMPLES;
            await saved.write(index, logSoftmax(logits.slice((chunk.keep[0] - first) * CLASSES, (chunk.keep[1] - first) * CLASSES)));
          }
          onProgress?.((done + 1) / missing.length);
        }
      }, { sessions, ...gpu });
    }
    const out: AlignResponse = groups.map(g => g.words.map(() => null));
    let previousEnd = after ?? -Infinity;
    for (const region of regions) {
      const [from, to] = region.frames;
      if (to <= from) continue;
      const em: Emissions = { logProbs: await saved.read(from, to), frames: to - from, origin: from * FRAME_SAMPLES / SAMPLE_RATE - offset };
      previousEnd = place(em, groups, region.groups, previousEnd, out);
    }
    onProgress?.(1);
    return out;
  } finally {
    await Promise.all([audio?.close(), store?.close()]);
  }
}

/** The largest difference between two sets of logits, and the share of frames whose top class differs. */
function compareLogits(a: Float32Array, b: Float32Array) {
  let worst = a.length === b.length ? 0 : Infinity, flips = 0;
  const frames = Math.min(a.length, b.length) / CLASSES;
  for (let f = 0; f < frames; f++) {
    let top = 0, other = 0;
    for (let c = 0; c < CLASSES; c++) {
      const at = f * CLASSES + c;
      worst = Math.max(worst, Math.abs(a[at]! - b[at]!));
      if (a[at]! > a[f * CLASSES + top]!) top = c;
      if (b[at]! > b[f * CLASSES + other]!) other = c;
    }
    if (top !== other) flips++;
  }
  return { worst, flips: frames ? flips / frames : 0 };
}

type Runtime = ReturnType<typeof loadRuntime>;
type Session = Awaited<ReturnType<Runtime["InferenceSession"]["create"]>>;

/** One window's logits, its audio normalized like the model's feature extractor. */
async function infer(ort: Runtime, session: Session, part: Float32Array) {
  let total = 0, variance = 0;
  for (let i = 0; i < part.length; i++) total += part[i]!;
  const mean = total / part.length;
  for (let i = 0; i < part.length; i++) variance += (part[i]! - mean) ** 2;
  const sd = Math.sqrt(variance / part.length + 1e-7);
  const input = new Float32Array(part.length);
  for (let i = 0; i < part.length; i++) input[i] = (part[i]! - mean) / sd;
  const result = await session.run({ input_values: new ort.Tensor("float32", input, [1, input.length]) });
  const logits = result.logits!;
  const frames = framesFor(part.length);
  if (logits.dims[1] !== frames || logits.dims[2] !== CLASSES) throw new Error(`Unexpected aligner output ${logits.dims.join("×")}.`);
  return logits.data as Float32Array;
}

/** Log-probabilities over ≤30 s windows that overlap by 2 s, each normalized like the model's feature extractor. */
async function emit(ort: Runtime, session: Session, samples: Float32Array, onChunk?: (done: number) => void) {
  const chunks = planChunks(samples.length);
  const outputs: Float32Array[] = [];
  for (const [index, chunk] of chunks.entries()) {
    outputs.push(await infer(ort, session, samples.subarray(chunk.start, chunk.start + chunk.length)));
    onChunk?.((index + 1) / chunks.length);
  }
  const logProbs = logSoftmax(stitchChunks(chunks, outputs));
  return { logProbs, frames: logProbs.length / CLASSES };
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
