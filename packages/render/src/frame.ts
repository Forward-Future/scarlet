/**
 * Single-frame extraction for thumbnails, scrubbing and agent frame inspection.
 */
import { FILMSTRIP_SEEK_BATCH, sparseFilmstrip, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { buildFilterGraph, type GraphOptions } from "./graph.js";
import { FFMPEG_BASE_ARGS, INDEXED_MP4_INPUT, LOCAL_MEDIA_INPUT, failureReason, ffSeconds, requireDrawtext, resolveFfmpeg, runCapture, withStreamInfoFallback } from "./exec.js";
import { CUDA_FRAMES_INPUT } from "./mediaInput.js";
import { isImagePath, withDecoderFallback } from "./probe.js";
import { toneMapFilters, type HdrTransfer } from "./hdr.js";
import { drawtextFontArg } from "./fonts.js";

export interface FrameOptions {
  /** Output width in pixels; height follows the source aspect (default 320). */
  width?: number;
  /** mjpeg quality 2 (best) .. 31 (worst); default 4. */
  quality?: number;
  /** The input is a previously probed MP4 camera stream or a prepared H.264 preview. */
  indexedMp4?: boolean;
  /** The source's frame rate. The frame on screen is then looked for in the frame and a half before the time, else in the half second before it. */
  fps?: number;
  /**
   * Decode and scale on an NVIDIA GPU, then bring back only the small frame. On a 4K recording a frame took 1.1-1.6 s
   * and 0.9 s of CPU this way, against 1.5-2.4 s and 7 s on the CPU. Falls back to the CPU when the driver can't,
   * and uses the CPU from the start for a file whose frames need turning (`storedAsShown`).
   * "videotoolbox" decodes on a Mac's media engine and filters on the CPU: the same JPEG, byte for byte, with almost
   * none of the CPU, so a frame nobody is watching for leaves the cores to the editor's. Falls back to the CPU too.
   */
  decoder?: "cuda" | "videotoolbox";
  /** The file's HDR transfer (`MediaAsset.color.hdr`): the frame is tone-mapped to SDR, as every picture made from it is. */
  hdr?: HdrTransfer;
  /** Hears why the frame came the slower way: the GPU could not decode it, or the movie's index could not be used. */
  onFallback?: (reason: string) => void;
  /** Only this area of the picture, as fractions of it: left, top, right, bottom. */
  area?: [number, number, number, number];
  /** Lines over the picture at round percents of the whole source, each labelled, so an area of it can be named. Needs the source's size. */
  grid?: { width: number; height: number };
  ffmpegPath?: string;
  signal?: AbortSignal;
}

/**
 * Filters that draw lines at round percents of a source picture over the part of it in `area`, drawn `width` by
 * `height` pixels, with each line's percent beside it at the top and left edges. The step is the roundest that puts
 * at least four lines across the picture's width.
 */
export function percentGrid(area: [number, number, number, number], width: number, height: number): string[] {
  const [left, top, right, bottom] = area.map(n => n * 100) as [number, number, number, number];
  const step = [10, 5, 2, 1, 0.5].find(s => (right - left) / s >= 4) ?? 0.5;
  const face = drawtextFontArg();
  const size = Math.max(11, Math.round(width / 90));
  const label = (n: number) => String(Math.round(n * 10) / 10);
  const filters: string[] = [];
  const lines = (from: number, to: number) => {
    const out: number[] = [];
    for (let n = Math.ceil(from / step - 1e-9) * step; n <= to + 1e-9; n += step) if (n > from + step / 4 && n < to - step / 4) out.push(n);
    return out;
  };
  for (const n of lines(left, right)) {
    const x = Math.round((n - left) / (right - left) * width);
    filters.push(`drawbox=x=${x}:y=0:w=1:h=${height}:color=white@0.45:t=fill`, `drawbox=x=${x + 1}:y=0:w=1:h=${height}:color=black@0.35:t=fill`,
      `drawtext=${face}:text='${label(n)}':x=${x + 3}:y=3:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=2`);
  }
  for (const n of lines(top, bottom)) {
    const y = Math.round((n - top) / (bottom - top) * height);
    filters.push(`drawbox=x=0:y=${y}:w=${width}:h=1:color=white@0.45:t=fill`, `drawbox=x=0:y=${y + 1}:w=${width}:h=1:color=black@0.35:t=fill`,
      `drawtext=${face}:text='${label(n)}':x=3:y=${y + 3}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=2`);
  }
  return filters;
}

/**
 * A time written to the millisecond still finds the frame that starts up to half a millisecond after it. Below a
 * quarter of a frame at 120 fps.
 */
const FRAME_START_SLACK = 0.0005;
/** How far before the time a frame lasting longer than the first look is looked for, as a variable frame rate can hold one. */
const LONG_FRAME_LOOKBACK = 2;

/**
 * Decode the frame on screen at `tSeconds`, the last one starting at or before it, and return it as a JPEG. A time
 * inside the last frame gives the last frame, and a time before the first frame gives the first.
 */
export async function extractFrame(file: string, tSeconds: number, opts: FrameOptions = {}): Promise<Buffer> {
  // A grid without its percents can't be read, so that says why instead.
  if (opts.grid) await requireDrawtext("label the grid’s lines; the frame without grid needs no text", opts.ffmpegPath);
  // The GPU path keeps frames on the GPU, where a clip stored sideways or a photo with a turn is not turned,
  // so that file decodes on the CPU.
  return withDecoderFallback(file, opts, "frame", decoder => frameFrom(file, tSeconds, { ...opts, decoder }));
}

async function frameFrom(file: string, tSeconds: number, opts: FrameOptions): Promise<Buffer> {
  // A still has one picture, shown for as long as its clip is (a GIF's first, as the render holds it). Its file ends
  // after one frame, so a later time would find nothing.
  const t = isImagePath(file) ? 0 : Math.max(0, tSeconds);
  const width = Math.max(2, Math.round(opts.width ?? 320));
  // An area or a grid is drawn on the CPU, where the picture is in memory.
  // So is an HDR picture's tone-mapping, which has no GPU filter in the bundled builds.
  const gpu = opts.decoder === "cuda" && !opts.area && !opts.grid && !opts.hdr;
  const toneMap = (await toneMapFilters(opts.hdr, opts.ffmpegPath)).map(f => "," + f).join("");
  const area = opts.area ?? [0, 0, 1, 1];
  const crop = opts.area ? `crop=iw*${area[2] - area[0]}:ih*${area[3] - area[1]}:iw*${area[0]}:ih*${area[1]},` : "";
  const height = opts.grid ? Math.max(2, Math.round(width * (area[3] - area[1]) * opts.grid.height / ((area[2] - area[0]) * opts.grid.width) / 2) * 2) : -2;
  const grid = opts.grid ? "," + percentGrid(area, width, height).join(",") : "";
  const picture = gpu ? `scale_cuda=${width}:-2:interp_algo=bicubic:format=yuv420p,hwdownload,format=yuv420p` : `${crop}scale=${width}:${height}${toneMap}${grid}`;
  const input = [
    ...FFMPEG_BASE_ARGS,
    ...(gpu ? CUDA_FRAMES_INPUT : opts.decoder === "videotoolbox" ? ["-hwaccel", "videotoolbox"] : []),
    ...(opts.indexedMp4 ? INDEXED_MP4_INPUT : []),
  ];
  /**
   * A seek gives the first frame starting at or after where it lands, which for a time inside a frame is the next
   * one. So decoding starts `lookback` seconds before the time, keeps the frames up to it and gives the last of them.
   * `select` keeps them exactly; `trim`, which rounds to the stream's clock, only stops the decoding a little after.
   * Without `lookback`, the first frame at or after the time: for a time before the video's first frame.
   */
  const decode = async (inputArgs: string[], lookback?: number) => {
    const from = lookback === undefined ? t : Math.max(0, t - lookback);
    const end = t - from + FRAME_START_SLACK;
    const filter = lookback === undefined ? picture : `trim=end=${end + lookback * 0.4},select='lte(t,${end})',${picture},reverse`;
    const { stdout } = await runCapture(resolveFfmpeg(opts.ffmpegPath), [
      ...inputArgs, "-ss", ffSeconds(from), ...LOCAL_MEDIA_INPUT, "-i", file,
      "-map", "0:v:0", "-frames:v", "1", "-vf", filter,
      "-f", "image2", "-update", "1", "-c:v", "mjpeg", "-q:v", String(opts.quality ?? 4), "pipe:1",
    ], { signal: opts.signal });
    if (stdout.length < 4 || stdout[0] !== 0xff || stdout[1] !== 0xd8) {
      throw new Error(`no frame decoded at ${tSeconds}s from ${file}`);
    }
    return stdout;
  };
  const near = opts.fps && opts.fps > 0 ? 1.5 / opts.fps : 0.5;
  // Only a variable frame rate holds a frame longer than that. Before the second look, a time that near the start has nothing earlier to find.
  const lookbacks = t > near && near < LONG_FRAME_LOOKBACK ? [near, LONG_FRAME_LOOKBACK] : [near];
  return withStreamInfoFallback(input, opts.signal, async inputArgs => {
    for (const lookback of lookbacks) {
      try { return await decode(inputArgs, lookback); }
      catch { opts.signal?.throwIfAborted(); } // Nothing up to the time: no frame has started yet, or past the end.
    }
    return decode(inputArgs);
  }, error => opts.onFallback?.(indexFallback(error)));
}

const indexFallback = (error: unknown) => `The movie's index could not be used (${failureReason(error)}); scanned the file instead.`;

/** Sample a completed CFR preview on its media clock (including MP4 edit lists).
 * Source-aspect cells abut so the timeline can draw each sample in its own time slot. */
export async function extractFilmstrip(file: string, frames: number[], fps: number, signal?: AbortSignal, layout: "16:9" | "source-aspect" = "16:9") {
  // Decode from one frame before the first sample; fps normalizes any PTS gaps
  // at segment joins to the frame displayed by the finished video.
  const args: string[] = [...FFMPEG_BASE_ARGS];
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
        ...FFMPEG_BASE_ARGS, ...inputArgs,
        "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1",
      ], { signal });
      if (!stdout.length) throw new Error(`No timeline frame at ${range.start}s`);
      return stdout;
    }, error => inputs?.onFallback?.(indexFallback(error)));
  } finally {
    await graph.cleanup();
  }
}
