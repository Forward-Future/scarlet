/**
 * Delivery/program audio mixing: sample-exact lossless sections concatenated
 * into one continuous AAC program so encoder priming never lands on interior edits.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planSegments, sha256, snapToFrame, stableStringify, timelineDuration } from "@scarlet/timeline";
import type { MediaAsset, Project, Timeline, TimeRange } from "@scarlet/timeline";
import { effectKind } from "./effects.js";
import { BEST_AUDIO_BITRATE, COMPRESSED_AUDIO_BITRATE, PROGRAM_AUDIO_BITRATE } from "./encoder.js";
import { fnum, runFfmpeg, sampleCount } from "./exec.js";
import { buildFilterGraph, clipPlacement } from "./graph.js";
import { isImagePath } from "./probe.js";
import type { RenderOptions } from "./render.js";
import { DELIVERY_AUDIO_REVISION } from "./segmentKey.js";
import { concatFile, exportSegments, fileHasContent, publishSegment, renderBatch, segmentTimelines, withStagedFile } from "./segmentUtils.js";

export interface ProgramAudioOptions extends RenderOptions {
  exportRange?: TimeRange;
  concurrency?: number;
}

/** The caches for the lossless sections and complete program are identified by their inputs. */
function audioMixPlan(project: Project, timeline: Timeline, range: TimeRange, cacheDir: string, output: "mix" | "program", media: Map<string, MediaAsset>, bitrate = PROGRAM_AUDIO_BITRATE) {
  const { sampleRate, audioChannels } = project.settings;
  const inputs = timeline.tracks.flatMap(track => track.clips.flatMap(clip => {
    if (clip.kind !== "media") return [];
    const p = clipPlacement(clip, range, 0.5 / sampleRate);
    if (!p) return [];
    const asset = media.get(clip.mediaId);
    return [{
      source: asset?.hash ?? asset?.path ?? clip.mediaId, kind: asset?.kind, hasAudio: asset?.hasAudio,
      graphicStill: asset?.kind === "graphic" ? isImagePath(asset.path) : undefined,
      videoStart: asset?.previewClock?.videoStart, volume: clip.volume, speed: clip.speed,
      seek: fnum(clip.sourceIn + p.local0 * clip.speed), visible: fnum(p.vis), delay: Math.round(p.pos * sampleRate),
      effects: clip.effects.filter(effect => effectKind(effect.type) !== "video"),
      fades: clip.audioFadeIn || clip.audioFadeOut ? [clip.audioFadeIn, clip.audioFadeOut, p.local0, p.clipDur] : undefined,
      // The level a keyframe gives is timed from the clip's start, so the section's place in the clip goes with it.
      levels: clip.volumeKeyframes?.length ? [clip.volumeKeyframes, fnum(p.local0)] : undefined,
    }];
  }));
  const samples = sampleCount(range.start, range.end, sampleRate);
  const codec = output === "program" ? ["-c:a", "aac", "-b:a", bitrate] : ["-c:a", "alac"];
  const key = sha256(stableStringify([`delivery-mix-${DELIVERY_AUDIO_REVISION}`, sampleRate, audioChannels, samples, inputs, codec]));
  const file = path.join(cacheDir, output + "-" + key + ".m4a");
  return { timeline, range, samples, codec, file };
}

/** Render original samples. AAC encoder priming belongs to the complete program, never to an interior edit. */
async function mixAudio(project: Project, plan: ReturnType<typeof audioMixPlan>, opts: RenderOptions) {
  const { timeline, range, samples, codec, file } = plan;
  const { sampleRate, audioChannels } = project.settings;
  if (await fileHasContent(file)) return file;
  return withStagedFile(file, "part.m4a", async temp => {
    const graph = await buildFilterGraph(project, timeline, range, { ...opts, audioOnly: true, pictureOnly: false, audioSamples: samples });
    try {
      await runFfmpeg(["-y", ...graph.args, "-map_chapters", "-1", ...codec, "-ar", String(sampleRate), "-ac", String(audioChannels), "-movie_timescale", String(sampleRate), temp],
        { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
      await publishSegment(temp, file);
      return file;
    } finally {
      await graph.cleanup();
    }
  });
}

/** Each original sample is mixed once. One continuous AAC encode keeps priming out of the joins. */
export async function renderProgramAudio(project: Project, timeline: Timeline, cacheDir: string, opts: ProgramAudioOptions): Promise<string> {
  const media = new Map(project.media.map(asset => [asset.id, asset]));
  const audible: Timeline = { ...timeline, tracks: timeline.tracks
    .filter(track => track.kind !== "caption" && !track.muted)
    .map(track => ({ ...track, clips: track.clips.filter(clip => clip.kind === "media" &&
      clip.enabled !== false && clip.volume > 0 && media.get(clip.mediaId)?.hasAudio !== false) })) };
  const duration = timelineDuration(timeline);
  const bitrate = opts.best ? BEST_AUDIO_BITRATE : opts.quality === "preview" ? COMPRESSED_AUDIO_BITRATE : PROGRAM_AUDIO_BITRATE;
  // A short cut list fits one FFmpeg graph. Bound the number of simultaneously open
  // decoders on busy cuts by mixing to sample-counted lossless segments instead.
  if (audible.tracks.reduce((n, track) => n + track.clips.length, 0) <= 16) {
    const range = opts.exportRange ?? { start: 0, end: snapToFrame(duration, project.settings.fps) };
    return mixAudio(project, audioMixPlan(project, audible, range, cacheDir, "program", media, bitrate), opts);
  }
  const ranges = exportSegments(planSegments(project, audible, 10, duration), opts.exportRange);
  const parts = segmentTimelines(audible, ranges);
  const mixes = ranges.map((range, i) => audioMixPlan(project, parts[i]!, range, cacheDir, "mix", media));
  const files = mixes.map(mix => mix.file);
  const { sampleRate, audioChannels } = project.settings;
  const key = sha256(stableStringify(["delivery-aac-1", sampleRate, audioChannels, bitrate, files.map(f => path.basename(f))]));
  const file = path.join(cacheDir, "program-" + key + ".m4a");
  if (await fileHasContent(file)) return file;
  await renderBatch(mixes.length, Math.max(1, opts.concurrency ?? 1), opts.signal, async (i, signal) => {
    await mixAudio(project, mixes[i]!, { ...opts, signal });
  });
  // Another export may have finished the program while its sections were being mixed.
  if (await fileHasContent(file)) return file;
  const temp = await fs.mkdtemp(path.join(opts.tempDir ?? os.tmpdir(), "scarlet-sound-"));
  try {
    return await withStagedFile(file, "part.m4a", async staged => {
      const list = path.join(temp, "sound.txt");
      await fs.writeFile(list, files.map(concatFile).join("\n") + "\n");
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:a:0", "-map_chapters", "-1",
        "-af", "asetpts=N/SR/TB", "-c:a", "aac", "-b:a", bitrate, "-ar", String(sampleRate), "-ac", String(audioChannels), "-movie_timescale", String(sampleRate), staged],
        { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
      await publishSegment(staged, file);
      return file;
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
