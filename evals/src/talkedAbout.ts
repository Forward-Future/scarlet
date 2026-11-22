/**
 * Mark what you're talking about on your screen recording, sentence by sentence, so a cut can be checked for covering
 * it (the camera over it, or a crop that leaves it out). The marks are facts about the recording, not about any one
 * cut, so every cut of it is scored against the same marks and many placements can all be right.
 *
 *   tsx evals/src/talkedAbout.ts --project <name or id> [--db <scarlet.db>] [--port 4719] [--camera <id>] [--screen <id>] [--all]
 *
 * Only what the project's video plays now is offered: retakes and anything else its cut took out are never shown, so
 * they aren't marked. A sentence is split where the cut joins two pieces, and reads as it plays. Sentences are grouped
 * by the screen they're said over, and a screen the video never puts on picture (notes, a script, a call) isn't
 * offered. --all offers every word of the recording and every screen instead.
 *
 * Opens a page on this computer only (127.0.0.1). It reads the library read-only and shows the recordings' frames and
 * sound through ffmpeg, so any browser plays them whatever their codec; the marks go to
 * <eval data>/talked-about/<screen recording>.json, saved as you go.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli, isMain, main } from "./args.ts";
import type { Timeline } from "../../packages/timeline/src/index.ts";
import { ffmpegPath } from "./evidence.ts";
import { pictureAt } from "./layout.ts";
import { defaultLibrary } from "./leftovers.ts";
import { dataDir, fileComponent, readJson, writeJson } from "./paths.ts";

/**
 * A box on the screen recording's picture, each edge a fraction of its width or height from the top left. A box is the
 * thing talked about (worth zooming into); `wider` marks the broader part of the screen around it that is also fine to show.
 */
export interface Box { left: number; top: number; right: number; bottom: number; wider?: true }

/**
 * One sentence and what it talks about on screen: boxes; nothing on screen (`none`), where showing the screen or not
 * are both fine; or a screen that mustn't be shown (`hide`), such as notes, a script or a call.
 */
export interface TalkedLabel {
  /** The sentence, in seconds of the camera recording (the clock its words were transcribed on). */
  from: number;
  to: number;
  text: string;
  boxes: Box[];
  none?: true;
  hide?: true;
  at: string;
}

export interface TalkedFile {
  schema: 1;
  project: string;
  camera: string;
  screen: string;
  /** Screen recording second = camera second + offset. */
  offset: number;
  labels: TalkedLabel[];
}

/** A word of the camera recording; `part` is the piece of the cut it plays in, and a sentence never spans two. */
interface Word { text: string; start: number; end: number; part?: number }
export interface Sentence { from: number; to: number; text: string }

/** A pause this long ends a sentence even with no full stop: a transcript runs restarts together without one. */
const PAUSE = 0.6;
/** A sentence longer than this is split at its longest pause, until each part is shorter or has no pause to split at. */
const LONGEST = 12;
/** A scrap of a sentence shorter than this is too little to mark on its own. */
const SHORTEST = 1;

/** The transcript's words cut into sentences at a full stop, question or exclamation mark, or a pause. */
export function sentences(words: readonly Word[]): Sentence[] {
  const runs: Word[][] = [];
  let run: Word[] = [];
  words.forEach((w, n) => {
    run.push(w);
    const next = words[n + 1];
    if (/[.?!]["”’)]*$/.test(w.text.trim()) || !next || next.start - w.end >= PAUSE || next.part !== w.part) { runs.push(run); run = []; }
  });
  const split = (r: Word[]): Word[][] => {
    if (r.length < 2 || r.at(-1)!.end - r[0]!.start <= LONGEST) return [r];
    let at = 1;
    for (let k = 1; k < r.length; k++) if (r[k]!.start - r[k - 1]!.end > r[at]!.start - r[at - 1]!.end) at = k;
    return [...split(r.slice(0, at)), ...split(r.slice(at))];
  };
  // A scrap under SHORTEST ("but") joins the sentence after it in the same piece, or else the one before.
  const parts = runs.flatMap(split), out: Word[][] = [];
  const span = (r: Word[]) => r.at(-1)!.end - r[0]!.start;
  for (let k = 0; k < parts.length; k++) {
    const r = parts[k]!, next = parts[k + 1], prev = out.at(-1);
    if (span(r) >= SHORTEST) out.push(r);
    else if (next && next[0]!.part === r[0]!.part && next.at(-1)!.end - r[0]!.start <= LONGEST) parts[k + 1] = [...r, ...next];
    else if (prev && prev[0]!.part === r[0]!.part && r.at(-1)!.end - prev[0]!.start <= LONGEST) prev.push(...r);
    else out.push(r);
  }
  return out.map(sentenceOf);
}
const sentenceOf = (run: Word[]): Sentence => ({ from: run[0]!.start, to: run.at(-1)!.end, text: run.map(w => w.text.trim()).join(" ") });

/**
 * The words a cut plays: each word whose middle a clip of the camera plays, tagged with that clip's piece of the
 * recording. Pieces that run on without a gap are one piece, so a clip split without a cut doesn't split a sentence.
 */
export function keptWords(words: readonly Word[], clips: ReadonlyArray<{ sourceIn: number; sourceOut: number }>): Word[] {
  const pieces: Array<{ from: number; to: number }> = [];
  for (const c of [...clips].sort((a, b) => a.sourceIn - b.sourceIn)) {
    const last = pieces.at(-1);
    if (last && c.sourceIn <= last.to + 0.05) last.to = Math.max(last.to, c.sourceOut);
    else pieces.push({ from: c.sourceIn, to: c.sourceOut });
  }
  return words.flatMap(w => {
    const mid = (w.start + w.end) / 2, part = pieces.findIndex(p => p.from <= mid && mid < p.to);
    return part < 0 ? [] : [{ ...w, part }];
  });
}

/** Seconds into the day a recording's file name says it started ("2026-11-19 11-21-18.mp4"). */
const startedAt = (name: string) => {
  const m = [...name.matchAll(/(?<!\d)(\d{1,2})[-.:](\d{2})[-.:](\d{2})(?!\d)/g)].at(-1);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
};

interface Recording { id: string; name: string; path: string; duration: number; width: number; height: number; transcriptId?: string }

type Clip = { mediaId?: string; timelineIn: number; sourceIn: number; sourceOut: number; speed?: number };

function readProject(dbPath: string, wanted: string, camera?: string, screen?: string, all = false) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const project = db.prepare("SELECT id, name, head FROM projects WHERE deleted_at IS NULL AND (id = ? OR name = ?)").get(wanted, wanted) as { id: string; name: string; head: string | null } | undefined;
    if (!project) throw new Error(`No project “${wanted}” in ${dbPath}.`);
    const media = (db.prepare("SELECT json FROM media WHERE project_id = ?").all(project.id) as Array<{ json: string }>)
      .map(r => JSON.parse(r.json) as Recording & { kind: string }).filter(m => m.kind === "video");
    const words = (m: Recording): Word[] => {
      const row = (m.transcriptId ? db.prepare("SELECT json FROM transcripts WHERE id = ?").get(m.transcriptId)
        : db.prepare("SELECT json FROM transcripts WHERE media_id = ? ORDER BY created_at DESC LIMIT 1").get(m.id)) as { json: string } | undefined;
      const t = row ? JSON.parse(row.json) as { segments?: Array<{ words?: Word[] }> } : undefined;
      return t?.segments?.flatMap(s => s.words ?? []) ?? [];
    };
    // The camera is the recording with the most said on it; the screen is the other one.
    const ranked = media.map(m => ({ m, words: words(m) })).sort((a, b) => b.words.length - a.words.length);
    const cam = ranked.find(r => r.m.id === camera) ?? (camera ? undefined : ranked[0]);
    const scr = media.find(m => m.id === screen) ?? (screen ? undefined : media.find(m => m.id !== cam?.m.id));
    if (!cam || !scr) throw new Error(`${project.name} needs a camera and a screen recording (found ${media.map(m => m.name).join(", ")}).`);
    // Where Scarlet has put both on the timeline, their offset is read there; otherwise from the times in their names.
    let offset: number | undefined;
    for (const row of db.prepare("SELECT json FROM timeline_versions WHERE project_id = ? ORDER BY created_at DESC").all(project.id) as Array<{ json: string }>) {
      const clips = (JSON.parse(row.json) as { tracks: Array<{ clips: Clip[] }> }).tracks.flatMap(t => t.clips).filter(c => c.mediaId);
      for (const s of clips.filter(c => c.mediaId === scr.id)) {
        const c = clips.find(c => c.mediaId === cam.m.id && c.timelineIn <= s.timelineIn + 1e-6 && s.timelineIn < c.timelineIn + (c.sourceOut - c.sourceIn) / (c.speed ?? 1));
        if (c) { offset = s.sourceIn - (c.sourceIn + (s.timelineIn - c.timelineIn) * (c.speed ?? 1)); break; }
      }
      if (offset !== undefined) break;
    }
    const a = startedAt(cam.m.name), b = startedAt(scr.name);
    offset ??= a !== undefined && b !== undefined ? a - b : 0;
    // The video as it is now: only the camera's words it plays.
    const head = project.head && !all ? db.prepare("SELECT json FROM timeline_versions WHERE project_id = ? AND version = ?").get(project.id, project.head) as { json: string } | undefined : undefined;
    const video = head ? JSON.parse(head.json) as Timeline : undefined;
    const played = video && (video.tracks.flatMap(t => t.clips) as Clip[]).filter(c => c.mediaId === cam.m.id);
    const offered = played?.length ? keptWords(cam.words, played) : cam.words;
    const dir = join(dirname(dbPath), "projects", project.id, "media");
    return { project, camera: { ...cam.m, file: join(dir, cam.m.path) }, screen: { ...scr, file: join(dir, scr.path) },
      sentences: sentences(offered), offset: Math.round(offset * 1000) / 1000,
      video: played?.length ? video : undefined,
      from: played?.length ? `the video as it is now (${cam.words.length - offered.length} of ${cam.words.length} words cut out)` : "the whole recording" };
  } finally {
    db.close();
  }
}

/** What ffmpeg writes for these arguments, read-only on the recording. */
function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile(ffmpegPath(), ["-hide_banner", "-nostdin", "-loglevel", "error", ...args],
    { encoding: "buffer", maxBuffer: 1 << 26 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}
/** One frame of the screen recording, 1600 wide. */
const frame = (file: string, at: number) => ffmpeg(["-ss", String(Math.max(0, at)), "-i", file, "-frames:v", "1", "-vf", "scale=1600:-2", "-q:v", "3", "-f", "mjpeg", "pipe:1"]);
/** The camera's sound over a stretch, as a small mono file. */
const sound = (file: string, from: number, to: number) => ffmpeg(["-ss", String(Math.max(0, from)), "-t", String(Math.min(30, Math.max(0.1, to - from))), "-i", file,
  "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-f", "adts", "pipe:1"]);

/** A tiny grey picture of the screen recording at a second, to tell one screen from the next. */
const thumb = (file: string, at: number) => ffmpeg(["-ss", String(Math.max(0, at)), "-i", file, "-frames:v", "1", "-vf", "scale=48:27,format=gray", "-f", "rawvideo", "pipe:1"]);
/** How far apart two such pictures are, 0 to 255 per pixel, at which the screen has changed: a pointer or a call's video moving stays under it. */
const NEW_SCREEN = 1.5;

/**
 * Which screen each sentence is on, numbered from 0: a new number wherever the screen recording changes from one
 * sentence to the next (another page, a scroll), so one answer can stand for every sentence on a screen.
 */
export function screensOf(pictures: readonly Uint8Array[]): number[] {
  let n = 0;
  return pictures.map((p, k) => {
    const q = pictures[k - 1];
    if (q && apart(p, q) > NEW_SCREEN) n++;
    return n;
  });
}

/** How different two tiny pictures are, 0 to 255 per pixel. */
function apart(p: Uint8Array, q: Uint8Array): number {
  if (p.length !== q.length) return 255;
  let d = 0;
  for (let x = 0; x < p.length; x++) d += Math.abs(p[x]! - q[x]!);
  return d / p.length;
}

/**
 * The order to ask about sentences in, most different first. Round 1 is one sentence a screen: the longest the video
 * shows the screen over, the screens in the order that keeps each as unlike the ones before it as it can (starting
 * from the screen with the most said over it). Each later round takes one more sentence a screen, the one least like
 * those already asked about on it (in picture, then in time), so a screen that stays up for minutes is asked about
 * at its start, end and middle before the rest.
 */
export function exampleOrder(said: ReadonlyArray<Sentence & { screen: number }>, pictures: readonly Uint8Array[], shownOver: readonly boolean[] = []): Array<{ index: number; round: number }> {
  const groups = new Map<number, number[]>();
  said.forEach((s, k) => groups.set(s.screen, [...groups.get(s.screen) ?? [], k]));
  const length = (k: number) => said[k]!.to - said[k]!.from;
  const lists = new Map<number, number[]>();
  for (const [screen, members] of groups) {
    const shown = members.filter(k => shownOver[k]);
    const first = (shown.length ? shown : members).reduce((a, b) => length(b) > length(a) ? b : a);
    const list = [first], left = new Set(members.filter(k => k !== first));
    const unlike = (k: number) => Math.min(...list.map(c => apart(pictures[k]!, pictures[c]!) + Math.abs(said[k]!.from - said[c]!.from) / 60));
    while (left.size) {
      const next = [...left].reduce((a, b) => unlike(b) > unlike(a) ? b : a);
      list.push(next); left.delete(next);
    }
    lists.set(screen, list);
  }
  const screens = [...groups.keys()], firstOf = (screen: number) => lists.get(screen)![0]!;
  const order = [screens.reduce((a, b) => groups.get(b)!.length > groups.get(a)!.length ? b : a)];
  const rest = new Set(screens.filter(x => x !== order[0]));
  const unlike = (x: number) => Math.min(...order.map(o => apart(pictures[firstOf(x)]!, pictures[firstOf(o)]!)));
  while (rest.size) {
    const next = [...rest].reduce((a, b) => unlike(b) > unlike(a) ? b : a);
    order.push(next); rest.delete(next);
  }
  const out: Array<{ index: number; round: number }> = [];
  for (let round = 0; out.length < said.length; round++) {
    for (const screen of order) { const k = lists.get(screen)![round]; if (k !== undefined) out.push({ index: k, round: round + 1 }); }
  }
  return out;
}

/** The screens a video puts on picture while any of their sentences plays: the ones worth marking. */
export function screensShown(video: Timeline, camera: string, screen: string, said: ReadonlyArray<Sentence & { screen: number }>): Set<number> {
  return new Set(said.filter(s => shownWhile(video, camera, screen, s)).map(s => s.screen));
}
/** Whether a video puts the screen on picture at any moment of a sentence. */
export function shownWhile(video: Timeline, camera: string, screen: string, s: Sentence): boolean {
  for (let c = s.from; c <= s.to; c += 0.25) if (pictureAt(video, camera, c)?.layers[screen]) return true;
  return false;
}

/** Each sentence's screen, read once and kept beside the marks. */
async function readScreens(file: string, times: readonly number[], cache: string): Promise<{ screens: number[]; pictures: Uint8Array[] }> {
  const kept: Record<string, string> = existsSync(cache) ? readJson(cache) : {};
  const pictures: Uint8Array[] = new Array(times.length);
  let next = 0, read = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < times.length) {
      const k = next++, t = times[k]!.toFixed(1);
      if (!kept[t]) { kept[t] = (await thumb(file, times[k]!)).toString("base64"); read++; }
      pictures[k] = Buffer.from(kept[t]!, "base64");
    }
  }));
  if (read) writeJson(cache, kept);
  return { screens: screensOf(pictures), pictures };
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 1 << 20) throw new Error("too large"); }
  return JSON.parse(text);
}

const finite = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
/** A label as the page sends it, checked: a sentence, and boxes inside the picture or none. */
export function checkLabel(v: unknown): Omit<TalkedLabel, "at"> {
  const l = v as Partial<TalkedLabel>;
  if (!l || !finite(l.from, 0, 1e6) || !finite(l.to, 0, 1e6) || typeof l.text !== "string" || !Array.isArray(l.boxes)) throw new Error("bad label");
  const boxes = l.boxes.map(b => {
    if (![b.left, b.top, b.right, b.bottom].every(x => finite(x, 0, 1)) || b.right - b.left < 0.005 || b.bottom - b.top < 0.005) throw new Error("bad box");
    const r = (x: number) => Math.round(x * 10000) / 10000;
    return { left: r(b.left), top: r(b.top), right: r(b.right), bottom: r(b.bottom), ...(b.wider && { wider: true as const }) };
  });
  if ([boxes.length > 0, !!l.none, !!l.hide].filter(Boolean).length > 1) throw new Error("a sentence is boxes, nothing on screen or don't show the screen, one of them");
  if (boxes.length && boxes.every(b => b.wider)) throw new Error("a wider view needs the main thing marked too");
  return { from: l.from!, to: l.to!, text: l.text.slice(0, 2000), boxes, ...(l.none && { none: true as const }), ...(l.hide && { hide: true as const }) };
}

if (isMain(import.meta.url)) {
  const { values } = cli({ project: { type: "string" }, db: { type: "string" }, port: { type: "string" }, camera: { type: "string" }, screen: { type: "string" }, all: { type: "boolean" } },
    "usage: tsx evals/src/talkedAbout.ts --project <name or id> [--db <scarlet.db>] [--port 4719] [--camera <id>] [--screen <id>] [--all]");
  main(async () => {
    if (!values.project) throw new Error("Name the project with --project.");
    const found = readProject(values.db ?? defaultLibrary(), values.project, values.camera, values.screen, values.all);
    const path = join(dataDir(), "talked-about", fileComponent(found.screen.id) + ".json");
    const saved: TalkedFile = existsSync(path) ? readJson<TalkedFile>(path)
      : { schema: 1, project: found.project.id, camera: found.camera.id, screen: found.screen.id, offset: found.offset, labels: [] };
    if (!existsSync(path.replace(/\.json$/, ".screens.json"))) console.log("Reading where the screen changes (once, about 20 s)…");
    const { screens, pictures } = await readScreens(found.screen.file, found.sentences.map(s => Math.min(found.screen.duration - 0.05, Math.max(0, (s.from + s.to) / 2 + saved.offset))),
      path.replace(/\.json$/, ".screens.json"));
    // Screens the video never shows aren't offered; the rest are numbered again from the first.
    const grouped = found.sentences.map((s, k) => ({ ...s, screen: screens[k]!, picture: pictures[k]! }));
    const shown = found.video ? screensShown(found.video, found.camera.id, found.screen.id, grouped) : undefined;
    const kept = shown ? grouped.filter(s => shown.has(s.screen)) : grouped;
    const renumber = new Map([...new Set(kept.map(s => s.screen))].map((id, n) => [id, n]));
    const offered = kept.map(({ picture: _, ...s }) => ({ ...s, screen: renumber.get(s.screen)! }));
    // Asked in the order that keeps each example unlike the ones before it.
    const order = exampleOrder(offered, kept.map(s => s.picture), found.video ? offered.map(s => shownWhile(found.video!, found.camera.id, found.screen.id, s)) : []);
    const save = () => writeJson(path, { ...saved, labels: [...saved.labels].sort((a, b) => a.from - b.from) });
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(PAGE);
        } else if (req.method === "GET" && url.pathname === "/session") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ project: found.project.name, screen: { name: found.screen.name, width: found.screen.width, height: found.screen.height, duration: found.screen.duration },
            sentences: offered, order, offset: saved.offset, labels: saved.labels }));
        } else if (req.method === "GET" && url.pathname === "/frame.jpg") {
          const at = Number(url.searchParams.get("t"));
          if (!finite(at, 0, found.screen.duration)) throw new Error("bad time");
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" }).end(await frame(found.screen.file, at));
        } else if (req.method === "GET" && url.pathname === "/voice.aac") {
          const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
          if (!finite(from, 0, found.camera.duration) || !finite(to, from, found.camera.duration + 1)) throw new Error("bad stretch");
          res.writeHead(200, { "Content-Type": "audio/aac", "Cache-Control": "max-age=3600" }).end(await sound(found.camera.file, from, to));
        } else if (req.method === "POST" && url.pathname === "/label") {
          const label = { ...checkLabel(await body(req)), at: new Date().toISOString() };
          saved.labels = [...saved.labels.filter(l => Math.abs(l.from - label.from) > 1e-3), label];
          save();
          res.writeHead(204).end();
        } else if (req.method === "POST" && url.pathname === "/offset") {
          const { offset } = await body(req) as { offset?: unknown };
          if (!finite(offset, -3600, 3600)) throw new Error("bad offset");
          saved.offset = Math.round((offset as number) * 1000) / 1000;
          save();
          res.writeHead(204).end();
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end((err as Error).message);
      }
    });
    const port = Number(values.port ?? 4719);
    await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
    console.log(`${found.project.name}: ${offered.length} sentences on ${renumber.size} screens, from ${found.from}` +
      (shown ? `, leaving out ${screens.at(-1)! + 1 - renumber.size} screens it never shows` : "") + `, ${saved.labels.length} marked. Screen = camera ${saved.offset >= 0 ? "+" : ""}${saved.offset} s.`);
    console.log(`Open http://127.0.0.1:${port}  ·  marks save to ${path}`);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>What you're talking about</title>
<style>
  :root { color-scheme: dark; --dim: #8a8a8a; --line: #2a2a2a; --mark: #f5b544; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0b; color: #ededed; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  header .count { color: var(--dim); }
  header .bar { flex: 1; height: 2px; background: var(--line); align-self: center; position: relative; }
  header .bar i { position: absolute; inset: 0 auto 0 0; background: #d8d8d8; }
  main { max-width: 1200px; margin: 0 auto; padding: 16px 20px 40px; }
  .stage { position: relative; background: #000; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; user-select: none; cursor: crosshair; }
  .stage img { display: block; width: 100%; height: 100%; object-fit: contain; -webkit-user-drag: none; }
  .stage.loading img { opacity: .6; }
  .box { position: absolute; border: 2px solid var(--mark); background: rgba(245, 181, 68, .12); border-radius: 2px; }
  .box { box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
  .box.wider { border: 2px solid #f2f2f2; background: rgba(255, 255, 255, .05); }
  .box .tag { position: absolute; left: -2px; top: -19px; padding: 0 5px; border-radius: 3px; background: rgba(0,0,0,.8); font: 600 11px/17px ui-monospace, monospace; color: var(--mark); white-space: nowrap; }
  .box.wider .tag { color: #d8d8d8; }
  .box .tag.inside { top: 3px; left: 3px; }
  .box button { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 50%; border: 0; background: #ededed; color: #000; font-size: 13px; cursor: pointer; line-height: 22px; padding: 0; box-shadow: 0 0 0 1px rgba(0,0,0,.5); }
  .box button:hover { background: #fff; }
  .state { position: absolute; left: 12px; bottom: 12px; padding: 3px 9px; border-radius: 999px; background: rgba(0,0,0,.7); color: var(--dim); font-size: 12px; }
  .state.done { color: #ededed; }
  .state.hide { color: #ff8a80; }
  .stage.hide img { opacity: .35; }
  .scrub { width: 100%; margin: 10px 0 0; accent-color: #d8d8d8; }
  .said { margin: 14px 0 4px; font-size: 20px; line-height: 1.4; }
  .said.moved { animation: moved .45s ease-out; }
  @keyframes moved { from { opacity: .2; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .saved { position: absolute; right: 12px; bottom: 12px; padding: 3px 9px; border-radius: 999px; background: rgba(0,0,0,.7); color: #ededed; font-size: 12px; opacity: 0; transition: opacity .3s; }
  .saved.on { opacity: 1; transition: none; }
  .around { color: var(--dim); font-size: 13px; }
  .time { color: var(--dim); font-variant-numeric: tabular-nums; }
  .keys { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .keys button { background: #1c1c1c; color: #ededed; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; font: inherit; cursor: pointer; }
  .keys button:hover { background: #262626; }
  .keys button.primary { background: #e6e6e6; color: #000; border-color: #e6e6e6; }
  kbd { font: 11px ui-monospace, monospace; color: var(--dim); margin-left: 6px; }
  .keys button.primary kbd { color: #555; }
  .kind { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  .kind button { border: 0; border-radius: 0; background: #141414; color: var(--dim); }
  .kind button.on { background: #2a2a2a; color: #ededed; }
  .kind button.on#main { color: var(--mark); }
  .note { color: var(--dim); font-size: 12px; margin-top: 14px; }
</style></head>
<body>
<header><h1 id="title">What you're talking about</h1><span class="count" id="count"></span><span class="bar"><i id="progress"></i></span><span class="time" id="offset"></span></header>
<main>
  <div class="stage" id="stage"><img id="screen" alt="" draggable="false"><span class="state" id="state"></span><span class="saved" id="saved"></span></div>
  <input class="scrub" id="scrub" type="range" min="0" max="1000" value="500">
  <audio id="voice"></audio>
  <div class="around" id="before"></div>
  <div class="said" id="said"></div>
  <div class="around" id="after"></div>
  <div class="keys">
    <span class="kind"><button id="main" class="on">Main thing<kbd>1</kbd></button><button id="wide">Wider view<kbd>2</kbd></button></span>
    <button id="play">Play sentence<kbd>Space</kbd></button>
    <button id="none" title="For every unmarked sentence on this screen">Nothing on this screen<kbd>N</kbd></button>
    <button id="hide" title="For every unmarked sentence on this screen">Don't show this screen<kbd>H</kbd></button>
    <button id="copy" title="Copy the boxes from the nearest marked sentence on this screen">Copy nearby marks<kbd>C</kbd></button>
    <button id="clear">Clear boxes<kbd>⌫</kbd></button>
    <button id="back">Back<kbd>←</kbd></button>
    <button id="skip">Next unmarked<kbd>U</kbd></button>
    <button id="next" class="primary">Save and next<kbd>→</kbd></button>
  </div>
  <p class="note">Drag a box round the main thing you're talking about (what a zoom could go to); draw several if it's in several places. Then, if you like, a second box round the wider part of the screen that's also fine to show (it switches to Wider view by itself after your first box). N (nothing on this screen is what you mean) and H (this screen mustn't be shown: your notes, a script, a call) answer every unmarked sentence until the screen changes, and go on to the next screen. The camera is fine anywhere outside your main boxes. Off by a moment? <kbd>[</kbd> <kbd>]</kbd> move the screen 0.1 s against your voice.</p>
</main>
<script>
const $ = id => document.getElementById(id);
const screen = $("screen"), voice = $("voice"), stage = $("stage");
let S, i = 0, boxes = [], none = false, hide = false, wider = false, labels = new Map(), offset = 0, shown = null, wanted = null;
const key = s => s.from.toFixed(3);
const clock = t => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");

async function start() {
  S = await (await fetch("/session")).json();
  offset = S.offset;
  for (const l of S.labels) labels.set(l.from.toFixed(3), l);
  $("title").textContent = S.project + " · " + S.screen.name;
  stage.style.aspectRatio = S.screen.width + " / " + S.screen.height;
  // A frame that loads, or fails to, frees the picture for the next one, so a failed frame never freezes it.
  const loaded = () => { stage.classList.remove("loading"); shown = wanted; if (pending !== null) { const t = pending; pending = null; wanted = null; seek(t); } };
  screen.onload = loaded;
  screen.onerror = () => { wanted = null; loaded(); };
  // #12 opens sentence 12; otherwise the first one not marked yet.
  // #12 opens example 12; otherwise the first one not marked yet, in the order they're asked.
  const asked = Number(location.hash.slice(1)), first = S.order.find(o => !labels.has(key(S.sentences[o.index])));
  show(asked >= 1 ? S.order[Math.min(asked, S.order.length) - 1].index : (first ?? S.order[0]).index);
}

function show(n) {
  stop();
  i = Math.max(0, Math.min(S.sentences.length - 1, n));
  location.replace("#" + (pos() + 1));
  const s = S.sentences[i], saved = labels.get(key(s));
  boxes = saved ? saved.boxes.map(b => ({ ...b })) : [];
  none = !!saved?.none; hide = !!saved?.hide;
  setKind(boxes.some(b => !b.wider));
  const said = $("said");
  said.textContent = s.text;
  said.classList.remove("moved"); void said.offsetWidth; said.classList.add("moved");
  $("before").textContent = i ? S.sentences[i - 1].text : "";
  $("after").textContent = S.sentences[i + 1]?.text ?? "";
  $("scrub").value = 500;
  seek(s.from + (s.to - s.from) / 2);
  render();
}

/** Show the screen at a second of the camera's clock. One frame loads at a time; the latest asked for comes next. */
let pending = null;
function seek(camera) {
  const t = Math.min(S.screen.duration - 0.05, Math.max(0, Math.round((camera + offset) * 10) / 10));
  if (t === wanted) return;
  if (stage.classList.contains("loading")) { pending = camera; return; }
  wanted = t; stage.classList.add("loading");
  screen.src = "/frame.jpg?t=" + t;
}

function render() {
  const s = S.sentences[i];
  stage.querySelectorAll(".box").forEach(b => b.remove());
  const area = b => (b.right - b.left) * (b.bottom - b.top);
  boxes.map((b, n) => ({ b, n })).sort((x, y) => area(y.b) - area(x.b)).forEach(({ b, n }) => draw(b, n));
  const state = $("state");
  const mains = boxes.filter(b => !b.wider).length, wides = boxes.length - mains;
  state.textContent = boxes.length ? [mains && mains + " main", wides && wides + " wider"].filter(Boolean).join(" · ") : none ? "Nothing on screen" : hide ? "Don't show the screen" : labels.has(key(s)) ? "Marked" : "Not marked yet";
  state.className = "state" + (hide ? " hide" : boxes.length || none ? " done" : "");
  stage.classList.toggle("hide", hide);
  const done = S.sentences.filter(x => labels.has(key(x))).length;
  const screens = S.sentences.at(-1).screen + 1, at = S.order[pos()];
  $("count").textContent = "Example " + (pos() + 1) + " of " + S.order.length + (at.round === 1 ? " · one per screen, most different first (" + Math.min(pos() + 1, screens) + " of " + screens + " screens)" : " · round " + at.round + ": another on each screen") + " · " + clock(s.from) + " · " + done + " marked";
  $("progress").style.width = (100 * done / S.sentences.length) + "%";
  $("offset").textContent = "screen " + (offset >= 0 ? "+" : "") + offset.toFixed(1) + " s";
}

function draw(b, n) {
  const el = document.createElement("div");
  el.className = "box" + (b.wider ? " wider" : "");
  const tag = document.createElement("span");
  // A box at the picture's top edge keeps its label inside it, where the edge would cut it off.
  tag.className = "tag" + (b.top < 0.04 ? " inside" : ""); tag.textContent = b.wider ? "2 wider" : "1 main";
  el.append(tag);
  Object.assign(el.style, { left: b.left * 100 + "%", top: b.top * 100 + "%", width: (b.right - b.left) * 100 + "%", height: (b.bottom - b.top) * 100 + "%" });
  const x = document.createElement("button");
  x.textContent = "×"; x.title = "Remove";
  x.onmousedown = e => e.stopPropagation();
  x.onclick = e => { e.stopPropagation(); boxes.splice(n, 1); render(); };
  el.append(x);
  stage.append(el);
}

let drag = null;
stage.addEventListener("mousedown", e => {
  const r = stage.getBoundingClientRect();
  drag = { r, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, el: document.createElement("div") };
  drag.el.className = "box" + (wider ? " wider" : ""); stage.append(drag.el);
});
window.addEventListener("mousemove", e => {
  if (!drag) return;
  const x = Math.min(1, Math.max(0, (e.clientX - drag.r.left) / drag.r.width)), y = Math.min(1, Math.max(0, (e.clientY - drag.r.top) / drag.r.height));
  drag.box = { left: Math.min(x, drag.x), top: Math.min(y, drag.y), right: Math.max(x, drag.x), bottom: Math.max(y, drag.y) };
  Object.assign(drag.el.style, { left: drag.box.left * 100 + "%", top: drag.box.top * 100 + "%", width: (drag.box.right - drag.box.left) * 100 + "%", height: (drag.box.bottom - drag.box.top) * 100 + "%" });
});
window.addEventListener("mouseup", () => {
  if (!drag) return;
  const b = drag.box; drag.el.remove(); drag = null;
  if (b && b.right - b.left > 0.01 && b.bottom - b.top > 0.01) {
    boxes.push(wider ? { ...b, wider: true } : b); none = false; hide = false;
    if (!wider) setKind(true);
    render();
  }
});

/** Which box a drag draws: the main thing (1) or the wider view around it (2). */
function setKind(w) { wider = w; $("main").classList.toggle("on", !w); $("wide").classList.toggle("on", w); }

async function save() {
  const s = S.sentences[i];
  if (!boxes.length && !none && !hide) return true;
  if (boxes.length && !boxes.some(b => !b.wider)) { alert("Mark the main thing too (1): a wider view goes round it."); return false; }
  const label = { from: s.from, to: s.to, text: s.text, boxes, ...(none && { none: true }), ...(hide && { hide: true }) };
  const res = await fetch("/label", { method: "POST", body: JSON.stringify(label) });
  if (!res.ok) { alert("Not saved: " + await res.text()); return false; }
  labels.set(key(s), label);
  flash("Saved sentence " + (i + 1));
  return true;
}
let flashed;
function flash(text) { const el = $("saved"); el.textContent = text; el.classList.add("on"); clearTimeout(flashed); flashed = setTimeout(() => el.classList.remove("on"), 900); }
/** Where the open sentence is in the order of examples, and the sentence n places on from it. */
const pos = () => S.order.findIndex(o => o.index === i);
const step = n => S.order[Math.max(0, Math.min(S.order.length - 1, pos() + n))].index;
/** The next example not marked yet, after this one. */
const unmarked = () => S.order.slice(pos() + 1).find(o => !labels.has(key(S.sentences[o.index])))?.index ?? i;
async function next() { if (await save()) show(step(1)); }
/** The sentences said over the same screen as sentence n. */
function onScreen(n) { return S.sentences.flatMap((s, k) => s.screen === S.sentences[n].screen ? [k] : []); }
/** N or H: the same answer for this sentence and every unmarked one on this screen, then on to the next unmarked sentence. */
async function answerScreen(kind) {
  for (const k of onScreen(i)) {
    const s = S.sentences[k];
    if (k !== i && labels.has(key(s))) continue;
    const label = { from: s.from, to: s.to, text: s.text, boxes: [], [kind]: true };
    const res = await fetch("/label", { method: "POST", body: JSON.stringify(label) });
    if (!res.ok) { alert("Not saved: " + await res.text()); return; }
    labels.set(key(s), label);
  }
  show(unmarked());
}
function play() {
  const s = S.sentences[i], from = Math.max(0, s.from - 0.2);
  voice.src = "/voice.aac?from=" + from.toFixed(2) + "&to=" + (s.to + 0.3).toFixed(2);
  voice.dataset.from = from;
  voice.play();
}
function stop() { voice.pause(); }
const playing = () => !voice.paused && !voice.ended;
// The screen follows the voice while it plays.
voice.addEventListener("timeupdate", () => { if (playing()) { const s = S.sentences[i], t = Number(voice.dataset.from) + voice.currentTime; seek(t); $("scrub").value = Math.round(1000 * Math.min(1, Math.max(0, (t - s.from) / (s.to - s.from)))); } });
$("scrub").addEventListener("input", e => { const s = S.sentences[i]; seek(s.from + (s.to - s.from) * e.target.value / 1000); });

async function nudge(by) {
  offset = Math.round((offset + by) * 10) / 10;
  await fetch("/offset", { method: "POST", body: JSON.stringify({ offset }) });
  const s = S.sentences[i]; seek(s.from + (s.to - s.from) * $("scrub").value / 1000); render();
}

$("play").onclick = play;
$("main").onclick = () => setKind(false);
$("wide").onclick = () => setKind(true);
$("none").onclick = () => answerScreen("none");
$("hide").onclick = () => answerScreen("hide");
/** The marks on the nearest sentence said over the same screen, if any is marked. */
function nearestMarked() {
  const s = S.sentences[i];
  return S.sentences.filter((x, k) => k !== i && x.screen === s.screen && labels.get(key(x))?.boxes.length)
    .sort((a, b) => Math.abs(a.from - s.from) - Math.abs(b.from - s.from)).map(x => labels.get(key(x)))[0];
}
$("copy").onclick = () => { const p = nearestMarked(); if (p) { boxes = p.boxes.map(b => ({ ...b })); none = !!p.none; hide = !!p.hide; setKind(boxes.some(b => !b.wider)); render(); } };
$("clear").onclick = () => { boxes = []; none = false; hide = false; setKind(false); render(); };
$("back").onclick = async () => { await save(); show(step(-1)); };
$("skip").onclick = async () => { await save(); show(unmarked()); };
$("next").onclick = next;
window.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" && e.key !== " ") return;
  const k = e.key;
  // A focused button would press itself as well: the keys below are the page's alone.
  if (e.target.tagName === "BUTTON" && k === "Enter") e.preventDefault();
  if (k === " ") { e.preventDefault(); playing() ? stop() : play(); }
  else if (k === "ArrowRight" || k === "Enter") $("next").click();
  else if (k === "ArrowLeft") $("back").click();
  else if (k === "1") setKind(false);
  else if (k === "2") setKind(true);
  else if (k === "n" || k === "N") $("none").click();
  else if (k === "h" || k === "H") $("hide").click();
  else if (k === "c" || k === "C") $("copy").click();
  else if (k === "u" || k === "U") $("skip").click();
  else if (k === "Backspace") $("clear").click();
  else if (k === "[") nudge(-0.1);
  else if (k === "]") nudge(0.1);
});
start();
</script></body></html>`;
