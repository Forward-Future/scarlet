import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createScarletMcpServer } from "@scarlet/mcp";
import { contactSheet, extractFrame, makeProxy, PREVIEW_COPY_ACTIVITY_THRESHOLD, renderTimelineFrame, resolveFfmpeg, runCapture, spawnStats } from "@scarlet/render";
import { ScarletClient, type InspectionResult } from "@scarlet/shared";
import { createProject, emptyTimeline, makeMediaClip, timelineFromKeepRanges } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken, localUser } from "./auth.js";
import { proposeChange } from "./services/changes.js";
import { storeVersion } from "./services/timeline.js";
import { pictureDecoder } from "./services/pictureWork.js";
import { previewPictures, previewIdentity } from "./services/previewPictures.js";
import * as pictureCopies from "./services/previewPictures.js";
import { createTask } from "./services/tasks.js";

let directory: string, workspace: ScarletApp, client: ScarletClient;
let projectId: string, base: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scarlet-inspect-"));
  workspace = createApp({ dataDir: directory, env: {}, log: () => {} });
  const { ctx } = workspace;
  const project = ctx.repos.projects.insert(createProject("Inspection", { width: 320, height: 180, fps: 25 }));
  projectId = project.id;
  ctx.paths.ensureProject(projectId);
  const file = join(ctx.paths.media(projectId), "sample.mp4");
  // The existing shot goes black at 2.16. Audio ramps down gradually during
  // the passage we'll remove, making the level step at the new join audible.
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=4",
    "-f", "lavfi", "-i", "aevalsrc=0.4*sin(2*PI*440*t)*exp(-3*clip(t-1.2\\,0\\,1.5)):d=4",
    "-vf", "drawbox=color=black:t=fill:enable='gte(t,2.16)'", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", file]);
  ctx.repos.projects.putMedia(project.id, { id: "m", kind: "video", name: "sample", path: "sample.mp4",
    hasAudio: true, duration: 4, fps: 25, width: 320, height: 180 }, "ready");
  const tl = emptyTimeline(projectId);
  tl.tracks[0]!.clips = [makeMediaClip("m", 0, 4, 0, { id: "v" })];
  base = storeVersion(ctx, projectId, tl, { parent: null }).version;
  ctx.repos.projects.initializeHead(projectId, null, base);
  client = new ScarletClient({ baseUrl: "https://inspection.local", token: accessToken(ctx),
    fetch: (input, init) => workspace.app.request(input, init) });
});
afterAll(async () => { await workspace?.ctx.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

it("keeps the synchronized presenter in the bottom right of the full dialogue draft and proposed cut", async () => {
  const { ctx } = workspace;
  const { id } = ctx.repos.projects.insert(createProject("First cut", { width: 160, height: 96, fps: 25, audioChannels: 1 }));
  ctx.paths.ensureProject(id);
  const root = ctx.paths.media(id);
  const ffmpeg = (...args: string[]) => runCapture(resolveFfmpeg(), ["-v", "error", ...args]).then(r => r.stdout);
  const video = ["-f", "lavfi", "-i"], encode = ["-c:v", "libx264", "-threads", "1", "-c:a", "pcm_s16le"];
  const camera = join(root, "input-2.mov"), screen = join(root, "input-1.mov");
  // Shared, varying scratch sound gives audio_sync a measurable offset. The camera turns green at source 2s.
  await ffmpeg(...video, "color=red:s=160x96:r=25:d=4", ...video,
    "aevalsrc=sin(2*PI*440*t)*(0.35+0.25*sin(floor(t*25)^2*27)):s=48000:d=4",
    "-vf", "drawbox=c=lime:t=fill:enable='gte(t,2)'", ...encode, camera);
  await ffmpeg(...video, "color=blue:s=160x96:r=25:d=2.4", "-ss", "0.74", "-i", camera,
    "-map", "0:v", "-map", "1:a", "-af", "volume=0.5", "-t", "2.4", ...encode, screen);
  for (const [mediaId, path, duration] of [["m1-screen", "input-1.mov", 2.4], ["m2-camera", "input-2.mov", 4]] as const)
    ctx.repos.projects.putMedia(id, { id: mediaId, name: path, path, duration, kind: "video",
      hasAudio: true, hasAlpha: false, width: 160, height: 96, fps: 25 }, "ready");
  // The pass mode comes from the editor's explicit skill selection, as the composer sends it.
  const dialogue = ctx.repos.skills.select("name = 'dialogue-pass'")[0]!;
  const queued = createTask(ctx, { projectId: id, kind: "edit", agent: "codex", instruction: "/dialogue-pass",
    context: { mediaId: "m1-screen", skillIds: [dialogue.id] }, createdBy: { type: "human", name: "Editor" } });
  const task = ctx.repos.tasks.put({ ...queued, state: "claimed", startedAt: new Date().toISOString() });
  const editor = new Client({ name: "test", version: "1" });
  const [engineSide, editorSide] = InMemoryTransport.createLinkedPair();
  const server = createScarletMcpServer(client, { projectId: id, taskId: task.id, task, author: { type: "agent", name: "Codex" } });
  await server.connect(engineSide);
  await editor.connect(editorSide);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await editor.callTool({ name, arguments: args }) as CallToolResult;
    const text = result.content.find(block => block.type === "text")?.text ?? "";
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text.split("\n\n").at(-1)!);
  }
  try {
    await call("project_get");
    const { secondaryStartRelativeToReference: offset } = await call("audio_sync", { referenceId: "m2-camera", secondaryId: "m1-screen" });
    expect(offset).toBeCloseTo(0.74, 4);
    const assembly = { intent: "requested", description: "Align and compose the two recordings", ops: [
      { op: "addTrack", track: { id: "screen", kind: "video", name: "Selected screen" } },
      { op: "addClip", trackId: "v1", clip: makeMediaClip("m2-camera", 0, 4, 0, { id: "presenter" }) },
      { op: "addClip", trackId: "screen", clip: makeMediaClip("m1-screen", 0, 2.4, offset, { id: "desktop", volume: 0 }) },
    ] };
    const unframed = await call("timeline_propose", { ...assembly, intent: "suggestion" });
    expect(unframed.state).toBe("ready");
    const setup = await call("timeline_propose", { ...assembly, pictureLayout: { screenClipId: "desktop", cameraClipId: "presenter" } });
    expect(setup.state).toBe("approved");
    const edit = await call("dialogue_apply_cuts", { version: setup.toVersion, description: "Review two pauses", cuts: [
      { start: 1.2, end: 1.6, kind: "pause", decision: "review", reason: "Check the screen action." },
      { start: 1.76, end: 1.96, kind: "pause", decision: "review", reason: "Keep the presenter reaction?" },
    ] });
    // While the editor auditions the first cut, the second undecided passage stays in the draft.
    const { draft } = await client.cutReview(edit.changes[0].id, [1]);
    expect(draft).toBeDefined();
    const pcm = async (file: string, at: number) => ffmpeg("-ss", String(at), "-i", file, "-t", "0.05",
      "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-");
    async function renderFile(version: string, kind: "full" | "playback" | "segment", end: number) {
      const { render } = await client.requestRender(id, { version, kind, quality: "preview",
        range: kind === "full" ? undefined : { start: 0, end } });
      await expect.poll(async () => (await client.render(render.id)).render.state, { timeout: 15000 }).toBe("done");
      return join(ctx.paths.renders(id), (await client.render(render.id)).render.path!);
    }
    // Full preview MP4s include AAC priming. Compare the same preview path with a camera-only edit.
    const solo = storeVersion(ctx, id, timelineFromKeepRanges(id, "m2-camera", [{ start: 0, end: 4 }]), { parent: null });
    const cameraPreview = await renderFile(solo.version, "full", 4);
    const fullDraft = edit.changes[0].toVersion;
    for (const [version, kind, removed] of [[fullDraft, "full", .6], [fullDraft, "playback", .6], [draft!.version, "segment", .4]] as const) {
      const file = await renderFile(version, kind, 4 - removed);
      const frames = await ffmpeg("-i", file, "-map", "0:v", "-pix_fmt", "rgb24", "-f", "rawvideo", "-");
      const pixel = (t: number, x: number, y: number) => {
        const i = ((Math.round(t * 25) * 96 + y) * 160 + x) * 3;
        return [...frames.subarray(i, i + 3)].map(c => c > 180 ? 1 : 0);
      };
      const red = [1, 0, 0], green = [0, 1, 0], blue = [0, 0, 1];
      expect(pixel(.4, 60, 40)).toEqual(red);
      for (const [t, color] of [[1, red], [2.12 - removed, green]] as const) {
        expect(pixel(t, 60, 40)).toEqual(blue);
        expect(pixel(t, 140, 80)).toEqual(color);
        expect(pixel(t, 158, 80)).toEqual(blue);
      }
      expect(pixel(3.6 - removed, 60, 40)).toEqual(green);
      const source = await pcm(kind === "full" ? cameraPreview : camera, 2.12), actual = await pcm(file, 2.12 - removed);
      let error = 0, energy = 0;
      for (let i = 0; i < source.length; i += 2) {
        const sample = source.readInt16LE(i);
        error += (actual.readInt16LE(i) - sample) ** 2;
        energy += sample ** 2;
      }
      expect(error / energy).toBeLessThan(.015);
    }
  } finally { await editor.close(); }
});

async function ready(call: () => Promise<InspectionResult>) {
  let result = await call();
  if (result.state === "preparing") {
    for (const id of result.renderIds) {
      await expect.poll(async () => (await client.render(id)).render.state, { timeout: 15000 }).toBe("done");
    }
    result = await call();
  }
  if (result.state !== "ready") throw new Error("Preview was not reused");
  return result;
}

it("returns a cached source sheet with the actual scene change, and rejects invalid or cross-project windows", async () => {
  const sheet = () => client.contactSheet(projectId, { mediaId: "m", from: 0.4, to: 3.92, count: 6, mode: "scene" });
  const { windows: [w] } = await ready(sheet);
  expect(w).toMatchObject({ clock: "source", id: "m", columns: 3 });
  expect(w!.timestamps).toHaveLength(6);
  expect(w!.timestamps.some(t => Math.abs(t - 2.16) < 0.001)).toBe(true);
  expect(Buffer.from(w!.jpeg, "base64").subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  const decodes = spawnStats.ffmpeg;
  await sheet();
  expect(spawnStats.ffmpeg).toBe(decodes);
  // The timeline scene detector must keep the transition even with an offset
  // start and an overlapping request drawn from its previously indexed frames.
  for (const from of [0.4, 0.8]) {
    const composite = await client.contactSheet(projectId, { version: base, from, to: 3.92, count: 6, mode: "scene" });
    expect(composite.state).toBe("ready");
    if (composite.state === "ready") expect(composite.windows[0]!.timestamps).toContain(2.16);
  }
  const other = workspace.ctx.repos.projects.insert(createProject("Other"));
  await expect(client.contactSheet(other.id, { mediaId: "m", from: 0, to: 1 })).rejects.toMatchObject({ status: 404 });
  await expect(client.contactSheet(projectId, { from: 0, to: 121 })).rejects.toMatchObject({ status: 400 });
});

it("shares full-rate composite activity pictures while preserving a two-frame screen change across blocks", async () => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Activity coverage", { width: 640, height: 360, fps: 25 }));
  ctx.paths.ensureProject(p.id);
  const file = join(ctx.paths.media(p.id), "screen.mp4");
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=25:d=4",
    "-vf", "drawbox=x=300:y=150:w=12:h=12:color=white:t=fill:enable='between(n,50,51)'", "-c:v", "libx264", "-threads", "1", file]);
  ctx.repos.projects.putMedia(p.id, { id: "screen-short", kind: "video", name: "Screen", path: "screen.mp4",
    width: 640, height: 360, fps: 25, hasAudio: false, duration: 4 }, "ready");
  const tl = emptyTimeline(p.id);
  tl.tracks[0]!.clips = [makeMediaClip("screen-short", 0, 4, 0)];
  const { version } = storeVersion(ctx, p.id, tl, { parent: null });
  const inspect = async (from: number, to: number, mode: "activity" | "uniform" | "scene") => {
    const r = await client.contactSheet(p.id, { from, to, version, mode, count: 6 });
    if (r.state !== "ready") throw new Error("Picture inspection queued a playable video.");
    return r.windows[0]!;
  };
  const original = await inspect(1.8, 2.6, "activity");
  expect(original.changedFrames).toBe(2);
  expect(original.timestamps).toEqual(expect.arrayContaining([2, 2.08]));
  const decodes = spawnStats.ffmpeg;
  const overlap = await inspect(1.84, 2.48, "activity");
  expect(overlap.changedFrames).toBe(2);
  expect(spawnStats.ffmpeg - decodes).toBe(1); // Only repack the selected frames.
  expect((await inspect(2.16, 2.48, "activity")).changedFrames).toBe(0);
  for (const mode of ["uniform", "scene"] as const) {
    const sheet = await inspect(0, 4, mode);
    expect(sheet.timestamps).toHaveLength(6);
    expect(sheet.timestamps[0]).toBe(0);
    expect(sheet.timestamps.at(-1)).toBe(3.96);
  }
  expect(ctx.repos.renders.select("project_id = ?", [p.id])).toHaveLength(0);

  const input = { projectId: p.id, version, kind: "segment" as const, quality: "preview" as const,
    range: { start: 1, end: 3 } };
  const render = ctx.renders.request(input);
  await expect.poll(() => ctx.repos.renders.get(render.id)?.state, { timeout: 10000 }).toBe("done");
  const done = ctx.repos.renders.get(render.id)!;
  const reference = await contactSheet(join(ctx.paths.renders(p.id), done.path!), { start: 0.6, end: 1.4 },
    { origin: 1, count: 6, mode: "uniform", fps: 25 });
  const before = spawnStats.ffmpeg;
  const cached = await inspect(1.6, 2.4, "uniform");
  expect(cached.timestamps).toEqual(reference.timestamps);
  expect(cached.jpeg).toBe(reference.jpeg);
  expect(spawnStats.ffmpeg - before).toBe(1);
  await runCapture(resolveFfmpeg(), ["-y", "-v", "error", "-f", "lavfi", "-i", "color=red:s=640x360:r=25:d=4",
    "-c:v", "libx264", "-threads", "1", file]);
  expect((await inspect(1.6, 2.4, "uniform")).jpeg).not.toBe(cached.jpeg);
  expect((await inspect(1.8, 2.6, "activity")).changedFrames).toBe(0);
});

it("classifies and caches source voice activity only on an explicit speech analysis request", async () => {
  const wf = await client.waveform("m", 0, 1, 50);
  expect(wf.speechActivity).toBeUndefined();
  const speech = () => client.waveform("m", 0.4, 1.2, 40, true, true);
  const { speechActivity } = await speech();
  expect(speechActivity!.length).toBeGreaterThan(0);
  expect(speechActivity!.every(s => s.start >= 0.4 && s.end <= 1.2)).toBe(true);
  const decodes = spawnStats.ffmpeg;
  await speech();
  expect(spawnStats.ffmpeg).toBe(decodes);
  // A window someone asked for is read while the project's media work is paused: a running edit checks its joins with
  // these, and pausing the caching doesn't stop it.
  workspace.ctx.repos.projects.update(projectId, { mediaPaused: true });
  try {
    expect((await client.waveform("m", 1.2, 2, 40, true, true)).speechActivity).toBeInstanceOf(Array);
    expect(spawnStats.ffmpeg).toBeGreaterThan(decodes);
    // A pass's inspection of a cut reads levels and voice in one request, which prepares a waveform that isn't
    // cached yet. The timeline's drawing asks for no voice, and its waveform waits for resume.
    for (const id of ["drawn", "inspected"]) workspace.ctx.repos.projects.putMedia(projectId, { id, kind: "video", name: id, path: "sample.mp4",
      hasAudio: true, duration: 4, fps: 25, width: 320, height: 180 }, "ready");
    await expect(client.waveform("drawn", 0, 1, 64)).rejects.toMatchObject({ status: 404 });
    const read = await client.waveform("inspected", 0, 1, 64, false, true);
    expect([read.rms?.length, Array.isArray(read.speechActivity)]).toEqual([64, true]);
  } finally { workspace.ctx.repos.projects.update(projectId, { mediaPaused: false }); }
});

it("accepts a full minute of speech analysis at a fractional source offset", async () => {
  const file = join(workspace.ctx.paths.media(projectId), "long.wav");
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "572", file]);
  workspace.ctx.repos.projects.putMedia(projectId, { id: "long", kind: "audio", name: "Long",
    path: "long.wav", duration: 572, hasAudio: true }, "ready");
  const scan = (to: number) => client.waveform("long", 511.41, to, 50, false, true);
  expect(await scan(511.41 + 60)).toMatchObject({ speechActivity: [] });
  await expect(scan(571.42)).rejects.toMatchObject({ code: "bad_speech_range" });
});

it("compares both original boundaries to the proposed join and auditions its rendered mix", async () => {
  const { ctx } = workspace;
  const { change } = proposeChange(ctx, localUser(ctx), projectId, { fromVersion: base, description: "Remove ramp",
    ops: [{ op: "rippleDelete", start: 1, end: 3 }] });
  const review = () => client.reviewCut(projectId, { changeId: change.id, handles: 0.8, includeAudio: true });
  const result = await ready(review);
  expect(result.windows.map(w => [w.label, w.focus, w.id])).toEqual([
    ["Before outgoing", 1, base], ["Before incoming", 3, base], ["After", 1, change.toVersion],
  ]);
  const edited = result.windows[2]!;
  expect(edited.timestamps).toEqual(expect.arrayContaining([0.96, 1]));
  expect(edited.events?.some(e => e.kind === "black")).toBe(true);
  expect(edited.events?.some(e => e.kind === "freeze")).toBe(true);
  expect(result.newEvents?.map(e => e.kind)).toContain("level-drop");
  expect(result.newEvents?.some(e => e.kind === "black" || e.kind === "freeze")).toBe(false);
  for (const w of result.windows) {
    const wav = Buffer.from(w.wav!, "base64");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  }
  const decodes = spawnStats.ffmpeg;
  await review();
  expect(spawnStats.ffmpeg).toBe(decodes);
  expect(ctx.repos.projects.header(projectId)?.head).toBe(base);
}, 20000);

it("finds a newly black composite and can inspect an unapproved version directly", async () => {
  const { ctx } = workspace;
  const { change } = proposeChange(ctx, localUser(ctx), projectId, { fromVersion: base, description: "Hide picture",
    ops: [{ op: "updateClip", clipId: "v", patch: { opacity: 0 } }] });
  const result = await ready(() => client.reviewCut(projectId, { changeId: change.id, handles: 1 }));
  expect(result.newEvents?.some(e => e.kind === "black")).toBe(true);
  expect(result.windows.every(w => !w.wav)).toBe(true);
  const { windows: [sheet] } = await ready(() => client.contactSheet(projectId,
    { from: 0.4, to: 1.4, version: change.toVersion, focus: 1 }));
  expect(sheet).toMatchObject({ clock: "timeline", id: change.toVersion });
  expect(sheet!.timestamps).toEqual(expect.arrayContaining([0.96, 1]));
}, 20000);

it("refreshes the filmstrip for a same-duration edit and reuses frames within that version", async () => {
  const { ctx } = workspace;
  const { change } = proposeChange(ctx, localUser(ctx), projectId, { fromVersion: base, description: "Cover the first second",
    ops: [{ op: "addClip", trackId: "v1", clip: { kind: "color", id: "cover", color: "red", timelineIn: 0, timelineOut: 1 } }] });
  const getFrame = async (version: string, frame: number, view: "strip" | "hover" | "monitor" = "strip") => {
    const url = client.fileUrl(`/projects/${projectId}/versions/${version}/frame`) + `&frame=${frame}` + (view === "monitor" ? "&view=monitor" : view === "hover" ? "&w=640" : "");
    const response = await workspace.app.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    return Buffer.from(await response.arrayBuffer());
  };
  const before = await getFrame(base, 12);
  const after = await getFrame(change.toVersion, 12);
  expect(after.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  expect(after.equals(before)).toBe(false);
  const hover = await getFrame(change.toVersion, 12, "hover");
  expect(hover.equals(after)).toBe(false);
  expect(await getFrame(change.toVersion, 12, "hover")).toEqual(hover);
  const selected = await getFrame(change.toVersion, 12, "monitor");
  expect(selected.equals(after)).toBe(false);
  expect(await getFrame(change.toVersion, 12, "monitor")).toEqual(selected);
  const unchanged = await getFrame(base, 45);
  const decodes = spawnStats.ffmpeg;
  expect(await getFrame(change.toVersion, 45)).toEqual(unchanged);
  expect(spawnStats.ffmpeg).toBe(decodes + 1);
  await getFrame(change.toVersion, 45);
  expect(spawnStats.ffmpeg).toBe(decodes + 1);
});

it("composites an available source proxy for uncached cut frames and recovers from a damaged proxy", async () => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Preview frames", { width: 320, height: 180, fps: 25 }));
  ctx.paths.ensureProject(p.id);
  const root = ctx.paths.media(p.id);
  const asset = ctx.repos.projects.putMedia(p.id, { id: "preview-frame-source", kind: "video", name: "Camera", path: "source.mp4",
    width: 320, height: 180, fps: 25, hasAlpha: false, duration: 4, previewClock: { startPts: 0, frameRate: "25/1" } }, "ready");
  await copyFile(join(ctx.paths.media(projectId), "sample.mp4"), join(root, asset.path));
  const { local } = await previewIdentity(root, asset);
  const proxy = join(ctx.paths.proxies(p.id), `cached-${local}.mp4`);
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=4",
    "-c:v", "libx264", "-threads", "1", proxy]);
  const project = ctx.repos.projects.get(p.id)!;
  const tl = timelineFromKeepRanges(p.id, asset.id, [{ start: 0, end: 3 }]);
  const { version } = storeVersion(ctx, p.id, tl, { parent: null });
  const frame = async (i: number) => {
    const response = await workspace.app.request(client.fileUrl(`/projects/${p.id}/versions/${version}/frame`) + "&frame=" + i);
    expect(response.status).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  };
  const expected = (i: number, useProxy: boolean) => renderTimelineFrame(project, tl, { start: i / 25, end: (i + 1) / 25 },
    root, undefined, 160, useProxy ? { pictureSource: async () => ({ file: proxy, start: 0 }) } : undefined);
  expect(await frame(4)).toEqual(await expected(4, true));
  await writeFile(proxy, "damaged");
  expect(await frame(5)).toEqual(await expected(5, false));
});

it("reads a cut's pictures from the originals when a preview copy goes missing before it is read, and logs that once", async () => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Evicted copy", { width: 320, height: 180, fps: 25 }));
  ctx.paths.ensureProject(p.id);
  const root = ctx.paths.media(p.id);
  const asset = ctx.repos.projects.putMedia(p.id, { id: "evicted-copy-source", kind: "video", name: "Camera", path: "source.mp4",
    width: 320, height: 180, fps: 25, hasAlpha: false, duration: 4, previewClock: { startPts: 0, frameRate: "25/1" } }, "ready");
  await copyFile(join(ctx.paths.media(projectId), "sample.mp4"), join(root, asset.path));
  const project = ctx.repos.projects.get(p.id)!;
  const tl = timelineFromKeepRanges(p.id, asset.id, [{ start: 0, end: 3 }]);
  const { version } = storeVersion(ctx, p.id, tl, { parent: null });
  // The copy was there when it was chosen and is gone by the time ffmpeg opens it, as one evicted for space is.
  const copies = vi.spyOn(pictureCopies, "previewPictures").mockReturnValue(async () => ({ file: join(root, "evicted.mp4"), start: 0 }));
  const lines: string[] = [], log = ctx.log;
  ctx.log = line => lines.push(line);
  try {
    const frame = async (i: number) => {
      const response = await workspace.app.request(client.fileUrl(`/projects/${p.id}/versions/${version}/frame`) + "&frame=" + i);
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    };
    const original = (i: number) => renderTimelineFrame(project, tl, { start: i / 25, end: (i + 1) / 25 }, root, undefined, 160);
    expect(await frame(4)).toEqual(await original(4));
    expect(await frame(5)).toEqual(await original(5));
    const { windows: [sheet] } = await ready(() => client.contactSheet(p.id, { from: 0, to: 1, version }));
    expect(sheet).toMatchObject({ clock: "timeline", id: version });
    expect(sheet!.timestamps.length).toBeGreaterThan(0);
    // Each reader says it went back to the originals, and why, once for all the pictures that took.
    expect(lines.filter(line => line.includes("again from the originals"))).toEqual([
      expect.stringMatching(new RegExp(`^\\[render\\] reading a frame of ${version} again from the originals on the CPU: .+`)),
      expect.stringMatching(new RegExp(`^\\[inspection\\] reading ${version} again from the originals on the CPU: .+`)),
    ]);
  } finally { ctx.log = log; copies.mockRestore(); }
});

it("measures how much of a source window's picture changes and when, once per window", async () => {
  const { ctx } = workspace;
  // A still grey screen: a small box appears at 1 s, another at 2 s, and the whole picture goes black at 3 s.
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25:d=4", "-vf",
    "drawbox=x=20:y=20:w=32:h=18:color=white:t=fill:enable='gte(t,1)',drawbox=x=200:y=120:w=32:h=18:color=white:t=fill:enable='gte(t,2)'," +
    "drawbox=color=black:t=fill:enable='gte(t,3)'", "-c:v", "libx264", "-qp", "0", "-threads", "1", join(ctx.paths.media(projectId), "still.mp4")]);
  ctx.repos.projects.putMedia(projectId, { id: "still", kind: "video", name: "Still screen", path: "still.mp4",
    hasAudio: false, duration: 4, fps: 25, width: 320, height: 180 }, "ready");
  const measure = () => client.pictureActivity(projectId, { windows: [{ mediaId: "still", from: 0.4, to: 3.6 }, { mediaId: "still", from: 1.4, to: 1.9 }] });
  const { windows: [whole, quiet] } = await measure();
  expect(whole).toMatchObject({ mediaId: "still", from: 0.4, to: 3.6, changedFrames: 3, frames: 80 });
  expect(whole!.typicalArea).toBeGreaterThan(0.005);
  expect(whole!.typicalArea).toBeLessThan(0.03);
  expect(whole!.largestArea).toBeGreaterThan(0.95);
  expect(whole!.largestAt).toBeCloseTo(3, 2);
  expect(whole!.lastChangeAt).toBeCloseTo(3, 2);
  expect(quiet).toEqual({ mediaId: "still", from: 1.4, to: 1.9, changedFrames: 0, frames: 13 });
  const decodes = spawnStats.ffmpeg;
  await measure();
  expect(spawnStats.ffmpeg).toBe(decodes);
  await expect(client.pictureActivity(projectId, { windows: [{ mediaId: "still", from: 3, to: 5 }] })).rejects.toMatchObject({ status: 400 });
  await expect(client.pictureActivity(projectId, { windows: [{ mediaId: "nope", from: 0, to: 1 }] })).rejects.toMatchObject({ status: 404 });
});

it("reads a source sheet from its preview copy in source seconds, and from the original once the copy is damaged", async () => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Preview sheets", { width: 320, height: 180, fps: 25 }));
  ctx.paths.ensureProject(p.id);
  const root = ctx.paths.media(p.id);
  const asset = ctx.repos.projects.putMedia(p.id, { id: "sheet-source", kind: "video", name: "Screen", path: "source.mp4",
    width: 320, height: 180, fps: 25, hasAlpha: false, duration: 4, previewClock: { startPts: 0, frameRate: "25/1", videoStart: 0 } }, "ready");
  await copyFile(join(ctx.paths.media(projectId), "sample.mp4"), join(root, asset.path));
  const { local } = await previewIdentity(root, asset);
  // A blue copy shows which file the sheet came from. Its one faint step counts only at the copy threshold.
  const proxy = join(ctx.paths.proxies(p.id), `cached-${local}.mp4`);
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=4",
    "-vf", "format=yuv420p,geq=lum='p(X,Y)+20*gte(T,2)':cb='p(X,Y)':cr='p(X,Y)'", "-c:v", "libx264", "-qp", "0", "-threads", "1", proxy]);
  const window = { start: 0.4, end: 3.6 };
  const sheet = async () => {
    const result = await client.contactSheet(p.id, { mediaId: asset.id, from: window.start, to: window.end, count: 6, mode: "activity" });
    if (result.state !== "ready") throw new Error("Sheet still preparing");
    return result.windows[0]!;
  };
  const direct = (file: string, over: { activityThreshold?: number; decoder?: "cuda" | "videotoolbox" } = {}) =>
    contactSheet(file, window, { origin: 0, fps: 25, count: 6, mode: "activity", sourceWidth: 320, ...over });
  const fromCopy = await sheet();
  expect(fromCopy).toMatchObject({ clock: "source", id: asset.id, range: window, jpeg: (await direct(proxy, { activityThreshold: PREVIEW_COPY_ACTIVITY_THRESHOLD })).jpeg, changedFrames: 1 });
  expect(fromCopy.timestamps[0]).toBeCloseTo(0.4, 6);
  await writeFile(proxy, "damaged");
  const fromOriginal = await sheet();
  // The engine decodes an original on the GPU when there is one, and a GPU's pixels can differ from the CPU's by a
  // rounding step. Read the comparison the same way, so the sheet is told apart by its source alone.
  const original = await direct(join(root, asset.path), { decoder: await pictureDecoder(ctx.settings().render.hwaccel) });
  expect(fromOriginal.jpeg).toBe(original.jpeg);
  expect(fromOriginal.changedFrames).toBe(original.changedFrames);
});

async function frameBrightness(file: string, time: number) {
  const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", "-ss", String(time), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "gray", "-an", "-f", "rawvideo", "-"]);
  expect(stdout).toHaveLength(1);
  return stdout[0]!;
}

it("seeks the same picture in a 29.97 fps proxy chunk whose audio starts before its first frame", async () => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Chunk clock"));
  ctx.paths.ensureProject(p.id);
  const root = ctx.paths.media(p.id), file = join(root, "clock.mp4");
  const fps = 30000 / 1001;
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i",
    "nullsrc=s=96x54:r=30000/1001:d=33,geq=lum='16+mod(N*37,210)':cb=128:cr=128",
    "-f", "lavfi", "-i", "sine=sample_rate=48000:d=33", "-c:v", "libx264", "-threads", "1", "-crf", "0", "-c:a", "aac", file]);
  const asset = ctx.repos.projects.putMedia(p.id, { id: "clock", name: "Clock", path: "clock.mp4", kind: "video",
    width: 96, height: 54, fps, hasAlpha: false, hasAudio: true, previewClock: { frameRate: "30000/1001", startPts: 0 } }, "ready");
  const { local, legacyKeys } = await previewIdentity(root, asset);
  const oldDir = join(ctx.paths.proxies(p.id), "source-" + legacyKeys[0]);
  await mkdir(oldDir);
  await writeFile(join(oldDir, "v1-54-3.mp4"), "Old range with unknown frame synchronization");
  expect(await previewPictures(root)(asset, 26.5, 26.6, 54)).toBeUndefined();
  const chunks = join(ctx.paths.proxies(p.id), "source-" + local);
  await mkdir(chunks);
  const proxy = join(chunks, "v1-54-3.mp4");
  await makeProxy(file, proxy, { range: { start: 24, end: 32 }, height: 54 });
  const picture = await previewPictures(root)(asset, 26.5, 26.5 + 1 / fps, 54);
  expect(picture?.file).toBe(proxy);
  for (const time of [24.06, 26.44, 26.46, 26.48, 26.5, 26.52, 26.54, 31.98]) {
    expect(Math.abs(await frameBrightness(file, time) - await frameBrightness(proxy, time - picture!.start))).toBeLessThan(4);
  }
});

it.each([0.021, 0.217])("maps complete proxies to a recording with a %ss audio lead", async lead => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Legacy source origin"));
  ctx.paths.ensureProject(p.id);
  const root = ctx.paths.media(p.id), file = join(root, "camera.mp4");
  const fps = 30000 / 1001;
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i",
    "nullsrc=s=96x54:r=30000/1001:d=2,geq=lum='16+mod(N*37,210)':cb=128:cr=128",
    "-f", "lavfi", "-i", "sine=sample_rate=48000:d=2.5", "-vf", `settb=1/90000,setpts=PTS+${Math.round(lead * 90000)}`, "-fps_mode", "passthrough", "-enc_time_base:v", "1:90000",
    "-c:v", "libx264", "-threads", "1", "-crf", "0", "-c:a", "aac", file]);
  const asset = ctx.repos.projects.putMedia(p.id, { id: "legacy-origin-" + lead, name: "Camera", path: "camera.mp4", kind: "video",
    width: 96, height: 54, fps, hasAlpha: false, hasAudio: true }, "ready");
  const { local, legacyKeys } = await previewIdentity(root, asset);
  const proxy = join(ctx.paths.proxies(p.id), `cached-${local}.mp4`);
  const legacy = join(ctx.paths.proxies(p.id), `cached-${legacyKeys[0]}.mp4`);
  const resolve = () => previewPictures(root)(asset, 0.7, 0.9, 54);
  async function check(fileToUse: string) {
    const picture = await resolve();
    expect(picture?.file).toBe(fileToUse);
    for (const t of [.70, .72, .74, .76]) {
      expect(Math.abs(await frameBrightness(file, t) - await frameBrightness(fileToUse, t - picture!.start))).toBeLessThan(4);
    }
    return picture!.start;
  }
  // Old complete encodes can have either rounded first PTS or extra leading pictures.
  const oldEncode = (filters: string[]) => runCapture(resolveFfmpeg(), ["-v", "error", "-y", "-i", file, ...filters,
    "-fps_mode", "passthrough", "-c:v", "libx264", "-threads", "1", "-crf", "18", "-c:a", "copy", legacy]);
  await oldEncode([]);
  expect(Math.abs(await check(legacy))).toBeGreaterThan(.001);
  // An older FFmpeg encode can duplicate the opening and drop the tail at the same total count.
  await oldEncode(["-vf", "fps=30000/1001:start_time=0", "-frames:v", "60"]);
  expect(await resolve()).toBeUndefined();
  await makeProxy(file, proxy, { height: 54 });
  await check(proxy);
});

it("shares media metadata across strip samples and reloads it after media changes", async () => {
  const { ctx } = workspace;
  const project = ctx.repos.projects.insert(createProject("Strip inputs", { width: 320, height: 180, fps: 25 }));
  const timeline = emptyTimeline(project.id);
  timeline.tracks[0]!.clips = [{ kind: "color", id: "background", timelineIn: 0, timelineOut: 2, enabled: true, color: "black", opacity: 1 }];
  const { version } = storeVersion(ctx, project.id, timeline, { parent: null });
  const load = vi.spyOn(ctx.repos.projects, "listMedia");
  try {
    const frame = async (i: number) => {
      const res = await workspace.app.request(client.fileUrl(`/projects/${project.id}/versions/${version}/frame`) + "&frame=" + i);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    };
    await Promise.all([frame(2), frame(4), frame(6)]);
    expect(load).toHaveBeenCalledTimes(1);
    ctx.repos.projects.putMedia(project.id, { id: "added", name: "New source", path: "new.mp4", kind: "video" }, "ready");
    await frame(6);
    expect(load).toHaveBeenCalledTimes(2);
  } finally { load.mockRestore(); }
});

it("revalidates completed previews and JPEGs after source bytes change without a catalog edit", async () => {
  const { ctx } = workspace;
  const p = ctx.repos.projects.insert(createProject("Mutable media", { width: 320, height: 180, fps: 25 }));
  ctx.paths.ensureProject(p.id);
  const source = join(ctx.paths.media(p.id), "source.mp4");
  const replacement = join(ctx.paths.media(p.id), "new.mp4");
  await copyFile(join(ctx.paths.media(projectId), "sample.mp4"), source);
  ctx.repos.projects.putMedia(p.id, { id: "mutable", kind: "video", name: "Mutable", path: "source.mp4", duration: 4, fps: 25 }, "ready");
  const timeline = emptyTimeline(p.id);
  timeline.tracks[0]!.clips = [makeMediaClip("mutable", 0, 2, 0)];
  const { version } = storeVersion(ctx, p.id, timeline, { parent: null });
  ctx.repos.projects.initializeHead(p.id, null, version);
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, output) => { await copyFile(source, output); });
  try {
    const render = ctx.renders.request({ projectId: p.id, version, kind: "full", quality: "preview", range: null });
    await Promise.all([...ctx.pending]);
    const lookup = () => client.renders(p.id, { kind: "full", version });
    expect((await lookup()).renders.map(r => r.id)).toContain(render.id);
    const url = client.fileUrl(`/projects/${p.id}/versions/${version}/frame`) + "&frame=12&format=320x180@25";
    const first = await workspace.app.request(url);
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toContain("no-cache");
    const original = Buffer.from(await first.arrayBuffer());
    const revalidate = () => workspace.app.request(url, { headers: { "If-None-Match": etag } });
    expect((await revalidate()).status).toBe(304);
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=25:d=2",
      "-c:v", "libx264", "-threads", "1", replacement]);
    await rename(replacement, source);
    expect((await lookup()).renders.map(r => r.id)).not.toContain(render.id);
    expect((await client.render(render.id)).render.state).toBe("done");
    const latest = await revalidate();
    expect(latest.status).toBe(200);
    expect(latest.headers.get("ETag")).not.toBe(etag);
    expect(Buffer.from(await latest.arrayBuffer())).not.toEqual(original);
  } finally { encode.mockRestore(); }
});

it("samples a previously watched section at its local frame time for scrubbing", async () => {
  const { ctx } = workspace;
  const timeline = emptyTimeline(projectId);
  timeline.tracks[0]!.clips.push(makeMediaClip("m", 0, 30, 0));
  const { version } = storeVersion(ctx, projectId, timeline, { parent: base });
  const range = { start: 10, end: 20 };
  const input = { projectId, version, range, kind: "playback" as const, quality: "preview" as const };
  const file = join(ctx.paths.media(projectId), "sample.mp4");
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _t, _r, _c, output) => {
    await copyFile(file, output);
  });
  try { ctx.renders.request(input); await Promise.all([...ctx.pending]); }
  finally { encode.mockRestore(); }
  const url = client.fileUrl(`/projects/${projectId}/versions/${version}/frame`) + "&frame=265";
  const response = await workspace.app.request(url);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await extractFrame(file, (15 - .1) / 25, { width: 160 }));
});

it("samples a completed preview once per strip and refuses it for another timeline version", async () => {
  const { ctx } = workspace;
  const { change } = proposeChange(ctx, localUser(ctx), projectId, { fromVersion: base, description: "Cover the picture",
    ops: [{ op: "addClip", trackId: "v1", clip: { kind: "color", id: "red-strip", color: "red", timelineIn: 0, timelineOut: 4 } }] });
  async function preview(version: string) {
    const { render } = await client.requestRender(projectId, { kind: "full", quality: "preview", version });
    await expect.poll(async () => (await client.render(render.id)).render.state, { timeout: 10000 }).toBe("done");
    return render.id;
  }
  const strip = (id: string, version: string, frames = "3,12,75", layout = "source-aspect") =>
    workspace.app.request(client.fileUrl(`/renders/${id}/filmstrip`) + `&version=${version}&frames=${frames}&layout=${layout}`);
  const old = await preview(base);
  const cached = await strip(old, base);
  expect(cached.status).toBe(200);
  const picture = Buffer.from(await cached.arrayBuffer());
  const calls = spawnStats.ffmpeg;
  expect(Buffer.from(await (await strip(old, base)).arrayBuffer())).toEqual(picture);
  expect(spawnStats.ffmpeg).toBe(calls);
  expect(Buffer.from(await (await strip(old, base, "3,12,75", "16:9")).arrayBuffer())).not.toEqual(picture);
  expect((await strip(old, change.toVersion)).status).toBe(404);
  expect((await strip(old, base, "100000")).status).toBe(400);
  const current = await strip(await preview(change.toVersion), change.toVersion);
  expect(current.status).toBe(200);
  expect(Buffer.from(await current.arrayBuffer())).not.toEqual(picture);
}, 20000);

it("auditions only a short audio range from the selected project before any edit", async () => {
  const request = { mediaId: "m", from: 0.5, to: 1 };
  const wav = Buffer.from((await client.sourceAudio(projectId, request)).wav, "base64");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.readUInt32LE(40)).toBe(16000);
  const other = workspace.ctx.repos.projects.insert(createProject("Other mic"));
  await expect(client.sourceAudio(other.id, request)).rejects.toMatchObject({ status: 404 });
  await expect(client.sourceAudio(projectId, { ...request, to: 4.5 })).rejects.toMatchObject({ status: 400 });
  await expect(client.sourceAudio(projectId, { ...request, to: 9 })).rejects.toMatchObject({ status: 400 });
});

it("selects a four-frame menu that opens and disappears between normal screen thumbnails", async () => {
  const file = join(workspace.ctx.paths.media(projectId), "menu.mp4");
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i",
    "color=white:s=640x360:r=30:d=2", "-vf", "drawbox=x=300:y=125:w=50:h=30:color=black:t=fill:enable='between(n,11,14)'",
    "-c:v","libx264",file]);
  workspace.ctx.repos.projects.putMedia(projectId, { id:"menu",name:"screen",path:"menu.mp4",kind:"video",fps:30,duration:2 }, "ready");
  const sheet = await ready(() => client.contactSheet(projectId,{mediaId:"menu",from:0,to:2,mode:"activity",count:6}));
  expect(sheet.windows[0]?.changedFrames).toBeGreaterThanOrEqual(2);
  expect(sheet.windows[0]?.timestamps.some(t=>t>=11/30-0.00001 && t<0.5)).toBe(true);
  await expect(client.contactSheet(projectId,{mediaId:"menu",from:0,to:13,mode:"activity"})).rejects.toMatchObject({status:400});
});
