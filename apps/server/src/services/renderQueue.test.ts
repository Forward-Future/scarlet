import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, onTestFinished } from "vitest";
import { DELIVERY_AUDIO_REVISION, FfmpegError, MissingFilterError, missingTextFilterMessage, runCapture, segmentKey } from "@scarlet/render";
import { createProject, makeMediaClip, planTransitions, sha256, stableStringify, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { storeVersion } from "./timeline.js";

vi.mock("@scarlet/timeline", async importOriginal => {
  const timeline = await importOriginal<typeof import("@scarlet/timeline")>();
  return { ...timeline, planTransitions: vi.fn(timeline.planTransitions) };
});

let directory: string;
let workspace: ScarletApp;
let project: Project;
let version: string;
let lines: string[];
const programs: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-render-queue-test-"));
  const said: string[] = lines = [];
  workspace = createApp({
    dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line),
    render: {
      ...scarletRenderAdapter,
      async renderRange(_project, _timeline, _range, file) { writeFileSync(file, "section"); },
      async renderPlaybackSegment(_project, _timeline, _range, _cache, file) { writeFileSync(file, "fragment"); },
    },
  });
  const { ctx } = workspace;
  project = ctx.repos.projects.insert(createProject("Renders"));
  ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Camera", path: "camera.mp4", duration: 30, hasAudio: true }, "ready");
  version = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null }).version;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const program of programs.splice(0)) program.kill();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };
const section = () => ({ projectId: project.id, version, kind: "segment", quality: "delivery", range: { start: 1, end: 3 } }) as const;

it("yields a speculative fragment to playback, then finishes it before resuming the full cache", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 1 } });
  const order: string[] = [];
  const untilAbort = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  vi.spyOn(ctx.render, "renderFullCached").mockImplementationOnce(async (_p, _t, _c, _out, opts) => {
    order.push("full"); await untilAbort(opts.signal!);
  }).mockImplementation(async (_p, _t, _c, out) => { order.push("full"); writeFileSync(out, "full"); });
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementationOnce(async (_p, _t, _r, _c, _out, opts) => {
    order.push("warm"); await untilAbort(opts.signal!);
  }).mockImplementation(async (_p, _t, range, _c, out) => {
    order.push(range.start ? "play" : "warm"); writeFileSync(out, "fragment");
  });
  const input = { projectId: project.id, version, quality: "preview" } as const;
  const full = ctx.renders.request({ ...input, kind: "full", range: null }, "cache");
  const warm = ctx.renders.request({ ...input, kind: "playback", range: { start: 0, end: 4 }, speculative: true }, "next");
  await vi.waitFor(() => expect(order).toEqual(["full", "warm"]));
  const playing = ctx.renders.request({ ...input, kind: "playback", range: { start: 8, end: 12 } }, "viewer");
  await settle();
  expect(order).toEqual(["full", "warm", "play", "warm", "full"]);
  for (const render of [full, warm, playing]) expect(ctx.repos.renders.get(render.id)?.state).toBe("done");
});

it("promotes the same preparation when its viewer arrives and preserves playback when the preparation leaves", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 1 } });
  let finish!: () => void;
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementationOnce(async (_p, _t, _r, _c, out, opts) => {
    await new Promise<void>(resolve => {
      finish = resolve;
      opts.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    writeFileSync(out, "shared fragment");
  }).mockImplementation(async (_p, _t, _r, _c, out) => { writeFileSync(out, "second fragment"); });
  const input = { projectId: project.id, version, kind: "playback", quality: "preview", range: { start: 0, end: 4 } } as const;
  const warm = ctx.renders.request({ ...input, speculative: true }, "next");
  expect(ctx.renders.request(input, "viewer").id).toBe(warm.id);
  const other = ctx.renders.request({ ...input, range: { start: 8, end: 12 } }, "second viewer");
  ctx.renders.release(warm.id, "next");
  expect(encode.mock.calls[0]![5].signal?.aborted).toBe(false);
  expect(ctx.repos.renders.get(other.id)?.state).toBe("queued");
  finish();
  await settle();
  expect(encode).toHaveBeenCalledTimes(2);
  expect(ctx.repos.renders.get(warm.id)?.state).toBe("done");
});

it.each(["joined", "released"])("keeps the latest export destination when a running render's save is %s", async state => {
  const { ctx } = workspace;
  let finish!: () => void;
  const encoding = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => {
    await encoding;
    writeFileSync(file, "finished");
  });
  const input = { projectId: project.id, version, kind: "full", quality: "delivery", range: null } as const;
  const save = { ticket: 12, name: "Interview.mp4" };
  const owner = crypto.randomUUID();
  try {
    const render = state === "joined" ? ctx.renders.request(input) : ctx.renders.request(input, owner, save);
    expect(ctx.repos.renders.get(render.id)?.state).toBe("running");
    if (state === "joined") {
      expect(ctx.renders.request(input, owner, save).id).toBe(render.id);
    } else {
      // The encoder still has a second reader after the editor cancels the save.
      expect(ctx.renders.request(input, "reader").id).toBe(render.id);
      ctx.renders.release(render.id, owner);
    }
    finish();
    await settle();
    expect(ctx.repos.renders.get(render.id)?.state).toBe("done");
    expect(ctx.renders.exports().map(r => r.export)).toEqual(state === "joined" ? [{ owner, ...save }] : []);
  } finally { finish(); }
});

it.each(["playback", "segment"] as const)("loads only the overlapping sources for a %s render", async kind => {
  const { ctx } = workspace;
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]);
  const clips = timeline.tracks[0]!.clips;
  for (const id of ["later", "overlay", "unused"]) {
    ctx.repos.projects.putMedia(project.id, { id, kind: "video", name: id, path: id + ".mp4", duration: 30 }, "ready");
  }
  clips.push(makeMediaClip("later", 0, 5, 5), makeMediaClip("overlay", 0, 2, 1));
  const v = storeVersion(ctx, project.id, timeline, { parent: version }).version;
  const render = vi.spyOn(ctx.render, kind === "playback" ? "renderPlaybackSegment" : "renderRange");
  const allMedia = vi.spyOn(ctx.repos.projects, "listMedia");
  ctx.renders.request({ ...section(), version: v, kind, quality: "preview", range: { start: 1, end: 5 } });
  await settle();
  expect(allMedia).not.toHaveBeenCalled();
  const [inputs, part] = render.mock.calls[0]!;
  expect(inputs.media.map(m => m.id).sort()).toEqual(["camera", "overlay"]);
  if (kind === "playback") expect(part.tracks[0]!.clips.map(c => c.id)).toEqual([clips[0]!.id, clips[2]!.id]);
});

it("hands a playback section every clip it renders when its saved endpoints aren't on a frame", async () => {
  const { ctx } = workspace;
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 5 }]);
  ctx.repos.projects.putMedia(project.id, { id: "overlay", kind: "video", name: "overlay", path: "overlay.mp4", duration: 30 }, "ready");
  // It starts after the last frame the section snaps to, and before the section's own end.
  timeline.tracks[0]!.clips.push(makeMediaClip("overlay", 0, 1, 5.005));
  const v = storeVersion(ctx, project.id, timeline, { parent: version }).version;
  const render = vi.spyOn(ctx.render, "renderPlaybackSegment");
  const range = { start: 4, end: 5.012 };
  ctx.renders.request({ ...section(), version: v, kind: "playback", quality: "preview", range });
  await settle();
  const [inputs, part, rendered] = render.mock.calls[0]!;
  expect(rendered).toEqual(range);
  expect(part.tracks[0]!.clips.map(c => c.kind === "media" && c.mediaId)).toEqual(["camera", "overlay"]);
  expect(inputs.media.map(m => m.id)).toContain("overlay");
});

it("plans a version's transitions once for all its playback sections", async () => {
  const { ctx } = workspace;
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 4 }, { start: 6, end: 10 }, { start: 12, end: 16 }]);
  const clips = timeline.tracks[0]!.clips;
  for (const clip of clips.slice(1)) if (clip.kind === "media") clip.transitionIn = { type: "dip", duration: 1, direction: "left" };
  const v = storeVersion(ctx, project.id, timeline, { parent: version }).version;
  const render = vi.spyOn(ctx.render, "renderPlaybackSegment");
  vi.mocked(planTransitions).mockClear();
  for (const start of [0, 3, 7]) ctx.renders.request({ ...section(), version: v, kind: "playback", quality: "preview", range: { start, end: start + 2 } });
  await settle();
  // The whole timeline is planned once. Each section's own key plans just its window.
  expect(vi.mocked(planTransitions).mock.calls.filter(([planned]) => planned.tracks[0]!.clips.length === clips.length)).toHaveLength(1);
  // The section across the first dip still has both clips of its join.
  const across = render.mock.calls.find(([, , range]) => range.start === 3)!;
  expect(across[1].tracks[0]!.clips.map(c => c.id)).toEqual([clips[0]!.id, clips[1]!.id]);
});

it("renders a dissolve in a playback window whose outgoing clip has already ended", async () => {
  const { ctx } = workspace;
  const root = ctx.paths.media(project.id);
  mkdirSync(root, { recursive: true });
  ctx.repos.settings.update({ render: { hwaccel: "none" } });
  ctx.repos.projects.update(project.id, { settings: { ...project.settings, width: 64, height: 64, fps: 30 } });
  await Promise.all(["red", "blue"].map(async color => {
    await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=64x64:r=30:d=4`, "-c:v", "libx264", join(root, `${color}.mp4`)]);
    ctx.repos.projects.putMedia(project.id, { id: color, kind: "video", name: color, path: `${color}.mp4`, duration: 4,
      hasAudio: false, hasAlpha: false, width: 64, height: 64, fps: 30 }, "ready");
  }));
  const timeline = timelineFromKeepRanges(project.id, "red", [{ start: 1, end: 3 }]);
  timeline.tracks[0]!.clips.push(makeMediaClip("blue", 1, 3, 2, { transitionIn: { type: "dissolve", duration: 1, direction: "left" } }));
  const v = storeVersion(ctx, project.id, timeline, { parent: version }).version;
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(scarletRenderAdapter.renderPlaybackSegment);
  const render = ctx.renders.request({ ...section(), version: v, kind: "playback", quality: "preview", range: { start: 2, end: 4 } });
  await settle();
  const done = ctx.repos.renders.get(render.id)!;
  expect(done.state).toBe("done");
  const output = join(ctx.paths.renders(project.id), done.path!);
  const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
  expect([stdout[0], stdout[2]]).toEqual([expect.closeTo(125, -1), expect.closeTo(125, -1)]);
});

it.each(["queued", "done", "done with changed sources"] as const)("keeps the saved destination for a %s export with an older transition fingerprint", async state => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { hwaccel: "none" } });
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]);
  const clip = timeline.tracks[0]!.clips[0]!;
  if (clip.kind !== "media") throw new Error("Expected camera footage");
  clip.transitionIn = { type: "dip", duration: 1, direction: "left" };
  const saved = storeVersion(ctx, project.id, timeline, { parent: version });
  const stored = ctx.repos.projects.get(project.id)!;
  const originals = { ...stored, media: stored.media.map(asset => ({ ...asset, hash: asset.id })) };
  const format = { quality: "delivery", height: stored.settings.height, encoder: "none" } as const;
  const savedTimeline = ctx.repos.versions.get(project.id, saved.version)!.timeline;
  const content = segmentKey(originals, savedTimeline, { start: 0, end: 30 }, format, undefined, true);
  const asset = stored.media[0]!;
  const oldFingerprint = "local-v1-" + sha256(stableStringify([
    "full-program-v1", project.id, format.quality, content, [[asset.id, asset.path, undefined, undefined, undefined]],
    savedTimeline.tracks, [[asset.width, asset.height, asset.fps, asset.hasAlpha, asset.previewClock, asset.originalPlaybackType]], saved.version, [],
  ])) + `-mix${DELIVERY_AUDIO_REVISION}`;
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => { writeFileSync(file, "fresh"); });
  const input = { ...section(), version: saved.version, kind: "full" as const, quality: "delivery" as const, range: null };
  const owner = crypto.randomUUID();
  const save = { ticket: 38, name: "Saved.mp4" };
  const render = ctx.renders.request(input, owner, save);
  await settle();
  expect(render.previewContentKey).not.toBe(oldFingerprint);
  const done = ctx.repos.renders.get(render.id)!;
  expect(ctx.renders.exports()).toMatchObject([{ id: render.id, state: "done", export: { owner, ...save } }]);
  ctx.repos.renders.put({ ...done, ...(state === "queued" && { state: "queued", path: null }), previewContentKey: oldFingerprint });
  if (state === "done with changed sources") {
    ctx.paths.ensureProject(project.id);
    writeFileSync(join(ctx.paths.media(project.id), "camera.mp4"), "new footage");
  }
  if (state !== "queued") {
    const file = join(ctx.paths.renders(project.id), done.path!);
    writeFileSync(file, "previous render");
    expect(ctx.renders.exports()).toMatchObject([{ ...done, previewContentKey: oldFingerprint }]);
    expect(readFileSync(file, "utf8")).toBe("previous render");
    expect(encode).toHaveBeenCalledTimes(1);
    const requested = ctx.renders.request(input);
    expect(requested.id).not.toBe(done.id);
    await settle();
    expect(ctx.repos.renders.get(requested.id)).toMatchObject({ state: "done" });
    expect(readFileSync(file, "utf8")).toBe("previous render");
    expect(encode).toHaveBeenCalledTimes(2);
    return;
  }
  ctx.renders.recover();
  await settle();
  expect(ctx.repos.renders.get(render.id)).toMatchObject({ state: "done", previewContentKey: render.previewContentKey, export: { owner, ...save } });
  expect(encode).toHaveBeenCalledTimes(2);
});

it.each([
  ["full", "preview", "-mix4", "unstamped"], ["full", "preview", "-mix4", "stamped"], ["full", "preview", "-mix4", "pts1"], ["full", "preview", "-mix4", "changed"],
  ["segment", "preview", "-mix4", "stamped"],
  ["full", "delivery", "-mix4", "stamped"], ["export", "preview", "-mix4", "stamped"], ["export", "delivery", "-mix4", "mix3"],
] as const)("retires an old %s %s assembly before %s and validates its %s recovery", async (kind, quality, revision, legacy) => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => { writeFileSync(file, "full"); });
  const input = { ...section(), kind, quality, range: kind === "segment" ? { start: 0, end: 8 } : null };
  const initial = ctx.renders.request(input);
  await settle();
  const current = ctx.repos.renders.get(initial.id)!;
  expect(current).toMatchObject({ state: "done", key: expect.stringContaining(revision), previewContentKey: expect.stringContaining(revision) });
  const oldRevision = legacy === "mix3" ? "-mix3" : legacy === "pts1" ? "-pts1" : "";
  const old = ctx.repos.renders.put({ ...current, key: current.key.replace(revision, oldRevision),
    previewContentKey: legacy === "unstamped" ? undefined : current.previewContentKey!.replace(revision, oldRevision) });
  expect(ctx.renders.isCurrent(old, ctx.repos.projects.get(project.id)!)).toBe(false);
  expect(ctx.renders.coveringPreview(project, version, { start: 0, end: 2 }, 0)).toBeUndefined();
  const replacement = ctx.renders.request(input);
  await settle();
  expect(replacement.id).not.toBe(old.id);
  expect(encode).toHaveBeenCalledTimes(2);

  // An interrupted job must validate and rekey even when another worker has since
  // finished the corrected assembly and can supply its bytes.
  ctx.repos.renders.put({ ...old, state: "queued", path: null });
  if (legacy === "changed") {
    ctx.paths.ensureProject(project.id);
    writeFileSync(join(ctx.paths.media(project.id), "camera.mp4"), "different source bytes");
  }
  ctx.renders.recover();
  await settle();
  const retried = ctx.repos.renders.get(old.id)!;
  if (legacy === "changed") {
    expect(retried).toMatchObject({ state: "failed", error: expect.stringContaining("source changed") });
  } else {
    expect(retried).toMatchObject({ state: "done", key: current.key, previewContentKey: current.previewContentKey,
      path: ctx.repos.renders.get(replacement.id)!.path });
  }
  expect(encode).toHaveBeenCalledTimes(2);
});

it("encodes exports and previews as the hardware setting says: software for none, hardware for auto or a named device", async () => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_project, _timeline, _cache, file) => {
    writeFileSync(file, "video");
  });
  const base = { ...section(), range: null };
  for (const input of [
    { ...base, kind: "export" as const, quality: "preview" as const, exportOptions: { height: 720 } },
    { ...base, kind: "full" as const },
  ]) {
    ctx.repos.settings.update({ render: { hwaccel: "auto" } });
    const hardware = ctx.renders.request(input);
    expect(hardware.hwaccel).toBe("auto");
    await settle();
    expect(encode.mock.lastCall?.[4].hwaccel).toBe("auto");
    // An editor who turned hardware acceleration off gets a software encode, exports included.
    ctx.repos.settings.update({ render: { hwaccel: "none" } });
    const software = ctx.renders.request(input);
    expect(software.hwaccel).toBe("none");
    expect(software.key).not.toBe(hardware.key);
    await settle();
    expect(encode.mock.lastCall?.[4].hwaccel).toBe("none");
  }
  ctx.repos.settings.update({ render: { hwaccel: "qsv" } });
  expect(ctx.renders.request({ ...base, kind: "export" }).hwaccel).toBe("qsv");
  await settle();
  expect(encode.mock.lastCall?.[4].hwaccel).toBe("qsv");
});

it.each([
  [{ encoder: "h264_videotoolbox", rendered: 1 }, "hardware encoder h264_videotoolbox"],
  [{ encoder: "libx264", rendered: 1 }, "software encoder libx264"],
  [{ encoder: "copy", rendered: 0 }, "copied original video"],
  [{ encoder: "h264_nvenc", rendered: 0 }, "assembled cached video"],
] as const)("logs how the completed export produced its picture", async (result, message) => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_project, _timeline, _cache, file) => {
    writeFileSync(file, "video");
    return result;
  });
  const render = ctx.renders.request({ ...section(), kind: "export" });
  await settle();
  expect(lines.filter(line => line.includes("export video:"))).toEqual([`[render] ${render.id} export video: ${message}`]);
});

it("adopts interrupted software exports with their original settings and verifies completed software files before reuse", async () => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_project, _timeline, _cache, file) => {
    writeFileSync(file, "export");
  });
  ctx.repos.settings.update({ render: { hwaccel: "none" } });
  const base = { ...section(), range: null, quality: "preview" as const };
  const preview = ctx.renders.request({ ...base, kind: "full" });
  await settle();
  // The editor has since turned hardware encoding on. An export interrupted under the old setting goes on with it.
  ctx.repos.settings.update({ render: { hwaccel: "auto" } });
  // An explicit preview-quality export previously wrapped the same local source fingerprint
  // as the software preview at the identical height, plus its own range and output options.
  const input = { ...base, kind: "export" as const, exportOptions: { height: preview.height! } };
  const legacyKey = ctx.renders.keyFor(project, input, { height: preview.height!, hwaccel: "none" });
  const sourceFingerprint = preview.previewContentKey!.replace(new RegExp(`-mix${DELIVERY_AUDIO_REVISION}$`), "");
  const legacyContent = "export-v1-" + sha256(stableStringify([sourceFingerprint, version, null, input.exportOptions])) + `-mix${DELIVERY_AUDIO_REVISION}`;
  const legacy = { ...preview, ...input, id: "rnd_saved", key: legacyKey, previewContentKey: legacyContent,
    state: "running" as const, queuePid: undefined, demandPid: undefined, progress: 0.4 };
  // This export was interrupted before the delivery mix and encoder policy both changed.
  const oldAssembly = `-mix${DELIVERY_AUDIO_REVISION}`;
  const interrupted = { ...legacy, key: legacy.key.replace(oldAssembly, "-mix3"),
    previewContentKey: legacy.previewContentKey.replace(oldAssembly, "-mix3") };
  ctx.repos.renders.put(interrupted);
  ctx.renders.recover();
  await settle();
  const resumed = ctx.repos.renders.get(legacy.id)!;
  expect(resumed).toMatchObject({ id: legacy.id, state: "done", key: ctx.renders.keyFor(project, input), hwaccel: "auto" });
  expect(encode.mock.lastCall?.[4].hwaccel).toBe("auto");
  expect(ctx.renders.request(input).id).toBe(legacy.id);
  expect(ctx.renders.request(input).previewContentKey).not.toBe(legacyContent);

  // A finished old export can satisfy the same request without consuming an encoder.
  const old = ctx.repos.renders.put({ ...legacy, state: "done", path: resumed.path, progress: 1 });
  expect(ctx.renders.isCurrent(old, ctx.repos.projects.get(project.id)!)).toBe(true);
  encode.mockClear();
  const reused = ctx.renders.request(input);
  expect(reused).toMatchObject({ state: "done", hwaccel: "auto", path: old.path, key: resumed.key, previewContentKey: resumed.previewContentKey });
  expect(encode).not.toHaveBeenCalled();

  // A changed source must not acquire a new matching fingerprint during migration.
  ctx.repos.renders.put({ ...interrupted, id: "rnd_changed" });
  mkdirSync(ctx.paths.media(project.id), { recursive: true });
  writeFileSync(join(ctx.paths.media(project.id), "camera.mp4"), "new camera bytes");
  ctx.renders.recover();
  await settle();
  expect(ctx.repos.renders.get("rnd_changed")).toMatchObject({ state: "failed", error: expect.stringContaining("A source changed") });
  expect(encode).not.toHaveBeenCalled();
  const fresh = ctx.renders.request(input);
  expect(fresh.state).toBe("queued");
  await settle();
  expect(encode).toHaveBeenCalledTimes(1);
});

it("keeps a finished render finished when updating the edits that waited on it throws", async () => {
  const { ctx } = workspace;
  // The listener that moves an edit from rendering to ready reads the edits first. A locked database throws there.
  vi.spyOn(ctx.repos.changes, "select").mockImplementation(() => { throw new Error("database is locked"); });
  const render = ctx.renders.request(section());
  await settle();
  const saved = ctx.repos.renders.get(render.id)!;
  expect(saved).toMatchObject({ state: "done", progress: 1 });
  expect(saved.error).toBeUndefined();
  expect(existsSync(join(ctx.paths.renders(project.id), saved.path!))).toBe(true);
  expect(lines.filter(line => line.startsWith("[review]"))).toEqual([
    `[review] couldn’t update the edits waiting on render ${render.id} (done): database is locked`,
  ]);
  expect(lines.filter(line => line.includes("failed"))).toEqual([]);
});

/** A viewer's render that the engine working on it never finished: the engine was killed. `pid`: the process id it ran under. */
function abandoned(id: string, pid = spawnSync(process.execPath, ["-e", ""]).pid) {
  const { ctx } = workspace;
  const template = ctx.renders.request({ ...section(), kind: "playback", quality: "preview" }, "viewer");
  return ctx.repos.renders.put({ ...template, id, state: "running", progress: 0.4, queuePid: pid, demandPid: pid });
}

/**
 * A process that is running now: another engine at work, or whatever program was since given a killed engine's process id.
 * `began`: when it began, as an engine running in it notes.
 */
async function running(): Promise<{ pid: number; began: number }> {
  const program = spawn(process.execPath, ["-e", "console.log(performance.timeOrigin); setTimeout(() => {}, 60_000)"], { stdio: ["ignore", "pipe", "ignore"] });
  programs.push(program);
  const [began] = await once(program.stdout!, "data");
  return { pid: program.pid!, began: Number(began) };
}

/** What an engine notes as it starts: when it began, beside its process id. */
const noteStart = (pid: number, began: number) =>
  workspace.ctx.db.prepare("INSERT OR REPLACE INTO engines (pid, started_at) VALUES (?, ?)").run(pid, began);

/** A round of recovery, the time it takes to learn when a process began, and the round after. */
async function recovered(id: string) {
  const { ctx } = workspace;
  ctx.renders.recover();
  await settle();
  ctx.renders.recover();
  return ctx.repos.renders.get(id)?.state;
}

it("removes the file a killed engine was writing when it gives up that viewer's render", async () => {
  const { ctx } = workspace;
  const render = abandoned("rnd_killed");
  await settle();
  const file = join(ctx.paths.renders(project.id), `${render.id}.mp4`);
  writeFileSync(file, "half an encode");
  ctx.renders.recover();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("cancelled");
  expect(existsSync(file)).toBe(false);
});

it("still gives up a killed engine's render when its unfinished file can't be removed", async () => {
  const { ctx } = workspace;
  const render = abandoned("rnd_held");
  await settle();
  // Windows refuses to remove a file another program holds open. A folder in its place is refused everywhere.
  const file = join(ctx.paths.renders(project.id), `${render.id}.mp4`);
  mkdirSync(file);
  lines.length = 0;
  expect(() => ctx.renders.recover()).not.toThrow();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("cancelled");
  expect(lines.filter(line => line.includes("couldn’t remove"))).toEqual([
    expect.stringMatching(/^\[render\] rnd_held couldn’t remove the file its engine left unfinished: .+/),
  ]);
  // Given up for good: the next round has nothing to do, and says nothing.
  lines.length = 0;
  ctx.renders.recover();
  expect(lines).toEqual([]);
});

// Only macOS is asked when a process began: elsewhere a render stays with whatever process has its engine's id.
it.runIf(process.platform === "darwin")("gives up a killed engine's render once another program has its process id", async () => {
  // The computer has been up for days: the engine's note is from since it started, so only `ps` can say it is gone.
  const up = vi.spyOn(os, "uptime").mockReturnValue(30 * 86_400);
  onTestFinished(() => up.mockRestore());
  const { ctx } = workspace;
  const { pid: program } = await running();
  // The engine noted that it began an hour before the program that has its id now did.
  noteStart(program, Date.now() - 3_600_000);
  const render = abandoned("rnd_reused", program), stopped = abandoned("rnd_stopped", program);
  await settle();
  const file = join(ctx.paths.renders(project.id), `${render.id}.mp4`);
  writeFileSync(file, "half an encode");
  // The first rounds only ask when that process began, once between them. Until that is known the renders are still its engine's.
  ctx.renders.recover();
  ctx.renders.recover();
  expect(ctx.pending.size).toBe(1);
  expect(ctx.renders.cancel(stopped.id)?.state).toBe("running");
  expect(ctx.repos.renders.get(render.id)?.state).toBe("running");
  await settle();
  expect(lines.filter(line => line.startsWith("[engine]"))).toEqual([expect.stringMatching(new RegExp(
    `^\\[engine\\] process ${program} began at least \\d+m( \\d+s)? after the engine that noted that id, so it is another program: what that engine left claimed is free$`))]);
  // Stopping one works now, and the next round gives up the other.
  expect(ctx.renders.cancel(stopped.id)?.state).toBe("cancelled");
  ctx.renders.recover();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("cancelled");
  expect(existsSync(file)).toBe(false);
});

it("leaves a render with the engine that claimed it for as long as that engine runs", async () => {
  const engine = await running();
  const render = abandoned("rnd_claimed", engine.pid);
  await settle();
  // An engine from before engines noted when they began: there is nothing to hold its process id against.
  expect(await recovered(render.id)).toBe("running");
  // What an engine notes of itself and what is then learned of its process agree.
  noteStart(engine.pid, engine.began);
  expect(await recovered(render.id)).toBe("running");
});

it("logs each warning the renderer gives with the render it belongs to", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file, opts) => {
    opts.onWarning?.("clip clp_1: media med_gone not in project; skipped");
    opts.onWarning?.("no font file found for \"Inter\";\n relying on fontconfig");
    writeFileSync(file, "section");
  });
  const render = ctx.renders.request(section());
  await settle();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("done");
  expect(lines.filter(line => line.includes("warning"))).toEqual([
    `[render] ${render.id} warning: clip clp_1: media med_gone not in project; skipped`,
    `[render] ${render.id} warning: no font file found for "Inter"; relying on fontconfig`,
  ]);
});

it("tells the editor what to install when the FFmpeg in use can't draw the captions, before any encoding", async () => {
  const { ctx } = workspace;
  const said = missingTextFilterMessage("draw the video’s captions");
  vi.spyOn(ctx.render, "renderRange").mockRejectedValue(new MissingFilterError("drawtext", said));
  const render = ctx.renders.request(section());
  await settle();
  const failed = ctx.repos.renders.get(render.id);
  expect(failed).toMatchObject({ state: "failed", error: said });
  expect(failed).not.toHaveProperty("errorDetail");
  expect(said).toMatch(/^This copy of FFmpeg can’t draw text, so Scarlet can’t draw the video’s captions\. .+ Then restart Scarlet and try again\.$/);
});

it.each([
  ["a source file is gone", (media: string) => [`${media}/camera.mp4: No such file or directory\nError opening input file ${media}/camera.mp4.`, false],
    "Scarlet can’t find “Camera” in this project’s files: export the logs from Settings → Advanced to report it."],
  ["a source file can't be decoded", (media: string) => [`[mov,mp4,m4a,3gp,3g2,mj2 @ 0x7f8] moov atom not found\n${media}/camera.mp4: Invalid data found when processing input`, true],
    "Scarlet can’t read “Camera” in this project’s files: export the logs from Settings → Advanced to report it."],
  // The source is gone too, but ffmpeg named another file: that one is what it couldn't open.
  ["ffmpeg can't open a file that isn't a source", (media: string) => [`${media}/../luts/grade.cube: No such file or directory`, false], "Scarlet couldn’t render this part of the video: try once more, or export the logs from Settings → Advanced to report it."],
  ["the disk is full", () => ["[out#0/mp4 @ 0x600] Error writing trailer: No space left on device", true],
    "There isn’t enough free disk space to render this: free some space, then try again."],
  ["ffmpeg fails for its own reasons", () => ["[fc#0 @ 0x600] Error reinitializing filters!\nFailed to inject frame into filter network: Invalid argument", true], "Scarlet couldn’t render this part of the video: try once more, or export the logs from Settings → Advanced to report it."],
  // The renderer checks before it draws captions; this is for anything that asks for drawtext without that check.
  ["ffmpeg was built without drawtext", () => ["[AVFilterGraph @ 0x600] No such filter: 'drawtext'\nError : Filter not found", true], missingTextFilterMessage("draw the video’s captions")],
] as const)("says why a render failed in plain words when %s, and keeps ffmpeg's own output in the log and for an agent", async (_why, wrote, said) => {
  const { ctx } = workspace;
  const media = ctx.paths.media(project.id);
  const [stderr, present] = wrote(media);
  if (present) { mkdirSync(media, { recursive: true }); writeFileSync(join(media, "camera.mp4"), "footage"); }
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async () => {
    throw new FfmpegError(`ffmpeg exited with code 1:\n${stderr}\n--- filter graph ---\n[0:v]trim=start=1:end=3[v0]`, "ffmpeg", [], 1, stderr);
  });
  const render = ctx.renders.request(section());
  await settle();
  const raw = `ffmpeg exited with code 1:\n${stderr}\n--- filter graph ---\n[0:v]trim=start=1:end=3[v0]`;
  expect(ctx.repos.renders.get(render.id)).toMatchObject({ state: "failed", error: said, errorDetail: raw });
  expect(lines.filter(line => line.startsWith(`[render] ${render.id} failed:`))).toEqual([`[render] ${render.id} failed: ${raw}`]);
});
