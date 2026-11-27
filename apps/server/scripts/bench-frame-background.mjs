// How long the editor's own frames take while background work nobody waits on runs: here the source proxy Scarlet
// prepares for a long recording after import. Run after building the workspace, in a temporary library:
//
//   SCARLET_BIN_DIR=<ffmpeg and ffprobe> node apps/server/scripts/bench-frame-background.mjs <recording> [seconds]
//
// Measures editor frames with nothing else running, then starts the proxy and, once its encoder runs, asks for editor
// frames one after another, 300 ms apart as a slow scrub, for `seconds`. Every frame is a new time.
// SCARLET_BENCH_HASHES=<file> writes each frame's SHA-256 by its time, to compare two builds' pictures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../dist/app.js";
import { accessToken } from "../dist/auth.js";
import { ingestMedia } from "../dist/services/ingest.js";
import { editorFirst } from "../dist/services/editorFirst.js";
import { prepareSourceProxies } from "../dist/services/sourcePreviews.js";

const [recording, seconds = "30"] = process.argv.slice(2);
assert(recording && process.env.SCARLET_BIN_DIR, "Set SCARLET_BIN_DIR and name a recording.");
const scratch = await mkdtemp(join(tmpdir(), "scarlet-bench-background-"));
const { app, ctx } = createApp({ dataDir: join(scratch, "library"), skillsSeedDir: join(scratch, "library"), env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log: () => {} });
let project;
try {
  project = ctx.repos.projects.insert({ ...createProject("Background"), mediaPaused: true });
  ctx.paths.ensureProject(project.id);
  const media = await ingestMedia(ctx, project, { type: "path", path: recording }, { transcription: "refuse" });
  const headers = { authorization: `Bearer ${accessToken(ctx)}` };
  const hashes = {};
  let asked = 0;
  const frame = async () => {
    const t = (media.duration * ((0.5 + asked++ * 0.6180339887) % 1) * 0.98).toFixed(3);
    const started = performance.now();
    const res = await app.request(`/api/projects/${project.id}/media/${media.id}/frame?t=${t}&w=768&priority=interactive`, { headers });
    const body = Buffer.from(await res.arrayBuffer());
    assert(res.ok, body.toString("utf8").slice(0, 400));
    hashes[t] = createHash("sha256").update(body).digest("hex");
    return performance.now() - started;
  };
  const idle = [];
  for (let i = 0; i < 5; i++) { idle.push(await frame()); await delay(300); }
  // Nothing asked for a picture for a while, as when the editor comes back to the window.
  await delay(11_000);
  ctx.repos.projects.update(project.id, { mediaPaused: false });
  prepareSourceProxies(ctx, [media.id], true);
  const until = performance.now() + 20_000;
  while (!editorFirst.snapshot().length) { assert(performance.now() < until, "The proxy never started."); await delay(100); }
  await delay(2_000);
  const busy = [];
  const end = performance.now() + Number(seconds) * 1000;
  while (performance.now() < end) { busy.push(await frame()); await delay(300); }
  const lowered = editorFirst.snapshot().filter(p => p.lowered).length;
  if (process.env.SCARLET_BENCH_HASHES) await writeFile(process.env.SCARLET_BENCH_HASHES, JSON.stringify(hashes));
  const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
  const summary = values => ({ p50: Math.round(quantile(values, 0.5)), p95: Math.round(quantile(values, 0.95)), n: values.length });
  console.log(JSON.stringify({ editorDuringBackground: summary(busy), editorIdle: summary(idle), backgroundLoweredAtEnd: lowered,
    all: { busy: busy.map(Math.round), idle: idle.map(Math.round) } }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // Pausing stops the proxy's encoder before the library goes.
  if (project) ctx.repos.projects.update(project.id, { mediaPaused: true });
  if (project) { ctx.stopMedia(project.id); ctx.renders.stopProject(project.id, true); }
  await ctx.close?.().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
  process.exit();
}
