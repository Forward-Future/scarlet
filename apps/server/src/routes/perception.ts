import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileInDirectoryAsync, LOCAL_MEDIA_INPUT } from "@scarlet/render";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { FFMPEG, ffmpegPosition } from "../render/ffmpeg.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { numberParam, requireMedia } from "./util.js";

export interface Loudness { integratedLufs: number | null; loudnessRangeLu: number | null; truePeakDbtp: number | null }

/** Read ffmpeg's ebur128 summary. Silence reports -inf, which JSON cannot carry, so it becomes null. */
export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const value = (re: RegExp) => {
    const m = re.exec(summary);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    integratedLufs: value(/\bI:\s+(-?[\d.]+|-inf)\s+LUFS/),
    loudnessRangeLu: value(/\bLRA:\s+(-?[\d.]+)\s+LU\b/),
    truePeakDbtp: value(/\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS/),
  };
}

export function measureLoudness(file: string, from: number | undefined, to: number | undefined, signal: AbortSignal): Promise<Loudness> {
  const args = ["-hide_banner", "-nostats", "-nostdin"];
  if (from !== undefined) args.push("-ss", ffmpegPosition(from));
  if (to !== undefined) args.push("-t", String(to - (from ?? 0)));
  args.push(...LOCAL_MEDIA_INPUT, "-i", file, "-vn", "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-");
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-8192); });
    child.on("error", reject);
    child.on("close", code => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error(`ffmpeg ebur128 exited with ${code}: ${stderr.slice(-400)}`));
      else resolve(parseEbur128(stderr));
    });
  });
}

/** Read-only measurements the agent tools need beyond waveforms and transcripts. */
export function perceptionRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  // The cache also charges for each key, and this one carries the file's path and fingerprint:
  // about 600 bytes a result. Keep a few hundred; a budget under one entry keeps none.
  const loudness = new AnalysisCache<Loudness>(() => 24, 256 * 1024, 1);

  // Integrated loudness (EBU R128) of a source's first audio stream, optionally for a range.
  r.get("/projects/:projectId/media/:mediaId/loudness", async c => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "This media has no audio to measure.");
    const from = c.req.query("from") !== undefined ? numberParam(c.req.query("from"), "from") : undefined;
    const to = c.req.query("to") !== undefined ? numberParam(c.req.query("to"), "to") : undefined;
    if ((from !== undefined && from < 0) || (from !== undefined && to !== undefined && to <= from)) {
      throw badRequest("bad_range", "Choose a positive source range in seconds.");
    }
    const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
    if (!file) throw notFound("source file");
    const info = await stat(file);
    const key = JSON.stringify(["ebur128", file, media.hash, info.size, info.ctimeMs, info.mtimeMs, from, to]);
    // A measurement someone asked for, such as a running edit's, isn't stopped by a pause of the project's media work.
    const result = await loudness.get(key, signal => ctx.track(measureLoudness(file, from, to, AbortSignal.any([signal, ctx.projectSignal(media.projectId)]))));
    return c.json({ mediaId: media.id, ...(from !== undefined && { from }), ...(to !== undefined && { to }), ...result });
  });

  return r;
}
