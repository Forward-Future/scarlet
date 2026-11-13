/**
 * Range and full renders: build the filter graph, pick an encoder, run
 * ffmpeg with progress, and hand back a faststart mp4.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PREVIEW_HEIGHT, snapToFrame } from "@scarlet/timeline";
import type { Project, ProjectSettings, Timeline, TimeRange } from "@scarlet/timeline";
import { FfmpegError, failureReason, ffmpegEncoders, fnum, resolveFfmpeg, runCapture, runFfmpeg, threadedAvcPreview, withStreamInfoFallback } from "./exec.js";
import type { FontOptions } from "./fonts.js";
import { buildFilterGraph, type GraphOptions } from "./graph.js";
import type { ProbeResult } from "./probe.js";

export type RenderQuality = "preview" | "delivery";

/** Hardware encoder preference. "auto" tries each in turn and falls back to libx264. */
export type HwAccel = "none" | "auto" | "nvenc" | "qsv" | "amf" | "videotoolbox";

export interface RenderOptions extends FontOptions {
  pictureSource?: GraphOptions["pictureSource"];
  pictureOnly?: boolean;
  /** Absolute directory that relative media paths resolve against. */
  mediaRoot: string;
  /** preview: fast, scaled to `height`; delivery: slow, full resolution. Default preview. */
  quality?: RenderQuality;
  /** Preview height in pixels (default 540, never upscaled). Ignored for delivery. */
  height?: number;
  /** Explicit output size for a user-requested export, independent of encoder quality. */
  exportHeight?: number;
  hwaccel?: HwAccel;
  /** Retry a preview using the software decoder and scaler. */
  softwareDecode?: boolean;
  /** Set false to force a packet scan on every movie input. */
  indexedInputs?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Scratch directory for filter scripts (default os.tmpdir()). */
  tempDir?: string;
  /** Probe cache keyed by media id (filled in as needed). */
  probes?: Map<string, ProbeResult>;
  /** Extra ffmpeg output options inserted before the output path. */
  extraArgs?: string[];
  /**
   * Write consecutive frame-aligned parts of the range to separate files from one
   * decode, each encoded as if it had been rendered alone. `output` is unused.
   * Progress is reported only on completion.
   */
  splits?: Array<{ range: TimeRange; output: string }>;
}

/** Filter lines cutting [vout]/[aout] into separately encoded, zero-based parts. */
function splitLines(splits: NonNullable<RenderOptions["splits"]>, range: TimeRange, fps: number, sampleRate: number, audio: boolean): string {
  const n = splits.length;
  const frame = (t: number) => Math.round((t - range.start) * fps);
  const sample = (t: number) => Math.round(t * sampleRate) - Math.round(range.start * sampleRate);
  const lines = [`[vout]split=${n}${splits.map((_, k) => `[sv_in${k}]`).join("")}`];
  splits.forEach((s, k) => lines.push(`[sv_in${k}]trim=start_frame=${frame(s.range.start)}:end_frame=${frame(s.range.end)},setpts=PTS-STARTPTS[sv${k}]`));
  if (audio) {
    lines.push(`[aout]asplit=${n}${splits.map((_, k) => `[sa_in${k}]`).join("")}`);
    splits.forEach((s, k) => lines.push(`[sa_in${k}]atrim=start_sample=${sample(s.range.start)}:end_sample=${sample(s.range.end)},asetpts=PTS-STARTPTS[sa${k}]`));
  }
  return ";\n" + lines.join(";\n") + "\n";
}

export interface RenderResult {
  output: string;
  /** Frame-snapped range that was rendered. */
  range: TimeRange;
  duration: number;
  width: number;
  height: number;
  fps: number;
  encoder: string;
  warnings: string[];
  /** Full ffmpeg argv (after the binary) for logging. */
  args: string[];
  elapsedMs: number;
}

const HW_ENCODERS: Record<Exclude<HwAccel, "none" | "auto">, string> = {
  nvenc: "h264_nvenc",
  qsv: "h264_qsv",
  amf: "h264_amf",
  videotoolbox: "h264_videotoolbox",
};

const encoderProbe = new Map<string, Promise<boolean>>();

/**
 * A listed encoder may reject a particular frame size, or the quality flags a render gives it: VideoToolbox takes
 * -q:v on Apple silicon only. Test one frame at the render's dimensions, with the render's own flags, so an encoder
 * that would fail every render is passed over before one starts.
 */
function encoderWorks(encoder: string, dimensions: string, quality: RenderQuality, ffmpegPath?: string, onFallback?: (reason: string) => void): Promise<boolean> {
  const bin = resolveFfmpeg(ffmpegPath);
  const key = `${bin}|${encoder}|${dimensions}|${quality}`;
  let p = encoderProbe.get(key);
  if (!p) {
    p = runCapture(bin, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${dimensions}:r=30`,
      "-frames:v", "1", "-c:v", encoder, ...encoderArgs(encoder, quality), "-pix_fmt", "yuv420p", "-f", "null", "-",
    ])
      .then(() => true)
      .catch((error: unknown) => {
        // The answer is kept, so only the caller that asked first hears why. A test that
        // never started says nothing about the encoder, and the next caller asks again.
        // One that crashed is an answer: testing it again would crash on every render.
        if (error instanceof FfmpegError && !error.started) encoderProbe.delete(key);
        onFallback?.(`${encoder} could not encode a ${dimensions} frame (${failureReason(error)}).`);
        return false;
      });
    encoderProbe.set(key, p);
  }
  return p;
}

/**
 * The encoder a render of this `quality` will use for `hwaccel`; libx264 when nothing hardware works.
 * `onFallback` hears why a hardware encoder this build lists was passed over, once for each
 * encoder, frame size and quality, and why the list itself could not be read.
 */
export async function resolveVideoEncoder(hwaccel: HwAccel = "none", ffmpegPath?: string, size = { width: 1280, height: 720 },
  onFallback?: (reason: string) => void, quality: RenderQuality = "preview"): Promise<string> {
  if (hwaccel === "none") return "libx264";
  const available = await ffmpegEncoders(ffmpegPath).catch((error: unknown) => {
    onFallback?.(`Could not list this ffmpeg's encoders (${failureReason(error)}).`);
    return new Set<string>();
  });
  const order: Array<Exclude<HwAccel, "none" | "auto">> =
    hwaccel === "auto" ? ["nvenc", "amf", "qsv", "videotoolbox"] : [hwaccel];
  for (const hw of order) {
    const enc = HW_ENCODERS[hw];
    if (available.has(enc) && (await encoderWorks(enc, `${size.width}x${size.height}`, quality, ffmpegPath, onFallback))) return enc;
  }
  return "libx264";
}

/** Encoder-specific quality flags. */
export function encoderArgs(encoder: string, quality: RenderQuality): string[] {
  const preview = quality === "preview";
  switch (encoder) {
    case "h264_nvenc":
      return preview
        // Low-latency tuning drops B-frames and lookahead: ~30% faster, same picture at preview quality.
        ? ["-preset", "p2", "-tune", "ll", "-rc", "vbr", "-cq", "28", "-b:v", "0"]
        : ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-profile:v", "high"];
    case "h264_qsv":
      return preview ? ["-preset", "veryfast", "-global_quality", "28"] : ["-preset", "slow", "-global_quality", "20"];
    case "h264_amf":
      return preview
        ? ["-quality", "speed", "-rc", "cqp", "-qp_i", "26", "-qp_p", "26"]
        : ["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18"];
    case "h264_videotoolbox":
      return preview ? ["-q:v", "55"] : ["-q:v", "72"];
    default:
      return preview ? ["-preset", "veryfast", "-crf", "23"] : ["-preset", "slow", "-crf", "18"];
  }
}

/** Canvas size for a quality level: previews keep aspect and cap the height. */
export function outputSize(settings: ProjectSettings, quality: RenderQuality, height?: number, exportHeight?: number) {
  const h = Math.min(exportHeight ?? (quality === "delivery" ? settings.height : height ?? DEFAULT_PREVIEW_HEIGHT), settings.height);
  const w = Math.round((settings.width * h) / settings.height);
  return { width: Math.max(2, 2 * Math.round(w / 2)), height: Math.max(2, 2 * Math.round(h / 2)) };
}

/** Snap a range to frame boundaries, keeping at least one frame. */
export function snapRange(range: TimeRange, fps: number): TimeRange {
  const start = Math.max(0, snapToFrame(range.start, fps));
  let end = snapToFrame(range.end, fps);
  if (end <= start) end = start + 1 / fps;
  return { start, end };
}

/** Render `range` of the timeline to `output` (mp4). Time 0 of the file is `range.start`. */
export async function renderRange(
  project: Project,
  timeline: Timeline,
  range: TimeRange,
  output: string,
  opts: RenderOptions,
): Promise<RenderResult> {
  const settings = project.settings;
  const quality = opts.quality ?? "preview";
  const snapped = snapRange(range, settings.fps);
  const size = outputSize(settings, quality, opts.height, opts.exportHeight);
  // What this render fell back from, beside the graph's own warnings.
  const notes: string[] = [];
  const encoder = await resolveVideoEncoder(opts.hwaccel, opts.ffmpegPath, size, reason => notes.push(reason), quality);

  let proxyUsed = false;
  const resolver = quality === "preview" ? opts.pictureSource : undefined;
  let previewDecoder: GraphOptions["decoder"];
  if (encoder === "h264_nvenc") previewDecoder = "cuda";
  if (encoder === "h264_videotoolbox") {
    previewDecoder = opts.hwaccel === "auto" && threadedAvcPreview ? "videotoolbox-hevc" : "videotoolbox";
  }
  const graph = await buildFilterGraph(project, timeline, snapped, {
    indexedInputs: opts.indexedInputs ?? true,
    signal: opts.signal,
    pictureOnly: opts.pictureOnly,
    pictureSource: resolver && (async (...args) => {
      const source = await resolver(...args);
      if (source) proxyUsed = true;
      return source;
    }),
    decoder: !opts.softwareDecode && quality === "preview" && opts.exportHeight === undefined ? previewDecoder : undefined,
    mediaRoot: opts.mediaRoot,
    width: size.width,
    height: size.height,
    tempDir: opts.tempDir,
    probes: opts.probes,
    fontFile: opts.fontFile,
    fontDirs: opts.fontDirs,
    ffmpegPath: opts.ffmpegPath,
    ffprobePath: opts.ffprobePath,
  });

  const outputArgs = [
    "-map_chapters", "-1",
    "-c:v", encoder,
    ...encoderArgs(encoder, quality),
    // Bound the amount of video a random seek must decode in an editor preview.
    ...(quality === "preview" ? ["-g", String(Math.max(1, Math.round(settings.fps / 2)))] : []),
    "-pix_fmt", "yuv420p",
    "-r", fnum(settings.fps),
    ...(opts.pictureOnly ? [] : [
      "-c:a", "aac", "-b:a", quality === "delivery" ? "192k" : "128k",
      "-ar", String(settings.sampleRate), "-ac", String(settings.audioChannels),
    ]),
    "-movflags", "+faststart",
    ...(opts.extraArgs ?? []),
  ];
  let args: string[];
  if (opts.splits?.length) {
    const lines = splitLines(opts.splits, snapped, settings.fps, settings.sampleRate, !opts.pictureOnly);
    await fs.appendFile(graph.scriptPath, lines, "utf8");
    graph.graph += lines;
    const inputs = graph.args.slice(0, graph.args.indexOf(graph.scriptPath) + 1);
    args = ["-y", ...inputs, ...opts.splits.flatMap((s, k) => [
      "-map", `[sv${k}]`, ...(opts.pictureOnly ? [] : ["-map", `[sa${k}]`]), ...outputArgs, s.output,
    ])];
  } else {
    args = ["-y", ...graph.args, ...outputArgs, output];
  }

  const started = Date.now();
  try {
    for (const file of opts.splits?.map(s => s.output) ?? [output]) await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    const execution = {
      ffmpegPath: opts.ffmpegPath,
      signal: opts.signal,
      // Each part restarts its clock, so ffmpeg's output time no longer measures the whole range.
      onProgress: opts.onProgress && !opts.splits?.length ? (t: number) => opts.onProgress!(Math.min(1, t / graph.duration)) : undefined,
    };
    try {
      await withStreamInfoFallback(args, opts.signal, actual => {
        args = actual;
        return runFfmpeg(actual, execution);
      }, error => notes.push(`A movie's index could not be used for this range (${failureReason(error)}); scanned the file instead.`));
    } catch (error) {
      if (!(error instanceof FfmpegError) || opts.signal?.aborted || !args.includes("-hwaccel")) throw error;
      const fallback = await renderRange(project, timeline, range, output, { ...opts, softwareDecode: true });
      // The second try reads the index again and may have said the same of it.
      fallback.warnings.push(...notes.filter(note => !fallback.warnings.includes(note)),
        `Hardware decoding was unavailable for this range (${failureReason(error)}); used software decoding.`);
      return fallback;
    }
    opts.onProgress?.(1);
  } catch (e) {
    if (proxyUsed && !opts.signal?.aborted && e instanceof FfmpegError && /no such file|invalid data|error opening input/i.test(e.stderr)) {
      const fallback = await renderRange(project, timeline, range, output, { ...opts, pictureSource: undefined });
      fallback.warnings.push(...notes.filter(note => !fallback.warnings.includes(note)),
        `A preview copy could not be read for this range (${failureReason(e)}); rendered from the original files.`);
      return fallback;
    }
    // The graph is the thing you need to debug a failed render; keep it with the error.
    if (e instanceof FfmpegError) e.message += `\n--- filter graph ---\n${graph.graph}`;
    throw e;
  } finally {
    await graph.cleanup();
  }

  return {
    output,
    range: snapped,
    duration: graph.duration,
    width: graph.width,
    height: graph.height,
    fps: graph.fps,
    encoder,
    warnings: [...graph.warnings, ...notes],
    args,
    elapsedMs: Date.now() - started,
  };
}
