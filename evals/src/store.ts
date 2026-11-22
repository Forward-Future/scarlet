/**
 * The eval videos: the raw recordings and the video the editor published, kept apart from Scarlet's own library, so
 * an eval never starts from the editor's projects or edits and never changes them.
 *
 *   tsx evals/src/store.ts list
 *   tsx evals/src/store.ts library "<recording>" --out <dir> [--start assembly|empty] [--keep] [--models <dir>]
 *
 * One folder per recording under $SCARLET_EVAL_VIDEOS (default ~/Movies/Scarlet eval videos), named "<date> <title>":
 *   raw camera.*   raw screen.*   (a second file of a kind gets a number: "raw camera 2.mp4")
 *   published.*    the editor's finished video, when there is one
 *
 * `library` builds a new library for one recording: this checkout's engine (build it first) on <dir>/data, a project
 * of the raw files and, when there is one, a project of the published video; then it waits for their transcripts. The
 * raw project starts on the raw assembly the scorecard's cases use, or on an empty timeline as a project the editor
 * makes does (--start empty).
 * The library starts with the skills this checkout ships, never the editor's installed copies. Only the model files
 * (transcription, faces, screen text) are taken from the editor's Scarlet, as clones, so nothing is downloaded again.
 * With --keep the engine stays up and the commands to build a case and run passes against it are printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cli, isMain, main } from "./args.ts";
import { Engine } from "./engine.ts";
import { appSupportDir, REPO_ROOT } from "./paths.ts";

const USAGE = `Usage:
  store.ts list
  store.ts library "<recording>" --out <dir> [--start assembly|empty] [--keep] [--models <dir>]

The eval videos live in $SCARLET_EVAL_VIDEOS (default ~/Movies/Scarlet eval videos), one folder per recording:
"raw camera.*", "raw screen.*" and, when there is one, "published.*".

library builds a new Scarlet library for one recording in <dir> with this checkout's engine, imports the raw files
into one project and the published video into another, and waits for their transcripts. --keep leaves the engine up.
--start assembly (default) puts the raw files on the timeline as the scorecard's cases start: the camera with its
sound, over the screen as an inset when there is one. --start empty leaves the timeline empty, as a project the editor
makes starts, for trials of a whole first pass.`;

const VIDEO = /\.(mp4|mov|mkv|m4v)$/i;
const ROLE = /^(raw camera|raw screen|published)(?: (\d+))?$/i;

export type Role = "camera" | "screen" | "published";
export interface StoredFile { role: Role; path: string; name: string; bytes: number }
export interface Recording { name: string; dir: string; files: StoredFile[] }

/** SCARLET_EVAL_VIDEOS, else ~/Movies/Scarlet eval videos. */
export function videosDir(): string {
  return resolve(process.env.SCARLET_EVAL_VIDEOS ?? join(homedir(), "Movies", "Scarlet eval videos"));
}

/** Every recording in the store, oldest first. Files that aren't a raw recording or the published video are left out. */
export function recordings(root = videosDir()): Recording[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".")).map(d => {
    const dir = join(root, d.name);
    const files = readdirSync(dir).filter(f => VIDEO.test(f)).flatMap(f => {
      const role = ROLE.exec(basename(f, extname(f)))?.[1]?.toLowerCase();
      if (!role) return [];
      const path = join(dir, f);
      return [{ role: role === "raw camera" ? "camera" : role === "raw screen" ? "screen" : "published", path, name: f, bytes: statSync(path).size } as StoredFile];
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { name: d.name, dir, files };
  }).filter(r => r.files.length).sort((a, b) => a.name.localeCompare(b.name));
}

export function findRecording(name: string, root = videosDir()): Recording {
  const all = recordings(root);
  const exact = all.find(r => r.name === name);
  if (exact) return exact;
  const matches = all.filter(r => r.name.toLowerCase().includes(name.toLowerCase()));
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `"${name}" matches ${matches.map(r => `"${r.name}"`).join(", ")}: name one.`
    : `No recording "${name}" in ${root}. ${all.length ? "There are: " + all.map(r => `"${r.name}"`).join(", ") : "The store is empty."}`);
}

const within = (root: string, path: string) => { const rel = relative(resolve(root), resolve(path)); return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel)); };

/** The editor's own Scarlet and this checkout are never an eval library. */
export function checkLibraryDir(dir: string) {
  if (within(appSupportDir(), dir)) throw new Error(`${dir} is inside the editor's own Scarlet (${appSupportDir()}). Choose a folder of its own.`);
  if (within(REPO_ROOT, dir)) throw new Error(`${dir} is inside the repository. Eval libraries hold the editor's footage: choose a folder outside it.`);
}

function binDir(): string | undefined {
  if (process.env.SCARLET_BIN_DIR) return process.env.SCARLET_BIN_DIR;
  const app = "/Applications/Scarlet.app/Contents/MacOS";
  return process.platform === "darwin" && existsSync(join(app, "ffmpeg")) ? app : undefined;
}

/** Start this checkout's engine on a library folder and wait for its handshake. Its output goes to <library>/engine.log. */
export async function startEngine(data: string, opts: { detached?: boolean } = {}): Promise<{ engine: Engine; child: ChildProcess }> {
  const cliPath = join(REPO_ROOT, "apps", "server", "dist", "cli.js");
  if (!existsSync(cliPath)) throw new Error(`Build the engine first (${cliPath} is missing): pnpm -r build`);
  const bin = binDir();
  const log = join(data, "..", "engine.log");
  const fd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [cliPath, "serve", "--solo", "--port", "0", "--data", data], {
    env: { ...process.env, ...(bin && { SCARLET_BIN_DIR: bin, PATH: `${bin}:${process.env.PATH ?? ""}` }) },
    stdio: ["ignore", fd, fd], detached: !!opts.detached,
  });
  closeSync(fd);
  let exited: number | null | undefined;
  child.once("exit", code => { exited = code; });
  for (const started = Date.now(); ;) {
    const line = readFileSync(log, "utf8").split("\n").findLast(l => l.startsWith("SCARLET_READY "));
    if (line) {
      const ready = JSON.parse(line.slice("SCARLET_READY ".length)) as { url: string; token: string };
      return { engine: new Engine(ready.url, ready.token), child };
    }
    if (exited !== undefined || Date.now() - started > 120_000) {
      child.kill();
      throw new Error(`The engine ${exited !== undefined ? `exited (${exited})` : "didn't start in 2 minutes"}; see ${log}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

interface ImportedMedia { id: string; name: string; role: Role }

async function importInto(engine: Engine, name: string, files: StoredFile[]): Promise<{ projectId: string; media: ImportedMedia[] }> {
  const { project } = await engine.request<{ project: { id: string } }>("POST", "/projects", { name });
  const media: ImportedMedia[] = [];
  for (const f of files) {
    const { media: m } = await engine.request<{ media: { id: string } }>("POST", `/projects/${project.id}/media/import`, { path: f.path, name: f.name });
    media.push({ id: m.id, name: f.name, role: f.role });
    console.log(`  ${name}: ${f.name} → ${m.id}`);
  }
  return { projectId: project.id, media };
}

/**
 * Wait until every file is read and has its transcript, or its transcription ended without one. A large file is read
 * before its transcription is queued, so an empty queue alone doesn't mean it's done.
 */
async function waitForTranscripts(engine: Engine, projects: Array<{ projectId: string; media: ImportedMedia[] }>, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    let waiting = false;
    for (const p of projects) {
      const [listed, tasks] = await Promise.all([engine.media(p.projectId), engine.tasks(p.projectId)]);
      const transcribing = tasks.filter(t => t.kind === "transcribe" && ["queued", "claimed", "running"].includes(t.state));
      for (const m of p.media) {
        const status = listed.find(l => l.id === m.id)?.status;
        if (status === "failed") continue;
        if (status === "ingesting" || transcribing.length || !(await engine.transcript(m.id)) && !tasks.some(t => t.kind === "transcribe" && ["done", "failed", "cancelled", "canceled"].includes(t.state) && (t.context as { mediaId?: string } | undefined)?.mediaId === m.id)) waiting = true;
      }
    }
    if (!waiting) break;
    if (Date.now() - started > timeoutMs) throw new Error("Transcription is still running: start it again with --keep and wait, or raise --timeout-min.");
    await new Promise(r => setTimeout(r, 15_000));
  }
  const missing: string[] = [];
  for (const p of projects) for (const m of p.media) if (!(await engine.transcript(m.id))) missing.push(m.name);
  return missing;
}

/**
 * The raw assembly the scorecard's cases start from: the camera with its sound, and when there is a screen recording,
 * the screen full frame under the camera as an inset, both from their first frame (the Muse case's layout). Neither
 * is synced to the other: the pass does that, as it does in the editor's projects.
 */
export function assemblyOps(media: Array<ImportedMedia & { duration: number }>) {
  const camera = media.find(m => m.role === "camera");
  if (!camera) throw new Error("A raw assembly needs a camera recording (\"raw camera.*\"): use --start empty.");
  const screen = media.find(m => m.role === "screen");
  const clip = (id: string, m: { id: string; duration: number }, extra: Record<string, unknown>) => ({
    id, timelineIn: 0, enabled: true, kind: "media", mediaId: m.id, sourceIn: 0, sourceOut: m.duration, speed: 1, opacity: 1,
    audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], ...extra,
  });
  if (!screen) return { description: "Raw assembly", ops: [{ op: "addClip", trackId: "v1", clip: clip("clip_rawcamera", camera, { volume: 1 }) }] };
  return {
    description: "Raw assembly: screen with the camera inset",
    ops: [
      { op: "addClip", trackId: "v1", clip: clip("clip_rawscreen", screen, { volume: 0 }) },
      { op: "addTrack", track: { id: "v2", kind: "video", name: "V2", muted: false, hidden: false, clips: [] } },
      { op: "addClip", trackId: "v2", clip: clip("clip_rawcamera", camera, {
        volume: 1, transform: { x: 0.35, y: 0.35, scale: 0.25, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }) },
    ],
  };
}

export interface LibraryInfo {
  recording: string;
  builtAt: string;
  checkout: string;
  raw: { projectId: string; media: ImportedMedia[] };
  published?: { projectId: string; media: ImportedMedia[] };
  untranscribed: string[];
}

export type Start = "assembly" | "empty";

async function buildLibrary(rec: Recording, out: string, opts: { keep: boolean; start: Start; models?: string; timeoutMs: number }) {
  checkLibraryDir(out);
  const data = join(out, "data");
  if (existsSync(join(data, "scarlet.db"))) throw new Error(`${out} already holds a library. Choose a new folder.`);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const models = opts.models ?? join(appSupportDir(), "data", "models");
  if (existsSync(models)) {
    // Model weights only: clones on the same disk, so they take no space. The engine downloads what is missing.
    cpSync(models, join(data, "models"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  }
  const { engine, child } = await startEngine(data, { detached: opts.keep });
  try {
    const raw = await importInto(engine, rec.name, rec.files.filter(f => f.role !== "published"));
    const pub = rec.files.filter(f => f.role === "published");
    const published = pub.length ? await importInto(engine, `${rec.name} published`, pub) : undefined;
    console.log("Waiting for the transcripts…");
    const untranscribed = await waitForTranscripts(engine, [raw, ...(published ? [published] : [])], opts.timeoutMs);
    const info: LibraryInfo = { recording: rec.name, builtAt: new Date().toISOString(), checkout: REPO_ROOT, raw, ...(published && { published }), untranscribed };
    writeFileSync(join(out, "library.json"), JSON.stringify(info, null, 1) + "\n", { mode: 0o600 });
    if (untranscribed.length) console.log(`No transcript for: ${untranscribed.join(", ")}`);
    const env = `SCARLET_APP_SUPPORT='${out}' SCARLET_ENGINE_URL=${engine.url} SCARLET_ACCESS_TOKEN=$(cat '${join(data, "access-token")}')`;
    // Reading the timeline saves the empty one a project starts on.
    const { timeline } = await engine.request<{ timeline: { version: string } }>("GET", `/projects/${raw.projectId}/timeline`);
    let head = timeline.version;
    if (opts.start === "assembly") {
      const listed = await engine.media(raw.projectId);
      const { description, ops } = assemblyOps(raw.media.map(m => ({ ...m, duration: Number(listed.find(l => l.id === m.id)?.duration) })));
      const { change } = await engine.request<{ change: { toVersion: string; state: string } }>("POST", `/projects/${raw.projectId}/changes`, {
        fromVersion: head, ops, description, autoApprove: true, skipRender: true,
      });
      head = change.toVersion;
      console.log(`${description}: version ${head} (${change.state})`);
    }
    const camera = raw.media.find(m => m.role === "camera");
    console.log(`\nLibrary ready in ${out} (library.json says what is in it).`);
    console.log(`Build a case from it${opts.keep ? "" : " once its engine is started again"}:`);
    console.log(`  ${env} \\\n    node_modules/.bin/tsx evals/src/dataset.ts build --project ${raw.projectId} --source ${head} --id <case id>` +
      (camera ? ` --media ${camera.id}` : "") +
      (published ? ` --published-media ${published.media[0]!.id} --published-video '${pub[0]!.path}'` : ""));
    if (!opts.keep) console.log(`Start its engine again: node apps/server/dist/cli.js serve --solo --port 0 --data '${data}'`);
    return { engine, child };
  } catch (err) {
    child.kill();
    throw err;
  } finally {
    if (!opts.keep) child.kill();
  }
}

if (isMain(import.meta.url)) main(async () => {
  const { values, positionals } = cli({
    out: { type: "string" }, keep: { type: "boolean" }, start: { type: "string" }, models: { type: "string" }, "timeout-min": { type: "string" },
  }, USAGE);
  const [command, name] = positionals;
  if (command === "list") {
    const all = recordings();
    if (!all.length) { console.log(`No recordings in ${videosDir()}.`); return; }
    console.log(videosDir());
    for (const r of all) {
      const has = (role: Role) => r.files.filter(f => f.role === role).length;
      console.log(`  ${r.name}: ${has("camera")} camera, ${has("screen")} screen, ${has("published") ? "published" : "no published video"}`);
    }
    return;
  }
  if (command === "library" && name && values.out) {
    const out = resolve(values.out);
    const minutes = values["timeout-min"] ? Number(values["timeout-min"]) : 120;
    const start = (values.start ?? "assembly") as Start;
    if (start !== "assembly" && start !== "empty") throw new Error("--start is assembly or empty.");
    const { child } = await buildLibrary(findRecording(name), out, { keep: !!values.keep, start, models: values.models, timeoutMs: minutes * 60_000 });
    if (values.keep) {
      console.log(`Engine pid ${child.pid} stays up; stop it with kill ${child.pid}.`);
      child.unref();
    }
    return;
  }
  throw new Error(USAGE);
});

/** For tests: what a library.json holds. */
export const readLibraryInfo = (dir: string) => JSON.parse(readFileSync(join(dir, "library.json"), "utf8")) as LibraryInfo;
