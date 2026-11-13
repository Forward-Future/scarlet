import path from "node:path";
import { rm } from "node:fs/promises";
import type { Project, ProjectSettings, Timeline } from "@scarlet/timeline";
import { LOCAL_MEDIA_INPUT, resolveFfprobe, runCapture, runFfmpeg } from "./exec.js";
import { avcConfigurationArgs, sameAvcConfiguration } from "./avcConfiguration.js";
import { directExportPicture } from "./graph.js";
import { parseRate, probeMedia } from "./probe.js";
import type { RenderOptions } from "./render.js";

interface OriginalPicture {
  file: string;
  frames: number;
  fps: number;
  timeBase: string;
}

/** Only copy one whole original H.264 stream. A cut, including trimming just the end, needs the normal renderer. */
export async function wholeOriginalPicture(project: Project, picture: Timeline, duration: number,
  size: { width: number; height: number }, opts: RenderOptions): Promise<OriginalPicture | undefined> {
  const clips = picture.tracks.flatMap(t => t.clips);
  const clip = clips[0];
  if (clips.length !== 1 || clip?.kind !== "media" || clip.timelineIn !== 0 || clip.sourceIn !== 0 ||
      Math.abs(clip.sourceOut - duration) > 1e-6) return;
  const asset = project.media.find(m => m.id === clip.mediaId);
  if (!asset || asset.kind !== "video") return;
  const file = path.resolve(opts.mediaRoot, asset.path);
  const probe = await probeMedia(file, opts).catch(() => { opts.signal?.throwIfAborted(); return undefined; });
  const fps = project.settings.fps, frames = Math.round(duration * fps);
  const span = { local0: 0, pos: 0, vis: duration, clipDur: duration };
  if (probe?.videoBFrames !== 0 || probe.videoFrameCount !== frames || !probe.videoTimeBase ||
      !directExportPicture(clip, span, asset, probe, size.width, size.height, fps, duration)) return;
  return { file, frames, fps, timeBase: probe.videoTimeBase };
}

/** Read packet timestamps in constant memory. Equal reported average and nominal rates alone do not rule out VFR or an edit list. */
async function hasOriginalClock(file: string, original: OriginalPicture, opts: RenderOptions) {
  const ticks = 1 / (parseRate(original.timeBase) * original.fps), step = Math.round(ticks);
  if (!Number.isSafeInteger(step) || step <= 0 || Math.abs(step - ticks) > 1e-6) return false;
  let count = 0, valid = true, pending = "";
  await runCapture(resolveFfprobe(opts.ffprobePath), ["-v", "error", "-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pts,dts,duration,flags", "-of", "csv=p=0", ...LOCAL_MEDIA_INPUT, file], {
    signal: opts.signal, maxStdout: 256 * (original.frames + 1),
    onStdoutChunk(chunk) {
      if (!valid) return;
      const lines = (pending + chunk.toString("utf8")).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const [pts, dts, duration, flags] = line.split(",");
        if (!flags || (count === 0 && !flags.includes("K")) || /[DC]/.test(flags) ||
            pts !== String(count * step) || dts !== pts || duration !== String(step) || count >= original.frames) {
          valid = false;
          break;
        }
        count++;
      }
      if (pending.length > 256) valid = false;
    },
  });
  return valid && !pending && count === original.frames;
}

/** Inspect the completed scratch file's actual packet clock before it can be published. */
export async function copyOriginalPicture(original: OriginalPicture,
  audio: string, output: string, { sampleRate, audioChannels }: ProjectSettings, opts: RenderOptions): Promise<boolean> {
  const duration = original.frames / original.fps;
  // A later AVC parameter set can change size, crop, or color while the MP4 header and packet clock stay constant.
  // Inspect the same packets being copied, without decoding pictures or hashing their compressed payload.
  const parameters = output + ".parameter-hashes";
  try {
    await runFfmpeg(["-y", "-copyts", ...LOCAL_MEDIA_INPUT, "-i", original.file, ...LOCAL_MEDIA_INPUT, "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1", "-c", "copy",
      "-avoid_negative_ts", "disabled", "-movie_timescale", String(sampleRate), "-movflags", "+faststart", output,
      ...avcConfigurationArgs(parameters)],
      { signal: opts.signal, ffmpegPath: opts.ffmpegPath, onProgress: t => opts.onProgress?.(Math.min(0.97, t / duration * 0.97)) });
    if (!await sameAvcConfiguration(parameters, opts.signal)) return false;
  } finally { await rm(parameters, { force: true }); }
  const final = await probeMedia(output, opts);
  return final.videoTimeBase === original.timeBase && final.videoFrameCount === original.frames && final.fps === original.fps &&
    final.audioCodec === "aac" && final.sampleRate === sampleRate && final.channels === audioChannels &&
    !!final.audioDuration && Math.round(final.audioDuration * sampleRate) === Math.round(duration * sampleRate) &&
    await hasOriginalClock(output, original, opts);
}
