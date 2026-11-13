/**
 * Media inspection: ffprobe wrapper, content hashing and media-kind detection.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { MediaAsset, MediaKind } from "@scarlet/timeline";
import { LOCAL_MEDIA_INPUT, resolveFfprobe, runCapture } from "./exec.js";

export interface ProbeResult {
  previewClock?: { frameRate: string; startPts: number; videoStart?: number };
  path: string;
  /** Container duration in seconds (0 for still images). */
  duration: number;
  videoDuration?: number;
  videoFrameCount?: number;
  videoTimeBase?: string;
  /** Presentation time of the first picture relative to the input's seek origin. */
  videoStart?: number;
  /** The first picture's timestamp in its own stream, whatever its frame rate. */
  videoStartPts?: number;
  /** Frames per second of the first video stream (0 when there is none or it is a still). */
  fps: number;
  width: number;
  height: number;
  hasVideo: boolean;
  videoStreamCount?: number;
  hasAudio: boolean;
  /** Pixel format carries an alpha plane (png with transparency, ProRes 4444...). */
  hasAlpha: boolean;
  /** True for image2/png_pipe style demuxers or single-frame "video" streams. */
  isStillImage: boolean;
  videoCodec?: string;
  videoCodecTag?: string;
  videoBFrames?: number;
  /** Display rotation in degrees (0 when the picture is shown as stored). */
  rotation: number;
  /** The video stream carries a display matrix: a rotation, a flip or both, applied when its frames are shown. */
  displayMatrix?: boolean;
  audioCodec?: string;
  audioDuration?: number;
  pixFmt?: string;
  sampleRate?: number;
  channels?: number;
  /** Overall bitrate in bits/s, if the container reports one. */
  bitrate?: number;
  formatName?: string;
  /** Raw ffprobe JSON for anything not surfaced above. */
  raw: unknown;
}

interface FfprobeStream {
  sample_aspect_ratio?: string;
  field_order?: string;
  color_range?: string;
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  chroma_location?: string;
  closed_captions?: number;
  film_grain?: number;
  has_b_frames?: number;
  time_base?: string;
  start_pts?: number;
  start_time?: string;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  tags?: { rotate?: string; alpha_mode?: string; ALPHA_MODE?: string };
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { start_time?: string; duration?: string; bit_rate?: string; format_name?: string };
}

const ALPHA_PIX_FMTS = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d|ayuv|vuya|pal8)/;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".heic", ".avif"]);
const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|gif|heif|avif)($|,)/;

/** MP4 carries the sample index and AVC decoder configuration in its headers. */
export function hasIndexedAvc(asset: MediaAsset) {
  return asset.kind === "video" && asset.hasAlpha === false &&
    /^video\/mp4; codecs="avc1[.,"]/i.test(asset.originalPlaybackType ?? "");
}

/** Parse "30000/1001" or "30" into a number; 0 for "0/0" or garbage. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const parts = rate.split("/").map(Number);
  const n = parts[0];
  const d = parts[1];
  if (n === undefined || !Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  if (!d || !Number.isFinite(d)) return 0;
  return n / d;
}

/**
 * Whether decoded frames are already the picture as shown. A phone's portrait video is stored on its side with a
 * display matrix (a rotation, a flip or both), and a photo carries its turn in its own orientation tag, which the
 * stream probe does not list. FFmpeg applies both only to frames that come back to memory. Frames kept on the GPU
 * (CUDA decode into `scale_cuda`) skip that step and come out unturned, with no error to retry on, so such a file
 * decodes on the CPU instead.
 */
export const storedAsShown = (probe: Pick<ProbeResult, "rotation" | "displayMatrix" | "isStillImage">) =>
  !probe.isStillImage && !probe.displayMatrix && Math.abs(probe.rotation) % 360 === 0;

/** The unaltered source must carry the same picture and display properties as the compositor's square-pixel canvas. */
export function matchesCanvasFormat(probe: ProbeResult): boolean {
  const stream = (probe.raw as FfprobeOutput | undefined)?.streams?.find(s => s.codec_type === "video");
  return !!stream && storedAsShown(probe) && !probe.hasAlpha && probe.pixFmt === "yuv420p" &&
    stream.sample_aspect_ratio === "1:1" && stream.field_order === "progressive" &&
    (!stream.color_range || stream.color_range === "tv") && (!stream.color_space || stream.color_space === "bt709") &&
    !stream.color_primaries && !stream.color_transfer && (!stream.chroma_location || stream.chroma_location === "left") &&
    !stream.closed_captions && !stream.film_grain && !stream.side_data_list?.length;
}

/** `storedAsShown` for a file. A file that can't be probed counts as turned, so it takes the CPU path. */
export async function isStoredAsShown(file: string, opts: { ffprobePath?: string; signal?: AbortSignal } = {}) {
  try { return storedAsShown(await probeMedia(file, opts)); }
  catch { opts.signal?.throwIfAborted(); return false; }
}

// Import, proxy chunks and render inspection often probe the same MP4. Keep
// bounded JSON strings so every caller still gets independent mutable metadata.
const probeCache = new Map<string, { stamp: string; json: string }>();

export async function probeMedia(
  file: string,
  opts: { ffprobePath?: string; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const bin = resolveFfprobe(opts.ffprobePath);
  const key = JSON.stringify([bin, path.resolve(file)]);
  const info = await stat(file, { bigint: true }).catch(() => undefined);
  opts.signal?.throwIfAborted();
  const stamp = info?.isFile() ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":") : undefined;
  const cached = probeCache.get(key);
  let json: FfprobeOutput;
  if (cached && cached.stamp === stamp) {
    json = JSON.parse(cached.json);
    // The oldest entry is dropped first, so a file in use moves back to the newest place.
    probeCache.delete(key);
    probeCache.set(key, cached);
  } else {
    const { stdout } = await runCapture(
      bin,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...LOCAL_MEDIA_INPUT, file],
      { signal: opts.signal },
    );
    const source = stdout.toString("utf8");
    json = JSON.parse(source);
    if (stamp && stdout.length <= 128 * 1024) {
      // A file that changed takes the newest place too: setting a key that is there keeps its old place.
      probeCache.delete(key);
      probeCache.set(key, { stamp, json: source });
      if (probeCache.size > 32) probeCache.delete(probeCache.keys().next().value!);
    }
  }
  const streams = json.streams ?? [];
  // Ignore cover-art "video" streams in audio files.
  const videoStreams = streams.filter(s => s.codec_type === "video");
  const video = videoStreams.find(s => !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");

  let duration = Number(json.format?.duration);
  if (!Number.isFinite(duration)) {
    duration = Math.max(0, ...streams.map((s) => Number(s.duration)).filter((d) => Number.isFinite(d)));
  }
  const formatName = json.format?.format_name;
  const isStillImage =
    !!video && (IMAGE_FORMATS.test(formatName ?? "") || (video.nb_frames === "1" && !audio));

  // avg_frame_rate is what the stream actually plays at; r_frame_rate is the
  // timebase-derived guess and can be doubled for interlaced/variable sources.
  let fps = parseRate(video?.avg_frame_rate);
  if (!fps) fps = parseRate(video?.r_frame_rate);
  if (isStillImage) fps = 0;

  // Phone cameras can store portrait video as a landscape stream with a display rotation.
  const rotation = video?.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? Number(video?.tags?.rotate);
  const swapDimensions = Math.abs(rotation) % 180 === 90;
  const bitrate = Number(json.format?.bit_rate);
  const videoStart = Number(video?.start_time) - Number(json.format?.start_time);
  return {
    path: file,
    // A chunk's zero-based clock can be mapped back to source frames only for
    // recordings with consistent declared and measured frame rates.
    previewClock: video?.start_pts !== undefined && video === videoStreams[0] && video.avg_frame_rate && fps > 0 &&
      Math.abs(fps - parseRate(video.r_frame_rate)) < 1e-6
      ? { frameRate: video.avg_frame_rate, startPts: video.start_pts, videoStart: Number.isFinite(videoStart) ? videoStart : undefined } : undefined,
    videoDuration: Number(video?.duration) || undefined,
    videoFrameCount: Number(video?.nb_frames) || undefined,
    videoTimeBase: parseRate(video?.time_base) > 0 ? video?.time_base : undefined,
    videoStart: Number.isFinite(videoStart) ? videoStart : undefined,
    videoStartPts: video?.start_pts,
    duration: isStillImage ? 0 : duration,
    fps,
    width: (swapDimensions ? video?.height : video?.width) ?? 0,
    height: (swapDimensions ? video?.width : video?.height) ?? 0,
    hasVideo: !!video,
    videoStreamCount: videoStreams.length,
    hasAudio: !!audio,
    hasAlpha: (!!video?.pix_fmt && ALPHA_PIX_FMTS.test(video.pix_fmt)) ||
      (video?.tags?.alpha_mode ?? video?.tags?.ALPHA_MODE) === "1",
    isStillImage,
    videoCodec: video?.codec_name,
    videoCodecTag: video?.codec_tag_string,
    videoBFrames: video?.has_b_frames,
    rotation: Number.isFinite(rotation) ? rotation : 0,
    displayMatrix: video?.side_data_list?.some(data => data.side_data_type === "Display Matrix") ?? false,
    audioCodec: audio?.codec_name,
    audioDuration: Number(audio?.duration) || undefined,
    pixFmt: video?.pix_fmt,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    bitrate: Number.isFinite(bitrate) ? bitrate : undefined,
    formatName,
    raw: json,
  };
}

/** Streaming sha256 of a file's contents (hex). */
export function hashFile(file: string, onBytesRead?: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file, { highWaterMark: 1024 * 1024, signal });
    input
      .on("data", (chunk) => {
        hash.update(chunk);
        onBytesRead?.(input.bytesRead);
      })
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Classify media for the cut list. Stills and video with transparency are
 * "graphic" (lower thirds, logos), plain stills are "image", streams with no
 * picture are "audio", everything else is "video".
 */
export function detectMediaKind(probe: ProbeResult, filename = probe.path): MediaKind {
  const ext = path.extname(filename).toLowerCase();
  if (!probe.hasVideo) return "audio";
  if (probe.isStillImage || IMAGE_EXTS.has(ext)) return probe.hasAlpha ? "graphic" : "image";
  if (probe.hasAlpha) return "graphic";
  return "video";
}

/** True when a path's extension says "still image" (used when no probe is at hand). */
export function isImagePath(file: string): boolean {
  return IMAGE_EXTS.has(path.extname(file).toLowerCase());
}

/** The media-asset fields the schema stores, taken from a probe. */
export function probeToAssetFields(probe: ProbeResult) {
  return {
    duration: probe.duration || undefined,
    fps: probe.fps || undefined,
    width: probe.width || undefined,
    height: probe.height || undefined,
    hasAudio: probe.hasAudio,
    hasAlpha: probe.hasAlpha,
  };
}
