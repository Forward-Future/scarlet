import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakerProgress } from "@scarlet/shared";
import { describe, expect, it, vi } from "vitest";
import { runSpeakerWorker, speakerGpuRuntime } from "./speakerWorker.js";

// The engine requires the speaker runtime's native addon by name. Here that gives the stand-in the test installed.
const installed = vi.hoisted(() => ({ addon: undefined as unknown, asked: [] as string[] }));
vi.mock("node:module", async original => ({
  ...await original<typeof import("node:module")>(),
  createRequire: () => Object.assign((name: string) => { installed.asked.push(name); return installed.addon; }, { resolve: (name: string) => `/modules/${name}/index.js` }),
}));

it.runIf(process.platform === "win32")("uses the GPU speaker runtime only when its addon is really there", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-speaker-gpu-"));
  try {
    const gpu = join(dir, "speaker-gpu");
    const env = { SCARLET_BIN_DIR: dir };
    await mkdir(gpu);
    await writeFile(join(gpu, "DirectML.dll"), "dll");
    expect(speakerGpuRuntime(env)).toBeUndefined();
    // A build without the GPU runtime ships an empty addon, which replaces one an earlier update installed.
    await writeFile(join(gpu, "sherpa-onnx.node"), "");
    expect(speakerGpuRuntime(env)).toBeUndefined();
    await writeFile(join(gpu, "sherpa-onnx.node"), "addon");
    expect(speakerGpuRuntime(env)).toBe(gpu);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("builds the GPU speaker runtime from the sherpa-onnx and ONNX Runtime versions the engine installs", async () => {
  const script = await readFile(new URL("../../../desktop/scripts/build-speaker-gpu.mjs", import.meta.url), "utf8");
  const { dependencies } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  // Outside GitHub a mismatch only warns and leaves the GPU runtime out of the build, so a forgotten pin shows here.
  expect(/const sherpaVersion = "([^"]+)"/.exec(script)?.[1]).toBe(dependencies["sherpa-onnx-node"]);
  expect(/const ortVersion = "([^"]+)"/.exec(script)?.[1]).toBe(dependencies["onnxruntime-node"]);
});

describe("speaker analysis in its worker", () => {
  type Turn = { start: number; end: number; speaker: number };
  /**
   * A stand-in for the sherpa-onnx addon. Its diarization returns `turns` after reporting `steps` of progress, and a
   * voice is the mean level of the audio it was given, so a test can tell which stretch each turn was heard from.
   */
  function addon(options: { seconds: number; sampleRate?: number; turns: Turn[]; steps?: Array<[number, number]>; unready?: number[] }) {
    const samples = new Float32Array(options.seconds * 16000);
    // The level rises through the recording: second n is at n / 100.
    for (let i = 0; i < samples.length; i++) samples[i] = Math.floor(i / 16000) / 100;
    const seen = { config: undefined as unknown, extractor: undefined as unknown, excerpts: [] as Array<{ seconds: number; level: number }>, receiver: undefined as unknown, read: "" };
    let streams = 0;
    installed.addon = {
      readWave: (wav: string) => { seen.read = wav; return { sampleRate: options.sampleRate ?? 16000, samples }; },
      createOfflineSpeakerDiarization: (config: unknown) => { seen.config = config; return { handle: "diarization" }; },
      async offlineSpeakerDiarizationProcessAsync(this: unknown, handle: unknown, audio: Float32Array, onStep: (processed: number, total: number) => void) {
        seen.receiver = this;
        expect(handle).toEqual({ handle: "diarization" });
        expect(audio).toBe(samples);
        for (const [processed, total] of options.steps ?? []) onStep(processed, total);
        return options.turns;
      },
      createSpeakerEmbeddingExtractor: (config: unknown) => { seen.extractor = config; return { extractor: true }; },
      speakerEmbeddingExtractorCreateStream: () => ({ stream: streams++, level: 0 }),
      acceptWaveformOnline: (stream: { level: number }, wave: { sampleRate: number; samples: Float32Array }) => {
        expect(wave.sampleRate).toBe(16000);
        stream.level = wave.samples.reduce((sum, x) => sum + x, 0) / wave.samples.length;
        seen.excerpts.push({ seconds: Math.round(wave.samples.length / 160) / 100, level: Math.round(stream.level * 1000) / 1000 });
      },
      inputFinished: () => {},
      speakerEmbeddingExtractorIsReady: (_extractor: unknown, stream: { stream: number }) => !options.unready?.includes(stream.stream),
      // Two voices: the first 30 s of the recording sound like one, the rest like the other.
      speakerEmbeddingExtractorComputeEmbedding: (_extractor: unknown, stream: { level: number }) => stream.level < 0.3 ? Float32Array.of(1, 0) : Float32Array.of(0, 1),
    };
    return seen;
  }

  it("reports each phase once as it changes, hears each turn from its middle, and reunites a voice that returns", async () => {
    const seen = addon({ seconds: 60, turns: [
      { start: 2, end: 12, speaker: 0 }, { start: 40, end: 44, speaker: 1 }, { start: 20, end: 23, speaker: 2 }, { start: 50, end: 53, speaker: 3 },
      // Too short to tell a voice from.
      { start: 30, end: 30.6, speaker: 4 },
    ], steps: [[0, 0], [0, 4], [1, 4], [1, 4], [2, 4], [4, 4], [4, 4]] });
    const progress: SpeakerProgress[] = [];
    const turns = await runSpeakerWorker("recording.wav", "segmentation.onnx", "embedding.onnx", p => progress.push(p));
    expect(seen.read).toBe("recording.wav");
    expect(installed.asked.at(-1)).toBe(`sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`);
    expect(progress).toEqual([
      { phase: "segmenting", percent: undefined }, { phase: "identifying", percent: 0 }, { phase: "identifying", percent: 25 },
      { phase: "identifying", percent: 50 }, { phase: "grouping", percent: undefined },
      { phase: "matching", percent: 0 }, { phase: "matching", percent: 20 }, { phase: "matching", percent: 40 }, { phase: "matching", percent: 60 }, { phase: "matching", percent: 80 },
    ]);
    // A long turn is heard for 4 s around its middle (5 to 9 s of a turn from 2 to 12), a short one all but its edges.
    expect(seen.excerpts).toEqual([{ seconds: 4, level: 0.065 }, { seconds: 3.9, level: 0.415 }, { seconds: 2.9, level: 0.21 }, { seconds: 2.9, level: 0.51 }]);
    // Four native speakers, two voices: the turns come back in order with the voice each matched, and none for the short one.
    expect(turns).toEqual([
      { start: 2, end: 12, speaker: 0 }, { start: 20, end: 23, speaker: 0 }, { start: 30, end: 30.6, speaker: -1 },
      { start: 40, end: 44, speaker: 1 }, { start: 50, end: 53, speaker: 1 },
    ]);
    expect(seen.config).toMatchObject({ segmentation: { pyannote: { model: "segmentation.onnx" }, provider: "cpu" }, embedding: { model: "embedding.onnx", provider: "cpu" } });
    expect(seen.extractor).toMatchObject({ model: "embedding.onnx", provider: "cpu" });
    // The native call keeps its receiver alive, and the receiver holds the handle it only borrows.
    expect(seen.receiver).toMatchObject({ handle: { handle: "diarization" } });
  });

  it("leaves a turn unmatched when the runtime can't tell its voice, and refuses audio that isn't 16 kHz", async () => {
    addon({ seconds: 60, turns: [{ start: 2, end: 12, speaker: 0 }, { start: 20, end: 30, speaker: 1 }], unready: [1] });
    const turns = await runSpeakerWorker("recording.wav", "segmentation.onnx", "embedding.onnx", () => {}, true);
    expect(turns).toEqual([{ start: 2, end: 12, speaker: 0 }, { start: 20, end: 30, speaker: -1 }]);
    const seen = addon({ seconds: 1, sampleRate: 44100, turns: [] });
    await expect(runSpeakerWorker("recording.wav", "segmentation.onnx", "embedding.onnx", () => {})).rejects.toThrow("Speaker analysis requires 16 kHz audio.");
    expect(seen.config).toBeUndefined();
  });
});
