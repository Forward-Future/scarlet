import { mkdtemp, mkdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hashFile, renderPlaybackSegment, runCapture } from "@scarlet/render";
import { createProject, sha256, timelineFromKeepRanges, type MediaClip } from "@scarlet/timeline";
import { scarletRenderAdapter } from "./scarletRender.js";

// The real renderer, with a playback section that one test can answer for.
vi.mock("@scarlet/render", async original => {
  const real = await original<typeof import("@scarlet/render")>();
  return { ...real, renderPlaybackSegment: vi.fn(real.renderPlaybackSegment) };
});

it("uses verified proxy picture for playback and full preview while keeping original audio and delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "scarlet-preview-pictures-"));
  try {
    const mediaRoot = join(root, "media"), proxyDir = join(root, "proxies");
    await Promise.all([mkdir(mediaRoot), mkdir(proxyDir)]);
    const source = join(mediaRoot, "source.mp4");
    const input = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"];
    await runCapture("ffmpeg", [...input, "color=red:size=160x90:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=700:duration=1", "-c:v", "libx264", "-c:a", "aac", source]);
    const hash = await hashFile(source);
    await runCapture("ffmpeg", [...input, "color=blue:size=160x90:rate=30:duration=1",
      "-c:v", "libx264", join(proxyDir, "cached-" + sha256(hash) + ".mp4")]);
    const { size, ctimeMs, mtimeMs } = await stat(source);
    const project = createProject("Pictures", { width: 160, height: 90, fps: 30 });
    project.media.push({ id: "camera", kind: "video", name: "Camera", path: "source.mp4", hash, hasAudio: true,
      hasAlpha: false, duration: 1, fps: 30, width: 160, height: 90, fingerprintStamp: { size, ctimeMs, mtimeMs } });
    const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 1 }]);
    for (const mode of ["playback", "preview", "delivery", "stale"] as const) {
      const file = join(root, mode + ".mp4");
      const cache = join(root, mode === "playback" ? "player-segments" : "export-segments");
      const opts = { mediaRoot, quality: mode === "delivery" ? mode : "preview" as const, height: 90, hwaccel: "none" as const };
      if (mode === "stale") await utimes(source, new Date(), new Date(mtimeMs - 5_000));
      if (mode === "playback") {
        await scarletRenderAdapter.renderPlaybackSegment(project, timeline, { start: 0, end: 1 }, cache, file, opts);
      } else {
        await scarletRenderAdapter.renderFullCached(project, timeline, cache, file, opts);
      }
      const pixel = (await runCapture("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale=1:1",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])).stdout;
      expect(pixel[mode === "stale" || mode === "delivery" ? 0 : 2]).toBeGreaterThan(200);
      const pcm = (await runCapture("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "s16le", "-"])).stdout;
      expect(pcm.some(byte => byte !== 0)).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("passes on what the renderer worked around, for a section and for a whole edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "scarlet-render-warnings-"));
  try {
    const mediaRoot = join(root, "media");
    await mkdir(mediaRoot);
    await runCapture("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=red:size=160x90:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=700:duration=1", "-c:v", "libx264", "-c:a", "aac", join(mediaRoot, "source.mp4")]);
    const project = createProject("Warnings", { width: 160, height: 90, fps: 30 });
    project.media.push({ id: "camera", kind: "video", name: "Camera", path: "source.mp4", hasAudio: true, hasAlpha: false, duration: 1, fps: 30, width: 160, height: 90 });
    const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 1 }]);
    const opts = { mediaRoot, quality: "delivery" as const, height: 90, hwaccel: "none" as const };
    // An edit whose sources are all there has nothing to say.
    const quiet: string[] = [];
    await scarletRenderAdapter.renderRange(project, timeline, { start: 0, end: 1 }, join(root, "whole.mp4"), { ...opts, onWarning: w => quiet.push(w) });
    expect(quiet).toEqual([]);

    // A clip of footage the project no longer has is left out, and the render says so instead of failing.
    const clip = timeline.tracks[0]!.clips[0] as MediaClip;
    timeline.tracks[0]!.clips.push({ ...clip, id: "clp_gone", mediaId: "med_gone", timelineIn: 1 });
    const section: string[] = [], whole: string[] = [];
    await scarletRenderAdapter.renderRange(project, timeline, { start: 0, end: 2 }, join(root, "section.mp4"), { ...opts, onWarning: w => section.push(w) });
    expect(section).toEqual(["clip clp_gone: media med_gone not in project; skipped"]);
    await scarletRenderAdapter.renderFullCached(project, timeline, join(root, "segments"), join(root, "full.mp4"), { ...opts, onWarning: w => whole.push(w) });
    expect(whole).toEqual(["clip clp_gone: media med_gone not in project; skipped"]);
    // The file is still written, with the picture that was there.
    const pixel = (await runCapture("ffmpeg", ["-v", "error", "-i", join(root, "full.mp4"), "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])).stdout;
    expect(pixel[0]).toBeGreaterThan(200);
    // With nobody listening the render is the same.
    await scarletRenderAdapter.renderRange(project, timeline, { start: 0, end: 2 }, join(root, "unheard.mp4"), opts);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("passes on what the renderer worked around in a playback section, and takes one that reports nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "scarlet-playback-warnings-"));
  try {
    const project = createProject("Playback warnings", { width: 160, height: 90, fps: 30 });
    const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 1 }]);
    const heard: string[] = [];
    const render = () => scarletRenderAdapter.renderPlaybackSegment(project, timeline, { start: 0, end: 1 }, join(root, "segments"), join(root, "section.mp4"),
      { mediaRoot: root, quality: "preview", height: 90, onWarning: w => heard.push(w) });
    vi.mocked(renderPlaybackSegment).mockResolvedValueOnce({ warnings: ["clip clp_gone: media med_gone not in project; skipped", "no hardware encoder"] } as never);
    await render();
    expect(heard).toEqual(["clip clp_gone: media med_gone not in project; skipped", "no hardware encoder"]);
    vi.mocked(renderPlaybackSegment).mockResolvedValueOnce(undefined as never);
    await render();
    expect(heard).toHaveLength(2);
    vi.mocked(renderPlaybackSegment).mockResolvedValueOnce({ warnings: ["unheard"] } as never);
    await scarletRenderAdapter.renderPlaybackSegment(project, timeline, { start: 0, end: 1 }, join(root, "segments"), join(root, "section.mp4"), { mediaRoot: root, quality: "preview", height: 90 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
