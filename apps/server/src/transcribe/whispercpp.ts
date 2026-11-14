import { readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, win32 } from "node:path";
import { z } from "zod/v3";
import { newId, type TranscriptSegment, type TranscriptWord } from "@scarlet/timeline";
import { extractWav, run } from "../render/ffmpeg.js";
import { decodedRecording } from "../services/recordingAudio.js";
import { SAMPLE_RATE } from "./ctcAlign.js";
import type { TranscribeInput, TranscribeResult, TranscriptionProvider } from "./index.js";

const offsets = z.object({ from: z.number().finite(), to: z.number().finite() });
const whisperOutput = z.object({
  result: z.object({
    language: z.string().optional(),
    // Older adapters may already use this optional field for their own metadata.
    model: z.string().trim().min(1).optional().catch(undefined),
  }).optional(),
  transcription: z.array(z.object({
    offsets, text: z.string(),
    tokens: z.array(z.object({ text: z.string(), offsets: offsets.optional(), p: z.number().finite().optional() })).optional(),
  })),
});
type WhisperJson = z.infer<typeof whisperOutput>;

function adapterModelLabel(name?: string) {
  if (!name || name.includes("://")) return undefined;
  // Preserve registry IDs such as owner/checkpoint. A filesystem path only contributes its filename.
  return /^[\w-][\w.-]*\/[\w.-]+$/.test(name) ? name : win32.basename(name);
}

/** A successful adapter process must explicitly report silence with an empty transcription array. */
function readOutput(source: string): WhisperJson {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("The local transcription adapter returned invalid JSON. Check its output format."); }
  const result = whisperOutput.safeParse(value);
  if (!result.success) {
    const field = result.error.issues[0]?.path.join(".") || "root";
    throw new Error(`The local transcription adapter returned an invalid field (${field}). Check its whisper.cpp JSON output format.`);
  }
  return result.data;
}

/**
 * whisper-cli uses 4 threads unless told otherwise. On a 24-thread Core Ultra 9, 8 threads transcribed
 * 10 minutes of dialogue about 10% faster than 4 (median of six runs) and a 52-minute recording 7% faster
 * (165 s against 178 s), while 16 took nearly three times as long: past the performance cores, efficiency
 * cores hold every step back. Same rule as the word aligner's ONNX session. A different thread count sums
 * in a different order, which can tip Whisper's close calls: the 52-minute transcripts differed in about
 * 3% of words, each an equally plausible reading, while the 10-minute ones matched exactly.
 */
export function whisperThreads(cores = availableParallelism()) {
  return Math.min(cores, cores >= 16 ? 8 : 4);
}

/**
 * Whether the bundled build runs on the GPU while the aligner, filler and speaker models run on the CPU. That is the
 * Apple silicon build, which uses Metal; ONNX Runtime has no GPU path for these models there. On Windows the GPU
 * build shares the GPU with DirectML, so Whisper keeps its turn among the other models.
 */
export function bundledWhisperOnGpu(platform: string = process.platform, arch: string = process.arch) {
  return platform === "darwin" && arch === "arm64";
}

/** GPU builds that failed a run the CPU build then finished. Each falls back to the CPU build until the engine restarts. */
const failedGpu = new Set<string>();

/** Save roughly two minutes per turn. Look for a pause either side before cutting the next WAV. */
const CHUNK_SECONDS = 120;
/**
 * Each window is a new process that loads its model again. For the CrisperWhisper adapter that is a Python start, a
 * torch import and its weights moved to the GPU, so it takes ten-minute windows: an hour is 6 loads rather than 30,
 * and a quit still keeps all but the window under way. It reads a whole recording in one run as well, so a longer
 * window is nothing it hasn't done.
 */
const CRISPER_CHUNK_SECONDS = 600;
const SEARCH_SECONDS = 4;

async function chunkEnd(audio: Awaited<ReturnType<typeof decodedRecording>>, start: number, duration: number, seconds: number) {
  const target = start + seconds;
  if (target + SEARCH_SECONDS >= duration) return duration;
  const from = target - SEARCH_SECONDS;
  const pcm = await audio.pcm(from, target + SEARCH_SECONDS);
  // The middle of the lowest-energy 200 ms makes a natural break in speech. When several windows
  // are silent, choose the one nearest the target. Avoid a fixed split in the middle of a word.
  const width = SAMPLE_RATE / 5;
  const step = SAMPLE_RATE / 50;
  let best = target, bestEnergy = Infinity;
  for (let at = 0; at + width <= pcm.length; at += step) {
    let energy = 0;
    for (let i = at; i < at + width; i++) energy += pcm[i]! ** 2;
    const middle = from + (at + width / 2) / SAMPLE_RATE;
    if (energy < bestEnergy || (energy === bestEnergy && Math.abs(middle - target) < Math.abs(best - target))) {
      bestEnergy = energy;
      best = middle;
    }
  }
  return best;
}

/** Local whisper.cpp: `whisper-cli -m model -f wav -ojf -of prefix`. */
export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = "whispercpp";
  constructor(private readonly opts: {
    binary: string; model?: string | ((signal?: AbortSignal) => Promise<string>); language?: string;
    crisperScript?: string;
    beforeRun?: () => void;
    /** Tried first. A run that fails there, for example without a Vulkan driver, runs again on `binary`. */
    gpuBinary?: string;
    log?: (message: string) => void;
  }) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (input.dialogueWindow) {
      return this.transcribeWav(input.path, input.tmpDir, input.signal, input.language, input.dialogueWindow.prompt);
    }
    const wav = input.keepWavAt ?? join(input.tmpDir, newId("wcpp") + ".wav");
    try {
      await extractWav(input.path, wav, { signal: input.signal });
      if (input.checkpoint) return await this.transcribeChunks(wav, input, input.checkpoint);
      return await this.transcribeWav(wav, input.tmpDir, input.signal, input.language, undefined, input.onProgress);
    } finally { if (!input.keepWavAt) await rm(wav, { force: true }); }
  }

  private async transcribeChunks(wav: string, input: TranscribeInput, checkpoint: NonNullable<TranscribeInput["checkpoint"]>): Promise<TranscribeResult> {
    const audio = await decodedRecording(wav);
    const duration = audio.samples / SAMPLE_RATE;
    const { onProgress } = input;
    const result = { ...checkpoint.result, segments: [...checkpoint.result.segments] };
    const part = join(input.tmpDir, newId("wcpp") + ".wav");
    try {
      for (let from = checkpoint.through; from < duration;) {
        input.signal?.throwIfAborted();
        const end = await chunkEnd(audio, from, duration, this.opts.crisperScript ? CRISPER_CHUNK_SECONDS : CHUNK_SECONDS);
        const whole = from === 0 && end === duration;
        if (!whole) await audio.writeWindow(part, from, end);
        const selectedLanguage = input.language || this.opts.language;
        const language = selectedLanguage && selectedLanguage !== "auto" ? selectedLanguage : result.language;
        const chunk = await this.transcribeWav(whole ? wav : part, input.tmpDir, input.signal, language, undefined,
          onProgress && (fraction => onProgress((from + (end - from) * fraction) / duration)));
        input.signal?.throwIfAborted();
        // Whisper's 10 ms times can round past the last sample of a window. Keep its words inside the
        // audio it heard and place them on the original recording's clock.
        const at = (seconds: number) => Math.min(end, Math.max(from, from + seconds));
        const absolute = whole ? chunk.segments : chunk.segments.map(s => ({ ...s, start: at(s.start), end: at(s.end),
          words: s.words.map(w => ({ ...w, start: at(w.start), end: at(w.end) })) }));
        result.language ??= chunk.language;
        result.modelLabel ??= chunk.modelLabel;
        checkpoint.save(end, { language: result.language, modelLabel: result.modelLabel, segments: absolute }, end / duration);
        result.segments.push(...absolute);
        onProgress?.(end / duration);
        from = end;
      }
      return result;
    } finally { await rm(part, { force: true }); }
  }

  async transcribeWav(wav: string, tmpDir: string, signal?: AbortSignal, language?: string, prompt?: string, onProgress?: (fraction: number) => void) {
    // Fetch the model before either build runs. A download that fails is nothing the GPU did: it is thrown as it is,
    // and no build runs.
    const model = typeof this.opts.model === "function" ? await this.opts.model(signal) : this.opts.model;
    const gpu = this.opts.gpuBinary;
    if (gpu && !failedGpu.has(gpu)) {
      try {
        return await this.runWhisper(gpu, model, wav, tmpDir, signal, language, prompt, onProgress);
      } catch (error) {
        signal?.throwIfAborted();
        this.opts.log?.(`[whisper] A run failed on the GPU build and runs again on the CPU build: ${(error as Error).message}`);
        // Only the same run finishing on the CPU build shows the failure was the GPU's. Audio whisper-cli can't read,
        // a full disk or a missing program fails there too: that error is thrown, and the next run tries the GPU again.
        const result = await this.runWhisper(this.opts.binary, model, wav, tmpDir, signal, language, prompt, onProgress);
        failedGpu.add(gpu);
        this.opts.log?.("[whisper] That run finished on the CPU build, so transcription uses the CPU until Scarlet restarts.");
        return result;
      }
    }
    return this.runWhisper(this.opts.binary, model, wav, tmpDir, signal, language, prompt, onProgress);
  }

  private async runWhisper(binary: string, model: string | undefined, wav: string, tmpDir: string, signal?: AbortSignal, language?: string, prompt?: string,
    onProgress?: (fraction: number) => void) {
    const base = join(tmpDir, newId("wcpp"));
    try {
      const args = this.opts.crisperScript ? ["-I", "-B", this.opts.crisperScript] : [];
      if (model) args.push("-m", model);
      args.push("-f", wav, "-ojf", "-of", base, "-np", "-l", language || this.opts.language || "auto", "-t", String(whisperThreads()));
      // Conditioning on earlier text can lock long recordings into repeating one sentence for minutes.
      // A prompt is part of that text context, so prompted dialogue windows keep it.
      if (prompt) args.push("--prompt", prompt);
      else args.push("-mc", "0");
      if (onProgress) args.push("-pp");
      const onStderrLine = (line: string) => {
        if (this.opts.crisperScript && /^crisperwhisper (?:device = (?:mps|cuda|cpu)|fallback = (?:mps|cuda))$/.test(line)) {
          this.opts.log?.(`[transcribe] ${line}`);
        }
        const percent = /progress\s*=\s*(\d+)%/.exec(line)?.[1];
        if (percent) onProgress?.(Math.min(1, Number(percent) / 100));
      };
      this.opts.beforeRun?.();
      await run(binary, args, { signal, onStderrLine: onProgress || this.opts.crisperScript ? onStderrLine : undefined });
      const json = readOutput(await readFile(base + ".json", "utf8"));
      const modelLabel = adapterModelLabel(json.result?.model);
      return { language: json.result?.language, segments: parseWhisperJson(json), ...(modelLabel && { modelLabel }) };
    } finally { await rm(base + ".json", { force: true }); }
  }
}

export function parseWhisperJson(json: Partial<WhisperJson>): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of json.transcription ?? []) {
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    const words: TranscriptWord[] = [];
    for (const tok of seg.tokens ?? []) {
      const text = tok.text;
      if (!tok.offsets || !text || /^\[_.*\]$/.test(text) || /^<\|.*\|>$/.test(text)) continue;
      const ws = tok.offsets.from / 1000;
      const we = tok.offsets.to / 1000;
      const prev = words[words.length - 1];
      // Sub-word pieces (no leading space) attach to the previous word.
      if (prev && !text.startsWith(" ")) {
        prev.text += text.trim();
        prev.end = Math.max(prev.end, we);
        continue;
      }
      words.push({ text: text.trim(), start: ws, end: Math.max(ws, we), confidence: tok.p });
    }
    out.push({ id: newId("seg"), start, end: Math.max(start, end), text: seg.text.trim(), words: words.filter((w) => w.text) });
  }
  return out;
}
