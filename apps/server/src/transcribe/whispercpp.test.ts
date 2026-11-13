import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as ffmpeg from "../render/ffmpeg.js";
import { bundledWhisperOnGpu, parseWhisperJson, WhisperCppProvider, whisperThreads } from "./whispercpp.js";

afterEach(() => { vi.restoreAllMocks(); });

it("decodes long audio without text context and keeps context for a prompted window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-"));
  try {
    const calls: string[][] = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
      calls.push(args);
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", model: "model.bin" });
    await whisper.transcribeWav("a.wav", dir);
    await whisper.transcribeWav("a.wav", dir, undefined, "en", "Um, uh.");
    expect(calls[0]).toEqual(expect.arrayContaining(["-mc", "0"]));
    expect(calls[1]).not.toContain("-mc");
    expect(calls[1]).toEqual(expect.arrayContaining(["--prompt", "Um, uh."]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  ["{", "invalid JSON"],
  ['{"text":"words without timing"}', "transcription"],
  ['{"transcription":[{"text":"hello","offsets":{"from":0,"to":"soon"}}]}', "transcription.0.offsets.to"],
])("reports malformed local adapter output and removes the temporary result", async (output, reason) => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-adapter-"));
  try {
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
      await writeFile(args[args.indexOf("-of") + 1] + ".json", output);
      return Buffer.alloc(0);
    });
    const provider = new WhisperCppProvider({ binary: "my-adapter", model: "my-model" });
    await expect(provider.transcribeWav("sample.wav", dir)).rejects.toThrow(reason);
    expect(await readdir(dir)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  [" Parakeet TDT 0.6B v3 ", "Parakeet TDT 0.6B v3"],
  ["nvidia/parakeet-tdt-0.6b-v3", "nvidia/parakeet-tdt-0.6b-v3"],
  ["/private/weights/model.bin", "model.bin"],
  ["../weights/model.bin", "model.bin"],
  ["C:\\weights\\custom.gguf", "custom.gguf"],
  ["https://weights.example/model?token=private", undefined],
  [{ version: 1 }, undefined],
])("reads an optional model label without exposing a path or disrupting older adapters", async (reported, expected) => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-adapter-"));
  try {
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
      const output = { result: { model: reported }, transcription: [] };
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify(output));
      return Buffer.alloc(0);
    });
    const provider = new WhisperCppProvider({ binary: "my-adapter" });
    const result = await provider.transcribeWav("sample.wav", dir);
    expect(result.modelLabel).toBe(expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("uses up to 8 threads on large machines and keeps whisper-cli's 4 elsewhere", () => {
  expect(whisperThreads(24)).toBe(8);
  expect(whisperThreads(16)).toBe(8);
  expect(whisperThreads(10)).toBe(4);
  expect(whisperThreads(2)).toBe(2);
});

it("reports whisper-cli's progress lines for a full recording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-"));
  try {
    const calls: string[][] = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args, opts) => {
      calls.push(args);
      for (const line of ["whisper_init_from_file: loading model", "whisper_print_progress_callback: progress =   5%", "whisper_print_progress_callback: progress = 100%"]) {
        opts?.onStderrLine?.(line);
      }
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", model: "model.bin" });
    const progress: number[] = [];
    await whisper.transcribeWav("a.wav", dir, undefined, "en", undefined, f => progress.push(f));
    await whisper.transcribeWav("a.wav", dir, undefined, "en", "Um, uh.");
    expect(progress).toEqual([0.05, 1]);
    expect(calls[0]).toEqual(expect.arrayContaining(["-pp", "-t", String(whisperThreads())]));
    expect(calls[1]).not.toContain("-pp");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("logs just the CrisperWhisper device and fallback markers, even for a window without progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-crisper-log-"));
  try {
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args, opts) => {
      for (const line of ["crisperwhisper device = mps", "GPU recognition failed: model detail",
        "crisperwhisper fallback = mps", "crisperwhisper device = cpu", "other decoder output"]) {
        opts?.onStderrLine?.(line);
      }
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    const log = vi.fn();
    const provider = new WhisperCppProvider({ binary: "python", crisperScript: "crisper_cli.py", log });
    await provider.transcribeWav("sample.wav", dir);
    expect(log.mock.calls.flat()).toEqual(["[transcribe] crisperwhisper device = mps", "[transcribe] crisperwhisper fallback = mps",
      "[transcribe] crisperwhisper device = cpu"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("transcribes with the GPU build first, and on the CPU build once it has finished a run the GPU one failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-"));
  try {
    const binaries: string[] = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (bin, args, opts) => {
      opts?.signal?.throwIfAborted();
      binaries.push(bin);
      if (bin === "gpu/whisper-cli.exe" && binaries.length > 1) throw new Error("ggml_vulkan: device lost");
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    const logs: string[] = [];
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", gpuBinary: "gpu/whisper-cli.exe", model: "model.bin", log: m => logs.push(m) });
    await whisper.transcribeWav("a.wav", dir);
    await whisper.transcribeWav("a.wav", dir);
    await whisper.transcribeWav("a.wav", dir);
    expect(binaries).toEqual(["gpu/whisper-cli.exe", "gpu/whisper-cli.exe", "whisper-cli", "whisper-cli"]);
    // The failure is logged when it happens, and the switch once the CPU build has finished the run.
    expect(logs).toEqual([expect.stringContaining("device lost"), expect.stringContaining("until Scarlet restarts")]);
    // A cancelled run is not a GPU failure: nothing is logged against the GPU build, and the next run starts on it.
    const cancelled = new AbortController();
    cancelled.abort(new Error("stopped"));
    const said: string[] = [];
    const other = new WhisperCppProvider({ binary: "whisper-cli", gpuBinary: "gpu2/whisper-cli.exe", model: "model.bin", log: m => said.push(m) });
    await expect(other.transcribeWav("a.wav", dir, cancelled.signal)).rejects.toThrow("stopped");
    expect(said).toEqual([]);
    await other.transcribeWav("a.wav", dir);
    expect(binaries.at(-1)).toBe("gpu2/whisper-cli.exe");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("fetches the model before either build runs, so a failed download starts neither and leaves the GPU build in use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-"));
  try {
    const binaries: string[] = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (bin, args) => {
      binaries.push(bin);
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    let downloads = 0;
    const model = async () => {
      if (++downloads === 1) throw new Error("Could not download the local model ggml-base.bin: fetch failed. Retry transcription to try again.");
      return "model.bin";
    };
    const logs: string[] = [];
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", gpuBinary: "gpu3/whisper-cli.exe", model, log: m => logs.push(m) });
    await expect(whisper.transcribeWav("a.wav", dir)).rejects.toThrow("Could not download the local model");
    // One download, no program started, and nothing held against the GPU build.
    expect(downloads).toBe(1);
    expect(binaries).toEqual([]);
    expect(logs).toEqual([]);
    await whisper.transcribeWav("a.wav", dir);
    expect(binaries).toEqual(["gpu3/whisper-cli.exe"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("keeps the GPU build in use when the CPU build can't finish the transcription either", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-"));
  try {
    const binaries: string[] = [];
    // Audio whisper-cli can't read fails on both builds alike.
    const run = vi.spyOn(ffmpeg, "run").mockImplementation(async bin => {
      binaries.push(bin);
      throw new Error(`${bin} exited with code 11: error: failed to read audio file 'a.wav'`);
    });
    const logs: string[] = [];
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", gpuBinary: "gpu4/whisper-cli.exe", model: "model.bin", log: m => logs.push(m) });
    // The CPU build's error is the one thrown, as it is without a GPU build.
    await expect(whisper.transcribeWav("a.wav", dir)).rejects.toThrow(/^whisper-cli exited with code 11/);
    expect(binaries).toEqual(["gpu4/whisper-cli.exe", "whisper-cli"]);
    // A run stopped while the CPU build has it proves nothing about the GPU either.
    const stop = new AbortController();
    run.mockImplementation(async (bin, _args, opts) => {
      binaries.push(bin);
      if (bin === "whisper-cli") stop.abort(new Error("stopped"));
      opts?.signal?.throwIfAborted();
      throw new Error("ggml_vulkan: device lost");
    });
    await expect(whisper.transcribeWav("a.wav", dir, stop.signal)).rejects.toThrow("stopped");
    expect(binaries.slice(2)).toEqual(["gpu4/whisper-cli.exe", "whisper-cli"]);
    run.mockImplementation(async (bin, args) => {
      binaries.push(bin);
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    await whisper.transcribeWav("a.wav", dir);
    expect(binaries.at(-1)).toBe("gpu4/whisper-cli.exe");
    // Each GPU failure is logged with its error, and nothing says the GPU build was given up.
    expect(logs).toEqual([expect.stringContaining("gpu4/whisper-cli.exe exited with code 11"), expect.stringContaining("device lost")]);
    expect(logs.join(" ")).not.toContain("until Scarlet restarts");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("joins whisper's tokens into words: pieces onto the word before, punctuation with it, markers left out", () => {
  const token = (text: string, from: number, to: number, p = 0.9) => ({ text, offsets: { from, to }, p });
  const [first, second] = parseWhisperJson({ transcription: [
    { offsets: { from: 0, to: 2000 }, text: " Trans-Siberian, okay?", tokens: [
      { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
      token(" Trans", 100, 300, 0.8), token("-", 300, 320), token("S", 320, 400), token("iber", 400, 600), token("ian", 600, 900), token(",", 900, 910),
      // A token with no times, an empty one, and a timestamp marker are not words.
      { text: " lost" }, token("", 950, 960), token("<|endoftext|>", 960, 970), token("[_TT_48]", 970, 980),
      token(" okay", 1000, 1400, 0.5), token("?", 1400, 1410),
    ] },
    // A piece with nothing before it starts a word, a word that ends before it starts has no length, and a blank is dropped.
    { offsets: { from: 2000, to: 1500 }, text: " um ", tokens: [token("um", 2100, 2050, 0.3), token(" ", 2200, 2300), token(" so", 2300, 2500)] },
    { offsets: { from: 3000, to: 4000 }, text: "[BLANK_AUDIO]" },
  ] });
  expect(first).toMatchObject({ start: 0, end: 2, text: "Trans-Siberian, okay?" });
  expect(first!.words).toEqual([
    { text: "Trans-Siberian,", start: 0.1, end: 0.91, confidence: 0.8 },
    { text: "okay?", start: 1, end: 1.41, confidence: 0.5 },
  ]);
  expect(second).toMatchObject({ start: 2, end: 2, text: "um" });
  expect(second!.words).toEqual([{ text: "um", start: 2.1, end: 2.1, confidence: 0.3 }, { text: "so", start: 2.3, end: 2.5, confidence: 0.9 }]);
  expect(parseWhisperJson({ transcription: [{ offsets: { from: 3000, to: 4000 }, text: "[BLANK_AUDIO]" }] })).toMatchObject([{ start: 3, end: 4, text: "[BLANK_AUDIO]", words: [] }]);
  expect(parseWhisperJson({})).toEqual([]);
});

it("decodes a recording's audio for whisper, keeps the decode only where the caller asked, and reads a dialogue window as it is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-"));
  try {
    const decoded: Array<[string, string]> = [];
    vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (input, output) => { decoded.push([input, output]); await writeFile(output, "wav"); });
    const heard: string[] = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
      heard.push(args[args.indexOf("-f") + 1]!);
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" },
        transcription: [{ offsets: { from: 0, to: 900 }, text: " Hi.", tokens: [{ text: " Hi", offsets: { from: 100, to: 400 }, p: 0.9 }, { text: ".", offsets: { from: 400, to: 410 }, p: 0.9 }] }] }));
      return Buffer.alloc(0);
    });
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", model: "model.bin" });
    const result = await whisper.transcribe({ path: "talk.mov", tmpDir: dir });
    expect(result).toMatchObject({ language: "en", segments: [{ start: 0, end: 0.9, text: "Hi.", words: [{ text: "Hi.", start: 0.1, end: 0.41 }] }] });
    expect(decoded).toEqual([["talk.mov", heard[0]]]);
    // Its own decode and whisper's output are gone. One the caller asked for stays, for the aligner.
    expect(await readdir(dir)).toEqual([]);
    const kept = join(dir, "kept.wav");
    await whisper.transcribe({ path: "talk.mov", tmpDir: dir, keepWavAt: kept });
    expect(heard[1]).toBe(kept);
    expect(await readdir(dir)).toEqual(["kept.wav"]);
    await whisper.transcribe({ path: join(dir, "window.wav"), tmpDir: dir, dialogueWindow: {} });
    expect(heard[2]).toBe(join(dir, "window.wav"));
    expect(decoded).toHaveLength(2);
    // The decode is removed when whisper fails too.
    vi.spyOn(ffmpeg, "run").mockRejectedValue(new Error("whisper-cli exited with code 3"));
    await expect(whisper.transcribe({ path: "talk.mov", tmpDir: dir })).rejects.toThrow("exited with code 3");
    expect(await readdir(dir)).toEqual(["kept.wav"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("counts the bundled whisper as a GPU build only on Apple silicon", () => {
  expect(bundledWhisperOnGpu("darwin", "arm64")).toBe(true);
  expect(bundledWhisperOnGpu("darwin", "x64")).toBe(false);
  expect(bundledWhisperOnGpu("win32", "arm64")).toBe(false);
});
