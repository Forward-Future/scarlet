/**
 * A video on the web, for B-roll: what it is, what is said in it and one part of it as a file. yt-dlp does the reading
 * and the downloading, outside the agent's sandbox as page capture is, and Scarlet's own ffmpeg cuts the part.
 */
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { rootCertificates } from "node:tls";
import { resolveFfmpeg, resolveFfprobe } from "@scarlet/render";
import type { Ctx } from "../context.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { FfmpegError, run } from "../render/ffmpeg.js";
import { publicWebAddress } from "./publicWeb.js";
import { DOWNLOADERS, VideoDownloader } from "./videoDownloader.js";

/** The longest part one call saves: a call is one shot of B-roll, and the whole part is held in memory on its way to the task folder. */
export const MAX_PART_SECONDS = 600;
/** How much of the captions one call returns. */
export const CAPTION_CHARS = 20_000;
/** How long a video's reading is kept: the addresses it holds for the picture and sound stop working within hours. */
const KEEP_MS = 30 * 60_000;

const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
const downloaders = new Map<string, Promise<VideoDownloader>>();

/** This library's yt-dlp: `YT_DLP_PATH` when it names a program, else Scarlet's own copy, which it keeps working. */
function downloader(ctx: Ctx): Promise<VideoDownloader> {
  const folder = join(ctx.paths.root, "tools");
  let tool = downloaders.get(folder);
  if (!tool) {
    downloaders.set(folder, tool = (async () => {
      const set = (ctx.options.env?.YT_DLP_PATH ?? process.env.YT_DLP_PATH)?.trim();
      return new VideoDownloader({ folder, pinned: DOWNLOADERS[`${process.platform}-${process.arch}`], log: ctx.log,
        own: set && isAbsolute(set) && await runnable(set) ? set : undefined });
    })());
  }
  return tool;
}

/**
 * What yt-dlp and the ffmpeg it runs need around them: a folder where ffmpeg and ffprobe go by those names, and the
 * certificates to check a site with. The ffmpeg Scarlet ships carries its own OpenSSL and no certificates: it refused
 * every https address until it was given some (2026-11-23).
 */
async function surroundings(ctx: Ctx): Promise<{ ffmpegDir: string; env: NodeJS.ProcessEnv }> {
  const folder = join(ctx.paths.root, "tools");
  await mkdir(folder, { recursive: true });
  const env = { ...process.env, ...ctx.options.env };
  if (!env.SSL_CERT_FILE) {
    const roots = join(folder, "roots.pem");
    const pem = `${rootCertificates.join("\n")}\n`;
    if ((await stat(roots).catch(() => undefined))?.size !== Buffer.byteLength(pem)) await writeFile(roots, pem);
    env.SSL_CERT_FILE = roots;
  }
  const programs = [["ffmpeg", resolveFfmpeg()], ["ffprobe", resolveFfprobe()]] as const;
  const named = (name: string, path: string) => basename(path).replace(/\.exe$/i, "") === name;
  if (programs.every(([name, path]) => named(name, path)) && dirname(programs[0][1]) === dirname(programs[1][1]) && isAbsolute(programs[0][1])) {
    return { ffmpegDir: dirname(programs[0][1]), env };
  }
  // A development build names them for the machine they run on (`ffmpeg-aarch64-apple-darwin`), and one found on the
  // PATH has no folder to give: yt-dlp finds the PATH's by itself.
  if (!programs.every(([, path]) => isAbsolute(path)) || process.platform === "win32") return { ffmpegDir: "", env };
  const links = join(folder, "ffmpeg");
  await mkdir(links, { recursive: true });
  for (const [name, path] of programs) {
    await rm(join(links, name), { force: true });
    await symlink(path, join(links, name));
  }
  return { ffmpegDir: links, env };
}

/** What a site says about one video. */
export interface WebVideoAbout {
  url: string;
  title: string;
  channel?: string;
  /** Seconds. */
  duration?: number;
  /** The day it went up, as YYYY-MM-DD. */
  uploaded?: string;
  license?: string;
  width?: number;
  height?: number;
  chapters?: Array<{ start: number; end: number; title: string }>;
  description?: string;
}

interface CaptionLine { start: number; text: string }
interface Captions { language: string; automatic: boolean; lines: CaptionLine[] }
interface Reading { folder: string; info: string; about: WebVideoAbout; raw: Record<string, unknown>; at: number;
  /** The captions being read or read, and the signal of the caller whose read it is. */
  captions?: { read: Promise<Captions | undefined>; signal: AbortSignal } }

const readings = new Map<string, Promise<Reading>>();
const parts = new Map<string, { folder: string; file: string; projectId: string }>();

function forget(key: string, reading: Promise<Reading>) {
  if (readings.get(key) === reading) readings.delete(key);
  void reading.then(r => rm(r.folder, { recursive: true, force: true }), () => {});
}

/** yt-dlp's own last word on why it stopped, without its prefix. */
function said(error: unknown): string {
  const text = error instanceof FfmpegError ? error.stderr : String((error as Error)?.message ?? error);
  const line = text.split("\n").map(l => l.trim()).filter(l => l.startsWith("ERROR:")).pop();
  return (line ?? text.trim().split("\n").pop() ?? "").replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*\S+:\s*/, "").slice(0, 400) || "the site gave no reason";
}

async function ytDlp(ctx: Ctx, args: string[], signal: AbortSignal, around?: Awaited<ReturnType<typeof surroundings>>): Promise<Buffer> {
  const { ffmpegDir, env } = around ?? await surroundings(ctx);
  return (await downloader(ctx)).run(["--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", ...(ffmpegDir ? ["--ffmpeg-location", ffmpegDir] : []), ...args], { signal, env });
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function about(raw: Record<string, unknown>, asked: string): WebVideoAbout {
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(String(raw.upload_date ?? ""));
  const chapters = Array.isArray(raw.chapters) ? (raw.chapters as Array<Record<string, unknown>>).flatMap(c => {
    const start = number(c.start_time), end = number(c.end_time), title = text(c.title, 200);
    return start !== undefined && end !== undefined && title ? [{ start, end, title }] : [];
  }) : [];
  return {
    url: text(raw.webpage_url, 2048) ?? asked,
    title: text(raw.title, 300) ?? "Untitled",
    channel: text(raw.channel, 200) ?? text(raw.uploader, 200),
    duration: number(raw.duration),
    uploaded: day ? `${day[1]}-${day[2]}-${day[3]}` : undefined,
    license: text(raw.license, 200),
    width: number(raw.width),
    height: number(raw.height),
    ...(chapters.length && { chapters }),
    description: text(raw.description, 2000),
  };
}

/** Every address a reading would fetch from is on the public web: a site's page can point anywhere. */
async function publicOnly(raw: Record<string, unknown>) {
  const hosts = new Map<string, string>();
  const note = (value: unknown) => {
    if (typeof value !== "string" || !/^https?:/i.test(value)) return;
    try { const url = new URL(value); if (!hosts.has(url.host)) hosts.set(url.host, url.origin); } catch { /* not an address */ }
  };
  note(raw.webpage_url); note(raw.url); note(raw.manifest_url);
  for (const list of [raw.formats, raw.requested_formats]) {
    if (Array.isArray(list)) for (const f of list as Array<Record<string, unknown>>) { note(f.url); note(f.manifest_url); }
  }
  for (const origin of hosts.values()) await publicWebAddress(origin);
}

/** Read one video's page: what it is, and where its picture, sound and captions are. Kept a while, so its parts skip the reading. */
function read(ctx: Ctx, url: string, signal: AbortSignal): Promise<Reading> {
  const known = readings.get(url);
  if (known) {
    return known.then(r => Date.now() - r.at < KEEP_MS ? r : (forget(url, known), read(ctx, url, signal)),
      () => { if (readings.get(url) === known) readings.delete(url); return read(ctx, url, signal); });
  }
  const reading = (async () => {
    const folder = await mkdtemp(join(tmpdir(), "scarlet-web-video-"));
    try {
      const out = await ytDlp(ctx, ["-J", "--", url], signal).catch((error: Error) => {
        if (signal.aborted) throw error;
        throw new HttpError(502, "video_failed", `Couldn't read that video: ${said(error)}`);
      });
      const raw = JSON.parse(out.toString("utf8")) as Record<string, unknown>;
      if (raw._type === "playlist") throw badRequest("bad_url", "That address is a list of videos. Give the address of one video.");
      if (raw.is_live === true) throw badRequest("bad_url", "That video is live. Only a finished video can be used.");
      await publicOnly(raw);
      const info = join(folder, "info.json");
      await writeFile(info, out);
      return { folder, info, about: about(raw, url), raw, at: Date.now() };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  })();
  readings.set(url, reading);
  reading.catch(() => { if (readings.get(url) === reading) readings.delete(url); });
  // Old readings go as new ones come: each holds only a page's worth of text.
  for (const [key, old] of [...readings].slice(0, -16)) forget(key, old);
  return reading;
}

export async function aboutWebVideo(ctx: Ctx, raw: string, signal: AbortSignal): Promise<WebVideoAbout> {
  return (await read(ctx, await publicWebAddress(raw), signal)).about;
}

/** The captions to read: the uploader's own in the video's language, else the site's automatic ones in it. */
export function captionTrack(raw: Record<string, unknown>): { language: string; automatic: boolean } | undefined {
  const spoken = text(raw.language, 20) ?? "en";
  const pick = (tracks: unknown, names: string[]) => {
    const have = tracks && typeof tracks === "object" ? Object.keys(tracks).filter(k => k !== "live_chat") : [];
    for (const name of names) {
      const found = have.find(k => k === name) ?? have.find(k => k.startsWith(`${name}-`));
      if (found) return found;
    }
    return have;
  };
  const own = pick(raw.subtitles, [spoken, "en"]);
  if (typeof own === "string") return { language: own, automatic: false };
  const auto = pick(raw.automatic_captions, [`${spoken}-orig`, spoken, "en-orig", "en"]);
  if (typeof auto === "string") return { language: auto, automatic: true };
  // Captions in another language still say where things are.
  return own[0] ? { language: own[0], automatic: false } : undefined;
}

const seconds = (stamp: string) => stamp.split(":").reduce((sum, part) => sum * 60 + Number(part.replace(",", ".")), 0);

/** Captions as lines with the second each starts on, from the two forms sites give: YouTube's JSON and WebVTT. */
export function captionLines(file: string, body: string): CaptionLine[] {
  const lines: CaptionLine[] = [];
  const add = (start: number, said: string) => {
    const words = said.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    // A rolling caption repeats the line before it.
    if (words && Number.isFinite(start) && lines.at(-1)?.text !== words) lines.push({ start: Math.round(start * 10) / 10, text: words });
  };
  if (file.endsWith(".json3")) {
    const events = (JSON.parse(body) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }).events ?? [];
    for (const event of events) add((event.tStartMs ?? NaN) / 1000, (event.segs ?? []).map(s => s.utf8 ?? "").join(""));
    return lines;
  }
  for (const cue of body.replace(/\r/g, "").split(/\n\n+/)) {
    const rows = cue.split("\n");
    const at = rows.findIndex(row => row.includes("-->"));
    const start = at >= 0 ? /^(\d+(?::\d+){1,2}[.,]\d+)/.exec(rows[at]!.trim())?.[1] : undefined;
    if (start) add(seconds(start), rows.slice(at + 1).join(" "));
  }
  return lines;
}

async function readCaptions(ctx: Ctx, reading: Reading, signal: AbortSignal): Promise<Captions | undefined> {
  const track = captionTrack(reading.raw);
  if (!track) return;
  await ytDlp(ctx, ["--load-info-json", reading.info, "--skip-download", track.automatic ? "--write-auto-subs" : "--write-subs",
    "--sub-langs", track.language, "--sub-format", "json3/vtt/best", "-o", join(reading.folder, "captions")], signal).catch((error: Error) => {
    if (signal.aborted) throw error;
    throw new HttpError(502, "video_failed", `Couldn't read that video's captions: ${said(error)}`);
  });
  const file = (await readdir(reading.folder)).find(name => name.startsWith("captions.") && /\.(json3|vtt)$/.test(name));
  if (!file) return;
  return { ...track, lines: captionLines(file, await readFile(join(reading.folder, file), "utf8")) };
}

/**
 * A video's captions, read once for everyone who asks at the same time. The read runs for the caller who started it,
 * so one that caller gave up on is read again for a caller who still wants it, as a shared reading of the page is.
 */
async function captionsOf(ctx: Ctx, reading: Reading, signal: AbortSignal): Promise<Captions | undefined> {
  for (;;) {
    const shared = reading.captions ?? { read: readCaptions(ctx, reading, signal), signal };
    if (!reading.captions) {
      reading.captions = shared;
      shared.read.catch(() => { if (reading.captions === shared) reading.captions = undefined; });
    }
    try {
      return await shared.read;
    } catch (error) {
      if (shared.signal === signal || signal.aborted || !shared.signal.aborted) throw error;
      if (reading.captions === shared) reading.captions = undefined;
    }
  }
}

/**
 * What is said in a video, from a second on: the site's captions as lines of `seconds words`, as much as one call
 * holds, and where to read on when there is more. None for a video the site has no captions for.
 */
export async function webVideoCaptions(ctx: Ctx, raw: string, from: number, signal: AbortSignal) {
  const reading = await read(ctx, await publicWebAddress(raw), signal);
  const captions = await captionsOf(ctx, reading, signal);
  if (!captions) return;
  const rest = captions.lines.filter(line => line.start >= from);
  let size = 0;
  const shown = rest.findIndex(line => (size += String(line.start).length + line.text.length + 2) > CAPTION_CHARS);
  const lines = shown < 0 ? rest : rest.slice(0, Math.max(1, shown));
  return { language: captions.language, automatic: captions.automatic, text: lines.map(line => `${line.start} ${line.text}`).join("\n"),
    ...(lines.length < rest.length && { next: rest[lines.length]!.start }) };
}

/**
 * Save one part of a video: cut exactly at the seconds asked, as H.264 and AAC in an MP4, which every tool here reads,
 * with a picture from its middle to show where it came from. The file waits for `readWebVideoPart`.
 */
export async function saveWebVideoPart(ctx: Ctx, projectId: string, raw: string, range: { from: number; to: number; height: number }, signal: AbortSignal) {
  const url = await publicWebAddress(raw);
  const reading = await read(ctx, url, signal);
  const length = reading.about.duration;
  const to = length ? Math.min(range.to, length) : range.to;
  if (!(to > range.from)) throw badRequest("bad_range", length ? `That part is past the video's end: it is ${length} seconds long.` : "`to` comes after `from`.");
  if (to - range.from > MAX_PART_SECONDS) throw badRequest("bad_range", `One call saves up to ${MAX_PART_SECONDS / 60} minutes. Ask for a shorter part, or for the parts one at a time.`);
  const folder = await mkdtemp(join(tmpdir(), "scarlet-web-video-part-"));
  try {
    const around = await surroundings(ctx);
    await ytDlp(ctx, ["--load-info-json", reading.info, "--download-sections", `*${range.from}-${to}`, "--force-keyframes-at-cuts",
      "-S", `res:${range.height},vcodec:h264,acodec:aac`, "--merge-output-format", "mp4", "-o", join(folder, "part.%(ext)s")], signal, around).catch((error: Error) => {
      if (signal.aborted) throw error;
      // The addresses a reading holds stop working; the next call reads the page again.
      const known = readings.get(url);
      if (known) forget(url, known);
      throw new HttpError(502, "video_failed", `Couldn't download that part: ${said(error)}`);
    });
    const name = (await readdir(folder)).find(n => n.startsWith("part.") && !n.endsWith(".part"));
    if (!name) throw new HttpError(502, "video_failed", "The site gave no video for that part.");
    const file = join(folder, name);
    const probed = JSON.parse((await run(resolveFfprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
      "-of", "json", file], { signal })).toString("utf8")) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    const duration = Number(probed.format?.duration) || to - range.from;
    const poster = await run(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(duration / 2), "-i", file, "-frames:v", "1",
      "-vf", "scale=960:-2:force_original_aspect_ratio=decrease", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { signal }).catch(() => undefined);
    const id = randomUUID();
    parts.set(id, { folder, file, projectId });
    // A part nobody came for doesn't stay on the disk.
    setTimeout(() => { if (parts.delete(id)) void rm(folder, { recursive: true, force: true }); }, KEEP_MS).unref();
    return { about: reading.about, part: { id, from: range.from, to, duration: Math.round(duration * 1000) / 1000, width: probed.streams?.[0]?.width, height: probed.streams?.[0]?.height,
      size: (await stat(file)).size, ...(poster?.length && { poster: poster.toString("base64") }) } };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

/** A saved part's bytes, once: it leaves the engine as it is read. */
export async function readWebVideoPart(projectId: string, id: string): Promise<Buffer> {
  const part = parts.get(id);
  if (!part || part.projectId !== projectId) throw notFound("video part");
  parts.delete(id);
  try { return await readFile(part.file); } finally { await rm(part.folder, { recursive: true, force: true }); }
}
