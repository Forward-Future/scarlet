/**
 * Low-bitrate H.264 proxies for scrubbing in the browser and for agents that
 * want to look at frames without pulling the original.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PREVIEW_HEIGHT } from "@scarlet/timeline";
import { FfmpegError, LOCAL_MEDIA_INPUT, failureReason, runFfmpeg, threadedAvcPreview } from "./exec.js";
import { probeMedia, storedAsShown, type ProbeResult } from "./probe.js";
import { encoderArgs, resolveVideoEncoder, type HwAccel } from "./render.js";

export interface ProxyOptions {
  /** Directory keyed by source identity and proxy format. */
  checkpointDir?: string;
  /** Seek at input and encode only this source-time window. */
  range?: { start: number; end: number };
  /** Target height in pixels (never upscaled); default 540. */
  height?: number;
  /** Force a frame rate; source rate when omitted. */
  fps?: number;
  /** Audio bitrate, default "96k". */
  audioBitrate?: string;
  crf?: number;
  /** Hardware acceleration policy. Default "none" (libx264). */
  hwaccel?: HwAccel;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface ProxyResult {
  output: string;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Video encoder used ("libx264" when no hardware encoder applied). */
  encoder?: string;
  /** Why a hardware encoder was passed over or given up on, when one was. */
  warnings: string[];
}

/** Checkpoints start on source frames, including at fractional rates. */
function checkpointSpan(fps: number) {
  return Math.max(1, Math.round(fps * 30)) / fps;
}

/** Locate an atomically published, video-only part while the rest of the
 * recording is being prepared. The caller verifies the source and picture clocks. */
export async function proxyCheckpoint(dir: string, height: number, fps: number, from: number, to: number) {
  const span = checkpointSpan(fps);
  const index = Math.floor((from + 1e-7) / span);
  if (from < 0 || to > (index + 1) * span + 1e-6) return;
  const encoders = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of encoders) {
    if (!entry.isDirectory() || !entry.name.endsWith("-" + height)) continue;
    const file = join(dir, entry.name, index + ".mp4");
    if ((await stat(file).catch(() => null))?.size) return { file, start: index * span };
  }
}

/** The size `scale=w=-2:h=2*trunc(min(height,ih)/2)` produces, for the encoder probe. */
function proxySize(probe: ProbeResult, height: number) {
  const h = Math.max(2, 2 * Math.trunc(Math.min(height, probe.height) / 2));
  return { width: Math.max(2, 2 * Math.round((probe.width * h) / probe.height / 2)), height: h };
}

function videoArgs(probe: ProbeResult, height: number, encoder: string, opts: ProxyOptions): { input: string[]; output: string[] } {
  const scale = `w=-2:h='2*trunc(min(${height},ih)/2)'`;
  // Every half second is a keyframe so a seek decodes at most 15 pictures.
  const keyframes = ["-force_key_frames", "expr:gte(t,n_forced*0.5)"];
  // Older FFmpeg MP4 defaults duplicate the first picture to fill an audio lead.
  // Keep each filtered frame and its timestamp, including a partial-frame input seek.
  const clock = ["-fps_mode:v", "passthrough"];
  if (!opts.fps && probe.videoTimeBase) clock.push("-enc_time_base:v", probe.videoTimeBase);
  if (encoder === "libx264") {
    const filters = [`scale=${scale}`, ...(opts.fps ? [`fps=${opts.fps}`] : [])];
    return { input: [], output: [
      "-vf", filters.join(","), "-c:v", "libx264", "-preset", opts.range ? "ultrafast" : "veryfast",
      "-crf", String(opts.crf ?? 28), ...keyframes, ...clock, "-pix_fmt", "yuv420p", "-profile:v", "high",
    ] };
  }
  const nativeCodec = probe.videoCodec === "h264" || probe.videoCodec === "hevc";
  const upright = storedAsShown(probe);
  // Not every hardware encoder honours forced keyframes, but all of them bound the GOP.
  const gop = Math.max(1, Math.round((opts.fps ?? (probe.fps || 30)) / 2));
  const encode = ["-c:v", encoder, ...encoderArgs(encoder, "preview"), ...keyframes, ...clock, "-g", String(gop),
    // A forced I-frame is a seek point only when it is also an IDR frame.
    ...(encoder === "h264_nvenc" ? ["-forced-idr", "1"] : encoder === "h264_qsv" ? ["-forced_idr", "1"] : []), "-profile:v", "high"];
  // Keep 4K pictures on the GPU from decode to encode; only the small proxy is written out.
  if (encoder === "h264_nvenc" && nativeCodec && upright && !probe.hasAlpha && !opts.fps) {
    return { input: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
      output: ["-vf", `scale_cuda=${scale}:format=yuv420p:interp_algo=bicubic`, ...encode] };
  }
  const filters = [`scale=${scale}`, ...(opts.fps ? [`fps=${opts.fps}`] : [])];
  const threaded = opts.hwaccel === "auto" && threadedAvcPreview && probe.videoCodec === "h264";
  return {
    input: encoder === "h264_videotoolbox" && nativeCodec && !threaded ? ["-hwaccel", "videotoolbox"] : [],
    output: ["-vf", filters.join(","), ...encode, "-pix_fmt", "yuv420p"],
  };
}

export async function makeProxy(input: string, output: string, opts: ProxyOptions = {}): Promise<ProxyResult> {
  const probe = await probeMedia(input, { ffprobePath: opts.ffprobePath, signal: opts.signal });
  const height = Math.max(2, Math.round(opts.height ?? DEFAULT_PREVIEW_HEIGHT));
  const hasVideo = probe.hasVideo && !probe.isStillImage;
  const warnings: string[] = [];
  const encoder = hasVideo && probe.width && probe.height
    ? await resolveVideoEncoder(opts.hwaccel ?? "none", opts.ffmpegPath, proxySize(probe, height), reason => warnings.push(reason), "preview")
    : "libx264";
  // A driver can list an encoder or decoder it cannot run for this stream. Use the CPU instead.
  const onCpu = async (error: unknown): Promise<ProxyResult> => {
    const result = await makeProxy(input, output, { ...opts, hwaccel: "none" });
    return { ...result, warnings: [...warnings, `${encoder} could not make this preview copy (${failureReason(error)}); used libx264.`, ...result.warnings] };
  };
  const video = hasVideo ? videoArgs(probe, height, encoder, opts) : undefined;

  const pictureDuration = probe.videoDuration ?? probe.duration;
  // Phone recordings whose frame rate drifts a little are saved in parts too, so a restart keeps them; only the
  // scrub previews need a steady rate to map a part's pictures back to source frames, and they check for it.
  if (opts.checkpointDir && !opts.range && video && pictureDuration > 30 && probe.videoStartPts === 0 && probe.videoStart === 0) {
    // Align each boundary to a picture frame. Mux audio from the original once
    // so independent AAC encodes cannot introduce gaps at those boundaries.
    const dir = join(opts.checkpointDir, encoder + "-" + height);
    await mkdir(dir, { recursive: true });
    const span = checkpointSpan(probe.fps);
    // The final pass re-reads the original for its audio and rewrites the file, so it keeps a share of the bar.
    const PARTS = 0.9;
    const parts: Array<{ name: string; start: number }> = [];
    for (let i = 0; i * span < pictureDuration - 0.000001; i++) {
      opts.signal?.throwIfAborted();
      const start = i * span, end = Math.min(pictureDuration, (i + 1) * span);
      // A VFR checkpoint can begin between pictures. Older parts after the first rounded that offset to milliseconds.
      const name = (i > 0 && !probe.previewClock ? "pts-" : "") + i + ".mp4", path = join(dir, name);
      if (!(await stat(path).catch(() => null))?.size) {
        const temp = path + "." + randomUUID() + ".part.mp4";
        try {
          await runFfmpeg(["-y", ...video.input, "-ss", String(start), ...LOCAL_MEDIA_INPUT, "-i", input,
            "-t", String(end - start), "-map", "0:v:0", ...video.output, "-movie_timescale", "1000000", "-an", temp], {
            ffmpegPath: opts.ffmpegPath, signal: opts.signal,
            onProgress: t => opts.onProgress?.(PARTS * Math.min(end, start + t) / pictureDuration),
          });
          await rename(temp, path);
        } catch (error) {
          if (encoder !== "libx264" && error instanceof FfmpegError && !opts.signal?.aborted) return onCpu(error);
          throw error;
        } finally { await rm(temp, { force: true }); }
      }
      // A VFR screen capture may hold a picture for this entire part. An empty MP4 stops concat at that point.
      if (probe.previewClock || (await probeMedia(path, { ffprobePath: opts.ffprobePath, signal: opts.signal })).hasVideo) {
        parts.push({ name, start });
      }
      opts.onProgress?.(PARTS * end / pictureDuration);
    }
    const manifest = join(dir, randomUUID() + ".ffconcat");
    try {
      // Place each part at its source boundary, preserving the hold through any intervening empty parts.
      const list = parts.flatMap(({ name, start }, i) => [
        "file " + name, "inpoint 0", "duration " + ((parts[i + 1]?.start ?? pictureDuration) - start).toFixed(9),
      ]);
      await writeFile(manifest, list.join("\n") + "\n");
      const audio = probe.hasAudio ? [...LOCAL_MEDIA_INPUT, "-i", input, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac",
        "-b:a", opts.audioBitrate ?? "96k", "-ac", "2"] : ["-map", "0:v:0", "-an"];
      await runFfmpeg(["-y", "-f", "concat", "-safe", "1", "-i", manifest, ...audio,
        "-c:v", "copy", "-movflags", "+faststart", output], { signal: opts.signal, ffmpegPath: opts.ffmpegPath,
        onProgress: opts.onProgress && (t => opts.onProgress!(PARTS + (1 - PARTS) * Math.min(1, t / Math.max(probe.duration, pictureDuration)))) });
    } finally { await rm(manifest, { force: true }); }
    opts.onProgress?.(1);
    return { output, duration: probe.duration, hasVideo, hasAudio: probe.hasAudio, encoder, warnings };
  }
  const args = ["-y", ...(video?.input ?? [])];
  if (opts.range) args.push("-ss", String(opts.range.start));
  args.push(...LOCAL_MEDIA_INPUT, "-i", input);
  if (opts.range) args.push("-t", String(opts.range.end - opts.range.start));
  if (video) args.push("-map", "0:v:0", ...video.output);
  else args.push("-vn");
  if (probe.hasAudio) {
    args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", opts.audioBitrate ?? "96k", "-ac", "2");
  } else {
    args.push("-an");
  }
  // Preserve a first picture that starts between millisecond ticks, including when it starts after the sound.
  args.push("-movie_timescale", "1000000", "-movflags", "+faststart", output);

  const duration = opts.range ? opts.range.end - opts.range.start : probe.duration;
  try {
    await runFfmpeg(args, {
      ffmpegPath: opts.ffmpegPath,
      signal: opts.signal,
      onProgress: opts.onProgress
        ? (t) => opts.onProgress!(duration > 0 ? Math.min(1, t / duration) : 0)
        : undefined,
    });
  } catch (error) {
    if (encoder === "libx264" || !(error instanceof FfmpegError) || opts.signal?.aborted) throw error;
    return onCpu(error);
  }
  opts.onProgress?.(1);
  return { output, duration, hasVideo, hasAudio: probe.hasAudio, encoder, warnings };
}
