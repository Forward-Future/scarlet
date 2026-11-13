// Run after building the engine. Supply a 65–180 second CFR H.264/AAC excerpt.
// All source and cache writes use a disposable library. No desktop window is opened.
import assert from "node:assert/strict";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeProxy, probeMedia, probeToAssetFields, renderPlaybackSegment, resolveVideoEncoder } from "@scarlet/render";
import { createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import { createApp } from "../dist/app.js";
import { accessToken } from "../dist/auth.js";
import { previewIdentity, previewPictures, sourceCheckpointDir } from "../dist/services/previewPictures.js";

assert(process.argv[2], "Supply a local camera excerpt.");
const source = resolve(process.argv[2]), meta = await probeMedia(source);
assert(meta.duration >= 65 && meta.duration <= 180 && meta.videoCodec === "h264" &&
  meta.hasAudio && meta.height >= 720 && meta.previewClock?.startPts === 0 && meta.videoStart === 0);
const root = await mkdtemp(join(tmpdir(), "scarlet-checkpoint-bench-"));
const { ctx, app } = createApp({ dataDir: root, skillsSeedDir: root, env: {}, log() {} });
try {
  const project = ctx.repos.projects.insert(createProject("Bench", { fps: meta.fps }));
  ctx.paths.ensureProject(project.id);
  const mediaRoot = ctx.paths.media(project.id), src = join(mediaRoot, "camera.mp4");
  await copyFile(source, src, constants.COPYFILE_FICLONE);
  const asset = ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Camera", kind: "video", path: "camera.mp4",
    ...probeToAssetFields(meta), previewClock: meta.previewClock, originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"' }, "ready");
  project.media = [asset];
  const { local } = await previewIdentity(mediaRoot, asset);
  const height = 540, dir = sourceCheckpointDir(ctx.paths.proxies(project.id), local, "-540");
  const width = 2 * Math.round((meta.width * height / meta.height) / 2);
  const encoder = await resolveVideoEncoder("auto", undefined, { width, height });
  const first = join(dir, encoder + "-" + height, "0.mp4");
  const cancel = new AbortController(), start = performance.now();
  await assert.rejects(makeProxy(src, join(root, "full.mp4"), { hwaccel: "auto", height, checkpointDir: dir, signal: cancel.signal,
    onProgress() { if (existsSync(first)) cancel.abort(); } }));
  const firstCheckpointMs = Math.round(performance.now() - start);
  assert(existsSync(first) && !existsSync(join(root, "full.mp4")));
  const timeline = timelineFromKeepRanges(project.id, asset.id, [{ start: 5, end: 9 }]);
  const measures = [];
  const headers = { Authorization: "Bearer " + accessToken(ctx) };
  for (let pass = 0; pass < 4; pass++) {
    for (const visible of pass % 2 ? [true, false] : [false, true]) {
      if (!visible) await rename(dir, dir + ".hidden");
      try {
        const pictures = previewPictures(mediaRoot);
        assert.equal(!!await pictures(asset, 5, 9, 540), visible);
        const t0 = performance.now();
        for (const t of [1.5, 13.2, 8.3, 2.3, 10.6, 4.8]) {
          const at = t + (2 * pass + Number(visible)) / meta.fps;
          const r = await app.request("/api/media/camera/frame?w=160&preview=1&t=" + at, { headers });
          assert.equal(r.status, 200);
          assert((await r.arrayBuffer()).byteLength > 100);
        }
        const t1 = performance.now();
        await renderPlaybackSegment(project, timeline, { start: 0, end: 4 },
          join(root, "segments-" + pass + "-" + visible), join(root, "playback.mp4"),
          { mediaRoot, height, hwaccel: "auto", pictureSource: pictures });
        measures.push({ pass, visible, sixFrameMs: Math.round(t1 - t0), playbackMs: Math.round(performance.now() - t1) });
      } finally { if (!visible) await rename(dir + ".hidden", dir); }
    }
  }
  console.log(JSON.stringify({ sourceSeconds: meta.duration, firstCheckpointMs, measures }, null, 2));
} finally { await ctx.close(); await rm(root, { recursive: true, force: true }); }
