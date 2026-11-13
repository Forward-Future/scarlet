// Create one disposable native-playback fixture. The source DB is opened read-only.
// node apps/server/scripts/prepare-playback-fixture.mjs --library <source-data-dir> [--project <id>]
//   [--version head|dense|<version>] [--cache none|one|all] [--segments] [--out <new-directory>]
// --include-trashed permits an explicitly selected saved project to be cloned in active state.
// A fixture's data directory can itself be used as --library for identical repeated trials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, promisify } from "node:util";
import { clipEnd, planPlaybackSegments, ProjectSettings, Timeline, timelineDuration } from "@scarlet/timeline";
import { probeMedia } from "@scarlet/render";
import { openDb } from "../dist/db.js";
import { fullProxyVariants, previewIdentity } from "../dist/services/previewPictures.js";

const { values: v } = parseArgs({ options: {
  library: { type: "string" }, out: { type: "string" }, project: { type: "string" },
  version: { type: "string", default: "head" }, cache: { type: "string", default: "one" },
  segments: { type: "boolean" }, copy: { type: "boolean" }, "include-trashed": { type: "boolean" },
} });
assert(v.library && ["none", "one", "all"].includes(v.cache), "Specify --library and a valid cache policy.");
const library = await realpath(v.library);
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith(".." + sep) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)); };
if (v.out) {
  const parent = await realpath(resolve(v.out, ".."));
  assert(!inside(library, join(parent, basename(v.out))), "The destination must be outside the source library.");
}
const source = new DatabaseSync(join(library, "scarlet.db"), { readOnly: true });
source.exec("PRAGMA query_only=ON; BEGIN");
const root = v.out ? resolve(v.out) : await mkdtemp(join(tmpdir(), "scarlet-playback-fixture-"));
if (v.out) await mkdir(root, { mode: 0o700 }); // Only create a new directory.
const data = join(root, "data");
let target;
const safeName = name => { assert(name && basename(name) === name && name !== "." && name !== ".."); return name; };
const runFile = promisify(execFile);
const clone = async (from, to) => {
  assert((await lstat(from)).isFile() && inside(library, await realpath(from)), "Fixture inputs must be regular local library files.");
  if (process.platform === "darwin" && !v.copy) {
    assert((await stat(from)).dev === (await stat(resolve(to, ".."))).dev, "Use an APFS destination on the same volume or opt in to --copy.");
    await runFile("/bin/cp", ["-c", "-n", from, to]);
    return;
  }
  const flags = constants.COPYFILE_EXCL | (v.copy ? 0 : constants.COPYFILE_FICLONE_FORCE);
  await copyFile(from, to, flags);
};
try {
  const row = v.project ? source.prepare("SELECT * FROM projects WHERE id=?").get(v.project)
    : source.prepare("SELECT * FROM projects WHERE deleted_at IS NULL AND archived=0 ORDER BY updated_at DESC LIMIT 1").get();
  assert(row && (!row.deleted_at || (v.project && v["include-trashed"])), "Select an active project or explicitly permit a saved trash copy.");
  const id = safeName(row.id);
  const versions = source.prepare("SELECT * FROM timeline_versions WHERE project_id=?").all(id);
  const visible = timeline => timeline.tracks.filter(t => t.kind === "video" && !t.hidden).flatMap(t => t.clips.filter(c => c.enabled !== false));
  const selected = v.version === "dense" ? versions.reduce((best, current) =>
    visible(JSON.parse(current.json)).length > visible(JSON.parse(best.json)).length ? current : best)
    : versions.find(r => r.version === (v.version === "head" ? row.head : v.version));
  assert(selected, "The requested version is absent.");
  const timeline = Timeline.parse(JSON.parse(selected.json)), settings = ProjectSettings.parse(JSON.parse(row.settings));
  const timescale = settings.fps, duration = timelineDuration(timeline);
  assert(duration > 0);
  const sourceProject = join(library, "projects", id), copyProject = join(data, "projects", id);
  for (const name of ["media", "waveforms", "renders", "segments", "proxies", "notes"]) await mkdir(join(copyProject, name), { recursive: true });
  target = openDb(join(data, "scarlet.db"));
  const insert = (table, obj) => {
    const keys = Object.keys(obj);
    target.prepare(`INSERT INTO ${table} (${keys.map(k => '"' + k + '"').join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => obj[k]));
  };
  insert("projects", { ...row, name: "Native playback fixture", head: selected.version, deleted_at: null, archived: 0, media_paused: 1 });
  for (const version of versions) insert("timeline_versions", version);
  // Preserve actual edit/transcript history without importing pending jobs, hosts or credentials.
  for (const table of ["transcripts", "notes", "changes"]) {
    for (const record of source.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(id)) insert(table, record);
  }
  for (const task of source.prepare("SELECT * FROM tasks WHERE project_id=? AND state IN ('done','failed','cancelled')").all(id)) {
    insert("tasks", { ...task, worker_pid: null, worker_seen_at: null });
  }
  const render = JSON.parse(source.prepare("SELECT json_extract(json,'$.render') AS options FROM settings WHERE id=1").get()?.options ?? "{}");
  target.prepare("INSERT OR REPLACE INTO settings (id,json) VALUES (1,?)").run(JSON.stringify({ render, transcription: { provider: "none" }, noteCleanup: { enabled: false } }));
  const visibleVideos = new Set(visible(timeline).filter(clip => clip.kind === "media" && (clip.opacity ?? 1) > 0 && clipEnd(clip) > clip.timelineIn).map(clip => clip.mediaId));
  const isUhd = (width, height) => Math.max(width, height) >= 3840 && Math.min(width, height) >= 2160;
  const assets = [], proxyReady = [];
  let confirmedUhd;
  for (const record of source.prepare("SELECT * FROM media WHERE project_id=? ORDER BY id").all(id)) {
    assert(record.status === "ready", "Only ready recording assets can be snapshotted.");
    const asset = JSON.parse(record.json), name = safeName(asset.path);
    const original = join(sourceProject, "media", name), local = join(copyProject, "media", name);
    const before = await stat(original), identity = await previewIdentity(join(sourceProject, "media"), asset);
    await clone(original, local);
    const after = await stat(original), own = await stat(local);
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && own.size === before.size);
    // Only carry forward a content identity the source library actually verified.
    const copied = { ...asset, fingerprintStamp: identity.shared ? { size: own.size, mtimeMs: own.mtimeMs, ctimeMs: own.ctimeMs } : undefined };
    insert("media", { ...record, ingest_pid: null, json: JSON.stringify(copied) });
    if (!confirmedUhd && asset.kind === "video" && visibleVideos.has(asset.id) && isUhd(asset.width, asset.height)) {
      const actual = await probeMedia(local);
      if (actual.hasVideo && !actual.isStillImage && isUhd(actual.width, actual.height)) confirmedUhd = { id: asset.id, width: actual.width, height: actual.height };
    }
    const newIdentity = await previewIdentity(join(copyProject, "media"), copied);
    const keys = identity.shared ? [identity.shared, identity.local] : [identity.local];
    const ready = fullProxyVariants(join(sourceProject, "proxies"), keys, asset.height);
    let copiedHeight;
    if (v.cache === "all" || (v.cache === "one" && !proxyReady.length)) {
      for (const candidate of ready) {
        if (candidate.height < Math.min(render.previewHeight ?? 540, asset.height ?? 720)) continue;
        if (!(await stat(candidate.file).catch(() => null))?.size) continue;
        const name = `cached-${newIdentity.shared ?? newIdentity.local}${candidate.suffix}.mp4`;
        await clone(candidate.file, join(copyProject, "proxies", name));
        copiedHeight = candidate.height;
        proxyReady.push(asset.id);
        break;
      }
    }
    assets.push({ id: asset.id, kind: asset.kind, width: asset.width, height: asset.height, fps: asset.fps, duration: asset.duration, bytes: own.size, copiedProxyHeight: copiedHeight ?? null });
  }
  assert(confirmedUhd, "The selected edit must use a visible 3840×2160-or-larger video recording (landscape or portrait).");
  for (const f of await readdir(join(sourceProject, "waveforms"), { withFileTypes: true }).catch(() => [])) {
    if (f.isFile() && /\.(?:waveform|json)$/.test(f.name)) await clone(join(sourceProject, "waveforms", f.name), join(copyProject, "waveforms", f.name));
  }
  let segments = 0, segmentBytes = 0;
  if (v.segments) {
    const src = join(sourceProject, "segments"), dest = join(copyProject, "segments");
    const files = (await readdir(src, { withFileTypes: true }).catch(() => []))
      .filter(f => f.isFile() && /^[a-f0-9]{64}\.mp4$/.test(f.name));
    if (files.length && process.platform === "darwin" && !v.copy) {
      assert(inside(library, await realpath(src)) && (await stat(src)).dev === (await stat(dest)).dev);
      for (let i = 0; i < files.length; i += 100) {
        const group = files.slice(i, i + 100);
        await runFile("/bin/cp", ["-c", "-n", ...group.map(f => join(src, f.name)), dest]);
      }
    } else {
      for (const f of files) await clone(join(src, f.name), join(dest, f.name));
    }
    segments = files.length;
    for (const f of files) segmentBytes += (await stat(join(dest, f.name))).size;
  }
  target.pragma("wal_checkpoint(TRUNCATE)");
  target.close(); target = undefined;
  source.exec("COMMIT");
  const maxFrame = Math.max(0, Math.ceil(duration * timescale - 1e-6) - 1);
  // Permute 64 equal-duration strata to exercise long seeks in both directions reproducibly.
  const scrubTimes = Array.from({ length: 64 }, (_, i) => Math.round((((i * 37) % 64) + .5) / 64 * maxFrame) / timescale);
  const cuts = [...new Set(visible(timeline).flatMap(clip => [Math.round(clip.timelineIn * timescale), Math.round(clipEnd(clip) * timescale)]))]
    .filter(frame => frame > 0 && frame < maxFrame).sort((a, b) => a - b);
  const cutTimes = cuts.map(frame => frame / timescale);
  const manifest = { projectId: id, version: selected.version, originalHead: row.head, selection: v.version, data, settings, render,
    duration, videoClips: visible(timeline).length, tracks: timeline.tracks.map(t => ({ kind: t.kind, clips: t.clips.length, hidden: t.hidden, muted: t.muted })),
    assets, confirmedUhd, cache: { policy: v.cache, proxyReady, target: assets.filter(a => a.kind === "video" && !proxyReady.includes(a.id)).sort((a, b) => b.bytes - a.bytes)[0]?.id ?? null, segments, segmentBytes, finishedRenders: 0, pausedInitially: true },
    scrubTimes, cutTimes, playbackRanges: planPlaybackSegments({ settings }, timeline) };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ root, data, projectId: id, version: selected.version, videoClips: manifest.videoClips, duration, cutCount: cuts.length, sources: assets.length, ...manifest.cache }));
} catch (err) {
  target?.close();
  await rm(root, { force: true, recursive: true });
  throw err;
} finally { source.close(); }
