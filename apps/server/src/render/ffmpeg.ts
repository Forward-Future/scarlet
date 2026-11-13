import { spawn } from "node:child_process";
import { LOCAL_MEDIA_INPUT, SOURCE_AUDIO_CLOCK, resolveFfmpeg, resolveFfprobe } from "@scarlet/render";

// Same resolution as the renderer: env override → binary beside the engine → PATH.
export const FFMPEG = resolveFfmpeg();
export const FFPROBE = resolveFfprobe();

export interface RunOptions {
  onStdoutBytes?: (total: number) => void;
  /** Open an IPC channel for a Node worker that reports progress alongside its stdout result. */
  onMessage?: (message: unknown) => void;
  signal?: AbortSignal;
  /** Called with 0..1 as ffmpeg reports `out_time_us` (requires `-progress pipe:1`). */
  onProgress?: (p: number) => void;
  /** Expected output duration in seconds, used to normalise progress. */
  duration?: number;
  /** Max stdout bytes to retain (default 64 MB). */
  maxStdout?: number;
  /** Called with each complete stderr line, such as whisper-cli's `-pp` progress. */
  onStderrLine?: (line: string) => void;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/** Run a binary, collecting stdout as a Buffer. Rejects with FfmpegError (tail of stderr) on non-zero exit. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn(bin, args, { windowsHide: true, stdio: opts.onMessage ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
    if (opts.onMessage) child.on("message", opts.onMessage);
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let progressBuf = "";
    const max = opts.maxStdout ?? 64 * 1024 * 1024;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.on("data", (d: Buffer) => {
      if (opts.onProgress) {
        progressBuf += d.toString("utf8");
        let nl: number;
        while ((nl = progressBuf.indexOf("\n")) >= 0) {
          const line = progressBuf.slice(0, nl).trim();
          progressBuf = progressBuf.slice(nl + 1);
          const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line);
          if (m && opts.duration && opts.duration > 0) {
            const t = Number(m[1]) / 1e6;
            opts.onProgress(Math.max(0, Math.min(0.99, t / opts.duration)));
          }
        }
        return;
      }
      if (outBytes < max) {
        out.push(d);
        outBytes += d.length;
        opts.onStdoutBytes?.(outBytes);
      }
    });
    let stderrLine = "";
    child.stderr!.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      err += text;
      if (err.length > 16000) err = err.slice(-8000);
      if (!opts.onStderrLine) return;
      stderrLine += text;
      let nl: number;
      while ((nl = stderrLine.indexOf("\n")) >= 0) {
        opts.onStderrLine(stderrLine.slice(0, nl).trim());
        stderrLine = stderrLine.slice(nl + 1);
      }
    });
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FfmpegError(`${bin} failed to start: ${e.message}`, args, err));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new FfmpegError(`${bin} cancelled`, args, err));
      if (code !== 0) return reject(new FfmpegError(`${bin} exited with code ${code}: ${err.trim().split("\n").slice(-6).join("\n")}`, args, err));
      resolve(Buffer.concat(out));
    });
  });
}

export const ffmpeg = (args: string[], opts: RunOptions = {}) =>
  run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], opts);

export const ffprobe = (args: string[], opts: RunOptions = {}) => run(FFPROBE, ["-v", "error", ...args], opts);

/**
 * A position in seconds as ffmpeg's `-ss`. Arithmetic on times leaves values like 5.5e-17, which String writes with
 * an exponent and ffmpeg refuses. Anything under a microsecond is the start. Not for `-t`: a length of 0 there
 * means no limit.
 */
export const ffmpegPosition = (seconds: number) => Math.abs(seconds) < 1e-6 ? "0" : String(seconds);

/** Extract (part of) a file's audio as 16 kHz mono PCM wav, the format whisper wants. */
export async function extractWav(
  input: string,
  output: string,
  opts: { start?: number; duration?: number; sampleRate?: number; audioStream?: number; signal?: AbortSignal;
    progress?: { duration: number; onProgress: (fraction: number) => void } } = {},
): Promise<void> {
  const args: string[] = [];
  if (opts.start !== undefined) args.push("-ss", ffmpegPosition(opts.start));
  if (opts.duration !== undefined) args.push("-t", String(opts.duration));
  args.push(...LOCAL_MEDIA_INPUT, "-i", input);
  if (opts.audioStream !== undefined) args.push("-map", `0:a:${opts.audioStream}`);
  if (opts.progress) args.push("-progress", "pipe:1", "-nostats");
  args.push("-vn", "-map_metadata", "-1", "-af", SOURCE_AUDIO_CLOCK, "-ac", "1", "-ar", String(opts.sampleRate ?? 16000), "-c:a", "pcm_s16le", "-y", output);
  await ffmpeg(args, { signal: opts.signal, ...opts.progress });
}
