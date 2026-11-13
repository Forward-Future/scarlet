import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../app.js";
import * as ffmpeg from "../render/ffmpeg.js";
import { LocalWhisperModel } from "../transcribe/localModel.js";
import { speakerAnalysisVersion } from "../transcribe/speakerLabels.js";
import * as speakerWorker from "../transcribe/speakerWorker.js";
import { speakersAtOnce, speakersRunBeside } from "./recordingSpeakers.js";

/** An engine that finds a GPU speaker runtime bundled. The decode, the model downloads and the worker program are faked. */
async function speakerFixture() {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-speakers-"));
  const logs: string[] = [];
  const { ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: message => logs.push(message) });
  onTestFinished(async () => {
    await ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Speakers"));
  ctx.paths.ensureProject(project.id);
  vi.spyOn(speakerWorker, "speakerGpuRuntime").mockReturnValue(join(dir, "speaker-gpu"));
  // With a GPU runtime the analysis takes its turn in the audio lane, whatever the machine running the test.
  ctx.speakers.beside = false;
  vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { await writeFile(wav, "pcm"); });
  // The runtimes whose worker fails, and the runtime of each worker the engine started.
  const failing = new Set<"gpu" | "cpu">();
  const workers: Array<"gpu" | "cpu"> = [];
  vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
    // A trailing "cpu" keeps the worker off the GPU runtime.
    const runtime = args.at(-1) === "cpu" ? "cpu" : "gpu";
    workers.push(runtime);
    if (failing.has(runtime)) throw new Error(`the ${runtime} worker failed`);
    return Buffer.from("[]");
  });
  return {
    failing, workers,
    said: () => logs.filter(line => line.startsWith("[speakers]")),
    /** Speaker turns for a new recording. */
    async analyse(name: string) {
      const media = ctx.repos.projects.putMedia(project.id, { id: name, name, path: name + ".wav", kind: "audio" }, "ready");
      await writeFile(join(ctx.paths.media(project.id), media.path), name);
      return ctx.speakers.turns(ctx, project.id, media);
    },
  };
}

it("analyses speakers on the GPU runtime first, and on the CPU once it has finished an analysis the GPU runtime failed", async () => {
  const { analyse, failing, workers, said } = await speakerFixture();
  expect(await analyse("first")).toEqual([]);
  failing.add("gpu");
  expect(await analyse("second")).toEqual([]);
  expect(await analyse("third")).toEqual([]);
  expect(workers).toEqual(["gpu", "gpu", "cpu", "cpu"]);
  // The failure is logged when it happens, and the switch once the CPU has finished the analysis.
  expect(said()).toEqual([expect.stringContaining("the gpu worker failed"), expect.stringContaining("until Scarlet restarts")]);
});

it("keeps the GPU speaker runtime in use when the CPU can't finish the analysis either", async () => {
  const { analyse, failing, workers, said } = await speakerFixture();
  // Audio the worker can't read fails on both runtimes alike. The CPU's error is the one thrown.
  failing.add("gpu").add("cpu");
  await expect(analyse("unreadable")).rejects.toThrow("the cpu worker failed");
  failing.clear();
  expect(await analyse("next")).toEqual([]);
  expect(workers).toEqual(["gpu", "cpu", "gpu"]);
  expect(said()).toEqual([expect.stringContaining("the gpu worker failed")]);
  expect(said().join(" ")).not.toContain("until Scarlet restarts");
});

it("runs speaker analysis beside the audio lane only on the CPU with cores to spare", () => {
  expect(speakersRunBeside(18, false)).toBe(true);
  expect(speakersRunBeside(12, false)).toBe(true);
  expect(speakersRunBeside(8, false)).toBe(false);
  // The GPU runtime would share the GPU with Whisper.
  expect(speakersRunBeside(24, true)).toBe(false);
  // Two recordings at a time take more cores again, and in the lane it is always one.
  expect([speakersAtOnce(18), speakersAtOnce(12), speakersAtOnce(8), speakersAtOnce(24, false)]).toEqual([2, 1, 1, 1]);
});

it("lets a pass's other audio work wait for every analysis a pass is waiting for, and for no other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-speakers-wait-"));
  const { ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  onTestFinished(async () => {
    await ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Speakers"));
  ctx.paths.ensureProject(project.id);
  vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { await writeFile(wav, "pcm"); });
  // Each worker runs until the test lets it finish, and the second one fails.
  const finish: Array<(error?: Error) => void> = [];
  vi.spyOn(ffmpeg, "run").mockImplementation(() => new Promise((resolve, reject) => {
    finish.push(error => error ? reject(error) : resolve(Buffer.from("[]")));
  }));
  const recording = async (name: string) => {
    const media = ctx.repos.projects.putMedia(project.id, { id: name, name, path: name + ".wav", kind: "audio" }, "ready");
    await writeFile(join(ctx.paths.media(project.id), media.path), name);
    return media;
  };
  // Nobody waits for an import's analysis in another project, so a pass's work doesn't either.
  const imported = ctx.speakers.turns(ctx, project.id, await recording("imported"));
  await vi.waitFor(() => expect(finish).toHaveLength(1));
  await ctx.speakers.awaitedByPass("another project");
  finish.shift()!();
  await imported;
  // A pass reads two recordings. Its work waits for both analyses, also when one fails.
  const camera = ctx.speakers.turns(ctx, project.id, await recording("camera"), undefined, true);
  await vi.waitFor(() => expect(finish).toHaveLength(1));
  const screen = ctx.speakers.turns(ctx, project.id, await recording("screen"), undefined, true).catch((error: Error) => error.message);
  let waited = false;
  const wait = ctx.speakers.awaitedByPass("another project").then(() => { waited = true; });
  finish.shift()!();
  await camera;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(waited).toBe(false);
  await vi.waitFor(() => expect(finish.length).toBe(1));
  finish.shift()!(new Error("the worker failed"));
  expect(await screen).toContain("the worker failed");
  await wait;
  expect(waited).toBe(true);
});

it("lets a pass's work wait for an analysis already running in its project, before the pass has asked for that recording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-speakers-project-"));
  const { ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  onTestFinished(async () => {
    await ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Camera and screen"));
  ctx.paths.ensureProject(project.id);
  vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { await writeFile(wav, "pcm"); });
  let finish!: () => void;
  const started = new Promise<void>(begun => {
    vi.spyOn(ffmpeg, "run").mockImplementation(() => new Promise(resolve => { finish = () => resolve(Buffer.from("[]")); begun(); }));
  });
  // The camera recording's analysis began at import. The pass has only asked for the screen recording so far.
  const media = ctx.repos.projects.putMedia(project.id, { id: "camera", name: "camera", path: "camera.wav", kind: "audio" }, "ready");
  await writeFile(join(ctx.paths.media(project.id), media.path), "camera");
  const camera = ctx.speakers.turns(ctx, project.id, media);
  await started;
  let waited = false;
  const wait = ctx.speakers.awaitedByPass(project.id).then(() => { waited = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(waited).toBe(false);
  finish();
  await camera;
  await wait;
  expect(waited).toBe(true);
});

it("goes on with an analysis a pass waits for while the project's media work is paused, and stops one nobody waits for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-speakers-pause-"));
  const { ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  onTestFinished(async () => {
    await ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Speakers"));
  ctx.paths.ensureProject(project.id);
  ctx.speakers.beside = true;
  vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { await writeFile(wav, "pcm"); });
  // Each worker runs until the test lets it finish and, like the real program, stops when its signal does.
  const workers: Array<() => void> = [];
  vi.spyOn(ffmpeg, "run").mockImplementation((_bin, _args, opts) => new Promise((resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true });
    workers.push(() => resolve(Buffer.from("[]")));
  }));
  const started = (count: number) => vi.waitFor(() => expect(workers).toHaveLength(count));
  /** Lets every worker still running finish. One that was stopped has ended already. */
  const finish = () => { for (const done of workers) done(); };
  const recording = async (name: string) => {
    const media = ctx.repos.projects.putMedia(project.id, { id: name, name, path: name + ".wav", kind: "audio" }, "ready");
    await writeFile(join(ctx.paths.media(project.id), media.path), name);
    return media;
  };
  const outcome = (analysis: Promise<unknown>) => analysis.then(() => "analysed", () => "stopped");
  // What the editor's Pause caching and Resume caching do in the engine.
  const pause = (on: boolean) => {
    ctx.repos.projects.update(project.id, { mediaPaused: on });
    if (on) ctx.stopMedia(project.id);
  };

  // Each step has one analysis under way, so this holds on a machine that runs one at a time.
  const [camera, screen] = [await recording("camera"), await recording("screen")];
  // The screen recording's analysis began with its transcript, and nobody waits for it: it stops with the pause.
  const screenImport = outcome(ctx.speakers.turns(ctx, project.id, screen));
  await started(1);
  pause(true);
  expect(await screenImport).toBe("stopped");
  // Still paused, it doesn't start for nobody. A pass that asks for it gets it.
  await expect(ctx.speakers.turns(ctx, project.id, screen)).rejects.toThrow("Project media processing stopped.");
  const screenPass = outcome(ctx.speakers.turns(ctx, project.id, screen, undefined, true));
  await started(2);
  finish();
  expect(await screenPass).toBe("analysed");

  // The camera's analysis began with its transcript too. A pass asks for it and waits, and then the editor pauses:
  // it goes on, for everyone who joined it.
  pause(false);
  const cameraImport = outcome(ctx.speakers.turns(ctx, project.id, camera));
  await started(3);
  const cameraPass = outcome(ctx.speakers.turns(ctx, project.id, camera, undefined, true));
  pause(true);
  finish();
  expect(await Promise.all([cameraImport, cameraPass])).toEqual(["analysed", "analysed"]);

  // Trash stops an analysis a pass waits for too.
  pause(false);
  const wide = outcome(ctx.speakers.turns(ctx, project.id, await recording("wide"), undefined, true));
  await started(4);
  ctx.repos.projects.softDelete(project.id);
  ctx.stopMedia(project.id, true);
  expect(await wide).toBe("stopped");
});

it("labels a transcript while the project's media work is paused only when the pause doesn't hold it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-speakers-labels-"));
  const { ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  onTestFinished(async () => {
    await ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Speakers"));
  ctx.paths.ensureProject(project.id);
  ctx.speakers.beside = true;
  vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { await writeFile(wav, "pcm"); });
  const worker = vi.spyOn(ffmpeg, "run").mockResolvedValue(Buffer.from("[]"));
  ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
  const media = ctx.repos.projects.putMedia(project.id, { id: "camera", name: "camera", path: "camera.wav", kind: "audio", transcriptId: "trs_camera" }, "ready");
  await writeFile(join(ctx.paths.media(project.id), media.path), "camera");
  ctx.repos.transcripts.put({ id: "trs_camera", projectId: project.id, mediaId: media.id, segments: [] });
  const transcript = ctx.repos.transcripts.get("trs_camera")!;
  const linked = () => ctx.repos.projects.getMedia("camera")!.transcriptId!;
  ctx.repos.projects.update(project.id, { mediaPaused: true });
  ctx.stopMedia(project.id);
  // With nothing under way the pause holds the project's transcripts, and their labels with them.
  await ctx.speakers.ensure(ctx, project.id, media, transcript, undefined, true);
  expect([linked(), worker.mock.calls.length]).toEqual(["trs_camera", 0]);
  // A request under way reads the transcript, so its labels are made though the project is paused.
  await ctx.speakers.ensure(ctx, project.id, media, transcript, undefined, false);
  expect(linked()).not.toBe("trs_camera");
  expect(ctx.repos.transcripts.get(linked())?.speakerAnalysis?.version).toBe(speakerAnalysisVersion);
});
