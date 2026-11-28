/**
 * The folder an editor takes to DaVinci Resolve, Final Cut Pro or Premiere Pro: timeline files, the captions, a Read me
 * and a copy of the footage. The engine says what goes in it; the desktop app writes it where the editor chose.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captionTracks, exactRate, handoffFileNames, handoffLosses, handoffRateWarnings, handoffReadMe, isDropFrameRate,
  styledCaptionFile, parseColor, timecodeFrames, timelineToSrt, toFcpxml, toOtio, usedMedia, type HandoffSource, type Project, type Timeline,
} from "@scarlet/timeline";
import type { HandoffFile } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { clip, humanDuration, logId } from "../logText.js";
import { ffmpeg, ffprobe } from "../render/ffmpeg.js";
import { safeFileName } from "./fileName.js";

interface ProbedStream {
  codec_type?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}

/** What another app needs to know about a file that Scarlet's own record leaves out: its timecode and its sound. */
async function probeForHandoff(file: string, signal?: AbortSignal, unreadable?: (reason: string) => void) {
  try {
    const out = await ffprobe(["-print_format", "json", "-show_format", "-show_streams", file], { signal });
    const json = JSON.parse(out.toString("utf8")) as { format?: { tags?: Record<string, string> }; streams?: ProbedStream[] };
    const streams = json.streams ?? [];
    const audio = streams.filter(s => s.codec_type === "audio");
    const video = streams.find(s => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
    const timecode = streams.find(s => s.codec_type === "data" && s.tags?.timecode)?.tags?.timecode ?? video?.tags?.timecode ??
      json.format?.tags?.timecode;
    return { timecode, audioStreams: audio.length, channels: audio[0]?.channels, sampleRate: Number(audio[0]?.sample_rate) || undefined };
  } catch (error) {
    // A file ffprobe can't read still goes in the folder; it starts at zero.
    unreadable?.((error as Error)?.message ?? String(error));
    return { audioStreams: undefined, channels: undefined, sampleRate: undefined, timecode: undefined };
  }
}

/** A frame-sized PNG of one colour, for a solid colour clip: every app reads a still, and none shares a solid generator. */
async function solidPng(color: string, width: number, height: number, signal?: AbortSignal): Promise<Buffer> {
  const { color: c, alpha } = parseColor(color)!;
  return ffmpeg(["-f", "lavfi", "-i", `color=c=${c}@${alpha}:s=${width}x${height}`, "-frames:v", "1", "-pix_fmt", "rgba",
    "-f", "image2pipe", "-c:v", "png", "pipe:1"], { signal });
}

export interface Handoff {
  /** The folder's contents, paths relative to it. */
  files: HandoffFile[];
  /** Bytes of footage the folder copies. */
  mediaBytes: number;
}

/**
 * Everything the hand-off folder holds. `folder` is where the desktop app will write it, so the timeline files can
 * link the copies by their full path, which every app opens without asking.
 */
export async function buildHandoff(ctx: Ctx, project: Project, timeline: Timeline, folder: string, signal?: AbortSignal): Promise<Handoff> {
  if (!isAbsolute(folder)) throw badRequest("handoff_folder", "Choose where to save the folder.");
  const started = Date.now();
  let unreadable = 0, stillsMade = 0;
  const base = safeFileName(folder.split(/[\\/]/).filter(Boolean).pop() || project.name).trim() || "Scarlet";
  const assets = usedMedia(project, timeline);
  const colors = [...new Set(timeline.tracks.flatMap(track => track.clips.flatMap(clip => clip.kind === "color" && parseColor(clip.color) ? [clip.color] : [])))];
  const names = handoffFileNames([
    ...assets.map(a => extname(a.name) ? a.name : `${a.name}${extname(a.path)}`),
    ...colors.map(color => `Solid ${color.replace(/^#/, "")}.png`),
  ]);
  const mediaUrl = (name: string) => pathToFileURL(join(folder, "Media", name)).href;
  const files: HandoffFile[] = [];
  const sources = new Map<string, HandoffSource>();
  let mediaBytes = 0;
  const root = ctx.paths.media(project.id);
  for (const [i, asset] of assets.entries()) {
    const file = join(root, asset.path);
    const size = await stat(file).then(s => s.size, () => undefined);
    if (size === undefined) throw badRequest("handoff_media_missing", `“${asset.name}” isn't in the project's media any more.`);
    mediaBytes += size;
    const probed = await probeForHandoff(file, signal, reason => {
      unreadable++;
      ctx.log(`[export] hand-off of ${logId(project.id)}: ffprobe couldn’t read ${logId(asset.id)}, so it starts at zero: ${clip(reason)}`);
    });
    const rate = asset.kind === "video" || asset.kind === "graphic" ? exactRate(asset.fps ?? project.settings.fps).rate : undefined;
    const tcRate = rate ?? exactRate(project.settings.fps).rate;
    const frames = probed.timecode ? timecodeFrames(probed.timecode, tcRate) : undefined;
    sources.set(asset.id, {
      url: mediaUrl(names[i]!), fileName: names[i]!,
      timecode: frames ? { frames, rate: tcRate, dropFrame: /[;,]/.test(probed.timecode!) && isDropFrameRate(tcRate) } : undefined,
      rate, width: asset.width, height: asset.height,
      hasVideo: asset.kind !== "audio", hasAudio: asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio !== false),
      audioChannels: probed.channels, audioRate: probed.sampleRate, audioStreams: probed.audioStreams,
      duration: asset.duration ?? 0, still: asset.kind === "image" || (asset.kind === "graphic" && !asset.duration),
    });
    files.push({ path: `Media/${names[i]}`, source: file, size });
  }

  // Solid colour clips become stills of their colour.
  const colorStills = new Map<string, HandoffSource>();
  const { width, height } = project.settings;
  for (const [i, color] of colors.entries()) {
    const name = names[assets.length + i]!;
    colorStills.set(color, { url: mediaUrl(name), fileName: name, hasVideo: true, hasAudio: false, width, height, duration: 0, still: true });
    // Kept in the library's temporary folder, where the desktop app copies from; the same colour and size reuse it.
    const still = join(ctx.paths.tmp, "handoff", `${Buffer.from(`${color}:${width}x${height}`).toString("hex")}.png`);
    const size = await stat(still).then(s => s.size, async () => {
      await mkdir(join(ctx.paths.tmp, "handoff"), { recursive: true });
      const png = await solidPng(color, width, height, signal);
      stillsMade++;
      const staged = `${still}.${randomUUID()}.part`;
      try {
        await writeFile(staged, png);
        await rename(staged, still);
      } finally {
        await rm(staged, { force: true });
      }
      return png.length;
    });
    files.push({ path: `Media/${name}`, source: still, size });
  }

  const fcpxml = `${base}.fcpxml`, otio = `${base}.otio`;
  files.unshift(
    { path: fcpxml, text: toFcpxml(project, timeline, sources, { colorStills }) },
    { path: otio, text: JSON.stringify(toOtio(project, timeline, { sources }), null, 2) },
  );
  const captions = captionTracks(timeline);
  const captionFiles = handoffFileNames(captions.map(({ track }) =>
    captions.length > 1 ? `${base} captions (${safeFileName(track.name)}).srt` : `${base} captions.srt`));
  const styledFiles: string[] = [];
  for (const [i, { track, cues }] of captions.entries()) {
    files.push({ path: captionFiles[i]!, text: timelineToSrt(timeline, { trackId: track.id }) });
    const text = styledCaptionFile(project, timeline, track, cues);
    if (text) {
      const path = captionFiles[i]!.replace(/\.srt$/, ".ass");
      files.push({ path, text });
      styledFiles.push(path);
    }
  }
  files.push({ path: "Read me.txt", text: handoffReadMe({
    projectName: project.name, timelineFiles: { fcpxml, otio }, captionFiles, styledFiles,
    losses: handoffLosses(project, timeline, sources), warnings: handoffRateWarnings(project, timeline, sources),
  }) });
  ctx.log(`[export] hand-off of ${logId(project.id)} ready in ${humanDuration(Date.now() - started)}: ${assets.length} footage ${assets.length === 1 ? "file" : "files"}`
    + ` (${(mediaBytes / 1e6).toFixed(1)} MB), ${colors.length} colour ${colors.length === 1 ? "still" : "stills"} (${stillsMade} made, ${colors.length - stillsMade} reused),`
    + ` ${captions.length} caption ${captions.length === 1 ? "file" : "files"}${unreadable ? `, ${unreadable} ffprobe couldn’t read` : ""}`);
  return { files, mediaBytes };
}
