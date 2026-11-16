import { spawn } from "node:child_process";
import { LOCAL_MEDIA_INPUT } from "@scarlet/render";
import type { Ctx } from "../context.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { FFMPEG, ffmpegPosition } from "./ffmpeg.js";

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

function measureLoudness(file: string, from: number | undefined, to: number | undefined, signal: AbortSignal): Promise<Loudness> {
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

// The cache also charges for each key, and this one carries the file's path and fingerprint:
// about 600 bytes a result. Keep a few hundred; a budget under one entry keeps none.
const caches = new WeakMap<Ctx, AnalysisCache<Loudness>>();

/**
 * EBU R128 loudness of a file's first audio stream, optionally over a range, measured once for the file as it is now
 * (`identity` is what changes when the file does: its size and times, its hash). `stop` ends the measurement for
 * everyone waiting on it; `signal` stops only this caller's wait.
 */
export function measuredLoudness(ctx: Ctx, file: string, identity: unknown[],
  opts: { from?: number; to?: number; stop?: AbortSignal; signal?: AbortSignal } = {}): Promise<Loudness> {
  let cache = caches.get(ctx);
  if (!cache) caches.set(ctx, cache = new AnalysisCache<Loudness>(() => 24, 256 * 1024, 1));
  const { from, to, stop, signal } = opts;
  const key = JSON.stringify(["ebur128", file, ...identity, from, to]);
  return cache.get(key, work => ctx.track(measureLoudness(file, from, to, stop ? AbortSignal.any([work, stop]) : work)),
    signal ? { signal } : {});
}
