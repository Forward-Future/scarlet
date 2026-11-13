import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { isSea } from "node:sea";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { audioWorker } from "./audioWorker.js";
import type * as Ort from "onnxruntime-node";
import type { AcousticFiller } from "@scarlet/shared";
import { LocalWhisperModel } from "./localModel.js";

const weights = {
  name: "uhm-1b7dc1ef.onnx",
  url: "https://huggingface.co/desert-ant-labs/uhm/resolve/1b7dc1ef7dfc415bfa349ed5fce06efb2507898a/uhm.onnx",
  size: 94042570, sha256: "fbd19765def76893841e0c70e498bf632d6c68175ceae5a2da8fe3bf7d9d0314",
};
const rate = 16000, frame = 320, maxSamples = 30 * rate;
/** Largest gap between a GPU's and the CPU's probabilities that still counts as the same answer. Measured: 0.00002. */
const GPU_TOLERANCE = 0.005;

export function loadRuntime(): typeof Ort {
  const req = createRequire(import.meta.url);
  if (!isSea()) return req("onnxruntime-node");
  const bin = dirname(process.execPath);
  const locations = [join(bin, "uhm-runtime"), join(bin, "../Resources/uhm-runtime")];
  const runtime = locations.map(p => join(p, "dist/runtime.cjs")).find(p => existsSync(p));
  if (!runtime) throw new Error("The installed Scarlet engine is missing its Uhm runtime.");
  return req(runtime);
}

type Session = Ort.InferenceSession;
type Provider = "cpu" | "dml" | "webgpu";

/**
 * Sessions kept open between requests in the audio helper (audioWorker.ts), so a model is read once. A GPU that
 * failed a model stays off for it until the helper exits.
 */
export class Sessions {
  private readonly open = new Map<string, Promise<Session>>();
  readonly gpuFailed = new Set<string>();
  /** Models whose GPU output has been checked against the CPU's in this process. */
  readonly verified = new Set<string>();
  private readonly said = new Set<string>();

  /** `note`: where each model runs and why a GPU was given up, once each, for the engine's log. */
  constructor(private readonly note?: (text: string) => void) {}

  /** Say it once per helper. */
  tell(text: string) {
    if (this.said.has(text)) return;
    this.said.add(text);
    this.note?.(text);
  }

  get(key: string, create: () => Promise<Session>) {
    let session = this.open.get(key);
    if (!session) {
      this.open.set(key, session = create());
      session.catch(() => { if (this.open.get(key) === session) this.open.delete(key); });
    }
    return session;
  }

  async drop(key: string) {
    const session = this.open.get(key);
    this.open.delete(key);
    await session?.then(s => s.release(), () => {}).catch(() => {});
  }
}

function sessionOptions(provider: Provider, cpuNodes?: readonly string[]): Ort.InferenceSession.SessionOptions {
  // DirectML can't use memory patterns or run nodes in parallel.
  if (provider === "dml") return { executionProviders: ["dml"], enableMemPattern: false, executionMode: "sequential", logSeverityLevel: 3 };
  const cores = availableParallelism();
  const threads = { intraOpNumThreads: Math.min(cores, cores >= 16 ? 8 : 4), interOpNumThreads: 1 };
  // Nodes WebGPU gets wrong stay on the CPU, named one to a line (the option holds 2,048 characters).
  if (provider === "webgpu") return { executionProviders: [{ name: "webgpu", ...(cpuNodes?.length && { forceCpuNodeNames: cpuNodes.join("\n") }) } as Ort.InferenceSession.ExecutionProviderConfig],
    ...threads, logSeverityLevel: 3 };
  return { executionProviders: ["cpu"], ...threads, logSeverityLevel: 3 };
}

/** Whether ONNX Runtime's WebGPU path is worth trying: Apple silicon, where it is the only GPU path these models have. */
export function webgpuAvailable(platform: string = process.platform, arch: string = process.arch) {
  return platform === "darwin" && arch === "arm64";
}

/**
 * Run `work` on the GPU first, then on the CPU. On Windows that's DirectML, which runs on any DirectX 12 GPU and ships
 * with onnxruntime-node. On the wav2vec2 aligner (RTX PRO 6000, 2026-11-06) a 30 s window took 23-230 ms on DirectML
 * against 0.8-1.6 s on 8 cores, with about a fiftieth of the CPU time and the same top letter in all 4,122 frames.
 * When the GPU can't create the session or run it, the work runs again on the CPU.
 *
 * `gpu` names another GPU path to try, or false for none. On Apple silicon ONNX Runtime's WebGPU path ran the filler
 * model 3.3 times as fast as eight cores with the same output, and the aligner three times as fast with the wrong
 * output (2,379 of 5,996 frames named another letter, M5 Max, onnxruntime 1.22). So a caller asks for it by name,
 * keeps the nodes it gets wrong on the CPU (`cpuNodes`), and checks what it returns. With `sessions`, each session
 * stays open for the next call instead of being released.
 */
export async function withInference<T>(ort: typeof Ort, model: string, work: (session: Session, provider: Provider) => Promise<T>,
  options: { sessions?: Sessions; gpu?: "webgpu" | false; cpuNodes?: readonly string[] } = {}): Promise<T> {
  const { sessions } = options;
  const gpu: Provider | undefined = options.gpu === false ? undefined : options.gpu ?? (process.platform === "win32" ? "dml" : undefined);
  const acquire = (provider: Provider) => {
    const create = () => ort.InferenceSession.create(model, sessionOptions(provider, options.cpuNodes));
    return sessions ? sessions.get(`${provider}:${model}`, create) : create();
  };
  const name = basename(model);
  if (gpu && !sessions?.gpuFailed.has(model)) {
    let session: Session | undefined;
    try {
      session = await acquire(gpu);
      const result = await work(session, gpu);
      sessions?.tell(`${name} runs on the GPU (${gpu})`);
      return result;
    } catch (error) {
      // No usable GPU, a driver the provider can't use, or output that failed the caller's check.
      sessions?.gpuFailed.add(model);
      sessions?.tell(`${name} left the GPU (${gpu}) for the CPU: ${error instanceof Error ? error.message : error}`);
      await sessions?.drop(`${gpu}:${model}`);
    } finally { if (!sessions) await session?.release().catch(() => {}); }
  }
  const session = await acquire("cpu");
  try { return await work(session, "cpu"); }
  finally { if (!sessions) await session.release(); }
}

/** Source: 16 kHz mono PCM as produced by extractWav. FFmpeg may include LIST chunks. */
export function wavSamples(wav: Buffer): Float32Array {
  for (let at = 12; at + 8 <= wav.length;) {
    const bytes = wav.readUInt32LE(at + 4), start = at + 8;
    if (start + bytes > wav.length) break;
    if (wav.toString("ascii", at, at + 4) === "data") {
      const samples = new Float32Array(Math.floor(bytes / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(start + i * 2) / 32768;
      return samples;
    }
    at = start + bytes + bytes % 2;
  }
  throw new Error("No complete PCM audio in the analysis window.");
}

export class UhmDetector {
  private model: LocalWhisperModel;
  constructor(directory: string) { this.model = new LocalWhisperModel(directory, weights); }

  async detect(wav: string, origin: number, signal: AbortSignal): Promise<AcousticFiller[]> {
    const model = await this.model.get(signal);
    return audioWorker.request<AcousticFiller[]>({ kind: "fillers", wav, model, origin }, { signal });
  }
}

/** One 30 s window of normalized audio through the model: six class probabilities per 20 ms frame. */
async function fillerProbs(ort: typeof Ort, session: Session, input: Float32Array) {
  const result = await session.run({ audio: new ort.Tensor("float32", input, [1, maxSamples]) });
  return result.probs!.data as Float32Array;
}

// onnxruntime-node runs native inference synchronously inside a setImmediate.
// Keep model loading and all inference off the engine's request/playback thread.
export async function runFillerWorker(wav: string, model: string, origin: number, sessions?: Sessions): Promise<AcousticFiller[]> {
  const samples = wavSamples(await readFile(wav));
  const ort = loadRuntime();
  // The GPU on Apple silicon, in the helper that keeps its session: preparing WebGPU for one page would cost more
  // than it saves. Its first window there is also run on the CPU, and the GPU is used only if the two agree.
  const gpu = sessions && webgpuAvailable() ? "webgpu" as const : undefined;
  return withInference(ort, model, async (session, provider) => {
    const sum = new Float32Array(Math.ceil(samples.length / frame));
    const counts = new Uint8Array(sum.length);
    for (let start = 0; start < samples.length; start += 25 * rate) {
      const part = samples.subarray(start, start + maxSamples);
      if (part.length < 400) break;
      let total = 0, variance = 0;
      for (let i = 0; i < part.length; i++) total += part[i]!;
      const mean = total / part.length;
      for (let i = 0; i < part.length; i++) variance += (part[i]! - mean) ** 2;
      const sd = Math.sqrt(variance / (part.length - 1)) + 1e-7;
      const input = new Float32Array(maxSamples);
      for (let i = 0; i < part.length; i++) input[i] = (part[i]! - mean) / sd;
      const probs = await fillerProbs(ort, session, input);
      if (provider === "webgpu" && sessions && !sessions.verified.has(model)) {
        const expected = await withInference(ort, model, cpu => fillerProbs(ort, cpu, input), { sessions, gpu: false });
        let worst = 0;
        for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(expected[i]! - probs[i]!));
        if (!(worst <= GPU_TOLERANCE)) throw new Error(`The GPU's filler probabilities differ from the CPU's by ${worst.toFixed(3)}.`);
        sessions.verified.add(model);
        await sessions.drop(`cpu:${model}`);
      }
      const frames = 1 + Math.floor((part.length - 400) / frame);
      for (let i = 0; i < frames; i++) {
        const slot = start / frame + i;
        sum[slot] = sum[slot]! + 1 - probs[6 * i]!;
        counts[slot] = counts[slot]! + 1;
      }
      if (start + part.length === samples.length) break;
    }
    const spans: AcousticFiller[] = [];
    for (let i = 0; i < sum.length;) {
      const first = i;
      let total = 0;
      while (i < sum.length && counts[i] && sum[i]! / counts[i]! >= 0.65) {
        total += sum[i]! / counts[i]!;
        i++;
      }
      if (i === first) { i++; continue; }
      const start = origin + first * frame / rate, end = origin + i * frame / rate;
      const previous = spans.at(-1);
      const confidence = total / (i - first);
      if (previous && start - previous.end <= 0.100001) {
        previous.end = end;
        previous.confidence = Math.max(previous.confidence, confidence);
      } else if (i - first >= 6) spans.push({ start, end, confidence });
    }
    return spans;
  }, { sessions, ...(gpu && { gpu }) });
}
