// Run after building the workspace. All inference runs locally in a temporary library.
// SCARLET_BIN_DIR must contain whisper-cli, ffmpeg and ffprobe. MODELS points to an existing
// Scarlet model cache. Arguments are a source file, start in seconds, excerpt duration and runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { probeMedia, contactSheet, encodeWaveformCache } from "@scarlet/render";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../dist/app.js";
import { extractWav } from "../dist/render/ffmpeg.js";
import { dialogueDetector } from "../dist/services/dialogueDetections.js";
import { getWaveform, ingestMedia, readWaveformCache, transcribeMedia } from "../dist/services/ingest.js";
import { createTask } from "../dist/services/tasks.js";

const source = process.argv[2] ?? fileURLToPath(new URL("../../web/public/sample.mp4", import.meta.url));
const from = Number(process.argv[3] ?? 0), duration = Number(process.argv[4] ?? 120), runs = Number(process.argv[5] ?? 3);
assert(process.env.MODELS && process.env.SCARLET_BIN_DIR, "Set MODELS and SCARLET_BIN_DIR.");
assert(Number.isFinite(from) && from >= 0 && Number.isFinite(duration) && duration > 0 && Number.isSafeInteger(runs) && runs > 0);
globalThis.fetch = async () => { throw new Error("Offline benchmark requires the four verified local models."); };
const probe = await probeMedia(source), seconds = Math.min(duration, probe.duration - from);
assert(seconds > 0 && probe.hasAudio, "Choose a range with program audio.");
const scratch = await mkdtemp(join(tmpdir(), "scarlet-bench-dialogue-"));
const times = {};
async function time(label, fn) {
  const start = performance.now(), result = await fn();
  (times[label] ??= []).push(performance.now() - start);
  return result;
}
async function drain(ctx) { while (ctx.pending.size) await Promise.all([...ctx.pending]); }
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value, (key, v) => key === "id" ? undefined : v)).digest("hex");
}
async function fixture(n, fixtureWav) {
  const dir = join(scratch, String(n));
  await mkdir(join(dir, "models"), { recursive: true });
  for (const name of ["ggml-large-v3-turbo-q5_0.bin", "uhm-1b7dc1ef.onnx", "speaker-segmentation-220ad67c.onnx", "speaker-eres2net-1a331345.onnx"]) {
    await copyFile(join(process.env.MODELS, name), join(dir, "models", name), constants.COPYFILE_FICLONE);
  }
  const { ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log() {} });
  assert(ctx.whisperCli, "Missing local Whisper binary.");
  try {
    const project = ctx.repos.projects.insert(createProject("Dialogue benchmark"));
    ctx.paths.ensureProject(project.id);
    if (process.env.SCARLET_BENCH_IMPORT === "1") {
      // Opt in because import stages a full project-owned copy of the supplied file.
      const imported = await time("sourceImportPlayable", () => ingestMedia(ctx, project, { type: "path", path: source },
        { transcription: { signal: ctx.repos.settings.transcriptionSignal } }));
      await time("sourceFingerprintAfterImport", () => drain(ctx));
      const ready = ctx.repos.projects.getMedia(imported.id);
      assert.equal(ready.status, "ready");
      assert(ready.hash);
    }
    const add = async id => {
      const media = ctx.repos.projects.putMedia(project.id, { id, kind: "audio", name: "Excerpt", path: id + ".wav", duration: seconds, hasAudio: true }, "ready");
      await copyFile(fixtureWav, join(ctx.paths.media(project.id), media.path));
      return media;
    };
    const media = await add("first-cut");
    const detector = dialogueDetector(ctx), pageEnd = Math.min(seconds, 60);
    const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First dialogue cut", state: "running",
      createdBy: { type: "scarlet", name: "Scarlet" } });
    let first;
    const heartbeat = monitorEventLoopDelay({ resolution: 10 });
    heartbeat.enable();
    try {
      await delay(15);
      await time("backgroundScanAllPagesCold", async () => {
        await detector.start(project.id, media, 0, seconds, task.id);
        first = await time("firstPageCold", () => detector.detect(project.id, media, 0, pageEnd));
        await drain(ctx);
      });
      await delay(15);
      (times.maxEngineTimerIntervalDuringColdScan ??= []).push(heartbeat.max / 1e6);
    } finally { heartbeat.disable(); }
    assert.equal(first.speakerIssue, undefined);
    const fingerprint = digest(first);
    const warm = await time("firstPageRestored", () => detector.detect(project.id, media, 0, pageEnd));
    assert.equal(digest(warm), fingerprint);
    ctx.db.prepare("DELETE FROM dialogue_scan_pages WHERE media_id = ?").run(media.id);

    const pages = await time("backgroundScanAllPagesModelsWarm", async () => {
      await detector.start(project.id, media, 0, seconds, task.id);
      await drain(ctx);
      return detector.checkpoints(project.id, media, 0, seconds);
    });
    assert.equal(pages.length, 1 + Math.ceil(Math.max(0, seconds - 60) / 58));
    const complete = await time("allPagesRestored", () => Promise.all(pages.map(p => detector.detect(project.id, media, p.start, p.end))));
    assert.equal(digest(complete[0]), fingerprint);
    const wave = { ...media, projectId: project.id };
    await time("wholeWaveformCreate", () => getWaveform(ctx, wave));
    await time("wholeWaveformFirstDiskRead", () => getWaveform(ctx, wave));
    await time("wholeWaveformMemoryRead", () => getWaveform(ctx, wave));
    // Audio sync alternates between 10,000-point pages of the two recordings.
    const peaks = new Float32Array(180_000).fill(0.25);
    const bytes = encodeWaveformCache({ duration: 3600, pointsPerSecond: 50, peaks, rms: peaks });
    for (const id of ["reference", "secondary"]) await writeFile(join(ctx.paths.waveforms(project.id), id + ".waveform"), bytes);
    await time("36AlternatingHourWaveformReads", async () => {
      for (let page = 0; page < 18; page++) {
        for (const id of ["reference", "secondary"]) assert((await readWaveformCache(ctx, project.id, id)).peaks.length === peaks.length);
      }
    });

    const ordinary = await add("standard-transcript");
    const transcript = await time("standardTranscriptWordsReady", () => transcribeMedia(ctx, project.id, ordinary));
    assert(transcript);
    await time("standardTranscriptSpeakerLabelsAfterWords", () => drain(ctx));
    const labeled = ctx.repos.transcripts.get(ctx.repos.projects.getMedia(ordinary.id).transcriptId);
    assert(labeled?.speakerAnalysis, "Local speaker analysis failed.");
    if (n === 0) console.log(JSON.stringify({ seconds, pages: pages.length, firstPageWords: first.segments.flatMap(s => s.words).length,
      firstPageSpeakerTurns: first.speakerTurns.length, firstPageEvidenceHash: fingerprint, standardTranscriptWords: transcript.segments.flatMap(s => s.words).length }));
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
}
try {
  const wav = join(scratch, "excerpt.wav");
  await extractWav(source, wav, { start: from, duration: seconds, audioStream: 0 });
  for (let i = 0; i < runs; i++) await fixture(i, wav);
  if (probe.hasVideo && seconds >= 4) {
    const range = { start: from, end: from + 4 };
    for (const mode of ["uniform", "scene", "activity"]) {
      const opts = { origin: 0, fps: probe.fps || 30, count: 6, mode, sourceWidth: probe.width };
      for (let i = 0; i < runs; i++) {
        const sheet = await time("sourceSheet_" + mode, () => contactSheet(source, range, opts));
        assert(sheet.timestamps.length && sheet.jpeg.length);
      }
    }
  }
  for (const [label, samples] of Object.entries(times)) {
    samples.sort((a, b) => a - b);
    const median = (samples[samples.length >>> 1] + samples[(samples.length - 1) >>> 1]) / 2;
    console.log(JSON.stringify({ label, medianMs: +median.toFixed(2), samplesMs: samples.map(n => +n.toFixed(2)) }));
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
