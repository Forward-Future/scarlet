// Run with a 30–60 s local 4K AVC excerpt, MODELS and SCARLET_BIN_DIR.
// Example: node apps/server/scripts/bench-preview-contention.mjs camera.mp4
// Alternates two encoders while the real first-cut detector keeps scanning.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProject, planPlaybackSegments, timelineFromKeepRanges } from "@scarlet/timeline";
import { makeProxy, probeMedia, probeToAssetFields, renderFullCached, renderPlaybackSegment } from "@scarlet/render";
import { createApp } from "../dist/app.js";
import { extractWav } from "../dist/render/ffmpeg.js";
import { dialogueDetector } from "../dist/services/dialogueDetections.js";

assert(process.argv[2] && process.env.MODELS && process.env.SCARLET_BIN_DIR, "Supply a recording and local model and binary directories.");
const source = resolve(process.argv[2]);
const meta = await probeMedia(source);
assert(meta.videoCodec === "h264" && meta.hasAudio && meta.duration >= 30 && meta.duration <= 60);
const passes = Number(process.env.SCARLET_BENCH_RUNS ?? 8);
assert(Number.isSafeInteger(passes) && passes > 0);
globalThis.fetch = async () => { throw new Error("This benchmark requires installed local models."); };
const directory = await mkdtemp(join(tmpdir(), "scarlet-preview-contention-"));
let ctx;
try {
  await cp(process.env.MODELS, join(directory, "models"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  ({ ctx } = createApp({ dataDir: directory, skillsSeedDir: directory, env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log() {} }));
  assert(ctx.whisperCli);
  const catalog = ctx.repos.projects.insert(createProject("Dialogue"));
  ctx.paths.ensureProject(catalog.id);
  const media = ctx.repos.projects.putMedia(catalog.id, {
    id: "speech", kind: "audio", hasAudio: true, name: "Excerpt", duration: 30, path: "input.wav",
  }, "ready");
  await extractWav(source, join(ctx.paths.media(catalog.id), media.path), { start: 0, duration: 30, audioStream: 0 });

  const project = createProject("Playback", { fps: meta.fps });
  project.media.push({ id: "camera", path: source, name: "Camera", kind: "video", hash: "fixture",
    ...probeToAssetFields(meta), originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"' });
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 1, end: 5 }, { start: 6, end: 10 }, { start: 12, end: 16 }]);
  const ranges = planPlaybackSegments(project, timeline);
  const proxyFile = join(directory, "proxy.mp4");
  await makeProxy(source, proxyFile, { hwaccel: "auto", height: 540 });
  const pictureSource = async () => ({ file: proxyFile, start: 0 });
  const detector = dialogueDetector(ctx);
  const warm = await detector.detect(catalog.id, media, 0, 30);
  assert.equal(warm.speakerIssue, undefined);

  // Set SCARLET_BENCH_BASELINE=videotoolbox on Mac to compare fully hardware
  // AVC decode/encode against the shipped auto policy. The default compares
  // auto with software encoding to expose contention with the CPU detector.
  const modes = [process.env.SCARLET_BENCH_BASELINE ?? "none", "auto"];
  for (let i = 0; i < passes; i++) {
    for (const hwaccel of i % 2 === 0 ? modes : modes.toReversed()) {
      const options = { hwaccel, mediaRoot: directory, quality: "preview", height: 540, concurrency: 2 };
      const run = await mkdtemp(join(directory, "render-"));
      const scans = [], playback = [];
      let stop = false;
      const scanning = (async () => {
        while (!stop) {
          ctx.db.prepare("DELETE FROM dialogue_scan_pages WHERE media_id = ?").run(media.id);
          const start = performance.now();
          const page = await detector.detect(catalog.id, media, 0, 30);
          assert.equal(page.speakerIssue, undefined);
          scans.push(Math.round(performance.now() - start));
        }
      })();
      // Observe concurrent inference errors immediately, then propagate them below.
      scanning.catch(() => {});
      try {
        for (let j = 0; j < 4; j++) {
          const start = performance.now();
          await renderPlaybackSegment(project, timeline, ranges[j % ranges.length], join(run, "segment-" + j),
            join(run, j + ".mp4"), { ...options, pictureSource: j % 2 ? pictureSource : undefined });
          playback.push(Math.round(performance.now() - start));
        }
        const start = performance.now();
        await renderFullCached(project, timeline, join(run, "cache"), join(run, "full.mp4"), { ...options, pictureSource });
        const fullMs = Math.round(performance.now() - start);
        stop = true;
        await scanning;
        console.log(JSON.stringify({ pass: i, hwaccel, originalPlaybackMs: [playback[0], playback[2]],
          proxyPlaybackMs: [playback[1], playback[3]], fullMs, scansMs: scans }));
      } finally {
        stop = true;
        await scanning;
        await rm(run, { recursive: true, force: true });
      }
    }
  }
} finally {
  await ctx?.close();
  await rm(directory, { recursive: true, force: true });
}
