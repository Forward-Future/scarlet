import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, planPlaybackSegments, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import type { Render, RenderFileInfo } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { FFMPEG } from "../render/ffmpeg.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { storeVersion } from "../services/timeline.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;
let version: string;
let fails = false;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-render-routes-test-"));
  fails = false;
  workspace = createApp({
    dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {},
    render: {
      ...scarletRenderAdapter,
      // A real file, so there is something to measure: two seconds of 160x90 picture at 25 fps with mono sound.
      async renderRange(_project, _timeline, _range, file) {
        if (fails) throw new Error("ffmpeg exited with code 1");
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=2",
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-y", file]);
      },
    },
  });
  const { ctx } = workspace;
  project = ctx.repos.projects.insert(createProject("Renders"));
  ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Camera", path: "camera.mp4", duration: 30, hasAudio: true }, "ready");
  version = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null }).version;
});
afterEach(async () => {
  await workspace.ctx.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };
async function read(path: string) {
  const res = await workspace.app.request("/api" + path, { headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}` } });
  return { status: res.status, body: await res.json() as { render: Render; fileInfo?: RenderFileInfo; error?: { code: string; message: string } } };
}
const section = () => workspace.ctx.renders.request({ projectId: project.id, version, kind: "segment", quality: "delivery", range: { start: 1, end: 3 } });

function prepare(times: unknown, signal?: AbortSignal, savedVersion = version) {
  return workspace.app.request(`/api/projects/${project.id}/versions/${savedVersion}/prepare-playback`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ times }), signal,
  });
}

it("prepares only the requested canonical fragments of the saved cut and reuses them on Play", async () => {
  const { ctx } = workspace;
  const timeline = ctx.repos.versions.get(project.id, version)!.timeline;
  const ranges = planPlaybackSegments(project, timeline);
  const [first, next] = ranges;
  const newHead = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 2, end: 12 }]), { parent: version });
  ctx.repos.projects.update(project.id, { head: newHead.version });
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _t, _r, _c, file) => { writeFileSync(file, "fragment"); });
  const response = await prepare([next!.start, 0, first!.end / 2]);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(encode.mock.calls.map(([, t, range]) => [t.version, range])).toEqual([[version, next], [version, first]]);
  const playback = await workspace.app.request(`/api/projects/${project.id}/renders?wait=1`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "playback", quality: "preview", version, range: first }),
  });
  expect(await playback.text()).toBe("fragment");
  expect(encode).toHaveBeenCalledTimes(2);
});

it("checks prepare positions before warming and skips paused projects and complete previews", async () => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment");
  for (const times of [[], [-1], [0, 1, 2, 3], ["2"], [0, 30]]) expect((await prepare(times)).status).toBe(400);
  expect((await prepare([0], undefined, "head")).status).toBe(404);
  ctx.repos.projects.update(project.id, { mediaPaused: true });
  expect((await prepare([0])).status).toBe(204);
  ctx.repos.projects.update(project.id, { mediaPaused: false });
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => { writeFileSync(file, "full"); });
  ctx.renders.request({ projectId: project.id, version, kind: "full", quality: "preview", range: null });
  await settle();
  expect((await prepare([0])).status).toBe(204);
  expect(encode).not.toHaveBeenCalled();
});

it("opens a standalone review file at frame boundaries, reuses it on replay, and bounds background work", async () => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderRange");
  const request = (start: number, end: number) => workspace.app.request(`/api/projects/${project.id}/versions/${version}/cut-playback-file`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start, end }),
  });
  expect((await request(0, 20)).status).toBe(400);
  expect((await request(30, 31)).status).toBe(400);
  expect((await request(2, 2)).status).toBe(400);
  const first = await request(6.001, 7.999);
  expect(first.status).toBe(200);
  const preview = await first.json();
  // Versions saved before duration metadata was introduced can open the same prepared clip.
  ctx.db.prepare("UPDATE timeline_versions SET duration = NULL WHERE project_id = ? AND version = ?").run(project.id, version);
  expect(preview).toMatchObject({ start: 6, end: 8 });
  expect(ctx.repos.renders.get(preview.renderId)).toMatchObject({ version, kind: "segment", range: { start: 6, end: 8 }, state: "done" });
  expect(await (await request(6, 8)).json()).toEqual(preview);
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => { writeFileSync(file, "full"); });
  const full = ctx.renders.request({ projectId: project.id, version, kind: "full", quality: "preview", range: null });
  await settle();
  expect(await (await request(9, 10)).json()).toEqual({ renderId: full.id, start: 0, end: 30, full: true });
  ctx.repos.projects.update(project.id, { mediaPaused: true });
  expect((await request(9, 10)).status).toBe(409);
  expect(encode).toHaveBeenCalledTimes(1);
});

it("stops a disconnected preparation in its first fragment without starting the following one", async () => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _t, _r, _c, _file, opts) => {
    await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
  });
  const controller = new AbortController();
  const request = prepare([0, 15], controller.signal);
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
  expect(ctx.repos.renders.select()).toHaveLength(1);
  controller.abort();
  expect((await request).status).toBe(499);
  await settle();
  expect(ctx.repos.renders.select().map(r => r.state)).toEqual(["cancelled"]);
});

it("returns a playback limit for an oversized historical version before requesting an encode", async () => {
  const { ctx } = workspace;
  const timeline = ctx.repos.versions.get(project.id, version)!.timeline;
  timeline.tracks[0]!.clips[0]!.timelineIn = 86400;
  ctx.db.prepare("UPDATE timeline_versions SET json = ? WHERE project_id = ? AND version = ?").run(JSON.stringify(timeline), project.id, version);
  const render = vi.spyOn(ctx.renders, "request");
  const result = await workspace.app.request(`/api/projects/${project.id}/renders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version, kind: "playback", range: { start: 0, end: 3 }, quality: "preview" }),
  });
  for (const denied of [result, await prepare([0])]) {
    expect(denied.status).toBe(422);
    expect(await denied.json()).toMatchObject({ error: { code: "timeline_limit" } });
  }
  expect(render).not.toHaveBeenCalled();
});

it("measures a finished render's file when asked to, and only then", async () => {
  const { id } = section();
  await settle();
  const plain = await read(`/renders/${id}`);
  expect(plain.body.render).toMatchObject({ id, state: "done", durationSeconds: 2 });
  expect(plain.body).not.toHaveProperty("fileInfo");
  const { body: { render, fileInfo } } = await read(`/projects/${project.id}/renders/${id}?inspectFile=true`);
  expect(render.id).toBe(id);
  // What is in the file, not what was asked for.
  expect(fileInfo).toMatchObject({ width: 160, height: 90, fps: 25, videoCodec: "h264", audioCodec: "aac", hasAudio: true, sampleRate: 48000, channels: 1 });
  expect(fileInfo!.duration).toBeCloseTo(2, 1);
  expect(fileInfo!.bitrate).toBeGreaterThan(0);
  expect(Object.keys(fileInfo!).sort()).toEqual(["audioCodec", "bitrate", "channels", "duration", "fps", "hasAudio", "height", "loudness", "sampleRate", "videoCodec", "width"]);
  // The sound as rendered, with its gain and effects, measured the way media_profile measures a source.
  expect(Object.keys(fileInfo!.loudness!).sort()).toEqual(["integratedLufs", "loudnessRangeLu", "truePeakDbtp"]);
});

it("has no file to measure for a render that failed, and says so when a finished one's file is gone", async () => {
  fails = true;
  const failed = section();
  await settle();
  const unfinished = await read(`/renders/${failed.id}?inspectFile=true`);
  expect(unfinished.body.render).toMatchObject({ state: "failed",
    error: "Scarlet couldn’t render this part of the video: try once more, or export the logs from Settings → Advanced to report it.", errorDetail: "ffmpeg exited with code 1" });
  expect(unfinished.body).not.toHaveProperty("fileInfo");

  fails = false;
  const done = workspace.ctx.renders.request({ projectId: project.id, version, kind: "segment", quality: "delivery", range: { start: 4, end: 6 } });
  await settle();
  const saved = workspace.ctx.repos.renders.get(done.id)!;
  rmSync(join(workspace.ctx.paths.renders(project.id), saved.path!));
  const gone = await read(`/renders/${done.id}?inspectFile=true`);
  expect([gone.status, gone.body.error]).toEqual([404, { code: "not_found", message: "render file not found" }]);
});

it("answers 404 for a render that isn't there, or isn't in the project named", async () => {
  const { id } = section();
  await settle();
  expect((await read("/renders/rnd_missing")).status).toBe(404);
  const other = workspace.ctx.repos.projects.insert(createProject("Other"));
  const elsewhere = await read(`/projects/${other.id}/renders/${id}`);
  expect([elsewhere.status, elsewhere.body.error?.message]).toEqual([404, `render ${id} not found`]);
});
