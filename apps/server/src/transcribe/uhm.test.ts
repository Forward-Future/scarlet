import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ort from "onnxruntime-node";
import { audioWorker } from "./audioWorker.js";
import { LocalWhisperModel } from "./localModel.js";
import { loadRuntime, runFillerWorker, Sessions, UhmDetector, wavSamples, webgpuAvailable, withInference } from "./uhm.js";

// The engine requires ONNX Runtime by name. Here that gives whichever stand-in the test has installed.
const installed = vi.hoisted(() => ({ ort: undefined as unknown, asked: [] as string[], packaged: false }));
vi.mock("node:sea", () => ({ isSea: () => installed.packaged }));
vi.mock("node:module", async original => ({
  ...await original<typeof import("node:module")>(),
  createRequire: () => (name: string) => { installed.asked.push(name); return installed.ort; },
}));

type Created = { provider: string; options: Ort.InferenceSession.SessionOptions; release: ReturnType<typeof vi.fn> };

/** A runtime whose sessions only record how they were made. `failing` providers can't create one. */
function runtime(failing: string[] = []) {
  const created: Created[] = [];
  const ort = { InferenceSession: { create: async (_model: string, options: Ort.InferenceSession.SessionOptions) => {
    const first = options.executionProviders![0]!;
    const provider = typeof first === "string" ? first : first.name;
    if (failing.includes(provider)) throw new Error(`no ${provider}`);
    const session = { provider, options, release: vi.fn(async () => {}) };
    created.push(session);
    return session;
  } } } as unknown as typeof Ort;
  return { ort, created };
}
const providerOf = (session: Ort.InferenceSession) => (session as unknown as Created).provider;

describe("inference sessions", () => {
  it("runs on the named GPU path with the nodes it gets wrong kept on the CPU, and releases a one-off session", async () => {
    const { ort, created } = runtime();
    const used = await withInference(ort, "aligner.onnx", async (session, provider) => [providerOf(session), provider],
      { gpu: "webgpu", cpuNodes: ["/conv.1", "/conv.2"] });
    expect(used).toEqual(["webgpu", "webgpu"]);
    expect(created[0]!.options.executionProviders).toEqual([{ name: "webgpu", forceCpuNodeNames: "/conv.1\n/conv.2" }]);
    expect(created[0]!.release).toHaveBeenCalledTimes(1);
  });

  it("falls back to the CPU when the GPU can't start or its output fails the caller's check", async () => {
    const none = runtime(["webgpu"]);
    expect(await withInference(none.ort, "m.onnx", async (_s, provider) => provider, { gpu: "webgpu" })).toBe("cpu");
    const wrong = runtime();
    const seen: string[] = [];
    const result = await withInference(wrong.ort, "m.onnx", async (_s, provider) => {
      seen.push(provider);
      if (provider === "webgpu") throw new Error("The GPU's output differs from the CPU's.");
      return "from the cpu";
    }, { gpu: "webgpu" });
    expect(result).toBe("from the cpu");
    expect(seen).toEqual(["webgpu", "cpu"]);
    // No GPU path is tried unless one is named for this platform or the caller.
    const plain = runtime();
    await withInference(plain.ort, "m.onnx", async () => {}, { gpu: false });
    expect(plain.created.map(s => s.provider)).toEqual(["cpu"]);
  });

  it("keeps sessions open between calls, and leaves a failed GPU off for that model", async () => {
    const { ort, created } = runtime();
    const sessions = new Sessions();
    for (let i = 0; i < 3; i++) expect(await withInference(ort, "a.onnx", async (_s, provider) => provider, { sessions, gpu: "webgpu" })).toBe("webgpu");
    expect(created.map(s => s.provider)).toEqual(["webgpu"]);
    expect(created[0]!.release).not.toHaveBeenCalled();
    // The GPU's answer fails a check once: its session is closed, and later calls go straight to the CPU.
    let checks = 0;
    const work = async (_s: Ort.InferenceSession, provider: string) => {
      if (provider === "webgpu") { checks++; throw new Error("differs"); }
      return provider;
    };
    expect(await withInference(ort, "a.onnx", work, { sessions, gpu: "webgpu" })).toBe("cpu");
    expect(await withInference(ort, "a.onnx", work, { sessions, gpu: "webgpu" })).toBe("cpu");
    expect(checks).toBe(1);
    expect(created[0]!.release).toHaveBeenCalledTimes(1);
    expect(created.map(s => s.provider)).toEqual(["webgpu", "cpu"]);
    // Another model still gets the GPU.
    expect(await withInference(ort, "b.onnx", async (_s, provider) => provider, { sessions, gpu: "webgpu" })).toBe("webgpu");
  });

  it("says once where each model runs and why it left the GPU, for the engine's log", async () => {
    const { ort } = runtime();
    const notes: string[] = [];
    const sessions = new Sessions(note => notes.push(note));
    for (let i = 0; i < 2; i++) await withInference(ort, "/models/fillers.onnx", async () => {}, { sessions, gpu: "webgpu" });
    await withInference(ort, "/models/aligner.onnx", async (_s, provider) => {
      if (provider === "webgpu") throw new Error("The GPU's aligner output differs from the CPU's (0.4, 12.0% of frames).");
    }, { sessions, gpu: "webgpu" });
    expect(notes).toEqual(["fillers.onnx runs on the GPU (webgpu)",
      "aligner.onnx left the GPU (webgpu) for the CPU: The GPU's aligner output differs from the CPU's (0.4, 12.0% of frames)."]);
  });
});

/** A WAV file's bytes: `chunks` are (id, body) pairs after the format chunk, each padded to an even length as RIFF requires. */
function wavBytes(...chunks: Array<[string, Buffer]>) {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(16000, 4);
  format.writeUInt32LE(32000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const parts = ([["fmt ", format], ...chunks] as Array<[string, Buffer]>).flatMap(([id, body]) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "ascii");
    head.writeUInt32LE(body.length, 4);
    return [head, body, Buffer.alloc(body.length % 2)];
  });
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, ...parts]);
}
const pcm = (samples: ArrayLike<number>) => Buffer.from(Int16Array.from(samples).buffer);

describe("reading a decode's samples", () => {
  it("finds the audio after FFmpeg's other chunks, whatever their length", () => {
    const list = Buffer.from("INFOISFT\x05\x00\x00\x00Lavf6");
    expect(list.length % 2).toBe(1);
    const samples = wavSamples(wavBytes(["LIST", list], ["data", pcm([0, 16384, -32768, 32767])]));
    expect([...samples]).toEqual([0, 0.5, -1, 32767 / 32768]);
    // Half a sample at the end is not a sample.
    expect([...wavSamples(wavBytes(["data", Buffer.concat([pcm([16384]), Buffer.alloc(1)])]))]).toEqual([0.5]);
    expect(wavSamples(wavBytes(["data", Buffer.alloc(0)]))).toHaveLength(0);
  });

  it("refuses a file with no audio chunk, or one cut off before its audio ends", () => {
    expect(() => wavSamples(wavBytes(["LIST", Buffer.alloc(6)]))).toThrow("No complete PCM audio in the analysis window.");
    const whole = wavBytes(["data", pcm([1, 2, 3, 4])]);
    expect(() => wavSamples(whole.subarray(0, whole.length - 2))).toThrow("No complete PCM audio in the analysis window.");
    expect(() => wavSamples(Buffer.alloc(0))).toThrow("No complete PCM audio in the analysis window.");
  });
});

describe("filler detection in the audio helper", () => {
  const rate = 16000, frame = 320;
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-uhm-")); });
  const machine = { platform: process.platform, arch: process.arch };
  const onMachine = (platform: string, arch: string) => {
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "arch", { value: arch });
  };
  afterEach(async () => { onMachine(machine.platform, machine.arch); await rm(dir, { recursive: true, force: true }); });

  /** Audio the stand-in model can read: a frame holds a filler when it opens with a spike. `fillers` are [first, last] frames. */
  async function recording(seconds: number, fillers: Array<[number, number]>) {
    const samples = new Int16Array(seconds * rate);
    for (const [first, last] of fillers) for (let f = first; f <= last; f++) samples[f * frame] = 20000;
    const file = join(dir, `${seconds}s.wav`);
    await writeFile(file, wavBytes(["LIST", Buffer.alloc(5)], ["data", pcm(samples)]));
    return file;
  }
  type Made = { provider: string; options: Ort.InferenceSession.SessionOptions; windows: number; released: boolean };
  /**
   * Installs a runtime whose model says how sure it is that each frame is not a filler. `sure(provider, window)`: how
   * sure it is of a filler it hears. `failing` providers can't create a session.
   */
  function runtime(sure: (provider: string, window: number) => number = () => 1, failing: string[] = []) {
    const made: Made[] = [];
    const ort = installed.ort = {
      Tensor: class { constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {} },
      InferenceSession: { create: async (_model: string, options: Ort.InferenceSession.SessionOptions) => {
        const first = options.executionProviders![0]!;
        const session: Made = { provider: typeof first === "string" ? first : first.name, options, windows: 0, released: false };
        if (failing.includes(session.provider)) throw new Error(`no ${session.provider}`);
        made.push(session);
        return {
          async run({ audio }: { audio: { data: Float32Array; dims: number[] } }) {
            expect(audio.dims).toEqual([1, 30 * rate]);
            const confidence = sure(session.provider, session.windows++);
            const probs = new Float32Array(6 * 1499).fill(0);
            for (let i = 0; i < 1499; i++) probs[6 * i] = audio.data[i * frame]! > audio.data[i * frame + 1]! ? 1 - confidence : 1;
            return { probs: { data: probs } };
          },
          async release() { session.released = true; },
        };
      } },
    } as unknown as typeof Ort;
    return { ort, made };
  }
  const rounded = (spans: Array<{ start: number; end: number; confidence: number }>) =>
    spans.map(s => [Math.round(s.start * 1000) / 1000, Math.round(s.end * 1000) / 1000, Math.round(s.confidence * 1000) / 1000]);

  it("returns fillers of 120 ms or more at their source times, joined across gaps of up to 100 ms", async () => {
    onMachine("linux", "x64");
    const { ort, made } = runtime();
    expect(loadRuntime()).toBe(ort);
    expect(installed.asked.at(-1)).toBe("onnxruntime-node");
    // 220 ms at 1 s, then 60 ms more after a 60 ms gap; 80 ms alone at 2 s; two of 140 ms either side of a 60 ms gap; two 120 ms apart.
    const wav = await recording(4, [[50, 60], [64, 66], [100, 103], [120, 126], [130, 136], [150, 156], [163, 169]]);
    const spans = await runFillerWorker(wav, "fillers.onnx", 100);
    expect(rounded(spans)).toEqual([[101, 101.34, 1], [102.4, 102.74, 1], [103, 103.14, 1], [103.26, 103.4, 1]]);
    expect(made.map(s => [s.provider, s.windows, s.released])).toEqual([["cpu", 1, true]]);
  });

  it("averages the two windows where they overlap, and hears nothing in audio too short for one frame", async () => {
    // 40 s is two windows, 0-30 s and 25-40 s. The filler at 26 s is in both, the one at 2 s only in the first.
    const wav = await recording(40, [[100, 110], [1300, 1310]]);
    onMachine("linux", "x64");
    const both = runtime((_provider, window) => window === 0 ? 0.9 : 0.5);
    expect(rounded(await runFillerWorker(wav, "fillers.onnx", 0))).toEqual([[2, 2.22, 0.9], [26, 26.22, 0.7]]);
    expect(both.made[0]!.windows).toBe(2);
    // Sure in one window and doubtful in the other comes to less than the 65% a filler needs.
    runtime((_provider, window) => window === 0 ? 0.9 : 0.3);
    expect(rounded(await runFillerWorker(wav, "fillers.onnx", 0))).toEqual([[2, 2.22, 0.9]]);
    const short = join(dir, "short.wav");
    await writeFile(short, wavBytes(["data", pcm(new Int16Array(399))]));
    const none = runtime();
    expect(await runFillerWorker(short, "fillers.onnx", 0)).toEqual([]);
    expect(none.made[0]!.windows).toBe(0);
  });

  it("uses the GPU on Apple silicon only once its first window matches the CPU's", async () => {
    onMachine("darwin", "arm64");
    const wav = await recording(4, [[50, 60]]);
    const agrees = runtime();
    const notes: string[] = [];
    const sessions = new Sessions(note => notes.push(note));
    for (let page = 0; page < 2; page++) expect(rounded(await runFillerWorker(wav, "/models/fillers.onnx", 0, sessions))).toEqual([[1, 1.22, 1]]);
    // The CPU ran the first window once, to check, and its session was closed. The GPU's stays open between pages.
    expect(agrees.made.map(s => [s.provider, s.windows, s.released])).toEqual([["webgpu", 2, false], ["cpu", 1, true]]);
    expect(notes).toEqual(["fillers.onnx runs on the GPU (webgpu)"]);

    runtime(provider => provider === "webgpu" ? 0.7 : 1);
    const said: string[] = [];
    const kept = new Sessions(note => said.push(note));
    // The answer is the CPU's: the GPU's 0.7 would have been its confidence.
    expect(rounded(await runFillerWorker(wav, "/models/fillers.onnx", 0, kept))).toEqual([[1, 1.22, 1]]);
    expect(said).toEqual(["fillers.onnx left the GPU (webgpu) for the CPU: The GPU's filler probabilities differ from the CPU's by 0.300."]);
    expect(kept.gpuFailed.has("/models/fillers.onnx")).toBe(true);
    // Without the helper's kept sessions the GPU is never tried: preparing it for one page costs more than it saves.
    const once = runtime();
    await runFillerWorker(wav, "/models/fillers.onnx", 0);
    expect(once.made.map(s => s.provider)).toEqual(["cpu"]);
  });

  it("tries DirectML first on Windows, and the CPU when it has no GPU to use", async () => {
    onMachine("win32", "x64");
    const wav = await recording(4, [[50, 60]]);
    const gpu = runtime();
    expect(rounded(await runFillerWorker(wav, "/models/fillers.onnx", 0))).toEqual([[1, 1.22, 1]]);
    expect(gpu.made.map(s => [s.provider, s.released])).toEqual([["dml", true]]);
    expect(gpu.made[0]).toMatchObject({ options: { enableMemPattern: false, executionMode: "sequential" } });
    const none = runtime(() => 1, ["dml"]);
    const notes: string[] = [];
    expect(rounded(await runFillerWorker(wav, "/models/fillers.onnx", 0, new Sessions(note => notes.push(note))))).toEqual([[1, 1.22, 1]]);
    expect(none.made.map(s => s.provider)).toEqual(["cpu"]);
    expect(notes).toEqual(["fillers.onnx left the GPU (dml) for the CPU: no dml"]);
  });

  it("asks the helper for a page's fillers with the model it has fetched, at the page's place in the source", async () => {
    const stop = new AbortController();
    const fetched = vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("/models/uhm.onnx");
    const asked = vi.spyOn(audioWorker, "request").mockResolvedValue([{ start: 61, end: 61.3, confidence: 0.9 }] as never);
    try {
      expect(await new UhmDetector(dir).detect("page.wav", 58, stop.signal)).toEqual([{ start: 61, end: 61.3, confidence: 0.9 }]);
      expect(fetched).toHaveBeenCalledWith(stop.signal);
      expect(asked).toHaveBeenCalledWith({ kind: "fillers", wav: "page.wav", model: "/models/uhm.onnx", origin: 58 }, { signal: stop.signal });
      // A model that can't be fetched fails the page before the helper is asked.
      asked.mockClear();
      fetched.mockRejectedValue(new Error("Could not download the local model uhm-1b7dc1ef.onnx: HTTP 503. Retry transcription to try again."));
      await expect(new UhmDetector(dir).detect("page.wav", 58, stop.signal)).rejects.toThrow("Could not download the local model");
      expect(asked).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it("says the installed engine is missing its runtime when the packaged one isn't beside it", () => {
    installed.packaged = true;
    try { expect(() => loadRuntime()).toThrow("The installed Scarlet engine is missing its Uhm runtime."); }
    finally { installed.packaged = false; }
  });

  it("tries WebGPU on Apple silicon only", () => {
    expect(webgpuAvailable("darwin", "arm64")).toBe(true);
    expect(webgpuAvailable("darwin", "x64")).toBe(false);
    expect(webgpuAvailable("win32", "arm64")).toBe(false);
  });
});
