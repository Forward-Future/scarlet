// Measure the time to publish the first cache map before starting any encoders.
// Usage after building @scarlet/render: node packages/render/bench/cache-plan.mjs [shots] [assets] [passes]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { renderFullCached } from "../dist/index.js";

const shots = Number(process.argv[2] ?? 900), assets = Number(process.argv[3] ?? 4000), passes = Number(process.argv[4] ?? 7);
for (const n of [shots, assets, passes]) assert(Number.isSafeInteger(n) && n > 0);
const project = createProject("Cache plan"), timeline = emptyTimeline(project.id);
project.media = Array.from({ length: assets }, (_, i) => ({ id: "m" + i, path: i + ".mp4", name: "Source " + i,
  kind: "video", width: 1920, height: 1080, duration: 60, fps: 30, hasAlpha: false, hasAudio: true,
  previewClock: { frameRate: "30/1", startPts: 0, videoStart: 0 }, hash: "fixture-" + i }));
timeline.tracks[0].clips = Array.from({ length: shots }, (_, i) => makeMediaClip("m" + (i % assets), 0, 4, i * 4));
const dir = await mkdtemp(join(tmpdir(), "scarlet-cache-plan-"));
try {
  const samplesMs = [];
  for (let i = -1; i < passes; i++) {
    const controller = new AbortController(), start = performance.now();
    const reason = new Error("Cache map measured");
    await assert.rejects(renderFullCached(project, timeline, dir, join(dir, "unused.mp4"), {
      mediaRoot: dir, hwaccel: "none", height: 540, pictureSource: async () => undefined, signal: controller.signal,
      onCachedRanges() {
        if (i >= 0) samplesMs.push(Math.round((performance.now() - start) * 100) / 100);
        controller.abort(reason);
      },
    }), error => error === reason);
  }
  const sorted = samplesMs.toSorted((a, b) => a - b);
  console.log(JSON.stringify({ shots, assets, passes, medianMs: (sorted[passes >> 1] + sorted[(passes - 1) >> 1]) / 2, samplesMs }));
} finally { await rm(dir, { force: true, recursive: true }); }
