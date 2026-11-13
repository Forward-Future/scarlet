import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerSettings } from "@scarlet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../context.js";
import * as ffmpeg from "../render/ffmpeg.js";
import { effectiveProviderName, getTranscriptionProvider, importTranscriptionPolicy, spokenText } from "./index.js";

it("reads what was said in a short recording, without whisper's labels for silence and sounds", () => {
  const said = (...texts: string[]) => spokenText(texts.map(text => ({ text })));
  expect(said(" Cut the", "[BLANK_AUDIO]", " first  take. ")).toBe("Cut the first take.");
  expect(said("(music) Trim this *coughs* (Laughs) part [ Silence ]")).toBe("Trim this part");
  // Words in brackets of the speaker's own are kept unless they name a sound.
  expect(said("Keep the (second) one (no speech)")).toBe("Keep the (second) one");
  expect(said("[BLANK_AUDIO]", " (silence) ", "*sighs*")).toBe("");
  expect(said()).toBe("");
});

it("keeps transcription off whatever a request asks for, and otherwise lets a request name the provider", () => {
  expect(effectiveProviderName("none", "openai")).toBe("none");
  expect(effectiveProviderName("whispercpp")).toBe("whispercpp");
  expect(effectiveProviderName("whispercpp", "openai")).toBe("openai");
});

describe("choosing a transcription provider", () => {
  let dir: string;
  let window: string;
  const machine = { platform: process.platform, arch: process.arch };
  const onMachine = (platform: string, arch: string) => {
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "arch", { value: arch });
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scarlet-provider-"));
    window = join(dir, "window.wav");
    await writeFile(window, Buffer.alloc(4000));
  });
  afterEach(async () => {
    onMachine(machine.platform, machine.arch);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  /** As much of the engine as a provider reads: the transcription settings with their policy signal, keys and bundled programs. */
  function engine(transcription: Partial<ServerSettings["transcription"]>, parts: { openaiKey?: string; whisperCli?: string; whisperGpu?: string; crisperAdapter?: string } = {}) {
    const policy = new AbortController(), shutdown = new AbortController();
    const settings = vi.fn();
    const model = vi.fn(async (_signal: AbortSignal) => "bundled-model.bin");
    const ctx = {
      repos: { settings: { transcriptionPolicy: () => ({ settings: { provider: "none", openaiModel: "whisper-1", ...transcription }, signal: policy.signal, revision: 7 }) } },
      paths: { root: dir }, env: { openaiKey: parts.openaiKey }, whisperCli: parts.whisperCli, whisperGpu: parts.whisperGpu, crisperAdapter: parts.crisperAdapter,
      whisperModel: { get: model }, shutdown: shutdown.signal, settings, log: vi.fn(),
    } as unknown as Ctx;
    return { ctx, policy, shutdown, settings, model };
  }
  /** whisper-cli stands in: it records the program and model it was run with and writes an empty transcript. */
  function whisper() {
    const runs: Array<{ binary: string; model: string; language: string }> = [];
    vi.spyOn(ffmpeg, "run").mockImplementation(async (binary, args, opts) => {
      opts?.signal?.throwIfAborted();
      runs.push({ binary, model: args[args.indexOf("-m") + 1]!, language: args[args.indexOf("-l") + 1]! });
      await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return Buffer.alloc(0);
    });
    return runs;
  }

  it("identifies the actual cloud model or local file without exposing model directories", () => {
    const openai = (openaiModel: string) => getTranscriptionProvider(engine({ provider: "openai", openaiModel }, { openaiKey: "key" }).ctx);
    expect(openai("ft:whisper-1:org:custom:1")?.modelLabel).toBe("ft:whisper-1:org:custom:1");
    expect(openai("/private/model")?.modelLabel).toBeUndefined();
    const local = (path: string) => getTranscriptionProvider(engine({ provider: "whispercpp", whisperModelPath: path }).ctx);
    expect(local("/private/models/ggml-small.bin")?.modelLabel).toBe("ggml-small.bin");
    expect(local("C:\\users\\models\\ggml-small.bin")?.modelLabel).toBe("ggml-small.bin");
  });

  it("has none when transcription is off, lacks its key or program, or a request names one that isn't set up", () => {
    expect(getTranscriptionProvider(engine({ provider: "none" }, { openaiKey: "key", whisperCli: "/bin/whisper-cli" }).ctx)).toBeNull();
    expect(getTranscriptionProvider(engine({ provider: "none" }, { openaiKey: "key" }).ctx, "openai")).toBeNull();
    expect(getTranscriptionProvider(engine({ provider: "openai" }).ctx)).toBeNull();
    expect(getTranscriptionProvider(engine({ provider: "whispercpp" }).ctx)).toBeNull();
    // Audio leaves the machine only when the editor chose OpenAI in Settings, whatever a request asks for.
    expect(getTranscriptionProvider(engine({ provider: "whispercpp" }, { openaiKey: "key", whisperCli: "/bin/whisper-cli" }).ctx, "openai")).toBeNull();
    expect(getTranscriptionProvider(engine({ provider: "whispercpp" }, { whisperCli: "/bin/whisper-cli" }).ctx, "deepgram")).toBeNull();
    expect(getTranscriptionProvider(engine({ provider: "openai" }, { openaiKey: "key" }).ctx)).toMatchObject({ name: "openai", separateWhisperLane: false });
  });

  it("runs the bundled whisper with the bundled model, or the program and model the editor chose in Settings", async () => {
    const runs = whisper();
    onMachine("darwin", "arm64");
    const bundled = engine({ provider: "whispercpp", language: "de" }, { whisperCli: "/app/whisper-cli" });
    const provider = getTranscriptionProvider(bundled.ctx)!;
    // On Apple silicon the bundled build runs on the GPU, so it need not wait for the CPU's audio models.
    expect(provider).toMatchObject({ name: "whispercpp", separateWhisperLane: true });
    await provider.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(runs.at(-1)).toEqual({ binary: "/app/whisper-cli", model: "bundled-model.bin", language: "de" });
    expect(bundled.model).toHaveBeenCalledTimes(1);

    const chosen = engine({ provider: "whispercpp", whisperCppPath: "/opt/whisper-cli", whisperModelPath: "/opt/large.bin" }, { whisperCli: "/app/whisper-cli", whisperGpu: "/app/gpu/whisper-cli" });
    const own = getTranscriptionProvider(chosen.ctx)!;
    expect(own.separateWhisperLane).toBe(false);
    await own.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(runs.at(-1)).toEqual({ binary: "/opt/whisper-cli", model: "/opt/large.bin", language: "auto" });
    expect(chosen.model).not.toHaveBeenCalled();

    // A model path alone means the whisper-cli on the PATH.
    await getTranscriptionProvider(engine({ provider: "whispercpp", whisperModelPath: "/opt/large.bin" }).ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(runs.at(-1)).toMatchObject({ binary: "whisper-cli", model: "/opt/large.bin" });

    // The bundled GPU build goes first where there is one, and the bundled build is not a GPU build off Apple silicon.
    onMachine("win32", "x64");
    const windows = getTranscriptionProvider(engine({ provider: "whispercpp" }, { whisperCli: "C:/app/whisper-cli.exe", whisperGpu: "C:/app/whisper-gpu/whisper-cli.exe" }).ctx)!;
    expect(windows.separateWhisperLane).toBe(false);
    await windows.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(runs.at(-1)!.binary).toBe("C:/app/whisper-gpu/whisper-cli.exe");
  });

  it("stops with the reason when transcription is turned off or the engine shuts down, before and during a run", async () => {
    const runs = whisper();
    const off = engine({ provider: "whispercpp" }, { whisperCli: "/app/whisper-cli" });
    const provider = getTranscriptionProvider(off.ctx)!;
    off.policy.abort(new Error("Transcription was turned off."));
    await expect(provider.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("Transcription was turned off.");
    expect(runs).toEqual([]);

    // The provider fails with its own error once the engine is shutting down: the reason given is the shutdown.
    const closing = engine({ provider: "whispercpp" }, { whisperCli: "/app/whisper-cli" });
    vi.spyOn(ffmpeg, "run").mockImplementation(async () => { closing.shutdown.abort(new Error("Scarlet is closing.")); throw new Error("whisper-cli was killed"); });
    await expect(getTranscriptionProvider(closing.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("Scarlet is closing.");

    // The caller's own signal stops it too, and a failure that is nobody's stop keeps its own error.
    const stop = new AbortController();
    const mine = engine({ provider: "whispercpp" }, { whisperCli: "/app/whisper-cli" });
    vi.spyOn(ffmpeg, "run").mockImplementation(async () => { stop.abort(new Error("cancelled")); throw new Error("whisper-cli was killed"); });
    await expect(getTranscriptionProvider(mine.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {}, signal: stop.signal })).rejects.toThrow("cancelled");
    vi.spyOn(ffmpeg, "run").mockRejectedValue(new Error("whisper-cli exited with code 3"));
    await expect(getTranscriptionProvider(mine.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("whisper-cli exited with code 3");
  });

  it.each(["darwin", "win32"])("runs the installed CrisperWhisper preset using the desktop adapter and the installed Python and weights on %s", async platform => {
    onMachine(platform, platform === "darwin" ? "arm64" : "x64");
    const base = join(dir, "models", "crisperwhisper"), model = join(base, "model", "model.safetensors");
    const binary = join(base, "venv", ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    const script = join(base, "crisper_cli.py");
    for (const file of [binary, script, model]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "fixture", { mode: 0o700 });
    }
    const releaseScript = join(dir, "release resources", "crisper_cli.py");
    await mkdir(dirname(releaseScript));
    await writeFile(releaseScript, "fixture");
    const runs = whisper();
    const parts = { whisperCli: "/app/whisper-cli", whisperGpu: "/app/gpu/whisper-cli", crisperAdapter: releaseScript };
    const preset = engine({ provider: "whispercpp" }, parts);
    const legacyCli = join(base, platform === "win32" ? "crisper-cli.exe" : "crisper-cli");
    const paths = { whisperCppPath: legacyCli, whisperModelPath: model };
    const legacy = engine({ provider: "whispercpp", ...paths }, parts);
    for (const install of [preset, legacy]) {
      const provider = getTranscriptionProvider(install.ctx)!;
      expect(provider.separateWhisperLane).toBe(false);
      await provider.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
      expect(runs.at(-1)).toMatchObject({ binary, model });
      expect(vi.mocked(ffmpeg.run).mock.lastCall![1].slice(0, 5)).toEqual(["-I", "-B", releaseScript, "-m", model]);
      expect(install.model).not.toHaveBeenCalled();
    }
    // A standalone engine can still use the adapter installed alongside the weights.
    const standalone = getTranscriptionProvider(engine({ provider: "whispercpp" }).ctx)!;
    await standalone.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(vi.mocked(ffmpeg.run).mock.lastCall![1].slice(0, 5)).toEqual(["-I", "-B", script, "-m", model]);
    const waiting = getTranscriptionProvider(preset.ctx)!;
    const marker = join(base, ".building-venv");
    await writeFile(marker, "");
    expect(getTranscriptionProvider(preset.ctx)?.localModel).toBe("whispercpp");
    await expect(waiting.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("Retry transcription");
    expect(runs).toHaveLength(3);
    await rm(marker);
    expect(getTranscriptionProvider(preset.ctx)?.localModel).toBe("crisperwhisper");
    // An explicit selection ignores the old preset paths, even if they are still saved.
    const bundled = engine({ provider: "whispercpp", localModel: "whispercpp", ...paths }, parts);
    await getTranscriptionProvider(bundled.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(runs.at(-1)).toMatchObject({ binary: parts.whisperGpu, model: "bundled-model.bin" });
    const custom = engine({ provider: "whispercpp", localModel: "custom", ...paths }, parts);
    vi.mocked(ffmpeg.run).mockRejectedValueOnce(new Error("custom adapter failed"));
    await expect(getTranscriptionProvider(custom.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("custom adapter failed");
    expect(vi.mocked(ffmpeg.run).mock.lastCall![0]).toBe(legacyCli);
    expect(vi.mocked(ffmpeg.run).mock.lastCall![1].slice(0, 2)).toEqual(["-m", model]);
    expect(getTranscriptionProvider(engine({ provider: "whispercpp", localModel: "custom" }, parts).ctx)).toBeNull();
    expect(getTranscriptionProvider(engine({ provider: "whispercpp", localModel: "custom", whisperModelPath: "https://example.test/model.bin" }, parts).ctx)).toBeNull();
  });

  it("omits the model argument for an explicit self-contained adapter and keeps the bundled weights for a legacy binary-only choice", async () => {
    whisper();
    const parts = { whisperCli: "/app/whisper-cli" };
    const paths = { provider: "whispercpp" as const, whisperCppPath: process.execPath };
    const custom = engine({ ...paths, localModel: "custom" }, parts);
    await getTranscriptionProvider(custom.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(vi.mocked(ffmpeg.run).mock.lastCall![0]).toBe(process.execPath);
    expect(vi.mocked(ffmpeg.run).mock.lastCall![1]).not.toContain("-m");
    expect(custom.model).not.toHaveBeenCalled();
    const legacy = engine(paths, parts);
    await getTranscriptionProvider(legacy.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} });
    expect(vi.mocked(ffmpeg.run).mock.lastCall![1].slice(0, 2)).toEqual(["-m", "bundled-model.bin"]);
    expect(legacy.model).toHaveBeenCalledTimes(1);
  });

  it("says in plain words that a recording couldn't be transcribed when ffmpeg or whisper-cli fails on it, and logs what they said", async () => {
    const plain = "Scarlet couldn’t transcribe this recording: export the logs from Settings → Advanced to report it.";
    const local = engine({ provider: "whispercpp" }, { whisperCli: "/app/whisper-cli" });
    vi.spyOn(ffmpeg, "run").mockRejectedValue(new ffmpeg.FfmpegError("/app/whisper-cli exited with code 3: error: failed to read audio data as wav", [], "error: failed to read audio data as wav"));
    await expect(getTranscriptionProvider(local.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toMatchObject({ message: plain });
    expect(local.ctx.log).toHaveBeenCalledWith("[transcribe] whispercpp failed: /app/whisper-cli exited with code 3: error: failed to read audio data as wav");
    // The audio of a recording sent to OpenAI is decoded first.
    const cloud = engine({ provider: "openai" }, { openaiKey: "key-for-tests" });
    vi.spyOn(ffmpeg, "extractWav").mockRejectedValue(new ffmpeg.FfmpegError("/app/ffmpeg exited with code 1: /data/voice.webm: Invalid data found when processing input", [], ""));
    await expect(getTranscriptionProvider(cloud.ctx)!.transcribe({ path: join(dir, "voice.webm"), duration: 3, tmpDir: dir })).rejects.toMatchObject({ message: plain });
    expect(cloud.ctx.log).toHaveBeenCalledWith("[transcribe] openai failed: /app/ffmpeg exited with code 1: /data/voice.webm: Invalid data found when processing input");
  });

  it("rechecks the settings before each upload and once the answer is in, so audio stops when consent is withdrawn", async () => {
    const order: string[] = [];
    const cloud = engine({ provider: "openai", openaiModel: "gpt-4o-transcribe", language: "en" }, { openaiKey: "key-for-tests" });
    cloud.settings.mockImplementation(() => { order.push("settings"); });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      order.push(`upload ${(init.body as FormData).get("model")} ${(init.body as FormData).get("language")}`);
      return Response.json({ language: "en", text: "", segments: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = getTranscriptionProvider(cloud.ctx)!;
    await provider.transcribe({ path: window, tmpDir: dir, dialogueWindow: {}, beforeUpload: () => { order.push("caller's check"); } });
    expect(order).toEqual(["settings", "caller's check", "upload gpt-4o-transcribe en", "settings"]);

    // Withdrawn while the audio was being read: nothing is uploaded.
    cloud.settings.mockImplementation(() => { cloud.policy.abort(new Error("Cloud transcription was turned off.")); });
    await expect(provider.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("Cloud transcription was turned off.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Withdrawn while the answer was arriving: the answer is not returned.
    const late = engine({ provider: "openai" }, { openaiKey: "key-for-tests" });
    let checks = 0;
    late.settings.mockImplementation(() => { if (++checks === 2) throw new Error("This project no longer allows cloud transcription."); });
    await expect(getTranscriptionProvider(late.ctx)!.transcribe({ path: window, tmpDir: dir, dialogueWindow: {} })).rejects.toThrow("no longer allows cloud transcription");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("snapshots the available provider with the settings' revision for an import", async () => {
    const local = engine({ provider: "whispercpp" }, { whisperCli: "/app/whisper-cli" });
    expect(await importTranscriptionPolicy(local.ctx)).toEqual({ provider: "whispercpp", revision: 7, signal: local.policy.signal });
    expect((await importTranscriptionPolicy(engine({ provider: "openai" }).ctx)).provider).toBeUndefined();
    const paths = { provider: "whispercpp" as const, localModel: "custom" as const, whisperCppPath: process.execPath };
    expect((await importTranscriptionPolicy(engine(paths).ctx)).provider).toBe("whispercpp");
    expect((await importTranscriptionPolicy(engine({ ...paths, whisperModelPath: join(dir, "missing.bin") }).ctx)).provider).toBeUndefined();
    expect((await importTranscriptionPolicy(engine({ ...paths, whisperCppPath: join(dir, "missing-cli") }).ctx)).provider).toBeUndefined();
  });
});
