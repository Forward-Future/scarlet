import { clusterExcerpts } from "./speakerClusters.js";
import type { SpeakerTurn } from "./speakerLabels.js";
import type { SpeakerProgress } from "@scarlet/shared";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { availableParallelism } from "node:os";

/**
 * Windows bundles a DirectML build of the speaker runtime in speaker-gpu/, beside the CPU one: the same addon, with
 * sherpa-onnx built against ONNX Runtime's DirectML package, which runs on any DirectX 12 GPU. A build without it
 * ships an empty addon in its place (build-speaker-gpu.mjs), which counts as none.
 */
export function speakerGpuRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== "win32") return;
  return [env.SCARLET_BIN_DIR, dirname(process.execPath)].flatMap(dir => dir ? [join(dir, "speaker-gpu")] : [])
    .find(dir => !!statSync(join(dir, "sherpa-onnx.node"), { throwIfNoEntry: false })?.size && existsSync(join(dir, "DirectML.dll")));
}

// The synchronous native inference runs in a child process. Cancelling a project
// or closing the app can stop it without blocking playback or the engine's API.
// A process loads one runtime, so the CPU fallback after a GPU failure is a fresh worker with `cpuOnly`.
export async function runSpeakerWorker(wav: string, segmentation: string, embedding: string, onProgress: (p: SpeakerProgress) => void, cpuOnly = false) {
  const require = createRequire(import.meta.url);
  const bin = dirname(process.execPath);
  const packaged = [join(bin, "speaker-runtime"), join(bin, "../Resources/speaker-runtime")];
  const gpu = cpuOnly ? undefined : speakerGpuRuntime();
  const addon = gpu ? require(join(gpu, "sherpa-onnx.node")) : isSea()
    ? require(join(packaged.find(p => existsSync(join(p, "sherpa-onnx.node"))) ?? packaged[0]!, "sherpa-onnx.node"))
    : createRequire(require.resolve("sherpa-onnx-node"))(`sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`);
  const wave = addon.readWave(wav);
  if (wave.sampleRate !== 16000) throw new Error("Speaker analysis requires 16 kHz audio.");
  // DirectML takes about 10 s to prepare both models, then runs well ahead of the CPU: 5 minutes of speech took 19-25 s
  // and about 20 s of CPU, against 24-33 s and 92-127 s on the CPU, with the same turns (RTX PRO 6000, 2026-11-06).
  // On 90 s it lost, 13-15 s against 5-8 s, so a short recording stays on the CPU.
  const provider = gpu && wave.samples.length >= 180 * 16000 ? "directml" : "cpu";
  // Speaker matching can overlap Whisper and Uhm, leaving cores for playback.
  const cores = availableParallelism();
  const numThreads = Math.min(cores, cores >= 16 ? 4 : 2);
  const handle = addon.createOfflineSpeakerDiarization({
    segmentation: { pyannote: { model: segmentation, windowShiftRatio: .25 }, numThreads, provider },
    embedding: { model: embedding, numThreads, provider },
    clustering: { numClusters: -1, threshold: .55 }, minDurationOn: .25, minDurationOff: .3,
  });
  let last: SpeakerProgress | undefined;
  function report(phase: SpeakerProgress["phase"], percent?: number) {
    if (last?.phase === phase && last.percent === percent) return;
    last = { phase, percent };
    onProgress(last);
  }
  // The native async worker retains its JS receiver, but only borrows the handle.
  const detector = { handle, process: addon.offlineSpeakerDiarizationProcessAsync };
  report("segmenting");
  const turns: SpeakerTurn[] = await detector.process(handle, wave.samples, (processed: number, total: number) => {
    if (last?.phase === "matching" || total <= 0) return;
    if (processed < total) report("identifying", Math.floor(100 * processed / total));
    else report("grouping");
  });
  const extractor = addon.createSpeakerEmbeddingExtractor({ model: embedding, numThreads, provider: "cpu" });
  return clusterExcerpts(turns.map((t, index) => {
    report("matching", Math.floor(100 * index / turns.length));
    const duration = t.end - t.start;
    if (duration < .65) return t;
    const length = Math.min(duration - .1, 4);
    const centerStart = t.start + (duration - length) / 2;
    const stream = addon.speakerEmbeddingExtractorCreateStream(extractor);
    addon.acceptWaveformOnline(stream, { sampleRate: 16000, samples: wave.samples.slice(Math.floor(centerStart * 16000), Math.floor((centerStart + length) * 16000)) });
    addon.inputFinished(stream);
    if (!addon.speakerEmbeddingExtractorIsReady(extractor, stream)) return t;
    const voice: Float32Array = addon.speakerEmbeddingExtractorComputeEmbedding(extractor, stream, true);
    return { ...t, voice };
  }));
}
