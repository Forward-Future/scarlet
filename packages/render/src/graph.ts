/**
 * Cut list → ffmpeg filter graph.
 *
 * One range of the timeline becomes: a `color` canvas at the project size and
 * frame rate, every visible video/colour clip overlaid bottom track first,
 * captions drawn on top with drawtext, and every audible clip trimmed,
 * positioned with adelay and summed with amix. Each media clip is its own
 * `-ss/-t` input so long sources are only decoded where they are used.
 *
 * Time 0 of the output is `range.start`. Clip-local effects (fades, keyframes)
 * are evaluated in clip time by shifting PTS so that a clip's first visible
 * frame carries the timestamp it would have had if the clip were not trimmed.
 *
 * The graph is written to a temp file and passed with `-/filter_complex`
 * (ffmpeg >= 7; `-filter_complex_script` before that) to stay clear of the
 * Windows command-line length limit.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ColorClip,
  MediaAsset,
  MediaClip,
  Project,
  Timeline,
  TimeRange,
  TransitionPlan,
} from "@scarlet/timeline";
import { audioMixStreamsFilter, resolveAudioTrack, type ResolvedAudioTrack } from "./audioTrack.js";
import { INDEXED_MP4_INPUT, LOCAL_MEDIA_INPUT, SOURCE_AUDIO_CLOCK, even, ffmpegMajor, fnum, requireDrawtext } from "./exec.js";
import { audioEffectDelay, effectFilters } from "./effects.js";
import { canZscale, toneMapChain, type HdrTransfer } from "./hdr.js";
import type { FontOptions } from "./fonts.js";
import { buildCaptionDrawtexts, wrapText } from "./graphCaptions.js";
import { adjacentPictureReads, collectCanvasCovers, directExportPicture, hasIndexedClock } from "./graphOptimize.js";
import {
  FRAME_SLACK,
  atempoFactors,
  clipPlacement,
  ffColor,
  fillsFrames,
  holdsFrame,
  holdsSample,
  keyframeExpr,
  overlayPosition,
  proxyHeightForClip,
  resolveTransform,
  signed,
  transformChain,
  videoClockStart,
  type AnimatedTransform,
  type Placement,
} from "./graphTransform.js";
import { CUDA_FRAMES_INPUT } from "./mediaInput.js";
import { hasIndexedAvc, isImagePath, isStillAsset, probeMedia, storedAsShown, type ProbeResult } from "./probe.js";
import { motionFilters, motionOffsets, motionsIn, planTransitions, type TransitionMotion } from "./transitions.js";

export {
  atempoFactors,
  clipPlacement,
  directExportPicture,
  ffColor,
  fillsFrames,
  holdsFrame,
  holdsSample,
  keyframeExpr,
  proxyHeightForClip,
  videoClockStart,
  wrapText,
};

export interface GraphOptions extends FontOptions {
  decoder?: "videotoolbox" | "videotoolbox-hevc" | "cuda";
  /** Look for an original picture the delivery encoder can read directly. */
  directPicture?: boolean;
  /** When the timeline was sliced after planning, use the original transitions and picture-only layers. */
  transitions?: Pick<TransitionPlan, "motions" | "layers">;
  /** Reuse probed movie headers for seeks when the caller supports discovery fallback. */
  indexedInputs?: boolean;
  signal?: AbortSignal;
  pictureSource?: (asset: MediaAsset, from: number, to: number, minimumHeight: number) => Promise<{ file: string; start: number } | undefined>;
  audioOnly?: boolean;
  /** Exact sample count for a lossless delivery mix segment. */
  audioSamples?: number;
  pictureOnly?: boolean;
  /** Internal analysis filters applied to the completed picture, before the output map. */
  pictureFilter?: string;
  /** Absolute directory that relative `MediaAsset.path`s resolve against. */
  mediaRoot: string;
  /** Optional extra trusted directories (such as library-wide style guides) for `.cube`/`.3dl` LUTs. */
  lutRoots?: readonly string[];
  /** Output canvas; defaults to the project settings. Previews pass a smaller size. */
  width?: number;
  height?: number;
  fps?: number;
  /** Sample a single picture at range.start, without decoding audio. */
  singleFrame?: boolean;
  /** Where the filter script and caption text files are written (default os.tmpdir()). */
  tempDir?: string;
  /** Probe cache keyed by media id, consulted when an asset lacks `hasAudio`. */
  probes?: Map<string, ProbeResult>;
  ffprobePath?: string;
  ffmpegPath?: string;
}

export interface FilterGraph {
  /** A candidate for direct encoding. The encoder must verify its decoded frame clock before publishing. */
  directPicture?: { file: string; start: number; frames: number };
  /** ffmpeg argv after the binary: inputs, the filter script option and output maps. */
  args: string[];
  /** Input files in `-i` order (one per media clip). */
  inputs: string[];
  warnings: string[];
  /** The filter graph text (also written to `scriptPath`). */
  graph: string;
  scriptPath: string;
  videoLabel: string;
  audioLabel: string;
  /** False when the audio output is generated silence. */
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  duration: number;
  range: TimeRange;
  /** Remove the temp directory holding the script and caption files. */
  cleanup: () => Promise<void>;
}

/** How a media clip's picture enters the graph. */
interface MediaPicture {
  still: boolean;
  /** Shrink the CUDA frames on the GPU before they come back to memory. */
  cudaScale: boolean;
  /** Where the clip's first frame is in an input it shares with the clips beside it. */
  sharedStart?: number;
  /** A still read once and repeated in the graph. */
  held: boolean;
  /** One picture on every project frame (`fillsFrames`). */
  filled: boolean;
  toneMap: string[];
}

export async function buildFilterGraph(
  project: Project,
  timeline: Timeline,
  range: TimeRange,
  opts: GraphOptions,
): Promise<FilterGraph> {
  const tmp = await fs.mkdtemp(path.join(opts.tempDir ?? os.tmpdir(), "scarlet-graph-"));
  const cleanup = () => fs.rm(tmp, { recursive: true, force: true });
  try {
    return await writeFilterGraph(project, timeline, range, opts, tmp, cleanup);
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function writeFilterGraph(
  project: Project, timeline: Timeline, range: TimeRange, opts: GraphOptions,
  tmp: string, cleanup: () => Promise<void>,
): Promise<FilterGraph> {
  const settings = project.settings;
  const W = even(opts.width ?? settings.width);
  const H = even(opts.height ?? settings.height);
  const fps = opts.fps ?? settings.fps;
  const SR = settings.sampleRate;
  const layout = settings.audioChannels === 1 ? "mono" : "stereo";
  const R0 = range.start;
  const R1 = range.end;
  const D = R1 - R0;
  if (!(D > 0)) throw new Error(`empty render range ${R0}..${R1}`);

  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const media = new Map(project.media.map((m) => [m.id, m]));
  const probes = opts.probes ?? new Map<string, ProbeResult>();
  const effectCtx = { mediaRoot: opts.mediaRoot, lutRoots: opts.lutRoots, warn };
  // Transitions add picture-only layers around their joins and move the clips either side.
  const transitions = opts.transitions
    ? { timeline, motions: opts.transitions.motions, layers: opts.transitions.layers }
    : planTransitions(timeline, media, fps);
  timeline = transitions.timeline;
  const motionsOf = (id: string): TransitionMotion[] => motionsIn(transitions.motions.get(id), R0, R1);

  const inputs: string[] = [];
  const inputArgs: string[] = [];
  const opened = new Map<string, number>();
  const addInput = (pre: string[], file: string): number => {
    const key = JSON.stringify([file, pre]);
    const previous = opened.get(key);
    if (previous !== undefined) return previous;
    opened.set(key, inputs.length);
    inputArgs.push(...pre, ...LOCAL_MEDIA_INPUT, "-i", file);
    inputs.push(file);
    return inputs.length - 1;
  };

  const lines: string[] = [];
  let labelN = 0;
  const label = (p: string) => `[${p}${labelN++}]`;

  const mediaPath = (asset: MediaAsset) =>
    path.isAbsolute(asset.path) ? asset.path : path.join(opts.mediaRoot, asset.path);

  const probeAsset = async (asset: MediaAsset) => {
    const cached = probes.get(asset.id);
    if (cached) return cached;
    const result = await probeMedia(mediaPath(asset), { ffprobePath: opts.ffprobePath, signal: opts.signal });
    probes.set(asset.id, result);
    return result;
  };

  const hasAudio = async (asset: MediaAsset, file: string): Promise<boolean> => {
    if (asset.kind === "audio") return true;
    if (asset.kind === "image") return false;
    if (asset.hasAudio !== undefined) return asset.hasAudio;
    if (isStillAsset(asset, file)) return false;
    try { return (await probeAsset(asset)).hasAudio; }
    catch (e) {
      opts.signal?.throwIfAborted();
      warn(`could not probe ${asset.path}: ${(e as Error).message.split("\n")[0]}`);
      return false;
    }
  };

  // Canvas.
  if (!opts.audioOnly) lines.push(`color=c=${ffColor(timeline.background)}:s=${W}x${H}:r=${fnum(fps)}:d=${fnum(D)}[base]`);
  let stack = "[base]";
  const audioLabels: string[] = [];
  const includeAudio = !opts.singleFrame && !opts.pictureOnly;
  let directPicture: FilterGraph["directPicture"];

  /** Lay `layer` over the stack where its transform, at `localT`, and its transition `moves` put it. */
  const overlay = (layer: string, tf: AnimatedTransform, localT: string, moves: TransitionMotion[], p: Placement, filled = false) => {
    directPicture = undefined;
    const pos = overlayPosition(tf, localT);
    const moved = motionOffsets(moves, W, H);
    const x = moved.x ? `${pos.x}+${moved.x}` : pos.x;
    const y = moved.y ? `${pos.y}+${moved.y}` : pos.y;
    const out = label("s");
    // The layer's own end stops it. Its start needs the test: overlay shows a layer from the base frame
    // nearest its first picture, which can be the frame before. A filled layer holds its last picture for as
    // long as its source showed it, which can be past the clip, so its window also ends on the clip's last
    // frame, as a caption's does. Any other layer keeps the frame it has when its clip ends just after one.
    lines.push(
      `${stack}${layer}overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${fnum(p.pos - FRAME_SLACK)},${fnum(p.pos + p.vis - (filled ? FRAME_SLACK : 0))})'${out}`,
    );
    stack = out;
  };

  const videoForMedia = (clip: MediaClip, idx: number, p: Placement, { still, cudaScale, sharedStart, held, filled, toneMap }: MediaPicture) => {
    const speed = clip.speed ?? 1;
    const moves = motionsOf(clip.id);
    const tf = resolveTransform(clip, warn);
    const chain: string[] = [];
    // Repeat the first picture on the clock the image demuxer's loop gives a still: one tick a frame.
    if (held) chain.push("loop=loop=-1:size=1:start=0", "settb=AVTB", `setpts=N/${fnum(fps)}/TB`, `fps=${fnum(fps)}`);
    // Download only the preview-sized picture for the CPU compositor.
    if (cudaScale) chain.push(`scale_cuda=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:format=yuv420p:interp_algo=bicubic`, "hwdownload", "format=yuv420p");
    // Source → clip-local time (speed applied, shifted so the first visible frame
    // sits at local0, which keeps fades and keyframes in clip time).
    chain.push(sharedStart === undefined ? `trim=duration=${fnum(still ? p.vis : p.vis * speed)}`
      : `trim=start=${fnum(sharedStart)}:end=${fnum(sharedStart + p.vis)}`);
    const div = speed !== 1 && !still ? `/${fnum(speed)}` : "";
    const localStart = videoClockStart(clip, p.local0);
    // A still's clock ticks once a frame and setpts drops the fraction, so 0.033333 s would land a frame early.
    const offset = (seconds: number) => still ? `${seconds < 0 ? "-" : "+"}round(${fnum(Math.abs(seconds))}/TB)` : signed(seconds, "/TB");
    chain.push(`setpts=(PTS-STARTPTS)${div}${localStart > 0 ? offset(localStart) : ""}`);
    // An HDR picture becomes SDR before anything else is done to it, so effects, looks and the canvas see what a normal screen shows.
    chain.push(...toneMap);
    chain.push(...effectFilters(clip.effects, "video", effectCtx));
    chain.push(...transformChain(tf, W, H));
    if (clip.videoFadeIn > 0) chain.push(`fade=t=in:st=0:d=${fnum(clip.videoFadeIn)}:alpha=1`);
    if (clip.videoFadeOut > 0) {
      chain.push(`fade=t=out:st=${fnum(Math.max(0, p.clipDur - clip.videoFadeOut))}:d=${fnum(clip.videoFadeOut)}:alpha=1`);
    }
    if (clip.opacity < 1) chain.push(`format=rgba,colorchannelmixer=aa=${fnum(clip.opacity)},format=yuva420p`);
    // Clip-local → output time.
    const shift = p.pos - localStart;
    if (shift !== 0) chain.push(`setpts=PTS${offset(shift)}`);
    // A transition's fades and blur run on the output clock, across the clip and the layer that continues it.
    chain.push(...motionFilters(moves, W, c => ffColor(c)));
    // Overlay shows a layer's last picture for one project frame, however long its source showed it, and of two
    // pictures that land on one frame it shows the first. Filled, the layer has one picture on every frame: each
    // held until the next, and the last to the end of its stream.
    if (filled) chain.push(`fps=${fnum(fps)}`);
    const lbl = label("v");
    lines.push(`[${idx}:v]${chain.join(",")}${lbl}`);
    overlay(lbl, tf, shift ? `(t${signed(-shift)})` : "t", moves, p, filled);
  };

  const videoForColor = (clip: ColorClip, p: Placement) => {
    const tf = resolveTransform({ id: clip.id, transform: clip.transform }, warn);
    // Pin an alpha format right at the source so the colour's alpha survives negotiation.
    const chain = [
      `color=c=${ffColor(clip.color, clip.opacity)}:s=${W}x${H}:r=${fnum(fps)}:d=${fnum(p.vis)}`,
      "format=yuva420p",
      ...transformChain(tf, W, H),
    ];
    if (p.pos > 0) chain.push(`setpts=PTS+round(${fnum(p.pos)}/TB)`);
    // A colour can be the picture a transition leaves: it fades, dips or moves on the output clock as footage does.
    const moves = motionsOf(clip.id);
    chain.push(...motionFilters(moves, W, c => ffColor(c)));
    const lbl = label("c");
    lines.push(`${chain.join(",")}${lbl}`);
    overlay(lbl, tf, "t", moves, p);
  };

  const audioForMedia = (clip: MediaClip, idx: number, p: Placement, skip: number, track: ResolvedAudioTrack, explicitTrack: boolean) => {
    const speed = clip.speed ?? 1;
    // Keep a delayed microphone on the input seek clock. Fill its leading
    // silence before trimming, changing speed or mixing it with other clips.
    // An effect that plays the sound late reads that much more of it, and the late start is dropped after it.
    const late = audioEffectDelay(clip.effects);
    const chain: string[] = [SOURCE_AUDIO_CLOCK, `atrim=start=${fnum(skip)}:duration=${fnum((p.vis + late) * speed)}`, "asetpts=PTS-STARTPTS"];
    for (const f of atempoFactors(speed)) chain.push(`atempo=${fnum(f)}`);
    chain.push(...effectFilters(clip.effects, "audio", effectCtx));
    if (late) chain.push(`atrim=start=${fnum(late)}`, "asetpts=PTS-STARTPTS");
    chain.push(...levelFilters(clip, p.local0));
    if (clip.audioFadeIn > 0 || clip.audioFadeOut > 0) {
      if (p.local0 > 0) chain.push(`asetpts=PTS+${fnum(p.local0)}/TB`);
      if (clip.audioFadeIn > 0) chain.push(`afade=t=in:st=0:d=${fnum(clip.audioFadeIn)}`);
      if (clip.audioFadeOut > 0) {
        chain.push(`afade=t=out:st=${fnum(Math.max(0, p.clipDur - clip.audioFadeOut))}:d=${fnum(clip.audioFadeOut)}`);
      }
      chain.push("asetpts=PTS-STARTPTS");
    }
    chain.push(`aformat=sample_rates=${SR}:channel_layouts=${layout}`);
    if (p.pos > 0) chain.push(`adelay=${Math.round(p.pos * SR)}S:all=1`);
    const lbl = label("a");
    if (track.mode === "mix") {
      const mixed = `amix_${labelN++}`;
      lines.push(audioMixStreamsFilter(idx, track.count, {
        sampleRate: SR,
        channelLayout: layout,
        outLabel: mixed,
        prefix: `as_${labelN++}_`,
      }));
      lines.push(`[${mixed}]${chain.join(",")}${lbl}`);
    } else {
      const pad = track.stream === 0 && !explicitTrack ? `[${idx}:a]` : `[${idx}:a:${track.stream}]`;
      lines.push(`${pad}${chain.join(",")}${lbl}`);
    }
    audioLabels.push(lbl);
  };

  // An opaque picture that fills the canvas hides every lower layer for as long as it is
  // shown. Those layers still contribute sound, but their pictures need no decode.
  const verifiedProbe = async (asset: MediaAsset) => {
    try { return await probeAsset(asset); }
    catch { opts.signal?.throwIfAborted(); return; }
  };
  const assetStoredAsShown = async (asset: MediaAsset) => {
    const probe = await verifiedProbe(asset);
    return !!probe && storedAsShown(probe);
  };
  // The HDR transfer of a moving picture: from its import, or read from the file for one imported before colour was.
  const hdrOf = async (asset: MediaAsset) => asset.color ? asset.color.hdr : (await verifiedProbe(asset))?.color?.hdr;
  let zscale: Promise<boolean> | undefined;
  const toneMapFor = async (hdr: HdrTransfer | undefined) => hdr ? toneMapChain(hdr, await (zscale ??= canZscale(opts.ffmpegPath))) : [];
  const covers = opts.audioOnly
    ? []
    : await collectCanvasCovers(timeline, range, media, W, H, fps, motionsOf, verifiedProbe);
  const covered = (trackIndex: number, p: Placement) =>
    covers.some(c => c.track > trackIndex && c.start <= p.pos + 1e-6 && c.end >= p.pos + p.vis - 1e-6);

  // The high-core Mac policy uses software for AVC and hardware for HEVC.
  // Nearby AVC cuts can still share their source read under that policy.
  const sharedReads = opts.indexedInputs && opts.pictureOnly && !opts.singleFrame && !opts.pictureSource &&
    (!opts.decoder || opts.decoder === "videotoolbox-hevc") && W * H <= 1920 * 1080
    ? await adjacentPictureReads(timeline, range, media, fps, covered, verifiedProbe) : undefined;
  // Video and audio tracks, bottom first so later tracks composite on top.
  for (const [trackIndex, track] of timeline.tracks.entries()) {
    if (track.kind === "caption") continue;
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      // Half a sample places a clip, so the sound of a sliver at the range's edge stays. Its picture needs a frame to be on.
      const p = clipPlacement(clip, range, 0.5 / SR);
      if (!p) continue;
      const showVideo = !opts.audioOnly && track.kind === "video" && !track.hidden && holdsFrame(p, fps) && !covered(trackIndex, p);

      if (clip.kind === "color") {
        if (showVideo) videoForColor(clip, p);
        continue;
      }
      if (clip.kind !== "media") continue;

      const asset = media.get(clip.mediaId);
      if (!asset) {
        warn(`clip ${clip.id}: media ${clip.mediaId} not in project; skipped`);
        continue;
      }
      const file = mediaPath(asset);
      const still = isStillAsset(asset, file);
      const wantVideo = showVideo && asset.kind !== "audio" && holdsFrame(p, fps, still);
      const speed = clip.speed ?? 1;
      const wantAudio = includeAudio && !track.muted && clip.volume > 0 && !transitions.layers.has(clip.id) && holdsSample(p.vis * speed, SR) && (await hasAudio(asset, file));
      if (!wantVideo && !wantAudio) continue;

      const srcStart = clip.sourceIn + p.local0 * speed;
      const firstPicture = still || asset.kind === "audio" ? 0 :
        asset.previewClock?.videoStart ?? (await verifiedProbe(asset))?.videoStart ?? 0;
      // A timeline frame can land between source frames, including just past the
      // last source frame's timestamp. Seek to the frame displayed at that time.
      const seek = opts.singleFrame && asset.fps && srcStart >= firstPicture
        ? firstPicture + Math.floor((srcStart - firstPicture) * asset.fps + 1e-7) / asset.fps : srcStart;
      // Import records carry the probed video codec in their playback MIME type.
      const codec = /\bcodecs="(avc1|hvc1)[.,"]/i.exec(asset.originalPlaybackType ?? "")?.[1]?.toLowerCase();
      const accelerate = opts.decoder && wantVideo && asset.kind === "video" && codec &&
        (opts.decoder !== "videotoolbox-hevc" || codec === "hvc1");
      const hdr = wantVideo && !still ? await hdrOf(asset) : undefined;
      // The last test reads the file: these frames stay on the GPU, where a clip stored sideways is not turned.
      const cudaScale = !!accelerate && opts.decoder === "cuda" && asset.hasAlpha === false &&
        !!asset.width && !!asset.height && asset.height > H && asset.width * H === asset.height * W &&
        !clip.transform && !clip.keyframes?.length && !clip.effects.length && !hdr && await assetStoredAsShown(asset);
      // FFmpeg's packet scan can discover AAC priming that is absent from the
      // movie index. Preserve it whenever the graph reads sound.
      // A clip a transition moves reads its own picture: the shared read assumes plain cuts.
      const shared = motionsOf(clip.id).length ? undefined : sharedReads?.get(clip);
      const indexedPicture = opts.indexedInputs && !includeAudio;
      let indexedOriginal = !!asset.previewClock && hasIndexedAvc(asset);
      const open = (input: string, start: number, hardware: boolean, duration = p.vis * speed) => addInput([
        ...(indexedPicture && (input !== file || shared || indexedOriginal) ? INDEXED_MP4_INPUT : []),
        ...(hardware && cudaScale ? CUDA_FRAMES_INPUT :
          hardware && accelerate && opts.decoder !== "cuda" ? ["-hwaccel", "videotoolbox"] : []),
        ...(start > 0 ? ["-ss", fnum(start)] : []), "-t", fnum(duration),
      ], input);
      const pictureDelay = still ? 0 : Math.max(0, firstPicture - srcStart) / speed;
      if (wantVideo && pictureDelay < p.vis) {
        const visible = pictureDelay > 0 ? { ...p, local0: p.local0 + pictureDelay, pos: p.pos + pictureDelay, vis: p.vis - pictureDelay } : p;
        const pictureSeek = Math.max(seek, firstPicture);
        let proxy: { file: string; start: number } | undefined;
        if (opts.pictureSource && !still) {
          const needed = proxyHeightForClip(clip, asset, W, H);
          if (needed !== undefined) proxy = await opts.pictureSource(asset, pictureSeek, pictureSeek + visible.vis * speed, needed);
        }
        // Older imports lack a saved picture clock. Validate the current file once
        // before allowing header-only seeks for stills. Probe results follow file changes.
        if (opts.singleFrame && indexedPicture && !asset.previewClock && !proxy && hasIndexedAvc(asset)) {
          const source = await verifiedProbe(asset);
          indexedOriginal = hasIndexedClock(source, asset.fps) && source.rotation === 0 && source.pixFmt === "yuv420p" &&
            source.width === asset.width && source.height === asset.height;
        }
        // Only the image demuxer repeats a picture at the input. A GIF, a HEIC or AVIF photo (which FFmpeg opens as a
        // movie, with no loop option), or a movie holding one picture, is read once and repeated in the graph.
        const held = still && (!isImagePath(file) || /\.(gif|heic|avif)$/i.test(file));
        const idx = held ? addInput(["-t", fnum(p.vis)], file)
          : still ? addInput(["-loop", "1", "-framerate", fnum(fps), "-t", fnum(p.vis)], file)
          : shared ? open(file, shared.start / fps, true, (shared.end - shared.start) / fps)
          : open(proxy?.file ?? file, Math.max(0, pictureSeek - (proxy?.start ?? 0)), !proxy, visible.vis * speed);
        const firstLayer = stack === "[base]";
        videoForMedia(clip, idx, visible, {
          still,
          cudaScale: cudaScale && !proxy,
          sharedStart: shared ? pictureSeek - shared.start / fps : undefined,
          held,
          // A single frame already seeks to the picture shown at its time.
          filled: !opts.singleFrame && fillsFrames(clip, asset, fps),
          // A preview copy of an HDR file is SDR already.
          toneMap: proxy ? [] : await toneMapFor(hdr),
        });
        if (opts.directPicture && opts.pictureOnly && !opts.pictureFilter && !opts.singleFrame && firstLayer && !shared && !proxy && !still && !motionsOf(clip.id).length &&
            directExportPicture(clip, visible, asset, await verifiedProbe(asset), W, H, fps, D)) {
          directPicture = { file, start: pictureSeek, frames: Math.round(D * fps) };
        }
      }
      if (wantAudio) {
        // Seeking before a movie's first video keyframe can discard earlier
        // audio packets. Read that prefix from the beginning and trim by PTS.
        const skip = srcStart < firstPicture ? srcStart : 0;
        const selectedTrack = clip.audioTrack ?? asset.audioTrack;
        const streamCount = asset.audioStreams?.length
          ?? (selectedTrack !== undefined ? (await verifiedProbe(asset))?.audioStreams?.length : undefined);
        // An effect that plays the sound late reads that much more of it (`audioForMedia`), so the input runs on too.
        const late = audioEffectDelay(clip.effects);
        audioForMedia(
          clip,
          open(file, srcStart - skip, true, (p.vis + late) * speed + skip),
          p,
          skip,
          resolveAudioTrack(selectedTrack, streamCount),
          selectedTrack !== undefined,
        );
      }
    }
  }

  // Captions, always above video.
  const drawtexts = opts.audioOnly
    ? []
    : await buildCaptionDrawtexts({ timeline, range, settings, width: W, height: H, fps, sampleRate: SR, tmp, fontOpts: opts, warn });
  if (drawtexts.length) {
    // Before any work: a build without drawtext fails the whole render, and FFmpeg's words don't say what to do.
    await requireDrawtext("draw the video’s captions", opts.ffmpegPath);
    const out = label("s");
    lines.push(`${stack}${drawtexts.join(",")}${out}`);
    stack = out;
  }

  if (!opts.audioOnly) lines.push(`${stack}trim=duration=${fnum(D)},setpts=PTS-STARTPTS,format=yuv420p${opts.pictureFilter ? "," + opts.pictureFilter : ""}[vout]`);

  // Audio mix, padded/trimmed to the exact duration.
  if (includeAudio) lines.push(audioMixLine(audioLabels, SR, layout, D, opts.audioSamples));

  const graph = lines.join(";\n") + "\n";
  const scriptPath = path.join(tmp, "graph.txt");
  await fs.writeFile(scriptPath, graph, "utf8");

  const major = await ffmpegMajor(opts.ffmpegPath).catch(() => undefined);
  const flag = (major ?? 7) >= 7 ? "-/filter_complex" : "-filter_complex_script";

  return {
    directPicture: drawtexts.length ? undefined : directPicture,
    args: [...inputArgs, flag, scriptPath, ...(opts.audioOnly ? [] : ["-map", "[vout]"]), ...(includeAudio ? ["-map", "[aout]"] : [])],
    inputs,
    warnings,
    graph,
    scriptPath,
    videoLabel: "[vout]",
    audioLabel: "[aout]",
    hasAudio: audioLabels.length > 0,
    width: W,
    height: H,
    fps,
    duration: D,
    range: { start: R0, end: R1 },
    cleanup,
  };
}

/**
 * The line that sums the clips' sound (`labels`) into `[aout]`, padded and trimmed to `duration`, or to exactly
 * `samples` samples when given. Silence when no clip sounds.
 */
function audioMixLine(labels: string[], sampleRate: number, layout: string, duration: number, samples: number | undefined): string {
  // Recompute monotonic sample timestamps with NB_CONSUMED_SAMPLES/SR/TB: adelay leading silence can emit AV_NOPTS_VALUE through amix.
  const tail = samples !== undefined ? `apad,atrim=end_sample=${samples},asetpts=NB_CONSUMED_SAMPLES/SR/TB[aout]` : `apad=whole_dur=${fnum(duration)},atrim=duration=${fnum(duration)},asetpts=PTS-STARTPTS[aout]`;
  if (labels.length === 0) {
    return samples === undefined ? `anullsrc=r=${sampleRate}:cl=${layout}:d=${fnum(duration)}[aout]` : `anullsrc=r=${sampleRate}:cl=${layout},${tail}`;
  }
  if (labels.length === 1) return `${labels[0]}${tail}`;
  return `${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0,${tail}`;
}

/**
 * The clip's level: its volume, and where its volume keyframes move it, the level they give each moment of the clip.
 * `local0` is where in the clip the placement starts, the clip's own second at the filter's t = 0. The level is worked
 * out every 256 samples, so a dip moves smoothly rather than in steps a frame of audio long.
 */
export function levelFilters(clip: Pick<MediaClip, "volume" | "volumeKeyframes">, local0: number): string[] {
  const keys = [...clip.volumeKeyframes ?? []].sort((a, b) => a.time - b.time);
  if (!keys.length || keys.every(k => k.db === keys[0]!.db)) {
    const gain = clip.volume * Math.pow(10, (keys[0]?.db ?? 0) / 20);
    return gain !== 1 ? [`volume=${fnum(gain)}`] : [];
  }
  const db = keyframeExpr(keys.map(k => ({ time: k.time, value: k.db, ease: k.ease })), local0 ? `(t+${fnum(local0)})` : "t");
  return ["asetnsamples=n=256:p=0", `volume='${clip.volume !== 1 ? `${fnum(clip.volume)}*` : ""}pow(10,(${db})/20)':eval=frame`];
}
