// How long an agent's burst of source frames takes, and how long the editor's own frames wait behind one.
// Run after building the workspace, on a long recording, in a temporary library:
//
//   SCARLET_BIN_DIR=<ffmpeg and ffprobe> node apps/server/scripts/bench-frame-burst.mjs <recording> [rounds] [burst]
//
// Each round first asks for one editor frame with nothing else running (the idle reference), then starts a burst of
// agent frames all at once. 150 ms in, the editor asks for a frame, and keeps asking for one after another, as a
// scrub does, until the burst is done. Every frame is a new time, so nothing comes from a cache.
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

const [recording, rounds = "3", burstSize = "24"] = process.argv.slice(2);
assert(recording && process.env.SCARLET_BIN_DIR, "Set SCARLET_BIN_DIR and name a recording.");
const scratch = await mkdtemp(join(tmpdir(), "scarlet-bench-frames-"));
const { app, ctx } = createApp({ dataDir: join(scratch, "library"), skillsSeedDir: join(scratch, "library"), env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log: () => {} });
try {
  const project = ctx.repos.projects.insert({ ...createProject("Frame burst"), mediaPaused: true });
  ctx.paths.ensureProject(project.id);
  const media = await ingestMedia(ctx, project, { type: "path", path: recording }, { transcription: "refuse" });
  const headers = { authorization: `Bearer ${accessToken(ctx)}` };
  const hashes = {};
  // Agent and editor times come from two sequences that never meet, so a build that asks for more editor frames in
  // the same time still asks for the same agent frames.
  const counters = { agent: 0, editor: 0 };
  const frame = async (who) => {
    const n = counters[who]++;
    const offset = who === "agent" ? 0 : 0.5;
    const t = (media.duration * ((offset + n * 0.6180339887) % 1) * 0.98).toFixed(3);
    const started = performance.now();
    const res = await app.request(`/api/projects/${project.id}/media/${media.id}/frame?t=${t}&w=768${who === "editor" ? "&priority=interactive" : ""}`, { headers });
    const body = Buffer.from(await res.arrayBuffer());
    assert(res.ok, body.toString("utf8").slice(0, 400));
    hashes[t] = createHash("sha256").update(body).digest("hex");
    return performance.now() - started;
  };
  await frame("agent");
  const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
  const bursts = [], editors = [], idle = [];
  for (let round = 0; round < Number(rounds); round++) {
    idle.push(await frame("editor"));
    await delay(100);
    const started = performance.now();
    let done = false;
    const burst = Promise.all(Array.from({ length: Number(burstSize) }, () => frame("agent"))).finally(() => { done = true; });
    await delay(150);
    while (!done) editors.push(await frame("editor"));
    await burst;
    bursts.push(performance.now() - started);
  }
  if (process.env.SCARLET_BENCH_HASHES) await writeFile(process.env.SCARLET_BENCH_HASHES, JSON.stringify(hashes));
  const summary = values => ({ p50: Math.round(quantile(values, 0.5)), p95: Math.round(quantile(values, 0.95)), n: values.length });
  console.log(JSON.stringify({
    burst: summary(bursts), editorDuringBurst: summary(editors), editorIdle: summary(idle),
    all: { bursts: bursts.map(Math.round), editors: editors.map(Math.round), idle: idle.map(Math.round) },
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await ctx.close?.().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
  process.exit();
}
