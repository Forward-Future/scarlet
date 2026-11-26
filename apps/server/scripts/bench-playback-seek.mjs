// A jump in the editor's player, timed in the engine alone: the exact paused still at the release point and the
// playback fragment the player needs to start playing there, asked for together as the player does.
// Headless: no window opens. Every seek lands in a section and a source keyframe interval no earlier seek touched,
// so each is cold, as after a long jump.
//
//   node apps/server/scripts/prepare-playback-fixture.mjs --library <data> --project <id> --cache none --out <fixture>
//   SCARLET_BIN_DIR=<ffmpeg and ffprobe> node apps/server/scripts/bench-playback-seek.mjs <fixture> [--seeks 12] \
//     [--mode both|still|play] [--keep <dir>]
//
// Each run works in a fresh APFS clone of the fixture's library, which it deletes afterwards. --keep writes each
// still and fragment there so two builds' outputs can be compared (decoded frame and sample hashes).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createApp } from "../dist/app.js";
import { accessToken } from "../dist/auth.js";

const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
  seeks: { type: "string", default: "12" }, mode: { type: "string", default: "both" }, keep: { type: "string" },
} });
const fixture = resolve(positionals[0] ?? "");
assert(positionals[0] && ["both", "still", "play"].includes(v.mode), "Name a fixture made by prepare-playback-fixture.mjs.");
const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
const seeks = Number(v.seeks);
assert(Number.isSafeInteger(seeks) && seeks > 0);
const fps = manifest.settings.fps, ranges = manifest.playbackRanges;
// The open editor has run FFmpeg and probed its encoder long before a jump, so one untimed jump to the last section
// warms the engine first.
const warm = { index: ranges.length - 1 };
// Spread across the edit in a fixed shuffled order, one per stratum, never in a section next to an earlier one.
const picks = [];
for (let i = 0; i < seeks; i++) {
  const stratum = (i * 7) % seeks;
  let index = Math.floor((stratum + 0.5) / seeks * ranges.length);
  while ([warm, ...picks].some(p => Math.abs(p.index - index) < 2) && index < ranges.length - 1) index++;
  const range = ranges[index];
  // Two fifths into the section: never on its first frame, which a previous section's preroll could have decoded.
  const frame = Math.floor((range.start + (range.end - range.start) * 0.4) * fps);
  picks.push({ index, range, frame });
}

const root = await mkdtemp("/tmp/scarlet-bench-seek-");
await promisify(execFile)("/bin/cp", ["-c", "-R", join(fixture, "data"), join(root, "data")]);
await chmod(join(root, "data"), 0o700); // A library is private; the engine refuses one others can read.
const { app, ctx } = createApp({ dataDir: join(root, "data"), skillsSeedDir: join(root, "data"), env: { SCARLET_BIN_DIR: process.env.SCARLET_BIN_DIR }, log: () => {} });
const headers = { authorization: `Bearer ${accessToken(ctx)}` };
const project = `/api/projects/${encodeURIComponent(manifest.projectId)}`;
async function timed(path, init) {
  const started = performance.now();
  const response = await app.request(path, { ...init, headers: { ...headers, ...init?.headers } });
  const body = Buffer.from(await response.arrayBuffer());
  assert(response.ok, `${path} returned ${response.status}: ${body.toString("utf8").slice(0, 300)}`);
  return { ms: Math.round(performance.now() - started), body };
}
const samples = [];
const jump = async pick => {
  const still = v.mode !== "play" && timed(`${project}/versions/${encodeURIComponent(manifest.version)}/frame?view=monitor&frame=${pick.frame}`);
  const play = v.mode !== "still" && timed(`${project}/renders?wait=1`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "playback", quality: "preview", version: manifest.version, range: pick.range }) });
  return Promise.all([still || undefined, play || undefined]);
};
try {
  if (v.keep) await mkdir(v.keep, { recursive: true });
  const last = ranges[warm.index];
  await jump({ range: last, frame: Math.floor((last.start + (last.end - last.start) * 0.4) * fps) });
  for (const [k, pick] of picks.entries()) {
    const [s, p] = await jump(pick);
    const hash = buffer => buffer && createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    samples.push({ frame: pick.frame, section: pick.index, stillMs: s?.ms, playMs: p?.ms, still: hash(s?.body), fragmentBytes: p?.body.length });
    if (v.keep) {
      if (s) await writeFile(join(v.keep, `${k}-still.jpg`), s.body);
      if (p) await writeFile(join(v.keep, `${k}-fragment.mp4`), p.body);
    }
  }
  const stat = key => {
    const values = samples.map(s => s[key]).filter(x => x !== undefined).sort((a, b) => a - b);
    if (!values.length) return undefined;
    return { median: values[Math.floor((values.length - 1) / 2)], p95: values[Math.ceil(values.length * 0.95) - 1], max: values.at(-1), n: values.length };
  };
  console.log(JSON.stringify({ mode: v.mode, still: stat("stillMs"), play: stat("playMs"), samples }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await ctx.close?.().catch(() => {});
  await rm(root, { recursive: true, force: true });
  process.exit();
}
