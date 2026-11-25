/**
 * Content-addressed segment cache. A full render is split into short segments
 * cut at clip boundaries where possible; each segment's key hashes exactly the
 * cut-list state that can affect its pixels and samples, so a change to one
 * clip only re-encodes the segments it touches. Assembly is a stream copy.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mergeRanges, planPlaybackSegments, planSegments, timelineDuration } from "@scarlet/timeline";
import type { Clip, Project, Timeline, TimeRange } from "@scarlet/timeline";
import { withRenderEncoder } from "./encoder.js";
import { FfmpegError, LOCAL_MEDIA_INPUT, failureReason, runFfmpeg, sampleCount } from "./exec.js";
import { copyOriginalPicture, wholeOriginalPicture } from "./pictureCopy.js";
import { renderProgramAudio } from "./programAudio.js";
import { outputSize, renderRange, type RenderOptions } from "./render.js";
import {
  DELIVERY_AUDIO_REVISION,
  PROXY_CLOCK_REVISION,
  RENDER_REVISION,
  TRANSITION_RENDER_REVISION,
  deliveryPicture,
  lutFileStamps,
  segmentInfo,
  segmentKey,
  usesRevisedProxyClock,
  type SegmentInfo,
  type SegmentKeyOptions,
} from "./segmentKey.js";
import {
  concatFile,
  exportSegments,
  fileHasContent,
  publishSegment,
  renderBatch,
  segmentTimelines,
  withStagedFile,
  withTempDir,
} from "./segmentUtils.js";
import { planTransitions } from "./transitions.js";

export {
  DELIVERY_AUDIO_REVISION,
  PROXY_CLOCK_REVISION,
  RENDER_REVISION,
  TRANSITION_RENDER_REVISION,
  lutFileStamps,
  segmentKey,
  usesRevisedProxyClock,
  type SegmentInfo,
  type SegmentKeyOptions,
};

export interface AssembleOptions {
  /** Frame-snapped section lengths. Container audio padding must not move a later picture. */
  pictureDurations?: number[];
  /** Completed gapless AAC program. Keep its MP4 priming edit intact during remux. */
  completedAudio?: { file: string; pictureDurations: number[]; sampleRate: number };
  ffmpegPath?: string;
  signal?: AbortSignal;
  tempDir?: string;
}

/** Concatenate identically-encoded mp4 segments without re-encoding. */
export async function assembleSegments(files: string[], output: string, opts: AssembleOptions = {}): Promise<void> {
  if (!files.length) throw new Error("no segments to assemble");
  await withTempDir(opts.tempDir, "scarlet-concat-", async tmp => {
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
  });
}

export interface CachedRenderOptions extends RenderOptions {
  onCachedRanges?: (ranges: TimeRange[]) => void;
  /**
   * Called once, before encoding, when some sections were already encoded: their length in seconds and the progress
   * they account for (on the onProgress scale), so a head start can be shown as reused rather than as fast work.
   */
  onReused?: (reused: { seconds: number; progress: number }) => void;
  exportRange?: TimeRange;
  omitCaptions?: boolean;
  segmentSeconds?: number;
  /** Segments rendered at once (default 1; ffmpeg is already multi-threaded). */
  concurrency?: number;
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

async function writeSegment(project: Project, timeline: Timeline, segment: SegmentInfo, opts: RenderOptions): Promise<string[]> {
  // A long export plans all its segments up front. Playback may have filled this one since then.
  if (await fileHasContent(segment.file)) {
    segment.cached = true;
    return [];
  }
  return withStagedFile(segment.file, "part.mp4", async temp => {
    const result = await renderRange(project, timeline, segment.range, temp, { ...opts, cacheIntermediate: true });
    await publishSegment(temp, segment.file);
    return result.warnings;
  });
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
  // A hardware encoder that fails here retries the section with the next one, and finally with x264.
  if (!opts.videoEncoder) {
    return withRenderEncoder({ ...size, fps: project.settings.fps }, { ...opts, quality },
      attempt => renderPlaybackSegment(project, timeline, range, cacheDir, output, attempt) as Promise<PlaybackSegmentResult>);
  }
  const warnings: string[] = [];
  const videoEncoder = opts.videoEncoder;
  const encoder = videoEncoder.cacheKey;
  await fs.mkdir(cacheDir, { recursive: true });
  const media = new Map(project.media.map(asset => [asset.id, asset]));
  const transitions = planTransitions(timeline, media, project.settings.fps);
  const [part] = segmentTimelines(transitions.timeline, [range]);
  const seg = segmentInfo(project, part!, range, cacheDir, { quality, height: size.height, encoder, allowProxy: !!opts.pictureSource }, opts.mediaRoot, media, transitions);
  seg.cached = await fileHasContent(seg.file);
  warnings.push(...await fillSegment(project, part!, seg, { ...opts, transitions, videoEncoder, quality, pictureOnly: false }));
  // Decode AAC with its MP4 priming edit intact. FLAC has no encoder delay, so
  // appending the next fragment neither drops nor repeats audio at the join.
  const samples = sampleCount(range.start, range.end, project.settings.sampleRate);
  await runFfmpeg(["-y", "-i", seg.file, "-map_chapters", "-1", "-c:v", "copy", "-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "0",
    "-af", `apad,atrim=end_sample=${samples}`, "-strict", "experimental",
    "-movflags", "+frag_keyframe+default_base_moof+delay_moov", "-avoid_negative_ts", "disabled", output],
    { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  return { warnings };
}

/**
 * Remux a delivery that is one whole, untouched original: its picture copied losslessly, with the mixed program
 * sound. False when the timeline is anything else or the copy doesn't check out; the edit is rendered then.
 */
async function copyWholeOriginal(project: Project, timeline: Timeline, picture: Timeline, duration: number,
  size: { width: number; height: number }, cacheDir: string, output: string, opts: CachedRenderOptions,
  probes: NonNullable<RenderOptions["probes"]>, warn: (message: string) => void): Promise<boolean> {
  const original = await wholeOriginalPicture(project, picture, duration, size, opts);
  if (!original) return false;
  const audio = await renderProgramAudio(project, timeline, cacheDir, { ...opts, probes });
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  return withStagedFile(output, "assembly.mp4", async staged => {
    const ok = await copyOriginalPicture(original, audio, staged, project.settings, opts).catch((error: unknown) => {
      opts.signal?.throwIfAborted();
      if (!(error instanceof FfmpegError)) throw error;
      warn(`Could not copy the original picture (${failureReason(error)}); rendered the edit instead.`);
      return false;
    });
    if (!ok) return false;
    opts.signal?.throwIfAborted();
    await fs.rename(staged, output);
    return true;
  });
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

  const format = { quality, height: size.height, encoder: opts.videoEncoder.cacheKey, pictureOnly, allowProxy: !pictureOnly && !!opts.pictureSource };
  const media = new Map(project.media.map(asset => [asset.id, asset]));
  const transitions = planTransitions(picture, media, project.settings.fps);
  const parts = segmentTimelines(transitions.timeline, ranges);
  const segments = ranges.map((range, i) => segmentInfo(project, parts[i]!, range, cacheDir, format, opts.mediaRoot, media, transitions));
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
  if (completed > 0) opts.onReused?.({ seconds: completed, progress: completed / total * 0.97 });
  opts.onProgress?.(completed / total * 0.97);

  const todo = segments.map((s, i) => [s, i] as const).filter(([s]) => !s.cached);
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const probes = opts.probes ?? new Map();
  // Never replace reusable encoded sections. A whole, untouched picture with a cold cache can instead be remuxed losslessly.
  if (quality === "delivery" && todo.length === segments.length && !opts.exportRange && !opts.extraArgs?.length && !opts.splits?.length &&
      await copyWholeOriginal(project, timeline, picture, total, size, cacheDir, output, opts, probes, warn)) {
    opts.onProgress?.(1);
    return { output, duration: total, segments: [], rendered: 0, reused: 0, encoder: "copy", warnings };
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
    const partOpts = { ...opts, transitions, signal: workerSignal, probes, quality, pictureOnly };
    if (run.length > 1) {
      const messages = await writeRun(project, transitions.timeline, run.map(([seg]) => seg), partOpts).catch((error: unknown) => {
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
  const mixProgramAudio = pictureOnly || segments.length > 1;
  // FFmpeg normally runs its video and audio encoders together. Keep one independent
  // sound worker alongside picture, draining both before a cancellation returns.
  // Multi-segment previews also mix one continuous AAC program so per-section AAC
  // priming and frame padding never collide or drift across joins during playback.
  await renderBatch(mixProgramAudio ? 2 : 1, 2, opts.signal, async (phase, signal) => {
    if (phase === 0) await encodePictures(signal);
    else sound = await renderProgramAudio(project, timeline, cacheDir, {
      ...opts,
      exportRange: opts.exportRange ? { start: ranges[0]!.start, end: ranges.at(-1)!.end } : undefined,
      probes,
      quality,
      concurrency: 1,
      signal,
    });
  });

  await withStagedFile(output, "assembly.mp4", async assembled => {
    const pictureDurations = ranges.map(r => r.end - r.start);
    await assembleSegments(segments.map(s => s.file), assembled, {
      ffmpegPath: opts.ffmpegPath, signal: opts.signal, tempDir: opts.tempDir,
      pictureDurations, completedAudio: sound ? { file: sound, pictureDurations, sampleRate: project.settings.sampleRate } : undefined,
    });
    await fs.rename(assembled, output);
  });
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
