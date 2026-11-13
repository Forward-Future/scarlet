/**
 * Single-frame extraction for thumbnails, scrubbing and agent frame inspection.
 */
import { FILMSTRIP_SEEK_BATCH, sparseFilmstrip, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { buildFilterGraph, type GraphOptions } from "./graph.js";
import { INDEXED_MP4_INPUT, LOCAL_MEDIA_INPUT, failureReason, ffSeconds, resolveFfmpeg, runCapture, withStreamInfoFallback } from "./exec.js";
import { isStoredAsShown } from "./probe.js";

export interface FrameOptions {
  /** Output width in pixels; height follows the source aspect (default 320). */
  width?: number;
  /** mjpeg quality 2 (best) .. 31 (worst); default 4. */
  quality?: number;
  /** The input is a previously probed MP4 camera stream or a prepared H.264 preview. */
  indexedMp4?: boolean;
  /**
   * Decode and scale on an NVIDIA GPU, then bring back only the small frame. On a 4K recording a frame took 1.1-1.6 s
   * and 0.9 s of CPU this way, against 1.5-2.4 s and 7 s on the CPU. Falls back to the CPU when the driver can't,
   * and uses the CPU from the start for a file whose frames need turning (`storedAsShown`).
   */
  decoder?: "cuda";
  /** Hears why the frame came the slower way: the GPU could not decode it, or the movie's index could not be used. */
  onFallback?: (reason: string) => void;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

/** Decode the frame at `tSeconds` and return it as a JPEG. */
export async function extractFrame(file: string, tSeconds: number, opts: FrameOptions = {}): Promise<Buffer> {
  // The GPU path keeps frames on the GPU, where a clip stored sideways or a photo with a turn is not turned,
  // so that file decodes on the CPU.
  if (opts.decoder && await isStoredAsShown(file, { signal: opts.signal })) {
    try { return await frameFrom(file, tSeconds, opts); }
    catch (error) { // A driver can list a decoder it cannot run for this stream.
      opts.signal?.throwIfAborted();
      opts.onFallback?.(`${opts.decoder} could not decode this frame (${failureReason(error)}); decoded it on the CPU.`);
    }
  }
  return frameFrom(file, tSeconds, { ...opts, decoder: undefined });
}

async function frameFrom(file: string, tSeconds: number, opts: FrameOptions): Promise<Buffer> {
  const width = Math.max(2, Math.round(opts.width ?? 320));
  const gpu = opts.decoder === "cuda";
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    ...(gpu ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] : []),
    ...(opts.indexedMp4 ? INDEXED_MP4_INPUT : []),
    "-ss",
    ffSeconds(Math.max(0, tSeconds)),
    ...LOCAL_MEDIA_INPUT, "-i",
    file,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-vf",
    gpu ? `scale_cuda=${width}:-2:interp_algo=bicubic:format=yuv420p,hwdownload,format=yuv420p` : `scale=${width}:-2`,
    "-f",
    "image2",
    "-update",
    "1",
    "-c:v",
    "mjpeg",
    "-q:v",
    String(opts.quality ?? 4),
    "pipe:1",
  ];
  return withStreamInfoFallback(args, opts.signal, async inputArgs => {
    const { stdout } = await runCapture(resolveFfmpeg(opts.ffmpegPath), inputArgs, { signal: opts.signal });
    if (stdout.length < 4 || stdout[0] !== 0xff || stdout[1] !== 0xd8) {
      throw new Error(`no frame decoded at ${tSeconds}s from ${file}`);
    }
    return stdout;
  }, error => opts.onFallback?.(indexFallback(error)));
}

const indexFallback = (error: unknown) => `The movie's index could not be used (${failureReason(error)}); scanned the file instead.`;

/** Sample a completed CFR preview on its media clock (including MP4 edit lists).
 * Source-aspect cells abut so the timeline can draw each sample in its own time slot. */
export async function extractFilmstrip(file: string, frames: number[], fps: number, signal?: AbortSignal, layout: "16:9" | "source-aspect" = "16:9") {
  // Decode from one frame before the first sample; fps normalizes any PTS gaps
  // at segment joins to the frame displayed by the finished video.
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  const seek = frames.length <= FILMSTRIP_SEEK_BATCH && sparseFilmstrip(frames, fps);
  const groups = seek ? frames.map(frame => [frame]) : [frames];
  const padding = layout === "16:9" ? ",pad=160:90:(ow-iw)/2:(oh-ih)/2" : "";
  const filters = groups.map((group, i) => {
    const origin = Math.max(0, group[0]! - 1);
    if (seek) args.push("-threads", "2");
    args.push("-ss", String(origin / fps), "-t", String((group.at(-1)! - origin + 2) / fps), ...LOCAL_MEDIA_INPUT, "-i", file);
    const select = group.map(frame => `eq(n,${frame - origin})`).join("+");
    return `[${i}:v:0]fps=${fps}:round=near,select='${select}',setpts=PTS-STARTPTS,`
      + `scale=160:90:force_original_aspect_ratio=decrease${padding},setsar=1[cell${i}]`;
  });
  const cells = groups.map((_, i) => `[cell${i}]`).join("");
  const tile = `tile=${frames.length}x1:padding=${layout === "16:9" ? 1 : 0}:color=black`;
  filters.push(cells + (seek ? `concat=n=${groups.length}:v=1:a=0,` : "") + tile + "[sheet]");
  const { stdout } = await runCapture(resolveFfmpeg(), [...args,
    "-filter_complex_threads", "2", "-filter_complex", filters.join(";"), "-map", "[sheet]",
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1"], { signal });
  if (!stdout.length) throw new Error("No frames in the completed preview");
  return stdout;
}

/** Sample the edited picture, using the same composition as playback. */
export async function renderTimelineFrame(project: Project, timeline: Timeline, range: TimeRange, mediaRoot: string, signal?: AbortSignal, maxDimension = 160,
  inputs?: Pick<GraphOptions, "pictureSource" | "decoder"> & Pick<FrameOptions, "onFallback">) {
  const { width, height } = project.settings;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const graph = await buildFilterGraph(project, timeline, range, {
    pictureSource: inputs?.pictureSource, decoder: inputs?.decoder, mediaRoot, signal, width: width * scale, height: height * scale, singleFrame: true, indexedInputs: true,
  });
  try {
    return await withStreamInfoFallback(graph.args, signal, async inputArgs => {
      const { stdout } = await runCapture(resolveFfmpeg(), [
        "-hide_banner", "-nostdin", "-loglevel", "error", ...inputArgs,
        "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1",
      ], { signal });
      if (!stdout.length) throw new Error(`No timeline frame at ${range.start}s`);
      return stdout;
    }, error => inputs?.onFallback?.(indexFallback(error)));
  } finally {
    await graph.cleanup();
  }
}
