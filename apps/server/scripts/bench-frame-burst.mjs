// How long an agent's burst of source frames takes, and how long the editor's own frame waits behind one.
// Run after building the workspace, on a long recording, in a temporary library:
//
//   SCARLET_BIN_DIR=<ffmpeg and ffprobe> node apps/server/scripts/bench-frame-burst.mjs <recording> [rounds]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../dist/app.js";
import { accessToken } from "../dist/auth.js";
import { ingestMedia } from "../dist/services/ingest.js";

const [recording, rounds = "3"] = process.argv.slice(2);
assert(recording && process.env.SCARLET_BIN_DIR, "Set SCARLET_BIN_DIR and name a recording.");
const scratch = await mkdtemp(join(tmpdir(), "scarlet-bench-frames-"));
const { app, ctx } = createApp({ dataDir: join(scratch, "library"), skillsSeedDir: join(scratch, "library"), env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log: () => {} });
try {
  const project = ctx.repos.projects.insert({ ...createProject("Frame burst"), mediaPaused: true });
  ctx.paths.ensureProject(project.id);
  const media = await ingestMedia(ctx, project, { type: "path", path: recording }, { transcription: "refuse" });
  const headers = { authorization: `Bearer ${accessToken(ctx)}` };
  let asked = 0;
  // Every frame is a new one: a time no earlier request asked for.
  const frame = async (priority) => {
    const t = (media.duration * ((asked++ * 0.6180339887) % 1) * 0.98).toFixed(3);
    const started = performance.now();
    const res = await app.request(`/api/projects/${project.id}/media/${media.id}/frame?t=${t}&w=768${priority ? "&priority=interactive" : ""}`, { headers });
    const body = await res.arrayBuffer();
    assert(res.ok, Buffer.from(body).toString("utf8").slice(0, 400));
    return performance.now() - started;
  };
  await frame(false);
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const bursts = [], editors = [];
  for (let round = 0; round < Number(rounds); round++) {
    const started = performance.now();
    const burst = Promise.all(Array.from({ length: 24 }, () => frame(false)));
    await delay(150);
    editors.push(await frame(true));
    await burst;
    bursts.push(performance.now() - started);
  }
  console.log(JSON.stringify({ burstOf24Ms: Math.round(median(bursts)), editorFrameDuringBurstMs: Math.round(median(editors)), all: { bursts: bursts.map(Math.round), editors: editors.map(Math.round) } }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await ctx.close?.().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
  process.exit();
}
