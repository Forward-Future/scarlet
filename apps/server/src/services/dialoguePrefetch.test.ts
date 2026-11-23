import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject, makeMediaClip, makeTrack, timelineFromKeepRanges } from "@scarlet/timeline";
import { createApp } from "../app.js";
import { accessToken } from "../auth.js";
import { WhisperCppProvider } from "../transcribe/whispercpp.js";
import { UhmDetector } from "../transcribe/uhm.js";
import { measuredLoudness } from "../render/loudness.js";
import { cancelTask, createTask } from "./tasks.js";
import { storeVersion } from "./timeline.js";
import { passRecordings, prefetchDialoguePass, scanAheadOfPasses } from "./dialoguePrefetch.js";
import { audioLane } from "./audioWork.js";

vi.mock("@scarlet/render", async original => ({
  ...await original<typeof import("@scarlet/render")>(),
  speechActivityOf: async () => [],
}));
vi.mock("../transcribe/wordAlign.js", async original => ({ ...await original<typeof import("../transcribe/wordAlign.js")>(), alignWords: async (_ctx: unknown, _wav: string, segments: unknown) => segments }));
vi.mock("../render/ffmpeg.js", async original => ({
  ...await original<typeof import("../render/ffmpeg.js")>(),
  extractWav: async (_file: string, target: string) => {
    const emptyWav = Buffer.alloc(20);
    emptyWav.write("data", 12);
    await writeFile(target, emptyWav);
  },
}));
vi.mock("../render/loudness.js", () => ({ measuredLoudness: vi.fn(async () => ({ integratedLufs: -20, loudnessRangeLu: 4, truePeakDbtp: -1 })) }));

it("reads a claimed first dialogue pass's recordings ahead of its first scan call, and reports them once it asks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-prefetch-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  let release: (() => void) | undefined;
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Read ahead"));
    ctx.paths.ensureProject(project.id);
    const put = (id: string, kind: "audio" | "video", words: boolean) => {
      const media = ctx.repos.projects.putMedia(project.id, { id, name: id, kind, path: `${id}.wav`, duration: 180, hasAudio: true }, "ready");
      ctx.repos.transcripts.put({ id: `trs_${id}`, projectId: project.id, mediaId: id,
        segments: words ? [{ id: "s", start: 1, end: 2, text: "hello", words: [{ text: "hello", start: 1, end: 2 }] }] : [] });
      return ctx.repos.projects.putMedia(project.id, { ...media, transcriptId: `trs_${id}` }, "ready");
    };
    const mic = put("mic", "audio", true);
    put("cam", "video", true);
    put("music", "audio", false);
    for (const id of ["mic", "cam", "music"]) await writeFile(join(ctx.paths.media(project.id), `${id}.wav`), id);
    // The camera's picture plays with its sound off, the mic carries the dialogue, and a music bed plays under it.
    const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 180 }], { audioMediaId: "mic" });
    const bed = makeTrack("audio", "Music");
    bed.clips.push(makeMediaClip("music", 0, 180, 0));
    timeline.tracks.push(bed);
    const version = storeVersion(ctx, project.id, timeline, { parent: null });
    ctx.repos.projects.update(project.id, { head: version.version });
    expect(passRecordings(ctx, project.id).map(m => m.id)).toEqual(["mic"]);

    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    const result = { language: "en", segments: [] };
    const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue(result);
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The second page is still being read when the pass asks.
    whisper.mockImplementationOnce(async () => result).mockImplementationOnce(async () => { await gate; return result; });
    const create = (context = {}) => createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
      state: "running", context: { dialogueOperation: "first-cut", ...context }, createdBy: { type: "scarlet", name: "Scarlet" } });

    // A request about one cut, or one that isn't a dialogue pass, reads nothing ahead.
    for (const other of [create({ cutIndex: 0, changeId: "chg_x" }), create({ dialogueOperation: "none" })]) {
      prefetchDialoguePass(ctx, other);
      cancelTask(ctx, other);
    }
    expect(whisper).not.toHaveBeenCalled();
    expect(measuredLoudness).not.toHaveBeenCalled();

    const task = create();
    prefetchDialoguePass(ctx, task);
    // The loudness media_profile reads is measured under the key the loudness route uses.
    await vi.waitFor(() => expect(measuredLoudness).toHaveBeenCalledTimes(1));
    expect(vi.mocked(measuredLoudness).mock.calls[0]![1]).toBe(await realpath(join(ctx.paths.media(project.id), "mic.wav")));
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(2));
    const events = () => ctx.repos.taskEvents.list(task.id).flatMap(e => e.data?.scanPage ? [e.data.scanPage] : []);
    // Nothing is reported read until the pass asks for the recording.
    expect(events()).toEqual([]);
    const scan = await app.app.request(`/api/projects/${project.id}/dialogue-scan`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, mediaId: mic.id, from: 0, to: 180 }),
    });
    expect(await scan.json()).toEqual([{ start: 0, end: 60 }]);
    // The pass's call joined the scan under way: the page read before it asked is reported now, and the rest as read.
    expect(events()).toEqual([{ mediaId: "mic", from: 0, to: 60, end: 180 }]);
    release!();
    await vi.waitFor(() => expect(events()).toHaveLength(4));
    expect(whisper).toHaveBeenCalledTimes(4);
    expect(events().map(page => page.from)).toEqual([0, 58, 116, 174]);
    cancelTask(ctx, task);
    await Promise.all([...ctx.pending]);

    // A pass that reads the recording from somewhere else: the read-ahead stops after the page it is on.
    ctx.db.prepare("DELETE FROM dialogue_scan_pages").run();
    whisper.mockClear();
    const held = new Promise<void>(resolve => { release = resolve; });
    whisper.mockImplementationOnce(async () => result).mockImplementationOnce(async () => { await held; return result; });
    const later = create();
    prefetchDialoguePass(ctx, later);
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(2));
    expect((await app.app.request(`/api/projects/${project.id}/dialogue-scan`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: later.id, mediaId: mic.id, from: 30, to: 180 }),
    })).ok).toBe(true);
    release!();
    await vi.waitFor(() => expect(ctx.repos.taskEvents.list(later.id).filter(e => e.data?.scanPage?.to)).toHaveLength(3));
    await new Promise(resolve => setTimeout(resolve, 50));
    // Its two pages and the pass's three: 0–60 and 58–118, then 30–90, 88–148 and 146–180.
    expect(whisper).toHaveBeenCalledTimes(5);
    cancelTask(ctx, later);
    await Promise.all([...ctx.pending]);
  } finally {
    release?.();
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads a recording's pages before any pass asks, saves them for the pass, and leaves the rest to a pass that starts reading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-ahead-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Read ahead of any pass"));
    ctx.paths.ensureProject(project.id);
    const media = ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", kind: "audio", path: "mic.wav", duration: 180, hasAudio: true }, "ready");
    ctx.repos.transcripts.put({ id: "trs_mic", projectId: project.id, mediaId: "mic",
      segments: [{ id: "s", start: 1, end: 2, text: "hello", words: [{ text: "hello", start: 1, end: 2 }] }] });
    ctx.repos.projects.putMedia(project.id, { ...media, transcriptId: "trs_mic" }, "ready");
    await writeFile(join(ctx.paths.media(project.id), "mic.wav"), "mic");
    vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue({ language: "en", segments: [] });
    const pages = () => ctx.db.prepare("SELECT start, end FROM dialogue_scan_pages ORDER BY start").all();

    // A cloud reading is paid for by the minute, so nothing is read ahead with one.
    ctx.repos.settings.update({ transcription: { provider: "openai" } });
    scanAheadOfPasses(ctx, project.id);
    await Promise.all([...ctx.pending]);
    expect(whisper).not.toHaveBeenCalled();

    // No edit yet: the recording with speech is read, on the grid a pass reads.
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    scanAheadOfPasses(ctx, project.id);
    await Promise.all([...ctx.pending]);
    expect(pages()).toEqual([{ start: 0, end: 60 }, { start: 58, end: 118 }, { start: 116, end: 176 }, { start: 174, end: 180 }]);
    expect(whisper).toHaveBeenCalledTimes(4);
    // Read again, it finds every page saved.
    scanAheadOfPasses(ctx, project.id);
    await Promise.all([...ctx.pending]);
    expect(whisper).toHaveBeenCalledTimes(4);

    // A pass reading the recording takes over: the read-ahead stops before its next page.
    ctx.db.prepare("DELETE FROM dialogue_scan_pages").run();
    const release = audioLane(ctx).focus("mic");
    scanAheadOfPasses(ctx, project.id);
    await Promise.all([...ctx.pending]);
    release();
    expect(pages()).toEqual([]);

    // Nor does it read while the project's media work is paused.
    ctx.repos.projects.update(project.id, { mediaPaused: true });
    scanAheadOfPasses(ctx, project.id);
    await Promise.all([...ctx.pending]);
    expect(whisper).toHaveBeenCalledTimes(4);
  } finally {
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads the page the read-ahead is on once when a pass claims the recording, and reads it for the pass if the pause stops the read-ahead", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-ahead-pass-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  let release = () => {};
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("A pass meets the read-ahead"));
    ctx.paths.ensureProject(project.id);
    const media = ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", kind: "audio", path: "mic.wav", duration: 180, hasAudio: true }, "ready");
    ctx.repos.transcripts.put({ id: "trs_mic", projectId: project.id, mediaId: "mic",
      segments: [{ id: "s", start: 1, end: 2, text: "hello", words: [{ text: "hello", start: 1, end: 2 }] }] });
    ctx.repos.projects.putMedia(project.id, { ...media, transcriptId: "trs_mic" }, "ready");
    await writeFile(join(ctx.paths.media(project.id), "mic.wav"), "mic");
    const version = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "mic", [{ start: 0, end: 180 }]), { parent: null });
    ctx.repos.projects.update(project.id, { head: version.version });
    expect(passRecordings(ctx, project.id).map(m => m.id)).toEqual(["mic"]);
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    const turns = vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    // The read-ahead's first page is held until the test lets it go. Like the real program, it stops when its signal does.
    const result = { language: "en", segments: [] };
    let gate = Promise.resolve();
    const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async (_wav, _tmp, signal) => {
      if (whisper.mock.calls.length === 1) await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
      return result;
    });
    const pages = () => ctx.db.prepare("SELECT start, end FROM dialogue_scan_pages ORDER BY start").all();
    const settle = async () => { while (ctx.pending.size) await Promise.allSettled([...ctx.pending]); };
    const create = () => createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
      state: "running", context: { dialogueOperation: "first-cut" }, createdBy: { type: "scarlet", name: "Scarlet" } });
    /** The read-ahead is on the recording's first page when a pass is claimed, and the pass's scan reaches that page. */
    const claimWhileReadingAhead = async () => {
      gate = new Promise<void>(resolve => { release = resolve; });
      scanAheadOfPasses(ctx, project.id);
      await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(1));
      const pass = create();
      prefetchDialoguePass(ctx, pass);
      // The pass's scan has reached that page, and asked for the recording's speakers as a pass does.
      await vi.waitFor(() => expect(turns).toHaveBeenCalledWith(ctx, project.id, expect.objectContaining({ id: "mic" }), undefined, true));
      return pass;
    };

    // The pass waits for the page the read-ahead is on instead of reading it again: one reading for each page.
    const pass = await claimWhileReadingAhead();
    release();
    await settle();
    expect(pages()).toEqual([{ start: 0, end: 60 }, { start: 58, end: 118 }, { start: 116, end: 176 }, { start: 174, end: 180 }]);
    expect(whisper).toHaveBeenCalledTimes(4);
    cancelTask(ctx, pass);
    await settle();

    // The pause stops the read-ahead's page under the pass, and the pass, which the editor asked for, reads it itself.
    ctx.db.prepare("DELETE FROM dialogue_scan_pages").run();
    whisper.mockClear();
    turns.mockClear();
    const later = await claimWhileReadingAhead();
    const paused = await app.app.request(`/api/projects/${project.id}`, { method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" }, body: JSON.stringify({ mediaPaused: true }) });
    expect(paused.ok).toBe(true);
    await settle();
    expect(pages()).toHaveLength(4);
    expect(whisper).toHaveBeenCalledTimes(5);
    cancelTask(ctx, later);
    await settle();
  } finally {
    release();
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
