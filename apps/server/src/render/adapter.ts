/**
 * Render adapter. The server codes against this interface; `@scarlet/render`
 * (being built separately) will replace the fallback below with a one-line
 * swap: `export const adapter: RenderAdapter = scarletRender;`.
 *
 * Expected surface of @scarlet/render:
 *   probeMedia(path) → { duration, fps?, width?, height?, hasAudio, hasAlpha?, kind }
 *   hashFile(path) → sha256 hex
 *   extractWaveformFull(path, duration, pointsPerSecond) → { peaks, rms? }
 *   waveformFromCache(cache, from, to, points) → { peaks, rms? }
 *   extractFrame(path, t, { width }) → Buffer (jpeg)
 *   makeProxy(input, output, { height, onProgress })
 *   renderRange(project, timeline, range, outputPath, { mediaRoot, quality, height, onProgress, signal })
 *   renderFullCached(project, timeline, cacheDir, outputPath, { mediaRoot, quality, onProgress, signal })
 *
 * The fallback here is a small ffmpeg implementation that handles the common
 * case: straight cuts of media clips on video tracks (topmost wins) plus audio
 * from those clips and from audio tracks, mixed. No transforms, fades, captions
 * or colour clips (gaps render black/silent).
 */
import { LOCAL_MEDIA_INPUT, extractWaveformFull as decodeWaveform, hashFile, renderPlaybackSegment, type WaveformCache as BinaryWaveformCache } from "@scarlet/render";
import { join } from "node:path";
import type { MediaAsset, MediaClip, MediaKind, Project, Timeline, TimeRange } from "@scarlet/timeline";
import { clipEnd, timelineDuration, timelineToSource } from "@scarlet/timeline";
import { ffmpeg, ffmpegPosition, ffprobe } from "./ffmpeg.js";
import { originalPlaybackType } from "../files.js";

export interface ProbeResult {
  previewClock?: MediaAsset["previewClock"];
  originalPlaybackType?: string;
  duration: number;
  fps?: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasAlpha?: boolean;
  kind: MediaKind;
}

export interface WaveformData<Values extends ArrayLike<number> = number[]> {
  peaks: Values;
  rms?: Values;
}

/** Full waveform samples from the binary or legacy JSON cache. */
export interface WaveformCache extends WaveformData<number[] | Float32Array> {
  pointsPerSecond: number;
  duration: number;
}

export interface RenderOptions {
  /** Absolute dir that MediaAsset.path is relative to. */
  mediaRoot: string;
  quality: "preview" | "delivery";
  exportRange?: TimeRange;
  exportHeight?: number;
  omitCaptions?: boolean;
  /** Output height in px (width follows the project aspect). Defaults to project height. */
  height?: number;
  hwaccel?: "none" | "auto" | "nvenc" | "qsv" | "videotoolbox";
  onProgress?: (p: number) => void;
  /** Called once for each thing the renderer couldn't do as asked and worked around: a missing source, an unsupported effect. */
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
  /** Cache segments a full render encodes at once (default 1). */
  concurrency?: number;
}

export interface RenderAdapter {
  probeMedia(path: string, signal?: AbortSignal): Promise<ProbeResult>;
  hashFile(path: string, onBytesRead?: (bytes: number) => void, signal?: AbortSignal): Promise<string>;
  extractWaveformFull(path: string, duration: number, pointsPerSecond: number, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<BinaryWaveformCache | WaveformData>;
  waveformFromCache(cache: WaveformCache, from: number, to: number, points: number): WaveformData;
  extractFrame(path: string, t: number, opts: { width: number; signal?: AbortSignal; indexedMp4?: boolean; decoder?: "cuda" }): Promise<Buffer>;
  makeProxy(input: string, output: string, opts: { height: number; checkpointDir?: string; range?: TimeRange; hwaccel?: RenderOptions["hwaccel"]; signal?: AbortSignal; onProgress?: (p: number) => void }): Promise<void>;
  /** True when footage proxies can be encoded on the GPU. The fallback adapter never can. */
  hardwareProxies?(hwaccel: RenderOptions["hwaccel"]): Promise<boolean>;
  renderRange(project: Project, timeline: Timeline, range: TimeRange, outputPath: string, opts: RenderOptions): Promise<void>;
  renderPlaybackSegment: typeof renderPlaybackSegment;
  renderFullCached(project: Project, timeline: Timeline, cacheDir: string, outputPath: string,
    opts: RenderOptions & { onCachedRanges?(ranges: TimeRange[]): void }): Promise<void>;
}

// ---------------------------------------------------------------------------
// ffmpeg fallback
// ---------------------------------------------------------------------------

const IMAGE_CODECS = new Set(["mjpeg", "png", "bmp", "tiff", "webp", "gif", "ppm", "pgm"]);
const ALPHA_HINTS = ["yuva", "rgba", "argb", "bgra", "abgr", "gbrap", "ya8", "ya16"];

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: Record<string, number>;
}

function parseRate(s?: string): number | undefined {
  if (!s) return undefined;
  const [n, d] = s.split("/").map(Number);
  if (!n || !d) return undefined;
  const v = n / d;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : undefined;
}

async function probeMedia(path: string, signal?: AbortSignal): Promise<ProbeResult> {
  const out = await ffprobe(["-print_format", "json", "-show_format", "-show_streams", ...LOCAL_MEDIA_INPUT, path], { signal });
  const json = JSON.parse(out.toString("utf8")) as { format?: { duration?: string }; streams?: ProbeStream[] };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic === 1));
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatDuration = Number(json.format?.duration);
  let duration = Number.isFinite(formatDuration) ? formatDuration : Number(video?.duration ?? audio?.duration ?? 0);
  if (!Number.isFinite(duration)) duration = 0;
  let kind: MediaKind = "video";
  if (video) {
    const isImage =
      IMAGE_CODECS.has(video.codec_name ?? "") && (!json.format?.duration || video.nb_frames === "1" || duration < 0.1);
    kind = isImage ? "image" : "video";
    if (isImage) duration = 0;
  } else if (audio) {
    kind = "audio";
  }
  return {
    duration: Math.max(0, duration),
    fps: video && kind === "video" ? parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) : undefined,
    width: video?.width,
    height: video?.height,
    hasAudio: !!audio,
    hasAlpha: video?.pix_fmt ? ALPHA_HINTS.some((h) => video.pix_fmt!.includes(h)) : undefined,
    kind,
    originalPlaybackType: originalPlaybackType(path, kind, video?.codec_name, audio?.codec_name),
  };
}

function extractWaveformFull(path: string, duration: number, pointsPerSecond: number, onProgress?: (fraction: number) => void, signal?: AbortSignal) {
  return decodeWaveform(path, duration, pointsPerSecond, { onProgress, signal });
}

function waveformFromCache(cache: WaveformCache, from: number, to: number, points: number): WaveformData {
  const n = Math.max(1, Math.floor(points));
  const peaks = new Array<number>(n).fill(0);
  const rms = new Array<number>(n).fill(0);
  const span = Math.max(0, to - from);
  const pps = cache.pointsPerSecond;
  for (let i = 0; i < n; i++) {
    const t0 = from + (span * i) / n;
    const t1 = from + (span * (i + 1)) / n;
    const s = Math.max(0, Math.floor(t0 * pps));
    const e = Math.min(cache.peaks.length, Math.max(s + 1, Math.ceil(t1 * pps)));
    let peak = 0;
    let sum = 0;
    let c = 0;
    for (let k = s; k < e; k++) {
      peak = Math.max(peak, cache.peaks[k] ?? 0);
      sum += cache.rms?.[k] ?? 0;
      c++;
    }
    peaks[i] = peak;
    rms[i] = c ? Math.round((sum / c) * 1000) / 1000 : 0;
  }
  return { peaks, rms: cache.rms ? rms : undefined };
}

async function extractFrame(path: string, t: number, opts: { width: number; signal?: AbortSignal }): Promise<Buffer> {
  const w = Math.max(16, Math.round(opts.width));
  return ffmpeg([
    "-ss", ffmpegPosition(Math.max(0, t)), ...LOCAL_MEDIA_INPUT, "-i", path, "-frames:v", "1", "-vf", `scale=${w}:-2`,
    "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "pipe:1",
  ], { signal: opts.signal });
}

async function makeProxy(input: string, output: string, opts: Parameters<RenderAdapter["makeProxy"]>[2]) {
  const h = Math.max(2, Math.round(opts.height / 2) * 2);
  let duration: number | undefined;
  if (opts.onProgress) {
    try {
      duration = (await probeMedia(input)).duration;
    } catch {
      /* progress is best-effort */
    }
  }
  await ffmpeg(
    [
      ...(opts.onProgress ? ["-progress", "pipe:1", "-nostats"] : []),
      ...(opts.range ? ["-ss", ffmpegPosition(opts.range.start)] : []),
      ...LOCAL_MEDIA_INPUT, "-i", input,
      ...(opts.range ? ["-t", String(opts.range.end - opts.range.start)] : []),
      "-vf", `scale=-2:'min(${h},ih)'`,
      "-c:v", "libx264", "-preset", opts.range ? "ultrafast" : "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-force_key_frames", "expr:gte(t,n_forced*0.5)",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", output,
    ],
    { signal: opts.signal, onProgress: opts.onProgress, duration },
  );
}

// -- naive range renderer ----------------------------------------------------

interface Piece {
  start: number;
  end: number;
  video: MediaClip | null;
  audio: MediaClip[];
}

function activeClipsAt(timeline: Timeline, t: number) {
  const videoTracks = timeline.tracks.filter((tr) => tr.kind === "video" && !tr.hidden);
  const audioTracks = timeline.tracks.filter((tr) => tr.kind === "audio" && !tr.muted);
  const covers = (c: MediaClip) => c.enabled !== false && c.timelineIn <= t && t < clipEnd(c);
  let video: MediaClip | null = null;
  let videoMuted = false;
  // Topmost (last) video track wins.
  for (let i = videoTracks.length - 1; i >= 0 && !video; i--) {
    const track = videoTracks[i]!;
    const c = track.clips.find((cl): cl is MediaClip => cl.kind === "media" && covers(cl));
    if (c) {
      video = c;
      videoMuted = track.muted;
    }
  }
  const audio: MediaClip[] = [];
  if (video && !videoMuted && video.volume > 0) audio.push(video);
  for (const track of audioTracks) {
    for (const c of track.clips) if (c.kind === "media" && covers(c) && c.volume > 0) audio.push(c);
  }
  return { video, audio };
}

function buildPieces(timeline: Timeline, range: TimeRange): Piece[] {
  const cuts = new Set<number>([range.start, range.end]);
  for (const track of timeline.tracks) {
    if (track.kind === "caption") continue;
    for (const c of track.clips) {
      for (const t of [c.timelineIn, clipEnd(c)]) if (t > range.start && t < range.end) cuts.add(t);
    }
  }
  const times = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i]!;
    const end = times[i + 1]!;
    if (end - start < 0.002) continue;
    const mid = (start + end) / 2;
    const { video, audio } = activeClipsAt(timeline, mid);
    pieces.push({ start, end, video, audio });
  }
  return pieces;
}

function fmt(n: number) {
  return n.toFixed(4);
}

async function renderRange(project: Project, timeline: Timeline, range: TimeRange, outputPath: string, opts: RenderOptions) {
  const fps = project.settings.fps;
  const sr = project.settings.sampleRate;
  const outH = Math.max(2, Math.round((opts.height ?? project.settings.height) / 2) * 2);
  const outW = Math.max(2, Math.round((project.settings.width * outH) / project.settings.height / 2) * 2);
  const media = new Map<string, MediaAsset>(project.media.map((m) => [m.id, m]));
  const resolvePath = (m: MediaAsset) => join(opts.mediaRoot, m.path);

  const total = Math.max(0, range.end - range.start);
  const pieces = buildPieces(timeline, range);
  if (!pieces.length) pieces.push({ start: range.start, end: Math.max(range.end, range.start + 1 / fps), video: null, audio: [] });

  const inputs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;
  const concatInputs: string[] = [];

  const pad = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;

  pieces.forEach((piece, n) => {
    const dur = piece.end - piece.start;
    // Video
    const asset = piece.video ? media.get(piece.video.mediaId) : undefined;
    if (piece.video && asset && asset.kind !== "audio") {
      const clip = piece.video;
      const speed = clip.speed ?? 1;
      const srcStart = timelineToSource(clip, piece.start);
      const srcDur = dur * speed;
      if (asset.kind === "image") {
        inputs.push("-loop", "1", "-framerate", String(fps), "-t", fmt(dur), ...LOCAL_MEDIA_INPUT, "-i", resolvePath(asset));
      } else {
        inputs.push("-ss", fmt(srcStart), "-t", fmt(srcDur + 0.05), ...LOCAL_MEDIA_INPUT, "-i", resolvePath(asset));
      }
      const idx = inputIndex++;
      const pts = speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${speed}`;
      filters.push(`[${idx}:v]${pts},fps=${fps},${pad},trim=duration=${fmt(dur)},setpts=PTS-STARTPTS[v${n}]`);
    } else {
      filters.push(`color=c=black:s=${outW}x${outH}:r=${fps}:d=${fmt(dur)},format=yuv420p[v${n}]`);
    }
    // Audio
    const audioLabels: string[] = [];
    piece.audio.forEach((clip, k) => {
      const a = media.get(clip.mediaId);
      if (!a || a.hasAudio === false || a.kind === "image") return;
      const speed = clip.speed ?? 1;
      const srcStart = timelineToSource(clip, piece.start);
      inputs.push("-ss", fmt(srcStart), "-t", fmt(dur * speed + 0.05), ...LOCAL_MEDIA_INPUT, "-i", resolvePath(a));
      const idx = inputIndex++;
      const tempo = speed !== 1 && speed >= 0.5 && speed <= 2 ? `,atempo=${speed}` : "";
      filters.push(
        `[${idx}:a]asetpts=PTS-STARTPTS${tempo},aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.volume},atrim=duration=${fmt(dur)},apad=whole_dur=${fmt(dur)}[a${n}_${k}]`,
      );
      audioLabels.push(`[a${n}_${k}]`);
    });
    if (audioLabels.length === 0) {
      filters.push(`anullsrc=r=${sr}:cl=stereo:d=${fmt(dur)}[a${n}]`);
    } else if (audioLabels.length === 1) {
      filters.push(`${audioLabels[0]}anull[a${n}]`);
    } else {
      filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest[a${n}]`);
    }
    concatInputs.push(`[v${n}][a${n}]`);
  });

  filters.push(`${concatInputs.join("")}concat=n=${pieces.length}:v=1:a=1[vout][aout]`);

  const crf = opts.quality === "delivery" ? "18" : "23";
  const preset = opts.quality === "delivery" ? "medium" : "veryfast";
  await ffmpeg(
    [
      "-progress", "pipe:1", "-nostats",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]", "-map", "[aout]", "-map_chapters", "-1",
      "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p", "-r", String(fps),
      ...(opts.quality === "delivery" ? [] : ["-g", String(Math.max(1, Math.round(fps / 2)))]),
      "-c:a", "aac", "-b:a", "160k", "-ar", String(sr),
      "-movflags", "+faststart", "-y", outputPath,
    ],
    { signal: opts.signal, onProgress: opts.onProgress, duration: total },
  );
  opts.onProgress?.(1);
}

async function renderFullCached(project: Project, timeline: Timeline, _cacheDir: string, outputPath: string, opts: RenderOptions) {
  // The fallback has no segment cache.
  const range = opts.exportRange ?? { start: 0, end: timelineDuration(timeline) };
  await renderRange(project, timeline, range, outputPath, opts);
}

export const fallbackAdapter: RenderAdapter = {
  probeMedia,
  hashFile,
  extractWaveformFull,
  waveformFromCache,
  extractFrame,
  makeProxy,
  renderRange,
  renderPlaybackSegment,
  renderFullCached,
};

/** Kept for tests and as a reference; the server defaults to scarletRender.ts. */
export const adapter: RenderAdapter = fallbackAdapter;
