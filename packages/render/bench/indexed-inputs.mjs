// Compare cold seeks and finished renders on the same probed, local AVC/AAC movie.
// Run after building @scarlet/render, e.g. node packages/render/bench/indexed-inputs.mjs camera.mp4
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import { extractFrame, probeMedia, probeToAssetFields, renderFullCached, renderPlaybackSegment } from "../dist/index.js";

assert(process.argv[2], "Supply a local H.264/AAC recording at least 60 seconds long.");
const file = resolve(process.argv[2]);
const m = await probeMedia(file);
assert(m.duration >= 60 && m.previewClock && m.videoCodec === "h264" && m.audioCodec === "aac");
const dir = await mkdtemp(join(tmpdir(), "scarlet-seek-bench-"));
const passes = Number(process.env.SCARLET_BENCH_RUNS ?? 5);
assert(Number.isSafeInteger(passes) && passes > 0);
try {
  const project = createProject("Cold cuts", { fps: m.fps });
  project.media.push({ id: "cam", path: file, name: "Camera", kind: "video", hash: "fixture", ...probeToAssetFields(m),
    originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"', previewClock: m.previewClock });
  const nearby = process.argv.includes("--nearby");
  const starts = nearby ? [35, 66, 103, 168, 204, 253] : [1, 12, 22, 33, 45, 58].map(s => Math.round(s * m.fps));
  const spans = starts.map(frame => ({ start: frame / m.fps, end: (frame + (nearby ? 25 : 15)) / m.fps }));
  const timeline = timelineFromKeepRanges(project.id, "cam", spans);
  const rows = [];
  for (let i = 0; i < passes; i++) {
    let previousFrames;
    for (const indexedInputs of i % 2 ? [true, false] : [false, true]) {
      const frameMs = [], hash = createHash("sha256");
      for (const t of [0, .2, 6.3]) {
        const start = performance.now();
        hash.update(await extractFrame(file, t, { indexedMp4: indexedInputs, width: 160 }));
        frameMs.push(Math.round(performance.now() - start));
      }
      const digest = hash.digest("hex");
      if (previousFrames) assert.equal(digest, previousFrames);
      previousFrames = digest;
      const options = { mediaRoot: dir, hwaccel: "auto", indexedInputs, height: 540, concurrency: 2 };
      const cache = join(dir, "cache-" + i + "-" + indexedInputs);
      let start = performance.now();
      await renderPlaybackSegment(project, timeline, { start: 0, end: 90 / m.fps }, cache,
        join(dir, "playback-" + indexedInputs + ".mp4"), options);
      const playbackMs = Math.round(performance.now() - start);
      start = performance.now();
      const result = await renderFullCached(project, timeline, cache, join(dir, "export-" + indexedInputs + ".mp4"), { ...options, quality: "delivery" });
      assert(result.rendered > 0);
      rows.push({ i, indexedInputs, frameMs, playbackMs, deliveryMs: Math.round(performance.now() - start) });
    }
  }
  console.log(JSON.stringify({ sourceSeconds: m.duration, width: m.width, height: m.height, fps: m.fps, shots: spans.length, nearby, rows }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
