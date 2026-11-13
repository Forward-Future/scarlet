/**
 * Content-addressed segment cache. A full render is split into short segments
 * cut at clip boundaries where possible; each segment's key hashes exactly the
 * cut-list state that can affect its pixels and samples, so a change to one
 * clip only re-encodes the segments it touches. Assembly is a stream copy.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipRange, mergeRanges, sha256, planPlaybackSegments, planSegments, snapToFrame, SOURCE_PREVIEW_SECONDS, stableStringify, timelineDuration } from "@scarlet/timeline";
import type { Clip, MediaAsset, Project, Timeline, TimeRange, Track } from "@scarlet/timeline";
import { buildFilterGraph, clipPlacement, fillsFrames, holdsFrame, holdsSample, proxyHeightForClip, videoClockStart } from "./graph.js";
import { isImagePath } from "./probe.js";
import { copyOriginalPicture, wholeOriginalPicture } from "./pictureCopy.js";
import { effectKind } from "./effects.js";
import { fileInDirectory } from "./assetPath.js";
import { FfmpegError, failureReason, fnum, runFfmpeg, LOCAL_MEDIA_INPUT } from "./exec.js";
import { outputSize, renderRange, type RenderOptions, type RenderQuality } from "./render.js";

import { resolveEncoding, withRenderEncoder } from "./encoder.js";

export { planSegments } from "@scarlet/timeline";

/** Preserve compositing order while visiting each clip only in segments it intersects. */
function segmentTimelines(timeline: Timeline, ranges: TimeRange[]): Timeline[] {
  const parts: Timeline[] = ranges.map(() => ({
    ...timeline,
    tracks: timeline.tracks.map(track => ({ ...track, clips: [] })),
  }));
  timeline.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      const { start, end } = clipRange(clip);
      let lo = 0;
      let hi = ranges.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ranges[mid]!.end <= start) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < ranges.length && ranges[i]!.start < end; i++) {
        parts[i]!.tracks[trackIndex]!.clips.push(clip);
      }
    }
  });
  return parts;
}

export const RENDER_REVISION = 5;
export const PROXY_CLOCK_REVISION = 3;
export const DELIVERY_AUDIO_REVISION = 4;

/** Old cache entries did not record whether the graph selected a proxy. Only
 * version windows where it could have selected one with a different origin. */
export function usesRevisedProxyClock(project: Project, timeline: Timeline, range: TimeRange, height?: number,
  assets = new Map(project.media.map(asset => [asset.id, asset]))): boolean {
  const size = outputSize(project.settings, "preview", height);
  return timeline.tracks.some(track => track.kind === "video" && !track.hidden && track.clips.some(clip => {
    if (clip.kind !== "media" || clip.enabled === false) return false;
    const asset = assets.get(clip.mediaId);
    if (!asset || asset.hasAlpha !== false || !asset.fps || !asset.height ||
        (asset.kind !== "video" && (asset.kind !== "graphic" || isImagePath(asset.path)))) return false;
    const placement = clipPlacement(clip, range, 0.5 / project.settings.fps);
    if (!placement) return false;
    const needed = proxyHeightForClip(clip, asset, size.width, size.height);
    if (needed === undefined || needed > Math.min(720, asset.height)) return false;
    // Stored absolute PTS alone cannot rule out leading audio in an older file.
    if (asset.previewClock?.videoStart !== 0) return true;
    const framesPerChunk = asset.fps * SOURCE_PREVIEW_SECONDS;
    const sourceEnd = clip.sourceIn + (placement.local0 + placement.vis) * clip.speed;
    return asset.previewClock.startPts === 0 && needed <= Math.min(480, asset.height) &&
      Math.abs(framesPerChunk - Math.round(framesPerChunk)) > 1e-6 && sourceEnd > SOURCE_PREVIEW_SECONDS;
  }));
}

export interface SegmentKeyOptions {
  quality: RenderQuality;
  /** Preview canvas height actually used. */
  height?: number;
  encoder?: string;
  pictureOnly?: boolean;
  /** Keep proxy-eligible previews separate from renders which require original pictures. */
  allowProxy?: boolean;
}

function mediaFingerprint(asset: MediaAsset | undefined, format: SegmentKeyOptions) {
  if (!asset) return null;
  // Prefer the content hash; fall back to the path (then edits in place go unnoticed).
  return {
    hash: asset.hash ?? null,
    path: asset.hash ? undefined : asset.path,
    kind: asset.kind,
    hasAudio: format.pictureOnly ? undefined : asset.hasAudio,
    sourceAlpha: format.pictureOnly || format.allowProxy ? asset.hasAlpha : undefined,
    proxyGeometry: format.allowProxy ? [asset.width, asset.height, asset.fps, asset.previewClock] : undefined,
  };
}

/** Fingerprint times at the precision passed to FFmpeg. Include sample offsets
 * separately: adelay rounds to samples before formatting its argument. */
function segmentClip(clip: Clip, range: TimeRange, media: Map<string, MediaAsset>, settings: Project["settings"], track: Pick<Track, "kind" | "hidden" | "muted">, format: SegmentKeyOptions) {
  const p = clipPlacement(clip, range, 0.5 / settings.sampleRate);
  if (!p) return undefined;
  const source = clip.kind === "media" ? media.get(clip.mediaId) : undefined;
  const still = !!source && (source.kind === "image" || (source.kind === "graphic" && isImagePath(source.path)));
  // As the graph places it: a clip is in a section for a frame of its picture or, with less than that, for a sample
  // of sound that is heard, from a file that has some.
  const heard = clip.kind === "media" && !format.pictureOnly && !track.muted && clip.volume > 0 && !!source && !still &&
    (source.kind === "audio" || source.hasAudio !== false) && holdsSample(p.vis * (clip.speed ?? 1), settings.sampleRate);
  if (track.kind !== "audio" && !holdsFrame(p, settings.fps, still) && !heard) return undefined;
  const { id: _id, label: _label, timelineIn, ...rest } = clip;
  const placement = { start: fnum(p.pos), end: fnum(p.pos + p.vis), duration: fnum(p.vis) };
  if (rest.kind !== "media") {
    const { timelineOut: _out, ...visual } = rest;
    return { ...visual, placement };
  }
  const asset = media.get(rest.mediaId);
  // Footage off the project's frames is drawn filled to them. Saying so here sets its sections apart from the ones
  // cached before it was, and leaves every other clip's part of the key as it has been.
  const frameFill = (track.kind === "video" && !track.hidden && !!asset && fillsFrames(rest, asset, settings.fps)) || undefined;
  if (!asset?.hash || rest.effects.some(effect => effect.enabled && effect.type === "lut")) {
    // Pending/legacy sources and external LUTs retain the old placement-sensitive identity.
    return { ...rest, timelineIn, range, media: mediaFingerprint(asset, format), frameFill };
  }
  const { sourceIn, sourceOut: _out, ...input } = rest;
  const videoStart = videoClockStart(rest, p.local0);
  const audioStart = rest.audioFadeIn || rest.audioFadeOut ? p.local0 : 0;
  const fadeStart = (duration: number) => {
    const start = Math.max(0, p.clipDur - duration);
    return duration > 0 && start <= p.local0 + p.vis + 1 / settings.fps ? fnum(start) : undefined;
  };
  return { ...input, placement, media: mediaFingerprint(asset, format),
    seek: fnum(sourceIn + p.local0 * rest.speed), sourceDuration: fnum(p.vis * rest.speed),
    videoStart: fnum(videoStart), audioStart: fnum(audioStart), shift: fnum(p.pos - videoStart), delaySamples: format.pictureOnly ? undefined : Math.round(p.pos * settings.sampleRate),
    videoFadeStart: fadeStart(rest.videoFadeOut), audioFadeStart: fadeStart(rest.audioFadeOut), frameFill };
}

/** Fingerprint the rendered window independently of its absolute timeline position. */
export function segmentKey(
  project: Project,
  timeline: Timeline,
  range: TimeRange,
  quality: RenderQuality | SegmentKeyOptions,
  media = new Map(project.media.map(asset => [asset.id, asset])),
): string {
  const o: SegmentKeyOptions = typeof quality === "string" ? { quality } : quality;
  const tracks = timeline.tracks
    .map((t) => {
      const clips = t.clips.filter(c => c.enabled !== false)
        .map(c => segmentClip(c, range, media, project.settings, t, o)).filter(c => c !== undefined);
      return { kind: t.kind, muted: t.muted, hidden: t.hidden, captionStyle: t.captionStyle, clips };
    })
    .filter((t) => t.clips.length > 0);
  return createHash("sha256").update(stableStringify({
    v: RENDER_REVISION,
    proxyClock: o.allowProxy && o.quality === "preview" && !o.pictureOnly && usesRevisedProxyClock(project, timeline, range, o.height, media) ? PROXY_CLOCK_REVISION : undefined,
    pictureOnly: o.pictureOnly || undefined,
    allowProxy: o.allowProxy || undefined,
    settings: o.pictureOnly ? { width: project.settings.width, height: project.settings.height, fps: project.settings.fps } : project.settings,
    background: timeline.background,
    captionStyle: timeline.captionStyle ?? null,
    quality: o.quality,
    height: o.height ?? null,
    encoder: o.encoder ?? null,
    duration: fnum(range.end - range.start),
    tracks,
  })).digest("hex");
}

/** Plan and key delivery picture independently of audio cuts, gain, channel routing and fades. */
function deliveryPicture(project: Project, timeline: Timeline): Timeline {
  const audioAssets = new Set(project.media.filter(asset => asset.kind === "audio").map(asset => asset.id));
  const tracks = timeline.tracks
    .filter(track => track.kind !== "audio" && !track.hidden)
    .map(track => {
      const clips = track.clips
        .filter(clip => clip.enabled !== false && (clip.kind !== "media" || !audioAssets.has(clip.mediaId)))
        .map(clip => clip.kind !== "media" ? clip : {
          ...clip, volume: 0, audioFadeIn: 0, audioFadeOut: 0,
          effects: clip.effects.filter(effect => effectKind(effect.type) !== "audio"),
        });
      return { ...track, muted: false, clips };
    });
  return { ...timeline, tracks };
}

export interface AssembleOptions {
  /** Frame-snapped section lengths. Container audio padding must not move a later picture. */
  pictureDurations?: number[];
  /** Completed gapless AAC program. Keep its MP4 priming edit intact during remux. */
  completedAudio?: { file: string; pictureDurations: number[]; sampleRate: number };
  ffmpegPath?: string;
  signal?: AbortSignal;
  tempDir?: string;
}

function concatFile(f: string): string {
  return `file '${path.resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

/** Concatenate identically-encoded mp4 segments without re-encoding. */
export async function assembleSegments(files: string[], output: string, opts: AssembleOptions = {}): Promise<void> {
  if (!files.length) throw new Error("no segments to assemble");
  const tmp = await fs.mkdtemp(path.join(opts.tempDir ?? os.tmpdir(), "scarlet-concat-"));
  try {
    const audio = opts.completedAudio;
    const durations = audio?.pictureDurations ?? opts.pictureDurations;
    if (durations && durations.length !== files.length) throw new Error("Picture duration count differs.");
    const list = files.map((file, i) => {
      const entry = concatFile(file);
      return durations ? entry + "\nduration " + durations[i]!.toFixed(9) : entry;
    });
    const listPath = path.join(tmp, "segments.txt");
    await fs.writeFile(listPath, list.join("\n") + "\n");
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    const input = ["-f", "concat", "-safe", "0", "-i", listPath];
    const streams = audio
      ? [...input, ...LOCAL_MEDIA_INPUT, "-i", audio.file, "-map", "0:v:0", "-map", "1:a:0", "-movie_timescale", String(audio.sampleRate)]
      : input;
    // The concat demuxer exposes AAC priming before zero. Rebasing that first
    // packet to zero would delay every picture of an assembled preview by 1024 samples.
    await runFfmpeg(["-y", "-copyts", ...streams, "-map_chapters", "-1", "-avoid_negative_ts", "disabled", "-c", "copy", "-movflags", "+faststart", output],
      { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export interface CachedRenderOptions extends RenderOptions {
  onCachedRanges?: (ranges: TimeRange[]) => void;
  exportRange?: TimeRange;
  omitCaptions?: boolean;
  segmentSeconds?: number;
  /** Segments rendered at once (default 1; ffmpeg is already multi-threaded). */
  concurrency?: number;
}

export interface SegmentInfo {
  range: TimeRange;
  key: string;
  file: string;
  /** True when the segment was already in the cache. */
  cached: boolean;
}

export interface CachedRenderResult {
  output: string;
  duration: number;
  segments: SegmentInfo[];
  rendered: number;
  reused: number;
  encoder: string;
  warnings: string[];
}

async function fileHasContent(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function publishSegment(temp: string, file: string): Promise<void> {
  try {
    await fs.rename(temp, file);
  } catch (err) {
    // Windows can lock a segment that a competing export has already started reading.
    const code = (err as NodeJS.ErrnoException).code;
    if (!["EPERM", "EACCES", "EEXIST"].includes(code ?? "") || !(await fileHasContent(file))) throw err;
    await fs.rm(temp);
  }
}

/** A LUT is an external file rather than an immutable media row. Include its current identity in cached pictures. */
export function lutFileStamps(timeline: Timeline, mediaRoot: string) {
  const names = new Set<string>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind !== "media" || clip.enabled === false) continue;
    for (const effect of clip.effects) {
      if (effect.type !== "lut" || !effect.enabled) continue;
      const name = typeof effect.params.file === "string" ? effect.params.file : effect.params.path;
      if (typeof name === "string") names.add(name);
    }
  }
  return [...names].sort().map(name => {
    const file = fileInDirectory(mediaRoot, name);
    const info = file && statSync(file, { throwIfNoEntry: false });
    return [name, info ? [file, info.size, info.mtimeMs, info.ctimeMs] : null];
  });
}

function segmentInfo(project: Project, timeline: Timeline, range: TimeRange, cacheDir: string, format: SegmentKeyOptions, mediaRoot: string, media?: Map<string, MediaAsset>): SegmentInfo {
  let key = segmentKey(project, timeline, range, format, media);
  const luts = lutFileStamps(timeline, mediaRoot);
  if (luts.length) key = sha256(stableStringify([key, luts]));
  const file = path.join(cacheDir, `${key}.mp4`);
  return { range, key, file, cached: false };
}

async function writeSegment(project: Project, timeline: Timeline, segment: SegmentInfo, opts: RenderOptions): Promise<string[]> {
  // A long export plans all its segments up front. Playback may have filled this one since then.
  if (await fileHasContent(segment.file)) {
    segment.cached = true;
    return [];
  }
  const temp = `${segment.file}.${randomUUID()}.part.mp4`;
  try {
    const result = await renderRange(project, timeline, segment.range, temp, { ...opts, cacheIntermediate: true });
    await publishSegment(temp, segment.file);
    return result.warnings;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Bounds for one multi-part encode: decoders opened together and work lost to a cancellation. */
const RUN_PARTS = 8;
const RUN_SECONDS = 40;
const RUN_MEDIA_CLIPS = 6;

type PendingSegment = readonly [SegmentInfo, number];

/** Group adjacent missing segments so one decode of their sources serves all of them. */
function planRuns(todo: readonly PendingSegment[], parts: Timeline[], maxParts: number): PendingSegment[][] {
  const runs: PendingSegment[][] = [];
  let run: PendingSegment[] = [];
  let clips = new Set<Clip>();
  for (const entry of todo) {
    const [segment, index] = entry;
    const own = parts[index]!.tracks.flatMap(track => track.clips.filter(clip => clip.kind === "media"));
    const merged = new Set([...clips, ...own]);
    const last = run.at(-1);
    if (last && last[1] === index - 1 && run.length < maxParts && merged.size <= RUN_MEDIA_CLIPS &&
        segment.range.end - run[0]![0].range.start <= RUN_SECONDS + 1e-6) {
      run.push(entry);
      clips = merged;
    } else {
      if (run.length) runs.push(run);
      run = [entry];
      clips = new Set(own);
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Encode adjacent segments from one decode. Undefined when another writer owns one of them. */
async function writeRun(project: Project, timeline: Timeline, segments: SegmentInfo[], opts: RenderOptions): Promise<string[] | undefined> {
  for (const segment of segments) {
    if (writingSegments.has(path.resolve(segment.file)) || await fileHasContent(segment.file)) return undefined;
  }
  const range = { start: segments[0]!.range.start, end: segments.at(-1)!.range.end };
  const [part] = segmentTimelines(timeline, [range]);
  const temps = segments.map(segment => `${segment.file}.${randomUUID()}.part.mp4`);
  try {
    const result = await renderRange(project, part!, range, temps[0]!, {
      ...opts, cacheIntermediate: true, onProgress: undefined, splits: segments.map((segment, k) => ({ range: segment.range, output: temps[k]! })),
    });
    for (const [k, segment] of segments.entries()) await publishSegment(temps[k]!, segment.file);
    return result.warnings;
  } finally {
    await Promise.all(temps.map(temp => fs.rm(temp, { force: true })));
  }
}

interface SegmentJob {
  controller: AbortController;
  progress: Set<(fraction: number) => void>;
  result: Promise<string[]>;
}

const writingSegments = new Map<string, SegmentJob>();

async function fillSegment(project: Project, timeline: Timeline, segment: SegmentInfo, opts: RenderOptions): Promise<string[]> {
  const signal = opts.signal;
  signal?.throwIfAborted();
  if (segment.cached) return [];
  const file = path.resolve(segment.file);
  let job = writingSegments.get(file);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const progress = new Set<(fraction: number) => void>();
    const result = writeSegment(project, timeline, segment, {
      ...opts, signal: controller.signal, onProgress: fraction => { for (const report of progress) report(fraction); },
    }).finally(() => {
      if (writingSegments.get(file)?.controller === controller) writingSegments.delete(file);
    });
    job = { controller, progress, result };
    writingSegments.set(file, job);
  } else segment.cached = true;

  // An export and a player can need the same bytes. Each can leave independently.
  const report = (fraction: number) => opts.onProgress?.(fraction);
  job.progress.add(report);
  let abort: (() => void) | undefined;
  try {
    if (!signal) return await job.result;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([job.result, cancelled]);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    job.progress.delete(report);
    if (!job.progress.size && signal?.aborted) {
      job.controller.abort();
      // The last subscriber owns shutdown. A still-active viewer can leave without waiting.
      await job.result.catch(() => undefined);
    }
  }
}

/** Stop siblings on failure and wait for every encoder and temporary file to drain. */
async function renderBatch(
  count: number, concurrency: number, parent: AbortSignal | undefined,
  render: (index: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const failed = new AbortController();
  const signal = parent ? AbortSignal.any([parent, failed.signal]) : failed.signal;
  let next = 0;
  async function worker() {
    try {
      while (next < count && !signal.aborted) await render(next++, signal);
    } catch (error) {
      failed.abort(error);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
  signal.throwIfAborted();
}

/** The caches for the lossless sections and complete program are identified by their inputs. */
function audioMixPlan(project: Project, timeline: Timeline, range: TimeRange, cacheDir: string, output: "mix" | "program", media: Map<string, MediaAsset>) {
  const { sampleRate, audioChannels } = project.settings;
  const inputs = timeline.tracks.flatMap(track => track.clips.flatMap(clip => {
    if (clip.kind !== "media") return [];
    const p = clipPlacement(clip, range, 0.5 / sampleRate);
    if (!p) return [];
    const asset = media.get(clip.mediaId);
    return [{
      source: asset?.hash ?? asset?.path ?? clip.mediaId, kind: asset?.kind, hasAudio: asset?.hasAudio,
      graphicStill: asset?.kind === "graphic" ? isImagePath(asset.path) : undefined,
      videoStart: asset?.previewClock?.videoStart, volume: clip.volume, speed: clip.speed,
      seek: fnum(clip.sourceIn + p.local0 * clip.speed), visible: fnum(p.vis), delay: Math.round(p.pos * sampleRate),
      effects: clip.effects.filter(effect => effectKind(effect.type) !== "video"),
      fades: clip.audioFadeIn || clip.audioFadeOut ? [clip.audioFadeIn, clip.audioFadeOut, p.local0, p.clipDur] : undefined,
    }];
  }));
  const samples = Math.round(range.end * sampleRate) - Math.round(range.start * sampleRate);
  const codec = output === "program" ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "alac"];
  const key = sha256(stableStringify([`delivery-mix-${DELIVERY_AUDIO_REVISION}`, sampleRate, audioChannels, samples, inputs, codec]));
  const file = path.join(cacheDir, output + "-" + key + ".m4a");
  return { timeline, range, samples, codec, file };
}

/** Render original samples. AAC encoder priming belongs to the complete program, never to an interior edit. */
async function mixAudio(project: Project, plan: ReturnType<typeof audioMixPlan>, opts: RenderOptions) {
  const { timeline, range, samples, codec, file } = plan;
  const { sampleRate, audioChannels } = project.settings;
  if (await fileHasContent(file)) return file;
  const temp = file + "." + randomUUID() + ".part.m4a";
  const graph = await buildFilterGraph(project, timeline, range, { ...opts, audioOnly: true, pictureOnly: false, audioSamples: samples });
  try {
    await runFfmpeg(["-y", ...graph.args, "-map_chapters", "-1", ...codec, "-ar", String(sampleRate), "-ac", String(audioChannels), "-movie_timescale", String(sampleRate), temp],
      { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
    await publishSegment(temp, file);
    return file;
  } finally {
    await graph.cleanup();
    await fs.rm(temp, { force: true });
  }
}

function exportSegments(ranges: TimeRange[], trim?: TimeRange): TimeRange[] {
  if (!trim) return ranges;
  return ranges.filter(r => r.end > trim.start && r.start < trim.end)
    .map(r => ({ start: Math.max(trim.start, r.start), end: Math.min(trim.end, r.end) }));
}

/** Each original sample is mixed once. One continuous AAC encode keeps priming out of the joins. */
async function renderProgramAudio(project: Project, timeline: Timeline, cacheDir: string, opts: CachedRenderOptions): Promise<string> {
  const media = new Map(project.media.map(asset => [asset.id, asset]));
  const audible: Timeline = { ...timeline, tracks: timeline.tracks
    .filter(track => track.kind !== "caption" && !track.muted)
    .map(track => ({ ...track, clips: track.clips.filter(clip => clip.kind === "media" &&
      clip.enabled !== false && clip.volume > 0 && media.get(clip.mediaId)?.hasAudio !== false) })) };
  const duration = timelineDuration(timeline);
  // A short cut list fits one FFmpeg graph. Bound the number of simultaneously open
  // decoders on busy cuts by mixing to sample-counted lossless segments instead.
  if (audible.tracks.reduce((n, track) => n + track.clips.length, 0) <= 16) {
    const range = opts.exportRange ?? { start: 0, end: snapToFrame(duration, project.settings.fps) };
    return mixAudio(project, audioMixPlan(project, audible, range, cacheDir, "program", media), opts);
  }
  const ranges = exportSegments(planSegments(project, audible, 10, duration), opts.exportRange);
  const parts = segmentTimelines(audible, ranges);
  const mixes = ranges.map((range, i) => audioMixPlan(project, parts[i]!, range, cacheDir, "mix", media));
  const files = mixes.map(mix => mix.file);
  const { sampleRate, audioChannels } = project.settings;
  const key = sha256(stableStringify(["delivery-aac-1", sampleRate, audioChannels, "192k", files.map(f => path.basename(f))]));
  const file = path.join(cacheDir, "program-" + key + ".m4a");
  if (await fileHasContent(file)) return file;
  await renderBatch(mixes.length, Math.max(1, opts.concurrency ?? 1), opts.signal, async (i, signal) => {
    await mixAudio(project, mixes[i]!, { ...opts, signal });
  });
  // Another export may have finished the program while its sections were being mixed.
  if (await fileHasContent(file)) return file;
  const temp = await fs.mkdtemp(path.join(opts.tempDir ?? os.tmpdir(), "scarlet-sound-"));
  const staged = file + "." + randomUUID() + ".part.m4a";
  try {
    const list = path.join(temp, "sound.txt");
    await fs.writeFile(list, files.map(concatFile).join("\n") + "\n");
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:a:0", "-map_chapters", "-1",
      "-af", "asetpts=N/SR/TB", "-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate), "-ac", String(audioChannels), "-movie_timescale", String(sampleRate), staged],
      { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
    await publishSegment(staged, file);
    return file;
  } finally {
    await fs.rm(staged, { force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export interface PlaybackSegmentResult {
  /** What the render skipped, replaced or fell back from. No render warnings when the section was already cached. */
  warnings: string[];
}

/**
 * Reuse the same encoded range as a full preview. Copy the video and package independently decodable audio for streaming.
 * Resolves with the render's warnings. The type leaves room for a stand-in that resolves with nothing.
 */
export async function renderPlaybackSegment(project: Project, timeline: Timeline, range: TimeRange, cacheDir: string, output: string, opts: RenderOptions): Promise<PlaybackSegmentResult | void> {
  const quality = "preview";
  const size = outputSize(project.settings, quality, opts.height, opts.exportHeight);
  const warnings: string[] = [];
  const videoEncoder = await resolveEncoding(opts.hwaccel, opts.ffmpegPath, { ...size, fps: project.settings.fps }, quality,
    reason => warnings.push(reason));
  const encoder = videoEncoder.cacheKey;
  await fs.mkdir(cacheDir, { recursive: true });
  const [part] = segmentTimelines(timeline, [range]);
  const seg = segmentInfo(project, part!, range, cacheDir, { quality, height: size.height, encoder, allowProxy: !!opts.pictureSource }, opts.mediaRoot);
  seg.cached = await fileHasContent(seg.file);
  warnings.push(...await fillSegment(project, part!, seg, { ...opts, videoEncoder, quality, pictureOnly: false }));
  // Decode AAC with its MP4 priming edit intact. FLAC has no encoder delay, so
  // appending the next fragment neither drops nor repeats audio at the join.
  const rate = project.settings.sampleRate;
  const samples = Math.round(range.end * rate) - Math.round(range.start * rate);
  await runFfmpeg(["-y", "-i", seg.file, "-map_chapters", "-1", "-c:v", "copy", "-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "0",
    "-af", `apad,atrim=end_sample=${samples}`, "-strict", "experimental",
    "-movflags", "+frag_keyframe+default_base_moof+delay_moov", "-avoid_negative_ts", "disabled", output],
    { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  return { warnings };
}

/** Render only the segments missing from `cacheDir`, then concatenate everything into `output`. */
export async function renderFullCached(
  project: Project,
  timeline: Timeline,
  cacheDir: string,
  output: string,
  opts: CachedRenderOptions,
): Promise<CachedRenderResult> {
  const quality = opts.quality ?? "preview";
  const size = outputSize(project.settings, quality, opts.height, opts.exportHeight);
  if (!opts.videoEncoder) {
    return withRenderEncoder({ ...size, fps: project.settings.fps }, opts,
      attempt => renderFullCached(project, timeline, cacheDir, output, attempt));
  }
  const pictureOnly = quality === "delivery" || opts.exportHeight !== undefined;
  const visible = opts.omitCaptions ? { ...timeline, tracks: timeline.tracks.filter(t => t.kind !== "caption") } : timeline;
  const picture = pictureOnly ? deliveryPicture(project, visible) : visible;
  const ranges = exportSegments(!pictureOnly && !opts.omitCaptions && opts.segmentSeconds === undefined
    ? planPlaybackSegments(project, timeline)
    : planSegments(project, picture, opts.segmentSeconds, timelineDuration(timeline)), opts.exportRange);
  if (!ranges.length) throw new Error("timeline is empty");
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const encoder = opts.videoEncoder.name;
  await fs.mkdir(cacheDir, { recursive: true });

  const parts = segmentTimelines(picture, ranges);
  const format = { quality, height: size.height, encoder: opts.videoEncoder.cacheKey, pictureOnly, allowProxy: !pictureOnly && !!opts.pictureSource };
  const media = new Map(project.media.map(asset => [asset.id, asset]));
  const segments = ranges.map((range, i) => segmentInfo(project, parts[i]!, range, cacheDir, format, opts.mediaRoot, media));
  for (let i = 0; i < segments.length; i += 32) {
    await Promise.all(segments.slice(i, i + 32).map(async seg => { seg.cached = await fileHasContent(seg.file); }));
  }

  const total = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  let published = mergeRanges(segments.filter(s => s.cached).map(s => s.range));
  opts.onCachedRanges?.(published);
  const progress: number[] = segments.map((s) => (s.cached ? 1 : 0));
  let completed = segments.reduce((sum, s, i) => sum + progress[i]! * (s.range.end - s.range.start), 0);
  const report = (i: number, fraction: number) => {
    if (!opts.onProgress || fraction === progress[i]) return;
    const { start, end } = ranges[i]!;
    completed += (fraction - progress[i]!) * (end - start);
    progress[i] = fraction;
    opts.onProgress(Math.min(0.97, completed / total * 0.97));
  };
  opts.onProgress?.(completed / total * 0.97);

  const todo = segments.map((s, i) => [s, i] as const).filter(([s]) => !s.cached);
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const probes = opts.probes ?? new Map();
  // Never replace reusable encoded sections. A whole, untouched picture with a cold cache can instead be remuxed losslessly.
  if (quality === "delivery" && todo.length === segments.length && !opts.exportRange && !opts.extraArgs?.length && !opts.splits?.length) {
    const original = await wholeOriginalPicture(project, picture, total, size, opts);
    if (original) {
      const audio = await renderProgramAudio(project, timeline, cacheDir, { ...opts, probes });
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      const staged = output + "." + randomUUID() + ".assembly.mp4";
      try {
        const copied = await copyOriginalPicture(original, audio, staged, project.settings, opts).catch((error: unknown) => {
          opts.signal?.throwIfAborted();
          if (!(error instanceof FfmpegError)) throw error;
          warn(`Could not copy the original picture (${failureReason(error)}); rendered the edit instead.`);
          return false;
        });
        if (copied) {
          opts.signal?.throwIfAborted();
          await fs.rename(staged, output);
          opts.onProgress?.(1);
          return { output, duration: total, segments: [], rendered: 0, reused: 0, encoder: "copy", warnings };
        }
      } finally { await fs.rm(staged, { force: true }); }
    }
  }
  // Previews are short sections of long-GOP sources. Decoding each from its keyframe
  // in its own process costs more than the encode, so adjacent sections share one.
  const runs = planRuns(todo, parts, quality === "preview" && !pictureOnly ? RUN_PARTS : 1);
  const complete = (seg: SegmentInfo, i: number, messages: string[]) => {
    if (opts.onCachedRanges) {
      published = mergeRanges([...published, seg.range]);
      opts.onCachedRanges(published);
    }
    report(i, 1);
    messages.forEach(warn);
  };
  const encodePictures = (signal: AbortSignal) => renderBatch(runs.length, concurrency, signal, async (index, workerSignal) => {
    const run = runs[index]!;
    const partOpts = { ...opts, signal: workerSignal, probes, quality, pictureOnly };
    if (run.length > 1) {
      const messages = await writeRun(project, picture, run.map(([seg]) => seg), partOpts).catch((error: unknown) => {
        // A driver can refuse several encoder sessions in one process. Encode the parts one at a time.
        if (workerSignal.aborted || !(error instanceof FfmpegError)) throw error;
        warn(`${run.length} sections could not be encoded in one pass (${failureReason(error)}); encoded them one at a time.`);
        return undefined;
      });
      if (messages) {
        for (const [seg, i] of run) complete(seg, i, messages);
        return;
      }
    }
    for (const [seg, i] of run) {
      complete(seg, i, await fillSegment(project, parts[i]!, seg, { ...partOpts, onProgress: fraction => report(i, fraction) }));
    }
  });
  let sound: string | undefined;
  // FFmpeg normally runs its video and audio encoders together. Keep one independent
  // sound worker alongside picture, draining both before a cancellation returns.
  await renderBatch(pictureOnly ? 2 : 1, 2, opts.signal, async (phase, signal) => {
    if (phase === 0) await encodePictures(signal);
    else sound = await renderProgramAudio(project, timeline, cacheDir, { ...opts, probes, quality, concurrency: 1, signal });
  });

  const assembled = output + "." + randomUUID() + ".assembly.mp4";
  try {
    const pictureDurations = ranges.map(r => r.end - r.start);
    await assembleSegments(segments.map(s => s.file), assembled, {
      ffmpegPath:opts.ffmpegPath, signal:opts.signal, tempDir:opts.tempDir,
      pictureDurations, completedAudio: sound ? { file: sound, pictureDurations, sampleRate: project.settings.sampleRate } : undefined,
    });
    await fs.rename(assembled, output);
  } finally {
    await fs.rm(assembled, { force:true });
  }
  opts.onProgress?.(1);

  const reused = segments.filter(segment => segment.cached).length;
  return {
    output,
    duration: total,
    segments,
    rendered: segments.length - reused,
    reused,
    encoder,
    warnings,
  };
}
