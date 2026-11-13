// Run after pnpm --filter @scarlet/render... build. An optional argument selects
// a 16–60 s H.264 source with audio. All outputs live in a temporary directory.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  checkFfmpeg, extractFrame, extractWaveformFull, makeProxy, probeMedia, probeToAssetFields,
  renderFullCached, renderPlaybackSegment, renderTimelineFrame, resolveFfmpeg, resolveVideoEncoder, runCapture, waveformFromCache,
} from "../dist/index.js";
import { createProject, planPlaybackSegments, timelineFromKeepRanges } from "@scarlet/timeline";

const directory = await mkdtemp(join(tmpdir(), "scarlet-editor-media-"));
const timings = new Map();
const repetitions = Number(process.env.SCARLET_BENCH_RUNS ?? 3);
const hwaccel = process.env.SCARLET_BENCH_HWACCEL ?? "auto";
assert(["auto", "none", "videotoolbox", "nvenc", "qsv", "amf"].includes(hwaccel));
assert(Number.isSafeInteger(repetitions) && repetitions > 0);
async function measure(label, operation) {
  const before = performance.now();
  const result = await operation();
  const samples = timings.get(label) ?? [];
  samples.push(performance.now() - before);
  timings.set(label, samples);
  return result;
}
try {
  const generated = !process.argv[2];
  const source = generated ? join(directory, "source.mp4") : resolve(process.argv[2]);
  if (generated) {
    const encoder = await resolveVideoEncoder("auto", undefined, { width: 3840, height: 2160 });
    await runCapture(resolveFfmpeg(), ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=30:d=16",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16",
      "-c:v", encoder, ...(encoder === "libx264" ? ["-preset", "ultrafast"] : []), "-b:v", "18M", "-g", "90",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", source]);
  }
  const metadata = await probeMedia(source);
  assert(metadata.duration >= 16 && metadata.duration <= 60 && metadata.videoCodec === "h264" && metadata.hasAudio,
    "Choose a 16–60 second H.264 source with audio");
  const project = createProject("Media benchmark", { width: 1920, height: 1080, fps: metadata.fps });
  project.media.push({ id: "source", path: source, name: basename(source), kind: "video", hash: "fixture",
    ...probeToAssetFields(metadata), previewClock: metadata.previewClock, originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"' });
  const fps = metadata.fps;
  const keeps = [[1, 5], [6, 10], [12, 16]].map(([a, b]) => ({ start: Math.round(a * fps) / fps, end: Math.floor(b * fps) / fps }));
  const timeline = timelineFromKeepRanges(project.id, "source", keeps);
  const [first] = planPlaybackSegments(project, timeline);
  const options = { mediaRoot: directory, hwaccel, height: 540, concurrency: 2 };
  for (let i = 0; i < repetitions; i++) {
    const root = join(directory, String(i));
    await mkdir(root);
    const proxy = join(root, "proxy.mp4");
    await measure("probe", () => probeMedia(source));
    await measure("source chunk (8 s, 480p)", () => makeProxy(source, join(root, "chunk.mp4"),
      { height: 480, hwaccel, range: { start: 6, end: 14 } }));
    await measure("source proxy (full, 540p)", () => makeProxy(source, proxy,
      { height: 540, hwaccel, checkpointDir: join(root, "source-parts") }));
    for (const [label, file] of [["original", source], ["proxy", proxy]]) {
      await measure("six source thumbnails (" + label + ")", async () => {
        for (const second of [1.5, 13.2, 8.3, 2.3, 10.6, 4.8]) await extractFrame(file, second, { width: 160 });
      });
    }
    const waveform = await measure("waveform (full)", () => extractWaveformFull(source, metadata.duration));
    await measure("waveform cache (128 range reads)", () => {
      for (let j = 0; j < 128; j++) waveformFromCache(waveform, j / 16, j / 16 + 4, 512);
    });
    for (const [label, opts] of [["original", options], ["proxy", { ...options, pictureSource: async () => ({ file: proxy, start: 0 }) }]]) {
      await measure("six edited thumbnails (" + label + ")", async () => {
        for (const second of [1.5, 9.2, 8.3, 2.3, 10.6, 4.8]) {
          const frame = Math.floor(second * fps);
          await renderTimelineFrame(project, timeline, { start: frame / fps, end: (frame + 1) / fps },
            directory, undefined, 160, { pictureSource: opts.pictureSource });
        }
      });
      const cache = join(root, "playback-" + label);
      await measure("first playback (" + label + ")", () => renderPlaybackSegment(project, timeline, first, cache, join(root, label + ".mp4"), opts));
      await measure("playback (cached segment, " + label + ")", () => renderPlaybackSegment(project, timeline, first, cache, join(root, label + "-warm.mp4"), opts));
    }
    for (const quality of ["preview", "delivery"]) {
      const cache = join(root, quality);
      const opts = { ...options, quality };
      const cold = await measure(quality + " (cold)", () => renderFullCached(project, timeline, cache, join(root, quality + ".mp4"), opts));
      const warm = await measure(quality + " (reuse all segments)", () => renderFullCached(project, timeline, cache, join(root, quality + "-warm.mp4"), opts));
      assert(cold.rendered > 0 && warm.rendered === 0);
    }
    process.stderr.write("Completed media benchmark pass " + (i + 1) + "\n");
  }
  console.log(JSON.stringify({ source: generated ? "synthetic" : "local", width: metadata.width, height: metadata.height,
    duration: metadata.duration, hwaccel, cpu: cpus()[0]?.model, ffmpeg: (await checkFfmpeg()).ffmpeg.version,
    medianMs: Object.fromEntries([...timings].map(([key, values]) => {
      values.sort((a, b) => a - b);
      const mid = values.length >>> 1;
      return [key, Number(((values[mid] + values[(values.length - 1) >>> 1]) / 2).toFixed(2))];
    })), samplesMs: Object.fromEntries(timings) }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
