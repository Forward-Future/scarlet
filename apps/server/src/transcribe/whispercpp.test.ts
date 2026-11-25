import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as ffmpeg from "../render/ffmpeg.js";
import { FfmpegError } from "../render/ffmpeg.js";
import { crisperWorker, type CrisperRequest } from "./crisperWorker.js";
import { decodedRecording } from "../services/recordingAudio.js";
import { newId } from "@scarlet/timeline";
import { bundledWhisperOnGpu, parseWhisperJson, WhisperCppProvider, whisperThreads } from "./whispercpp.js";
import { seamWindows } from "./seams.js";
import type { TranscribeResult } from "./index.js";

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

it("reads with the CrisperWhisper worker and logs just its device, fallback and quiet notes, even for a window without progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-crisper-log-"));
  try {
    const requests: CrisperRequest[] = [];
    vi.spyOn(crisperWorker, "transcribe").mockImplementation(async request => {
      requests.push(request);
      for (const line of ["crisperwhisper device = mps", "GPU recognition failed: model detail", "crisperwhisper fallback = mps",
        "crisperwhisper device = cpu", "crisperwhisper quiet = 412.5 s of 600.0 s not read", "other decoder output"]) {
        request.onStderrLine?.(line);
      }
      await writeFile(request.out + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
    });
    const run = vi.spyOn(ffmpeg, "run");
    const log = vi.fn();
    const provider = new WhisperCppProvider({ binary: "python", model: "model.safetensors", crisperScript: "crisper_cli.py", log });
    await provider.transcribeWav("sample.wav", dir, undefined, "en", "Um, uh.");
    expect(log.mock.calls.flat()).toEqual(["[transcribe] crisperwhisper device = mps", "[transcribe] crisperwhisper fallback = mps",
      "[transcribe] crisperwhisper device = cpu", "[transcribe] crisperwhisper quiet = 412.5 s of 600.0 s not read"]);
    expect(requests).toMatchObject([{ binary: "python", args: ["-I", "-B", "crisper_cli.py", "--serve", "-m", "model.safetensors", "-t", String(whisperThreads())],
      wav: "sample.wav", language: "en", progress: false }]);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("runs a standalone CrisperWhisper adapter that can't serve requests once per window, as before", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-crisper-old-"));
  try {
    const serve = vi.spyOn(crisperWorker, "transcribe").mockRejectedValue(new FfmpegError("python exited with code 2", [],
      "usage: crisper_cli.py [-h] -m MODEL_SAFETENSORS -f WAV -of OUTPUT_PREFIX -ojf\ncrisper_cli.py: error: the following arguments are required: -f, -of, -ojf\n"));
    const calls: string[][] = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
      calls.push(args);
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    const provider = new WhisperCppProvider({ binary: "python", model: "model.safetensors", crisperScript: "old_cli.py" });
    await provider.transcribeWav("a.wav", dir);
    await provider.transcribeWav("b.wav", dir);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(calls.map(args => args.slice(0, 7))).toEqual([["-I", "-B", "old_cli.py", "-m", "model.safetensors", "-f", "a.wav"],
      ["-I", "-B", "old_cli.py", "-m", "model.safetensors", "-f", "b.wav"]]);
    // Any other failure is the reading's own, and is reported.
    serve.mockRejectedValue(new FfmpegError("python failed: out of memory", [], "RuntimeError: out of memory"));
    const other = new WhisperCppProvider({ binary: "python", model: "model.safetensors", crisperScript: "crisper_cli.py" });
    await expect(other.transcribeWav("a.wav", dir)).rejects.toThrow("out of memory");
    expect(calls).toHaveLength(2);
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

it("leaves out a last line that only writes the end of the line before again, after it was said", () => {
  const token = (text: string, from: number, to: number) => ({ text, offsets: { from, to }, p: 0.9 });
  const line = (from: number, to: number, ...words: Array<[string, number, number]>) =>
    ({ offsets: { from, to }, text: words.map(w => w[0]).join(""), tokens: words.map(w => token(...w)) });
  const said = line(116_900, 120_780, [" behind", 117_000, 117_500], [" it", 117_500, 117_600], [" at", 117_600, 117_700], [" $3.26.", 117_700, 120_700]);
  const copy = line(122_920, 123_380, [" $3.26.", 122_920, 123_380]);
  expect(parseWhisperJson({ transcription: [said, copy] }).map(s => s.text)).toEqual(["behind it at $3.26."]);
  // Said again before the window's end, or as more than a few words, it is speech.
  expect(parseWhisperJson({ transcription: [said, copy, line(124_000, 125_000, [" Next", 124_000, 124_500])] })).toHaveLength(3);
  const sentence = line(130_000, 132_000, [" it", 130_000, 130_100], [" at", 130_100, 130_200], [" $3.26", 130_200, 131_000], [" now", 131_000, 131_200], [" today.", 131_200, 132_000]);
  const again = line(133_000, 135_000, [" it", 133_000, 133_100], [" at", 133_100, 133_200], [" $3.26", 133_200, 134_000], [" now", 134_000, 134_200], [" today.", 134_200, 135_000]);
  expect(parseWhisperJson({ transcription: [sentence, again] })).toHaveLength(2);
  // A copy that starts before its line ends is Whisper's overlap, read on its own merits elsewhere.
  expect(parseWhisperJson({ transcription: [said, line(120_000, 121_000, [" $3.26.", 120_000, 121_000])] })).toHaveLength(2);
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

/** A WAV whose samples say where they are: 1000 + tenths of a second, silent over `quiet` [from, to) seconds. */
function clockWav(seconds: number, quiet: Array<[number, number]> = []) {
  const rate = 16000, wav = Buffer.alloc(44 + seconds * rate * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < seconds * rate; i++) {
    const t = i / rate;
    wav.writeInt16LE(quiet.some(([a, b]) => t >= a && t < b) ? 0 : 1000 + Math.floor(t * 10), 44 + i * 2);
  }
  return wav;
}

/**
 * Whisper reading a window of a clockWav: a word for each whole second it heard, said at that second, except that it
 * leaves out the first word it hears and finishes the window with a word nobody said, as it does when the audio stops
 * mid-sentence. `ends` is where the recording ends: a window that reaches it ends on a real word.
 */
async function windowReading(path: string, ends: number) {
  const window = await readFile(path), rate = 16000;
  const length = window.readUInt32LE(40) / 2 / rate;
  const from = (window.readInt16LE(44) - 1000) / 10;
  const words = [];
  for (let s = Math.ceil(from) + 1; s < from + length; s++) words.push({ text: `w${s}`, start: s - from + 0.1, end: s - from + 0.6, confidence: 0.9 });
  if (from + length < ends - 0.01) words.push({ text: "insane.", start: length - 0.12, end: length, confidence: 0.1 });
  return { length, segments: [{ id: newId("seg"), start: 0, end: length, text: words.map(w => w.text).join(" "), words }] };
}

it("reads each window on past both of its seams and hands over at a word both readings have, so nothing made up at a window's edge stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-resume-"));
  try {
    const seconds = 300;
    // A pause at 122 s, two seconds after the first target.
    const wav = clockWav(seconds, [[122, 123]]);
    const extract = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, path) => writeFile(path, wav));
    const whisper = new WhisperCppProvider({ binary: "custom-adapter", language: "auto" });
    const lengths: number[] = [];
    const calls = vi.spyOn(whisper, "transcribeWav").mockImplementation(async (path, _tmp, _signal, _lang, _prompt, onProgress) => {
      const { length, segments } = await windowReading(path, seconds);
      lengths.push(length);
      onProgress?.(1);
      return { language: "fr", modelLabel: "example/model", segments };
    });
    const keepWavAt = join(dir, "kept.wav");
    // The last 40 s of video has no audio.
    const input = { path: "interview.mov", tmpDir: dir, duration: seconds + 40, keepWavAt };
    const said = Array.from({ length: seconds }, (_, s) => `w${s}`).slice(1);
    const texts = (r: TranscribeResult) => r.segments.flatMap(s => s.words.map(w => w.text));

    const saved: Array<{ through: number; chunk: TranscribeResult; fraction?: number }> = [];
    const save = (through: number, chunk: TranscribeResult, fraction?: number) => saved.push({ through, chunk, fraction });
    const progress: number[] = [];
    const whole = await whisper.transcribe({ ...input, checkpoint: { through: 0, result: { segments: [] }, save }, onProgress: f => progress.push(f) });
    expect(texts(whole)).toEqual(said);
    expect(whole.segments.every(s => s.text === s.words.map(w => w.text).join(" "))).toBe(true);
    // Windows end at the quietest moment near two minutes, and each reads 8 s on past both ends.
    expect(lengths.map(Math.round)).toEqual([130, 132, 70]);
    expect(saved.map(s => s.through).at(-1)).toBe(seconds);
    expect(saved.map(s => s.through)).toEqual([...saved.map(s => s.through)].sort((a, b) => a - b));
    expect(saved.map(s => s.fraction)).toEqual(saved.map(s => s.through / seconds));
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls.map(args => args[3])).toEqual([undefined, "fr", "fr"]);

    // Quit after the first save, then resume on the recording's clock from what was saved.
    saved.length = 0;
    const first = new AbortController();
    await expect(whisper.transcribe({ ...input, signal: first.signal, checkpoint: { through: 0, result: { segments: [] },
      save(through, chunk, fraction) { save(through, chunk, fraction); first.abort(new Error("quit")); } } })).rejects.toThrow("quit");
    const { through, chunk } = saved[0]!;
    // The first window's words are saved up to 8 s before its seam, in the pause at 122 s, as soon as it is read.
    expect(through).toBeGreaterThan(114);
    expect(through).toBeLessThan(115);
    const resumed = await whisper.transcribe({ ...input, checkpoint: { through, result: chunk, save } });
    // The resumed window's first word is the one Whisper leaves out, so only that word can go missing at a resume.
    expect(texts(resumed).filter(t => !t.startsWith("w") || said.includes(t))).toEqual(texts(resumed));
    expect(new Set(texts(resumed)).size).toBe(texts(resumed).length);
    expect(said.filter(t => !texts(resumed).includes(t)).length).toBeLessThanOrEqual(1);
    expect(await whisper.transcribe({ ...input, checkpoint: { through: seconds, result: resumed, save } })).toEqual(resumed);
    expect(await readdir(dir)).toEqual(["kept.wav"]);
    // A short recording is still transcribed as one file with the adapter's original timestamps.
    const short = join(dir, "short.wav");
    await (await decodedRecording(keepWavAt)).writeWindow(short, 0, 9.997);
    extract.mockImplementation(async (_file, target) => copyFile(short, target));
    const unsplit = await whisper.transcribe({ ...input, path: short, checkpoint: { through: 0, result: { segments: [] }, save } });
    expect(unsplit.segments.at(-1)!.end).toBeCloseTo(9.997, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("hands two windows over at the word they share nearest the seam, whatever times each gave it", () => {
  const seg = (words: Array<[string, number]>) => ({ id: newId("seg"), start: words[0]![1], end: words.at(-1)![1] + 0.3,
    text: words.map(w => w[0]).join(" "), words: words.map(([text, start]) => ({ text, start, end: start + 0.3 })) });
  // The earlier window heard "it is" at its end and finished the sentence; the later one heard how it went on, with
  // its times a little off, and missed the first word it heard.
  const before = [seg([["about", 113.8], ["Astra", 114.2], ["first", 114.5], ["is", 115.6], ["that", 115.8], ["it", 116.1], ["is", 116.4]]),
    seg([["a", 116.8], ["fine", 117.2], ["model", 118], ["insane.", 124.5]])];
  const after = [seg([["Astra", 114.0], ["first", 114.6], ["is", 115.7], ["that", 115.9], ["it", 116.2], ["is", 116.6], ["a", 117.0],
    ["fine", 117.3], ["model,", 118.1], ["but", 119.2]])];
  const joined = seamWindows(before, after, 116.7);
  const words = [...joined.before, ...joined.after].flatMap(s => s.words.map(w => w.text));
  expect(words).toEqual(["about", "Astra", "first", "is", "that", "it", "is", "a", "fine", "model,", "but"]);
  // "is" is the shared word nearest the seam: the earlier reading runs to it, the later one goes on after it.
  expect(joined.through).toBeCloseTo(116.7);
  expect(joined.before.map(s => s.text)).toEqual(["about Astra first is that it is"]);
  expect(joined.after[0]).toMatchObject({ text: "a fine model, but", start: 117 });
  // Readings with no word in common near the seam keep the words whose middle is on their own side of it.
  const apart = seamWindows([seg([["one", 110], ["two", 116.5]])], [seg([["three", 116.6], ["four", 118]])], 116.7);
  expect([...apart.before, ...apart.after].flatMap(s => s.words.map(w => w.text))).toEqual(["one", "two", "three", "four"]);
  expect(apart.through).toBe(116.7);
});

it("gives the CrisperWhisper adapter, which reads a whole recording in one run, ten-minute windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-crisper-windows-"));
  try {
    const seconds = 700, rate = 16000;
    const wav = Buffer.alloc(44 + seconds * rate * 2);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    wav.fill(42, 44);
    vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, path) => writeFile(path, wav));
    const windows = async (provider: WhisperCppProvider) => {
      const lengths: number[] = [];
      vi.spyOn(provider, "transcribeWav").mockImplementation(async path => {
        lengths.push((await readFile(path)).readUInt32LE(40) / 2 / rate);
        return { language: "en", segments: [] };
      });
      const saved: number[] = [];
      await provider.transcribe({ path: "interview.mov", tmpDir: dir, duration: seconds,
        checkpoint: { through: 0, result: { segments: [] }, save: through => saved.push(through) } });
      expect(saved.at(-1)).toBe(seconds);
      return lengths.map(Math.round);
    };
    expect(await windows(new WhisperCppProvider({ binary: "python", crisperScript: "crisper_cli.py" }))).toEqual([608, 108]);
    // whisper-cli's windows write two minutes each, and read 8 s on past both ends.
    expect(await windows(new WhisperCppProvider({ binary: "whisper-cli" }))).toEqual([128, 136, 136, 136, 136, 108]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("returns empty segments without spawning whisper-cli for a zero-sample WAV", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-whisper-empty-"));
  try {
    const emptyWav = join(dir, "empty.wav");
    const wav = Buffer.alloc(44);
    wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(0, 40);
    await writeFile(emptyWav, wav);
    const run = vi.spyOn(ffmpeg, "run");
    const whisper = new WhisperCppProvider({ binary: "whisper-cli", model: "model.bin" });
    expect(await whisper.transcribeWav(emptyWav, dir, undefined, "en")).toEqual({ language: "en", segments: [] });
    expect(run).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
