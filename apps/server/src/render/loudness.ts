import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audioMapArgs, heardAudioKey, LOCAL_MEDIA_INPUT, type HeardAudio } from "@scarlet/render";
import type { Ctx } from "../context.js";
import { logId } from "../logText.js";
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

function measureLoudness(file: string, from: number | undefined, to: number | undefined, signal: AbortSignal, audio?: HeardAudio): Promise<Loudness> {
  const args = ["-hide_banner", "-nostats", "-nostdin"];
  if (from !== undefined) args.push("-ss", ffmpegPosition(from));
  if (to !== undefined) args.push("-t", String(to - (from ?? 0)));
  args.push(...LOCAL_MEDIA_INPUT, "-i", file, "-vn", ...audioMapArgs(audio, { filters: "ebur128=peak=true:framelog=verbose" }), "-f", "null", "-");
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
 * EBU R128 loudness of a file's heard audio (`audio`: its chosen track or every track mixed, else its first), optionally over a range, measured once for the file as it is now
 * (`identity` is what changes when the file does: its size and times, its hash). `stop` ends the measurement for
 * everyone waiting on it; `signal` stops only this caller's wait.
 */
export function measuredLoudness(ctx: Ctx, file: string, identity: unknown[],
  opts: { projectId?: string; from?: number; to?: number; audio?: HeardAudio; stop?: AbortSignal; signal?: AbortSignal } = {}): Promise<Loudness> {
  let cache = caches.get(ctx);
  // A pass asks for each recording's loudness at once, so measure a few files side by side rather than in turn.
  if (!cache) caches.set(ctx, cache = new AnalysisCache<Loudness>(() => 24, 256 * 1024, 3));
  const { projectId, from, to, audio, stop, signal } = opts;
  // The first track keeps the name its measurement always had.
  const heard = heardAudioKey(audio);
  const key = JSON.stringify(["ebur128", file, ...identity, from, to, ...heard === null ? [] : [heard]]);
  // A file's loudness doesn't change while its identity holds, so keep it beside the project's waveforms across restarts.
  const saved = projectId ? join(ctx.paths.waveforms(projectId), `loudness-${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`) : undefined;
  return cache.get(key, async work => {
    if (saved) {
      // A kept figure cut short or damaged (a crash mid-write, a full disk) is measured again, as a missing one is.
      const kept = await readFile(saved, "utf8").then(text => JSON.parse(text) as Loudness | null).catch(() => undefined);
      if (kept && typeof kept === "object" && "integratedLufs" in kept) return kept;
    }
    const measured = await ctx.track(measureLoudness(file, from, to, stop ? AbortSignal.any([work, stop]) : work, audio), projectId);
    if (saved) {
      const temp = `${saved}.${process.pid}.tmp`;
      // Measured again next time instead; the figure in hand is still right.
      await writeFile(temp, JSON.stringify(measured)).then(() => rename(temp, saved))
        .catch(error => ctx.log(`[render] loudness-cache-write-failed project=${logId(projectId!)} ${error instanceof Error ? error.message : String(error)}`));
    }
    return measured;
  }, signal ? { signal } : {});
}
