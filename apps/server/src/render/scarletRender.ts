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

/** Where the renderer's own diagnostic lines go: the engine sets it to its log at startup. */
export const renderLog = R.renderLog;

function hwaccel(opts: RenderOptions): R.HwAccel {
  const h = (opts as { hwaccel?: string }).hwaccel;
  return h === "none" || h === "nvenc" || h === "qsv" || h === "amf" || h === "videotoolbox" ? h : "auto";
}

/** A stored hash identifies the current bytes only while its filesystem stamp matches.
 * Give unverified originals a file-local cache identity so they cannot reuse a different source’s picture. */
async function cacheInputs(project: Project, timeline: Timeline, root: string, range?: TimeRange): Promise<Project> {
  // A transition shows its incoming and outgoing sources up to half its length outside their clips’ own spans
  // (planTransitions). Widening the range by the longest half keeps every source it can show, without planning twice.
  let reach = 0;
  if (range) for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind === "media" && clip.transitionIn) reach = Math.max(reach, clip.transitionIn.duration / 2);
  }
  const window = range && { start: range.start - reach, end: range.end + reach };
  const used = new Set<string>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind === "media" && clip.enabled !== false && (!window || rangesOverlap(clipRange(clip), window))) used.add(clip.mediaId);
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
    // A failure is the caller's to log: each one that carries on without the facts says so with its media and consequence.
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
      ...(fields.audioStreams ? { audioStreams: fields.audioStreams } : {}),
      hasAlpha: probe.hasAlpha,
      color: fields.color,
      kind,
      originalPlaybackType: originalPlaybackType(path, kind, probe.videoCodec, probe.audioCodec),
    };
  },

  hashFile: R.hashFile,

  extractWaveformFull(path, duration, pointsPerSecond, onProgress, signal, audio) {
    return R.extractWaveformFull(path, duration, pointsPerSecond, {
      onProgress,
      signal,
      audioTrack: audio?.audioTrack,
      audioStreamCount: audio?.audioStreamCount,
    });
  },

  waveformFromCache(cache: WaveformCache, from: number, to: number, points: number): WaveformData {
    const wf = R.waveformFromCache(cache, from, to, points);
    return { peaks: wf.peaks, rms: cache.rms ? wf.rms : undefined };
  },

  extractFrame(path, t, opts) {
    // A frame that fails altogether is logged by its route (frame_fallback, or the request's failure).
    return R.extractFrame(path, t, {
      ...opts,
      onFallback: reason => R.logRender(() => `[media] frame: ${R.logReason(reason, 300)}`, `frame-fallback:${reason.slice(0, 40)}`),
    });
  },

  async makeProxy(input, output, opts) {
    const started = Date.now();
    const result = await R.makeProxy(input, output, { ...opts, hwaccel: hwaccel(opts as RenderOptions) });
    // A scrub window is a few seconds of work, made as the editor scrubs: only what it fell back from is kept.
    for (const warning of result.warnings) R.logRender(`[media] proxy: ${R.logReason(warning, 300)}`, `proxy-warning:${warning}`);
    if (!opts.range) {
      R.logRender(`[media] proxy encoded with ${result.encoder ?? "libx264"} in ${R.logElapsed(Date.now() - started)}: ` +
        `${result.duration.toFixed(1)} s, ${result.hasVideo ? (opts.height ? `${opts.height}p` : "default height") : "sound only"}${result.warnings.length ? `, ${result.warnings.length} fallbacks` : ""}`);
    }
  },

  async hardwareProxies(accel) {
    return (await R.resolveVideoEncoder(hwaccel({ hwaccel: accel } as RenderOptions))) !== "libx264";
  },

  async renderRange(project: Project, timeline: Timeline, range: TimeRange, outputPath: string, opts: RenderOptions) {
    const { warnings } = await R.renderRange(project, timeline, range, outputPath, {
      pictureSource:opts.quality==="preview"?previewPictures(opts.mediaRoot):undefined,
      mediaRoot: opts.mediaRoot,
      lutRoots: opts.lutRoots,
      quality: opts.quality,
      height: opts.height,
      fontDirs: opts.fontDirs,
      hwaccel: hwaccel(opts),
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    for (const warning of warnings) opts.onWarning?.(warning);
  },

  async renderPlaybackSegment(project, timeline, range, cacheDir, output, opts) {
    // The playback window includes footage outside the range when a transition needs its handles.
    const inputs = await cacheInputs(project, timeline, opts.mediaRoot);
    // A renderer that reports nothing for a playback section resolves with nothing.
    const result = (await R.renderPlaybackSegment(inputs, timeline, range, cacheDir, output, {
      ...opts, pictureSource: previewPictures(opts.mediaRoot),
    })) as { warnings?: string[] } | undefined;
    for (const warning of result?.warnings ?? []) (opts as RenderOptions).onWarning?.(warning);
  },

  async renderFullCached(project, timeline, cacheDir, outputPath, opts) {
    const inputs = await cacheInputs(project, timeline, opts.mediaRoot, opts.exportRange);
    if (opts.exportRange) {
      // Segment boundaries and the audio mix plan use media kinds across the timeline.
      const verified = new Map(inputs.media.map(asset => [asset.id, asset]));
      inputs.media = project.media.map(asset => verified.get(asset.id) ?? asset);
    }
    const { encoder, rendered, warnings } = await R.renderFullCached(inputs, timeline, cacheDir, outputPath, {
      exportHeight: opts.exportHeight,
      exportRange: opts.exportRange,
      onCachedRanges: opts.onCachedRanges,
      onReused: opts.onReused,
      omitCaptions: opts.omitCaptions,
      best: opts.best,
      pictureSource: opts.quality === "preview" && opts.exportHeight === undefined ? previewPictures(opts.mediaRoot) : undefined,
      mediaRoot: opts.mediaRoot,
      lutRoots: opts.lutRoots,
      quality: opts.quality,
      height: opts.height,
      fontDirs: opts.fontDirs,
      hwaccel: hwaccel(opts),
      onProgress: opts.onProgress,
      signal: opts.signal,
      concurrency: opts.concurrency,
    });
    for (const warning of warnings) opts.onWarning?.(warning);
    return { encoder, rendered };
  },
};
