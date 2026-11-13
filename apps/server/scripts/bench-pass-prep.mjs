// How long a dialogue pass waits on the engine: from importing recordings and asking at once, to the transcript's
// words, its word alignment, the first scan page and every scan page. No agent runs and nothing leaves this machine.
// Run after building the workspace, on real recordings with dialogue, in a temporary library:
//
//   MODELS=<a Scarlet model cache> SCARLET_BIN_DIR=<whisper-cli, ffmpeg and ffprobe> \
//     node apps/server/scripts/bench-pass-prep.mjs <recording>... [--out result.json] [--stagger seconds]
//
// --stagger asks for each recording's pages that many seconds after the one before, as a pass does: it reads one
// recording first and turns to the next minutes later.
// --out keeps the transcripts and scan pages, to compare two builds' results as well as their times. Other work on
// the machine moves these numbers a lot (the first page came at 25 s or 50 s for the same build), so compare builds
// by running them one after the other, more than once.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../dist/app.js";
import { accessToken } from "../dist/auth.js";
import { ingestMedia } from "../dist/services/ingest.js";
import { createTask } from "../dist/services/tasks.js";
import { importTranscriptionPolicy } from "../dist/transcribe/index.js";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt < 0 ? undefined : args.splice(outAt, 2)[1];
const staggerAt = args.indexOf("--stagger");
const stagger = staggerAt < 0 ? 0 : Number(args.splice(staggerAt, 2)[1]);
assert(process.env.MODELS && process.env.SCARLET_BIN_DIR && args.length, "Set MODELS and SCARLET_BIN_DIR, and name at least one recording.");
globalThis.fetch = async () => { throw new Error("This benchmark runs offline, on the models in MODELS."); };

const scratch = await mkdtemp(join(tmpdir(), "scarlet-bench-pass-"));
const library = join(scratch, "library");
await mkdir(join(library, "models"), { recursive: true });
for (const name of await readdir(process.env.MODELS)) await copyFile(join(process.env.MODELS, name), join(library, "models", name), constants.COPYFILE_FICLONE);
const started = performance.now();
const seconds = () => +((performance.now() - started) / 1000).toFixed(1);
const log = [];
const { app, ctx } = createApp({ dataDir: library, skillsSeedDir: library, env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log: line => log.push(`${seconds()}s ${line}`) });
const marks = {};
const mark = name => { if (!(name in marks)) { marks[name] = seconds(); console.log(`${String(marks[name]).padStart(7)}s  ${name}`); } };
try {
  assert(ctx.whisperCli, "SCARLET_BIN_DIR has no whisper-cli.");
  const project = ctx.repos.projects.insert(createProject("Pass preparation"));
  ctx.paths.ensureProject(project.id);
  const media = [];
  for (const path of args) media.push(await ingestMedia(ctx, project, { type: "path", path }, { transcription: await importTranscriptionPolicy(ctx) }));
  const label = Object.fromEntries(media.map((m, i) => [m.id, `recording ${i + 1}`]));
  mark("imported");
  // The request, the way the app sends it: at once. An edit with no live worker is taken for interrupted after 30 s.
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "/dialogue-pass", state: "running",
    createdBy: { type: "scarlet", name: "Scarlet" } });
  const alive = () => ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = ? WHERE id = ?").run(process.pid, new Date().toISOString(), task.id);
  alive();
  const beat = setInterval(alive, 5000);
  const asking = (async () => {
    for (const [i, m] of media.entries()) {
      if (i && stagger) await delay(stagger * 1000);
      // The route a pass's dialogue_scan calls: it starts the scan and, where it is missing, the transcript.
      const res = await app.request(`/api/projects/${project.id}/dialogue-scan`, { method: "POST",
        headers: { authorization: `Bearer ${accessToken(ctx)}`, "content-type": "application/json" },
        body: JSON.stringify({ mediaId: m.id, from: 0, to: m.duration, taskId: task.id }) });
      assert(res.ok, await res.text());
      mark(`${label[m.id]}: pages asked for`);
    }
  })();
  const pagesOf = m => 1 + Math.ceil(Math.max(0, m.duration - 60) / 58);
  for (let last = 0;;) {
    let done = true;
    const lines = [];
    for (const m of media) {
      const t = ctx.db.prepare("SELECT json_extract(json, '$.aligning.through') AS through FROM transcripts WHERE media_id = ?").get(m.id);
      const pages = ctx.db.prepare("SELECT count(*) AS n FROM dialogue_scan_pages WHERE media_id = ?").get(m.id).n;
      const name = label[m.id], all = pagesOf(m);
      if (t) mark(`${name}: words`);
      if (t && t.through === null) mark(`${name}: words placed on the audio`);
      if (pages >= 1) mark(`${name}: first scan page`);
      if (pages >= Math.ceil(all / 2)) mark(`${name}: half the scan pages`);
      if (pages >= all) mark(`${name}: all ${all} scan pages`);
      if (!t || t.through !== null || pages < all) done = false;
      lines.push(`${name}: ${!t ? "no words" : t.through === null ? "aligned" : `aligned to ${Math.round(t.through)} s`}, ${pages}/${all} pages`);
    }
    if (done) { await asking; break; }
    assert(seconds() < 3600, "Still not ready after an hour.\n" + log.slice(-20).join("\n"));
    if (seconds() - last >= 60) { last = seconds(); console.log(`      …  ${lines.join(" | ")}`); }
    await delay(200);
  }
  clearInterval(beat);
  mark("everything a pass reads is ready");
  const notable = log.filter(line => /\[audio\]|\[speakers\]|\[whisper\]|\[dialogue|\[align\]/.test(line));
  if (notable.length) console.log(notable.join("\n"));
  if (out) {
    const transcripts = media.map((m, i) => ({ media: `rec${i + 1}`, segments: ctx.repos.transcripts.select("media_id = ?", [m.id])[0]?.segments }));
    const pages = ctx.db.prepare("SELECT media_id, start, end, result FROM dialogue_scan_pages ORDER BY media_id, start").all()
      .map(p => ({ media: `rec${media.findIndex(m => m.id === p.media_id) + 1}`, start: p.start, end: p.end, result: JSON.parse(p.result) }));
    await writeFile(out, JSON.stringify({ marks, transcripts, pages }));
  }
} finally {
  await ctx.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
process.exit(0);
