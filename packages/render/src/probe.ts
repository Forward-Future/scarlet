/**
 * Media inspection: ffprobe wrapper, content hashing and media-kind detection.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AudioStreamInfo, MediaAsset, MediaKind } from "@scarlet/timeline";
import { LOCAL_MEDIA_INPUT, failureReason, logElapsed, logReason, logRender, resolveFfprobe, runCapture, runFfmpeg } from "./exec.js";
import { pictureColorOf, type PictureColor } from "./hdr.js";

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
  /** All audio streams in the container, in stream order (`0:a:0`, `0:a:1`, ...). */
  audioStreams?: AudioStreamInfo[];
  /** Pixel format carries an alpha plane (png with transparency, ProRes 4444...). */
  hasAlpha: boolean;
  /** True for image2/png_pipe style demuxers or single-frame "video" streams. */
  isStillImage: boolean;
  videoCodec?: string;
  videoCodecTag?: string;
  videoBFrames?: number;
  /**
   * An HEVC stream whose every picture parameter set turns on wavefront rows or tiles, from its MP4 decoder
   * configuration: a picture decodes across its rows at once (`hevcRowParallel`).
   */
  rowParallel?: boolean;
  /** Display rotation in degrees (0 when the picture is shown as stored). */
  rotation: number;
  /** The video stream carries a display matrix: a rotation, a flip or both, applied when its frames are shown. */
  displayMatrix?: boolean;
  audioCodec?: string;
  audioDuration?: number;
  pixFmt?: string;
  /** HDR or camera Log the video stream declares (`pictureColorOf`); absent for an ordinary BT.709 or untagged picture. */
  color?: PictureColor;
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
  bits_per_raw_sample?: string;
  /** `-show_data`'s hex dump of the codec configuration. */
  extradata?: string;
  tags?: { rotate?: string; alpha_mode?: string; ALPHA_MODE?: string } & Record<string, string | undefined>;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { start_time?: string; duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string | undefined> };
}

const ALPHA_PIX_FMTS = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d|ayuv|vuya|pal8)/;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".heic", ".avif"]);
const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|gif|heif|avif)($|,)/;

/** MP4 carries the sample index and AVC decoder configuration in its headers. */
export function hasIndexedAvc(asset: Pick<MediaAsset, "kind" | "hasAlpha" | "originalPlaybackType">) {
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

/**
 * Try decoding with an optional GPU decoder, skipping CUDA when frames need rotation (`storedAsShown`),
 * and fall back to CPU decoding on driver/stream failure.
 */
export async function withDecoderFallback<D extends "cuda" | "videotoolbox", T>(
  file: string,
  opts: { decoder?: D; signal?: AbortSignal; onFallback?: (reason: string) => void },
  noun: "frame" | "window",
  run: (decoder: D | undefined) => Promise<T>,
  canFallback: () => boolean = () => true,
): Promise<T> {
  if (opts.decoder && (opts.decoder !== "cuda" || await isStoredAsShown(file, { signal: opts.signal }))) {
    try { return await run(opts.decoder); }
    catch (error) { // A driver can list a decoder it cannot run for this stream.
      opts.signal?.throwIfAborted();
      if (!canFallback()) throw error;
      opts.onFallback?.(`${opts.decoder} could not decode this ${noun} (${failureReason(error)}); decoded it on the CPU.`);
    }
  }
  return run(undefined);
}

// Import, proxy chunks and render inspection often probe the same MP4. Keep
// bounded JSON strings so every caller still gets independent mutable metadata.
const probeCache = new Map<string, { stamp: string; json: string; measured?: number }>();

/**
 * Seconds a file runs, from reading every packet of its picture and sound once: for a file whose container leaves its
 * length out (a browser's WebM recording). The packets are copied, not decoded, so this is quick. 0 when none is found.
 */
async function measuredDuration(file: string, signal?: AbortSignal): Promise<number> {
  let end = 0;
  const started = Date.now();
  try {
    await runFfmpeg([...LOCAL_MEDIA_INPUT, "-i", file, "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-f", "null", "-"],
      { signal, onProgress: seconds => { end = Math.max(end, seconds); } });
  } catch (error) {
    signal?.throwIfAborted();
    logRender(() => `[media] a file without a stated length couldn't be read to its end (${logReason(error)}): ${end > 0 ? `counted ${end.toFixed(1)} s` : "its length stays unknown"}`, "measured-duration");
    // A file that ends early still says how far it got.
    if (!(end > 0)) return 0;
    return end;
  }
  logRender(`[media] a file without a stated length was measured from its packets: ${end.toFixed(1)} s in ${logElapsed(Date.now() - started)}`, `measured:${file}`);
  return end;
}

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
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_data", ...LOCAL_MEDIA_INPUT, file],
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
  const audioList = streams.filter((s) => s.codec_type === "audio");
  const audio = audioList[0];
  const audioStreams: AudioStreamInfo[] = audioList.map((s, index) => {
    const rate = s.sample_rate ? Number(s.sample_rate) : undefined;
    const lang = s.tags?.language?.trim();
    const title = s.tags?.title?.trim();
    return {
      index,
      ...(s.codec_name ? { codec: s.codec_name } : {}),
      ...(s.channels && s.channels > 0 ? { channels: s.channels } : {}),
      ...(rate && Number.isFinite(rate) && rate > 0 ? { sampleRate: rate } : {}),
      ...(lang && lang !== "und" ? { language: lang } : {}),
      ...(title ? { title: title.slice(0, 80) } : {}),
    };
  });

  let duration = Number(json.format?.duration);
  if (!Number.isFinite(duration)) {
    duration = Math.max(0, ...streams.map((s) => Number(s.duration)).filter((d) => Number.isFinite(d)));
  }
  const formatName = json.format?.format_name;
  const isStillImage =
    !!video && (IMAGE_FORMATS.test(formatName ?? "") || (video.nb_frames === "1" && !audio));
  // Without a length, every tool that works on a range of the recording would find none. Read it once from the
  // packets, and keep it with the file's probe.
  if (!(duration > 0) && !isStillImage && (video || audio)) {
    const kept = probeCache.get(key);
    if (kept?.stamp === stamp && kept?.measured !== undefined) duration = kept.measured;
    else {
      duration = await measuredDuration(file, opts.signal);
      const entry = probeCache.get(key);
      if (entry && entry.stamp === stamp) entry.measured = duration;
    }
  }

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
    ...(audioStreams.length ? { audioStreams } : {}),
    hasAlpha: (!!video?.pix_fmt && ALPHA_PIX_FMTS.test(video.pix_fmt)) ||
      (video?.tags?.alpha_mode ?? video?.tags?.ALPHA_MODE) === "1",
    isStillImage,
    videoCodec: video?.codec_name,
    videoCodecTag: video?.codec_tag_string,
    videoBFrames: video?.has_b_frames,
    ...(video?.codec_name === "hevc" && hevcRowParallel(hexDump(video.extradata)) && { rowParallel: true }),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    displayMatrix: video?.side_data_list?.some(data => data.side_data_type === "Display Matrix") ?? false,
    audioCodec: audio?.codec_name,
    audioDuration: Number(audio?.duration) || undefined,
    pixFmt: video?.pix_fmt,
    color: isStillImage ? undefined : pictureColorOf(video, json.format?.tags),
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    bitrate: Number.isFinite(bitrate) ? bitrate : undefined,
    formatName,
    raw: json,
  };
}

/** The bytes of ffprobe's `-show_data` dump: lines of an offset, 16 bytes in hex across 40 columns, then the text. */
export function hexDump(dump: string | undefined): Uint8Array | undefined {
  if (!dump) return undefined;
  const hex = dump.split("\n").map(line => /^[0-9a-f]{8}: /.test(line) ? line.slice(10, 50).replace(/ /g, "") : "").join("");
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  return Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
}

/**
 * Whether every picture parameter set in an HEVC decoder configuration record (MP4 `hvcC`) turns on wavefront rows
 * (`entropy_coding_sync_enabled_flag`) or tiles, so FFmpeg's slice threads decode each picture's rows at once. A camera's
 * 4K HEVC with wavefront rows gave its frame 2.3 times sooner that way than with frame threads, which set up a decoder per
 * thread and decode pictures side by side behind each other's references (0.15 s against 0.34 s, identical pictures).
 * False when the record carries no PPS, or one can't be read: the decoder then keeps its frame threads.
 */
export function hevcRowParallel(record: Uint8Array | undefined): boolean {
  // configurationVersion 1: an Annex B configuration (start codes, as in MPEG-TS) is not this record.
  if (!record || record.length < 23 || record[0] !== 1) return false;
  let at = 22, found = 0;
  const arrays = record[at++]!;
  for (let a = 0; a < arrays; a++) {
    if (at + 3 > record.length) return false;
    const type = record[at]! & 0x3f, count = (record[at + 1]! << 8) | record[at + 2]!;
    at += 3;
    for (let n = 0; n < count; n++) {
      if (at + 2 > record.length) return false;
      const length = (record[at]! << 8) | record[at + 1]!;
      at += 2;
      if (at + length > record.length) return false;
      if (type === 34) {
        if (!ppsRowParallel(record.subarray(at, at + length))) return false;
        found++;
      }
      at += length;
    }
  }
  return found > 0;
}

/** Reads a PPS NAL unit (H.265 7.3.2.3.1) as far as `tiles_enabled_flag` and `entropy_coding_sync_enabled_flag`. */
function ppsRowParallel(nal: Uint8Array): boolean {
  // The payload without its two-byte header and emulation prevention bytes (00 00 03).
  const rbsp: number[] = [];
  for (let i = 2, zeros = 0; i < nal.length; i++) {
    const byte = nal[i]!;
    if (zeros >= 2 && byte === 3) { zeros = 0; continue; }
    zeros = byte === 0 ? zeros + 1 : 0;
    rbsp.push(byte);
  }
  let bit = 0;
  const u = (n: number) => {
    let value = 0;
    for (let k = 0; k < n; k++, bit++) {
      if (bit >> 3 >= rbsp.length) throw new RangeError("PPS ends early");
      value = (value << 1) | ((rbsp[bit >> 3]! >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  const ue = () => {
    let zeros = 0;
    while (u(1) === 0) if (++zeros > 31) throw new RangeError("Bad exp-Golomb code");
    return (2 ** zeros - 1) + (zeros ? u(zeros) : 0);
  };
  try {
    ue(); ue(); // pps_pic_parameter_set_id, pps_seq_parameter_set_id
    u(1); u(1); u(3); u(1); u(1); // dependent slices, output flag, extra slice header bits, sign hiding, cabac init
    ue(); ue(); ue(); // num_ref_idx_l0/l1_default_active_minus1, init_qp_minus26 (se: same length)
    u(1); u(1); // constrained_intra_pred_flag, transform_skip_enabled_flag
    if (u(1)) ue(); // cu_qp_delta_enabled_flag, diff_cu_qp_delta_depth
    ue(); ue(); // pps_cb_qp_offset, pps_cr_qp_offset (se)
    u(1); u(1); u(1); u(1); // chroma qp offsets present, weighted pred, weighted bipred, transquant bypass
    const tiles = u(1), wavefront = u(1);
    return !!(tiles || wavefront);
  } catch { return false; }
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

/** True when an asset represents a single still picture (an image or a still-image graphic). */
export function isStillAsset(asset: Pick<MediaAsset, "kind" | "path">, file = asset.path): boolean {
  return asset.kind === "image" || (asset.kind === "graphic" && isImagePath(file));
}

/** True when an asset represents a moving picture (a video or a motion graphic). */
export function isMovingAsset(asset: Pick<MediaAsset, "kind" | "path">, file = asset.path): boolean {
  return asset.kind === "video" || (asset.kind === "graphic" && !isImagePath(file));
}

/** The media-asset fields the schema stores, taken from a probe. A moving picture always records its colour, `{}` for
 * ordinary SDR, so an asset without it is one imported before Scarlet read colour. */
export function probeToAssetFields(probe: ProbeResult) {
  return {
    ...(probe.hasVideo && !probe.isStillImage && { color: probe.color ?? {} }),
    duration: probe.duration || undefined,
    fps: probe.fps || undefined,
    width: probe.width || undefined,
    height: probe.height || undefined,
    hasAudio: probe.hasAudio,
    ...(probe.audioStreams && probe.audioStreams.length > 1 ? { audioStreams: probe.audioStreams } : {}),
    hasAlpha: probe.hasAlpha,
  };
}
