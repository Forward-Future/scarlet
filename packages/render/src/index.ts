export { fileInDirectory } from "./assetPath.js";
export * from "./exec.js";
export * from "./probe.js";
export * from "./waveform.js";
export * from "./frame.js";
export * from "./proxy.js";
export * from "./fonts.js";
export * from "./effects.js";
export * from "./graph.js";
export * from "./render.js";
export * from "./segments.js";

import { ffmpegEncoders, ffmpegVersion, resolveFfmpeg, resolveFfprobe, runCapture, type ToolPaths } from "./exec.js";

export interface FfmpegCheck {
  ok: boolean;
  ffmpeg: { path: string; version?: string; error?: string };
  ffprobe: { path: string; version?: string; error?: string };
  /** Hardware H.264 encoders this build lists (presence, not necessarily usability). */
  hwEncoders: string[];
}

/** Verify ffmpeg and ffprobe start, and report what the build offers. */
export async function checkFfmpeg(paths: ToolPaths = {}): Promise<FfmpegCheck> {
  const ffmpegPath = resolveFfmpeg(paths.ffmpegPath);
  const ffprobePath = resolveFfprobe(paths.ffprobePath);
  const out: FfmpegCheck = { ok: false, ffmpeg: { path: ffmpegPath }, ffprobe: { path: ffprobePath }, hwEncoders: [] };
  try {
    out.ffmpeg.version = await ffmpegVersion(ffmpegPath);
  } catch (e) {
    out.ffmpeg.error = (e as Error).message;
  }
  try {
    const r = await runCapture(ffprobePath, ["-version"]);
    out.ffprobe.version = r.stdout.toString("utf8").split(/\r?\n/)[0] ?? "";
  } catch (e) {
    out.ffprobe.error = (e as Error).message;
  }
  if (!out.ffmpeg.error) {
    const enc = await ffmpegEncoders(ffmpegPath).catch(() => new Set<string>());
    out.hwEncoders = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_vaapi"].filter((e) => enc.has(e));
  }
  out.ok = !out.ffmpeg.error && !out.ffprobe.error;
  return out;
}
export * from "./inspection.js";
export * from "./soundPicture.js";
