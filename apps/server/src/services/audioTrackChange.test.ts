import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WsEvent } from "@scarlet/shared";
import { createProject, type MediaAsset } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { afterAudioTrackChange, hearsSameTrack, remakeTrackPreview } from "./audioTrackChange.js";
import { createTask } from "./tasks.js";

let directory: string;
let workspace: ScarletApp;
let projectId: string;
let logs: string[];
let events: WsEvent[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-audio-track-change-test-"));
  logs = [];
  events = [];
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => { logs.push(line); } });
  workspace.ctx.repos.settings.update({ transcription: { provider: "none" } });
  workspace.ctx.bus.on("ws", (ev: WsEvent) => { events.push(ev); });
  projectId = workspace.ctx.repos.projects.insert(createProject("Podcast")).id;
  workspace.ctx.paths.ensureProject(projectId);
  writeFileSync(join(workspace.ctx.paths.media(projectId), "talk.mkv"), "recording");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A two-track recording as the project keeps it, hearing `audioTrack`. */
function recording(audioTrack?: MediaAsset["audioTrack"], over: Partial<MediaAsset> = {}, status: "ready" | "ingesting" = "ready") {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(projectId, { id: "talk", name: "Talk", path: "talk.mkv", kind: "video", duration: 10, height: 1080, hasAudio: true,
    audioStreams: [{ index: 0 }, { index: 1 }], ...(audioTrack !== undefined && { audioTrack }), ...over }, status);
  return ctx.repos.projects.getMedia("talk")!;
}
const proxy = () => join(workspace.ctx.paths.proxies(projectId), "talk.mp4");
const proxyFolder = () => readdirSync(workspace.ctx.paths.proxies(projectId));
/** The FFmpeg proxy encode, stood in for: it writes what it would have, or fails as told. */
function encode(run: (output: string, opts: Record<string, unknown>) => Promise<void> | void = output => { writeFileSync(output, "proxy"); }) {
  return vi.spyOn(workspace.ctx.render, "makeProxy").mockImplementation(async (_input, output, opts) => { await run(output, opts as Record<string, unknown>); });
}

it("hears the first track whether it is named or left out, and another track or the mix as different", () => {
  const base = { id: "a", name: "A", path: "a.mkv", kind: "video" as const, audioStreams: [{ index: 0 }, { index: 1 }] };
  expect(hearsSameTrack({ ...base }, { ...base, audioTrack: 0 })).toBe(true);
  expect(hearsSameTrack({ ...base, audioTrack: 1 }, { ...base, audioTrack: 1 })).toBe(true);
  expect(hearsSameTrack({ ...base }, { ...base, audioTrack: 1 })).toBe(false);
  expect(hearsSameTrack({ ...base, audioTrack: 1 }, { ...base, audioTrack: "all" })).toBe(false);
});

it("makes a video's preview again from the track it hears, no taller than the preview setting, and says it is ready", async () => {
  const media = recording(1, { height: 480 });
  const make = encode();
  await remakeTrackPreview(workspace.ctx, media);
  expect(make).toHaveBeenCalledTimes(1);
  const [input, output, opts] = make.mock.calls[0]!;
  expect(input).toBe(join(workspace.ctx.paths.media(projectId), "talk.mkv"));
  expect(output).toMatch(/talk\.mp4\..+\.part\.mp4$/);
  expect(opts).toMatchObject({ height: 480, audioTrack: 1 });
  expect(readFileSync(proxy(), "utf8")).toBe("proxy");
  expect(proxyFolder()).toEqual(["talk.mp4"]);
  expect(events).toContainEqual({ type: "media.previewReady", projectId, mediaId: "talk" });

  // A tall recording is made at the preview height, and one with no height at most 720.
  make.mockClear();
  await remakeTrackPreview(workspace.ctx, recording(1, { height: 2160 }));
  expect(make.mock.calls[0]![2]).toMatchObject({ height: Math.min(workspace.ctx.settings().render.previewHeight, 2160) });
  make.mockClear();
  await remakeTrackPreview(workspace.ctx, recording(1, { height: undefined }));
  expect(make.mock.calls[0]![2]).toMatchObject({ height: Math.min(workspace.ctx.settings().render.previewHeight, 720) });
});

it("makes no preview for a sound-only recording, one played from parts made on demand, or one not ready", async () => {
  const make = encode();
  await remakeTrackPreview(workspace.ctx, recording(1, { kind: "audio" }));
  await remakeTrackPreview(workspace.ctx, recording(1, { previewMode: "on-demand" }));
  await remakeTrackPreview(workspace.ctx, recording(1, {}, "ingesting"));
  expect(make).not.toHaveBeenCalled();
  expect(events.filter(e => e.type === "media.previewReady")).toEqual([]);
});

it("publishes no preview of a track the editor has already changed again, or of a recording removed meanwhile", async () => {
  const media = recording(1);
  encode(output => {
    writeFileSync(output, "track 2");
    recording("all");
  });
  await remakeTrackPreview(workspace.ctx, media);
  expect(existsSync(proxy())).toBe(false);
  expect(proxyFolder()).toEqual([]);

  encode(output => {
    writeFileSync(output, "track 2");
    workspace.ctx.db.prepare("DELETE FROM media WHERE id = ?").run("talk");
  });
  await remakeTrackPreview(workspace.ctx, recording(1));
  expect(existsSync(proxy())).toBe(false);
  expect(proxyFolder()).toEqual([]);
  expect(events.filter(e => e.type === "media.previewReady")).toEqual([]);
});

it("says why a preview couldn't be made and leaves no part behind, but stays quiet when a pause stopped it", async () => {
  encode(output => {
    writeFileSync(output, "half");
    throw new Error("encoder exited 1");
  });
  await remakeTrackPreview(workspace.ctx, recording(1));
  expect(logs).toContain("[media] talk couldn’t make its preview of the chosen audio track: encoder exited 1");
  expect(proxyFolder()).toEqual([]);

  logs.length = 0;
  // Pausing the project's media work stops the encode under way.
  const make = encode(() => {
    workspace.ctx.stopMedia(projectId);
    throw new Error("Project media processing stopped.");
  });
  await remakeTrackPreview(workspace.ctx, recording(1));
  expect(make.mock.calls[0]![2].signal!.aborted).toBe(true);
  expect(logs.filter(line => line.includes("couldn’t make its preview"))).toEqual([]);
  expect(proxyFolder()).toEqual([]);
});

it("does nothing when the recording still hears the same track", async () => {
  const make = encode();
  const before = recording(0);
  await afterAudioTrackChange(workspace.ctx, before, { ...before, audioTrack: undefined });
  expect(make).not.toHaveBeenCalled();
  expect(logs.filter(line => line.includes("hears audio track"))).toEqual([]);
});

it("stops a transcription running on the old track and clears its words when nothing can transcribe the new one", async () => {
  const { ctx } = workspace;
  const before = recording(0, { kind: "audio" });
  const task = createTask(ctx, { projectId, kind: "transcribe", agent: "claude", instruction: "Transcribe Talk", context: { mediaId: "talk" },
    createdBy: { type: "scarlet", name: "Scarlet" } });
  ctx.repos.tasks.put({ ...task, state: "running", startedAt: new Date().toISOString() });
  // Words a run before left behind for the old track.
  ctx.repos.transcripts.put({ id: "trs_old", projectId, mediaId: "talk", language: "en", provider: "openai", createdAt: "2026-01-01T00:00:00.000Z",
    segments: [{ id: "s", text: "old track", start: 0, end: 1, words: [] }] });
  const after = recording(1, { kind: "audio" });
  await afterAudioTrackChange(ctx, before, after);
  expect(ctx.repos.tasks.get(task.id)?.state).toBe("cancelled");
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM transcripts WHERE media_id = ?").get("talk")).toEqual({ n: 0 });
  expect(logs).toContain("[media] talk hears audio track 1 instead of null");
  expect(logs).toContain("[transcribe] talk cleared the transcript of its previous audio track: nothing is set up to transcribe the new track");
  expect(events.some(e => e.type === "media.updated" && e.media.id === "talk")).toBe(true);
});

it("leaves the transcript alone when the editor picked yet another track meanwhile", async () => {
  const { ctx } = workspace;
  const before = recording(0, { kind: "audio", transcriptId: "trs_kept" });
  const after = { ...before, audioTrack: 1 as const };
  recording("all", { kind: "audio", transcriptId: "trs_kept" });
  await afterAudioTrackChange(ctx, before, after);
  expect(ctx.repos.projects.getMedia("talk")?.transcriptId).toBe("trs_kept");
  expect(events.filter(e => e.type === "media.updated")).toEqual([]);
});

it("throws away the old track's previews and makes the new track's for a video", async () => {
  const { ctx } = workspace;
  const before = recording(0);
  const proxies = ctx.paths.proxies(projectId);
  mkdirSync(proxies, { recursive: true });
  writeFileSync(proxy(), "old track");
  const make = encode();
  const after = recording(1);
  await afterAudioTrackChange(ctx, before, after);
  await vi.waitFor(() => expect(events).toContainEqual({ type: "media.previewReady", projectId, mediaId: "talk" }));
  expect(make.mock.calls[0]![2]).toMatchObject({ audioTrack: 1 });
  expect(readFileSync(proxy(), "utf8")).toBe("proxy");
  // A recording that hears nothing transcribed has nothing cleared.
  expect(logs.filter(line => line.startsWith("[transcribe]"))).toEqual([]);
});

it("notes in the log when the preview falls back from the hardware encoder", async () => {
  encode((output, opts) => {
    (opts.onFallback as (stage: "decode" | "encode") => void)("decode");
    writeFileSync(output, "proxy");
  });
  await remakeTrackPreview(workspace.ctx, recording(1, { height: 480 }));
  expect(logs).toContain(`[media] proxy_fallback media=unknown project=${projectId} height=480 stage=decode`);
  expect(readFileSync(proxy(), "utf8")).toBe("proxy");
});

// Windows ignores a folder's mode, and root writes through it, so neither can make the removal fail this way.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says which old preview it couldn't remove, and carries on", async () => {
  const { ctx } = workspace;
  const before = recording(0);
  const proxies = ctx.paths.proxies(projectId);
  mkdirSync(proxies, { recursive: true });
  writeFileSync(proxy(), "old track");
  encode();
  chmodSync(proxies, 0o500);
  try {
    await afterAudioTrackChange(ctx, before, recording(1));
    await vi.waitFor(() => expect(logs.some(line => line.startsWith("[media] talk couldn’t make its preview"))).toBe(true));
  } finally {
    chmodSync(proxies, 0o700);
  }
  expect(logs.some(line => line.startsWith(`[media] talk left ${proxy()} behind:`))).toBe(true);
  expect(readFileSync(proxy(), "utf8")).toBe("old track");
});
