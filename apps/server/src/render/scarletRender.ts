/**
 * RenderAdapter backed by @scarlet/render (the full ffmpeg filter-graph
 * renderer: transforms, keyframes, fades, captions, colour clips, effects,
 * content-addressed segment cache). The fallback in adapter.ts stays as a
 * minimal reference implementation and for tests that stub rendering.
 */
import { previewPictures } from "../services/previewPictures.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as R from "@scarlet/render";
import { originalPlaybackType } from "../files.js";
import { clipRange, rangesOverlap, sha256, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { ProbeResult, RenderAdapter, RenderOptions, WaveformCache, WaveformData } from "./adapter.js";

function hwaccel(opts: RenderOptions): R.HwAccel {
  const h = (opts as { hwaccel?: string }).hwaccel;
  return h === "none" || h === "nvenc" || h === "qsv" || h === "amf" || h === "videotoolbox" ? h : "auto";
}

/** A stored hash identifies the current bytes only while its filesystem stamp matches.
 * Give unverified originals a file-local cache identity so they cannot reuse a different source’s picture. */
async function cacheInputs(project: Project, timeline: Timeline, root: string, range?: TimeRange): Promise<Project> {
  const used = new Set<string>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind === "media" && clip.enabled !== false && (!range || rangesOverlap(clipRange(clip), range))) used.add(clip.mediaId);
  }
  const media = await Promise.all(project.media.filter(asset => used.has(asset.id)).map(async asset => {
    const file = join(root, asset.path);
    const info = await stat(file).catch(() => undefined);
    const recorded = asset.fingerprintStamp;
    if (info && asset.hash && recorded?.size === info.size && recorded.mtimeMs === info.mtimeMs && recorded.ctimeMs === info.ctimeMs) return asset;
    const local = sha256(JSON.stringify(["file-stamp", file, asset.hash, info?.size, info?.ctimeMs, info?.mtimeMs]));
    return { ...asset, hash: local };
  }));
  return { ...project, media };
}

export const scarletRenderAdapter: RenderAdapter = {
  async probeMedia(path: string, signal?: AbortSignal): Promise<ProbeResult> {
    const probe = await R.probeMedia(path, { signal });
    const fields = R.probeToAssetFields(probe);
    const kind = R.detectMediaKind(probe, path);
    return {
      duration: fields.duration ?? 0,
      previewClock: probe.previewClock,
      fps: fields.fps,
      width: fields.width,
      height: fields.height,
      hasAudio: probe.hasAudio,
      hasAlpha: probe.hasAlpha,
      kind,
      originalPlaybackType: originalPlaybackType(path, kind, probe.videoCodec, probe.audioCodec),
    };
  },

  hashFile: R.hashFile,

  extractWaveformFull(path, duration, pointsPerSecond, onProgress, signal) {
    return R.extractWaveformFull(path, duration, pointsPerSecond, { onProgress, signal });
  },

  waveformFromCache(cache: WaveformCache, from: number, to: number, points: number): WaveformData {
    const wf = R.waveformFromCache(cache, from, to, points);
    return { peaks: wf.peaks, rms: cache.rms ? wf.rms : undefined };
  },

  extractFrame(path, t, opts) {
    return R.extractFrame(path, t, opts);
  },

  async makeProxy(input, output, opts) {
    await R.makeProxy(input, output, { ...opts, hwaccel: hwaccel(opts as RenderOptions) });
  },

  async hardwareProxies(accel) {
    return (await R.resolveVideoEncoder(hwaccel({ hwaccel: accel } as RenderOptions))) !== "libx264";
  },

  async renderRange(project: Project, timeline: Timeline, range: TimeRange, outputPath: string, opts: RenderOptions) {
    const { warnings } = await R.renderRange(project, timeline, range, outputPath, {
      pictureSource:opts.quality==="preview"?previewPictures(opts.mediaRoot):undefined,
      mediaRoot: opts.mediaRoot,
      quality: opts.quality,
      height: opts.height,
      hwaccel: hwaccel(opts),
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    for (const warning of warnings) opts.onWarning?.(warning);
  },

  async renderPlaybackSegment(project, timeline, range, cacheDir, output, opts) {
    const inputs = await cacheInputs(project, timeline, opts.mediaRoot, range);
    // A renderer that reports nothing for a playback section resolves with nothing.
    const result = (await R.renderPlaybackSegment(inputs, timeline, range, cacheDir, output, {
      ...opts, pictureSource: previewPictures(opts.mediaRoot),
    })) as { warnings?: string[] } | undefined;
    for (const warning of result?.warnings ?? []) (opts as RenderOptions).onWarning?.(warning);
  },

  async renderFullCached(project, timeline, cacheDir, outputPath, opts) {
    const inputs = await cacheInputs(project, timeline, opts.mediaRoot);
    const { warnings } = await R.renderFullCached(inputs, timeline, cacheDir, outputPath, {
      exportHeight: opts.exportHeight,
      exportRange: opts.exportRange,
      onCachedRanges: opts.onCachedRanges,
      omitCaptions: opts.omitCaptions,
      pictureSource: opts.quality === "preview" && opts.exportHeight === undefined ? previewPictures(opts.mediaRoot) : undefined,
      mediaRoot: opts.mediaRoot,
      quality: opts.quality,
      height: opts.height,
      hwaccel: hwaccel(opts),
      onProgress: opts.onProgress,
      signal: opts.signal,
      concurrency: opts.concurrency,
    });
    for (const warning of warnings) opts.onWarning?.(warning);
  },
};
