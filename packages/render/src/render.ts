/**
 * Range and full renders: build the filter graph, pick an encoder, run
 * ffmpeg with progress, and hand back a faststart mp4.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PREVIEW_HEIGHT, snapToFrame } from "@scarlet/timeline";
import type { Project, ProjectSettings, Timeline, TimeRange } from "@scarlet/timeline";
import { FfmpegError, even, failureReason, fnum, runFfmpeg, sampleCount, threadedAvcPreview, withStreamInfoFallback } from "./exec.js";
import type { FontOptions } from "./fonts.js";
import { buildFilterGraph, type GraphOptions } from "./graph.js";
import { directDevice, encodeDirectPicture } from "./directPicture.js";
import type { ProbeResult } from "./probe.js";

import { COMPRESSED_AUDIO_BITRATE, PROGRAM_AUDIO_BITRATE, hardwareEncoderFailure, withRenderEncoder, type VideoEncoder, type HwAccel, type RenderQuality } from "./encoder.js";
export { bestEncoder, encoderArgs, resolveVideoEncoder, type HwAccel, type RenderQuality } from "./encoder.js";

/** High-core Apple silicon decodes AVC previews and single-frame seeks faster in software. */
export function timelinePreviewDecoder(accel: HwAccel | undefined, decoder: GraphOptions["decoder"]): GraphOptions["decoder"] {
  return (accel ?? "auto") === "auto" && decoder === "videotoolbox" && threadedAvcPreview ? "videotoolbox-hevc" : decoder;
}

export interface RenderOptions extends FontOptions {
  pictureSource?: GraphOptions["pictureSource"];
  transitions?: GraphOptions["transitions"];
  pictureOnly?: boolean;
  /** Absolute directory that relative media paths resolve against. */
  mediaRoot: string;
  /** preview: fast, scaled to `height`; delivery: slow, full resolution. Default preview. */
  quality?: RenderQuality;
  /** Preview height in pixels (default 540, never upscaled). Ignored for delivery. */
  height?: number;
  /** Explicit output size for a user-requested export, independent of encoder quality. */
  exportHeight?: number;
  /** An export at original quality: the software encoder at CRF 10 and 320 kb/s sound. */
  best?: boolean;
  hwaccel?: HwAccel;
  /** The encoder already probed for this pass. Keep every part in its matching cache. */
  videoEncoder?: VideoEncoder;
  /** Read originals with the software decoder and scaler. Encoding may still use hardware. */
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
  /** Only a file read by the next local remux can skip relocating its MP4 index. */
  cacheIntermediate?: boolean;
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
  const sample = (t: number) => sampleCount(range.start, t, sampleRate);
  const lines = [`[vout]split=${n}${splits.map((_, k) => `[sv_in${k}]`).join("")}`];
  splits.forEach((s, k) => lines.push(`[sv_in${k}]trim=start_frame=${frame(s.range.start)}:end_frame=${frame(s.range.end)},setpts=PTS-STARTPTS[sv${k}]`));
  if (audio) {
    lines.push(`[aout]asplit=${n}${splits.map((_, k) => `[sa_in${k}]`).join("")}`);
    splits.forEach((s, k) => lines.push(`[sa_in${k}]atrim=start_sample=${sample(s.range.start)}:end_sample=${sample(s.range.end)},asetpts=NB_CONSUMED_SAMPLES/SR/TB[sa${k}]`));
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

/** Canvas size for a quality level: previews keep aspect and cap the height. */
export function outputSize(settings: ProjectSettings, quality: RenderQuality, height?: number, exportHeight?: number) {
  const h = Math.min(exportHeight ?? (quality === "delivery" ? settings.height : height ?? DEFAULT_PREVIEW_HEIGHT), settings.height);
  const w = Math.round((settings.width * h) / settings.height);
  return { width: even(w), height: even(h) };
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
  if (!opts.videoEncoder) {
    return withRenderEncoder({ ...size, fps: settings.fps }, opts,
      attempt => renderRange(project, timeline, range, output, attempt));
  }
  const notes: string[] = [];
  const { name: encoder, args: encodingArgs, pixelFormat } = opts.videoEncoder;

  let proxyUsed = false;
  const resolver = quality === "preview" ? opts.pictureSource : undefined;
  const exporting = quality === "delivery" || opts.exportHeight !== undefined;
  // On a high-core Apple Silicon Mac, threaded AVC decoding also wins on verified
  // full-size delivery. Both routes feed the same hardware encoder.
  const appleDecoder = encoder === "h264_videotoolbox" ? timelinePreviewDecoder(opts.hwaccel, "videotoolbox") : undefined;
  const threadedAvc = appleDecoder === "videotoolbox-hevc";
  const device = exporting && opts.pictureOnly && !opts.softwareDecode && !threadedAvc && !opts.splits?.length && !opts.extraArgs?.length
    ? directDevice(encoder) : undefined;
  let decoder: GraphOptions["decoder"];
  // Keep delivery effects and resizing on the reference compositor. An unchanged
  // full-size shot can pass the GPU surfaces straight through, including on NVIDIA.
  if (encoder === "h264_nvenc" && !exporting) decoder = "cuda";
  if (appleDecoder) decoder = appleDecoder;
  // Trim [aout] by exact sample count rather than duration: when an adelay clip is input 0 of amix,
  // its leading silence carries AV_NOPTS_VALUE PTS, which makes atrim=duration stop at the delay boundary.
  const splitEnd = opts.splits?.length ? Math.max(...opts.splits.map(s => sampleCount(snapped.start, s.range.end, settings.sampleRate))) : 0;
  const audioSamples = opts.pictureOnly ? undefined : Math.max(1, sampleCount(snapped.start, snapped.end, settings.sampleRate), splitEnd);
  const graph = await buildFilterGraph(project, timeline, snapped, {
    directPicture: !!device,
    transitions: opts.transitions,
    indexedInputs: opts.indexedInputs ?? true,
    signal: opts.signal,
    pictureOnly: opts.pictureOnly,
    audioSamples,
    pictureSource: resolver && (async (...args) => {
      const source = await resolver(...args);
      if (source) proxyUsed = true;
      return source;
    }),
    decoder: opts.softwareDecode ? undefined : decoder,
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

  const outputOptions = (pixelFormat: string) => [
    "-map_chapters", "-1",
    "-c:v", encoder,
    ...encodingArgs,
    // Bound the amount of video a random seek must decode in an editor preview.
    ...(quality === "preview" ? ["-g", String(Math.max(1, Math.round(settings.fps / 2)))] : []),
    "-pix_fmt", pixelFormat,
    "-r", fnum(settings.fps),
    ...(opts.pictureOnly ? [] : [
      "-c:a", "aac", "-b:a", quality === "delivery" ? PROGRAM_AUDIO_BITRATE : COMPRESSED_AUDIO_BITRATE,
      "-ar", String(settings.sampleRate), "-ac", String(settings.audioChannels),
    ]),
    ...(opts.cacheIntermediate ? [] : ["-movflags", "+faststart"]),
    ...(opts.extraArgs ?? []),
  ];
  const outputArgs = outputOptions(pixelFormat);
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

  /** Render the range again with `changes`, keeping this attempt's notes, and say why. */
  const retryWith = async (changes: Partial<RenderOptions>, why: string) => {
    const fallback = await renderRange(project, timeline, range, output, { ...opts, ...changes });
    // The second try reads the index again and may have said the same of it.
    fallback.warnings.push(...notes.filter(note => !fallback.warnings.includes(note)), why);
    return fallback;
  };

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
      const directArgs = device && graph.directPicture && await encodeDirectPicture(graph, device,
        opts.indexedInputs ?? true, outputOptions(device.format), output, execution);
      if (directArgs) args = directArgs;
      else await withStreamInfoFallback(args, opts.signal, actual => {
        args = actual;
        return runFfmpeg(actual, execution);
      }, error => {
        if (hardwareEncoderFailure(error, encoder)) throw error;
        notes.push(`A movie's index could not be used for this range (${failureReason(error)}); scanned the file instead.`);
      });
    } catch (error) {
      if (!(error instanceof FfmpegError) || opts.signal?.aborted || hardwareEncoderFailure(error, encoder) || !args.includes("-hwaccel")) throw error;
      return await retryWith({ softwareDecode: true },
        `Hardware decoding was unavailable for this range (${failureReason(error)}); used software decoding.`);
    }
    opts.onProgress?.(1);
  } catch (e) {
    if (proxyUsed && !opts.signal?.aborted && e instanceof FfmpegError && /no such file|invalid data|error opening input/i.test(e.stderr)) {
      return await retryWith({ pictureSource: undefined },
        `A preview copy could not be read for this range (${failureReason(e)}); rendered from the original files.`);
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
