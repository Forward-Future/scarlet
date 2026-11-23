/**
 * Process helpers shared by every module: locating ffmpeg/ffprobe, running
 * them with abort support, parsing `-progress` output, and a spawn counter
 * that tests use to prove the segment cache avoided work.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { isSea } from "node:sea";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

/** Quiet banner/stdin/error flags shared across ffmpeg invocations. */
export const FFMPEG_BASE_ARGS = ["-hide_banner", "-nostdin", "-loglevel", "error"] as const;

/** Quiet banner/stdin/stats flags for ffmpeg invocations that keep diagnostic stderr output. */
export const FFMPEG_QUIET_ARGS = ["-hide_banner", "-nostdin", "-nostats"] as const;

/** Round a pixel dimension to the nearest positive even integer (>= 2). */
export const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/** Exact audio sample count for a `[start, end]` range at `sampleRate`. */
export const sampleCount = (start: number, end: number, sampleRate: number) =>
  Math.round(end * sampleRate) - Math.round(start * sampleRate);

// Project assets must be self-contained media. Playlist/concat demuxers can open
// additional files or URLs, bypassing the import boundary on the next decode.
export const LOCAL_MEDIA_INPUT = [
  "-protocol_whitelist", "file",
  "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mxf,asf,mpeg,mpegts,mpegvideo,flv,ogg,wav,aiff,mp3,aac,flac,ac3,eac3,amr,caf,apng,gif,image2,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe",
] as const;

/** Keep leading silence when an audio stream starts after the recording or input seek. */
export const SOURCE_AUDIO_CLOCK = "aresample=first_pts=0";

/** Let the MOV demuxer seek using its stored sample table. */
export const INDEXED_MP4_INPUT = ["-nofind_stream_info", "-f", "mov"] as const;

// Eight AVC decode threads beat VideoToolbox on the 4K fixture. Restrict the
// auto policy to high-core Macs where dialogue analysis can run alongside it.
export const threadedAvcPreview = process.platform === "darwin" && process.arch === "arm64" && availableParallelism() >= 16;

/** Some containers need a packet scan even when their catalog entry has an
 * index. Retry using FFmpeg's ordinary stream discovery in that case.
 * `onFallback` hears why the indexed read failed, before the retry runs. */
export async function withStreamInfoFallback<T>(args: string[], signal: AbortSignal | undefined, run: (inputArgs: string[]) => Promise<T>,
  onFallback?: (error: unknown) => void): Promise<T> {
  try { return await run(args); }
  catch (error) {
    if (!args.includes("-nofind_stream_info") || signal?.aborted) throw error;
    const retry = [...args];
    for (let i = retry.length - INDEXED_MP4_INPUT.length; i >= 0; i--) {
      if (INDEXED_MP4_INPUT.every((arg, n) => retry[i + n] === arg)) retry.splice(i, INDEXED_MP4_INPUT.length);
    }
    if (retry.length === args.length) throw error;
    onFallback?.(error);
    return run(retry);
  }
}

export interface ToolPaths {
  ffmpegPath?: string;
  ffprobePath?: string;
}

/** Number of processes spawned since start. Tests compare it before and after a call. */
export const spawnStats = { ffmpeg: 0, ffprobe: 0 };

const EXE = process.platform === "win32" ? ".exe" : "";
const binaryCache = new Map<string, string | null>();

/**
 * Look for a local/development build beside the engine or under SCARLET_BIN_DIR.
 * Public installers use the separately installed media tools on PATH.
 * Empty files are dev-build placeholders and don't count.
 */
function findBinary(name: string): string | null {
  const cached = binaryCache.get(name);
  if (cached !== undefined) return cached;
  const dirs = [process.env.SCARLET_BIN_DIR, dirname(process.execPath)].filter((d): d is string => !!d);
  // The Mac setup helper puts its caption-capable build here. A GUI login PATH can
  // put a different Homebrew FFmpeg first. Only a packaged engine uses the helper.
  if (process.platform === "darwin" && isSea()) dirs.push(join(homedir(), ".local", "bin"));
  // On Windows spawn("ffmpeg") finds the empty Tauri dev placeholder in the
  // working directory before PATH. Choose a real executable by absolute path.
  if (process.platform === "win32") {
    dirs.push(...(process.env.PATH ?? "").split(delimiter).map(dir => dir.replace(/^"|"$/g, "")).filter(isAbsolute));
  }
  let found: string | null = null;
  for (const dir of dirs) {
    const candidate = join(dir, name + EXE);
    try {
      const info = statSync(candidate);
      if (!info.isFile() || !info.size) continue;
      accessSync(candidate, constants.X_OK);
      found = candidate;
      break;
    } catch {
      // A missing or unusable candidate leaves this tool to the next directory.
    }
  }
  binaryCache.set(name, found);
  return found;
}

/** Explicit arguments and environment overrides precede local binaries, the Mac helper and PATH. */
export function resolveFfmpeg(explicit?: string): string {
  return explicit ?? process.env.SCARLET_FFMPEG ?? process.env.FFMPEG_PATH ?? findBinary("ffmpeg") ?? "ffmpeg";
}

export function resolveFfprobe(explicit?: string): string {
  return explicit ?? process.env.SCARLET_FFPROBE ?? process.env.FFPROBE_PATH ?? findBinary("ffprobe") ?? "ffprobe";
}

/** How to install the FFmpeg Scarlet supports on this platform, as one sentence. */
function installFfmpeg(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "In PowerShell, run winget install --id Gyan.FFmpeg.Essentials --exact."
    : platform === "darwin"
      ? "Run the FFmpeg setup helper linked in the Scarlet download instructions."
      : "Install the FFmpeg package from your system’s package manager.";
}

/** Show the prerequisite at the import or render that needs it. Other launch errors keep their diagnostics. */
export function mediaToolLaunchError(bin: string, error: NodeJS.ErrnoException, fallback: string): string {
  if (error.code !== "ENOENT" || !/^ff(mpeg|probe)(\.exe)?$/i.test(basename(bin))) return fallback;
  return `${fallback}. ${installFfmpeg()} Then restart Scarlet and retry.`;
}

/**
 * Why Scarlet can't draw text with the FFmpeg it found, and what to do: some builds leave out the filter that draws
 * text (drawtext), which captions and the labels on Scarlet's pictures need. `need` says what that stops, such as
 * "draw the video’s captions". No path: the editor and the model read this.
 */
export function missingTextFilterMessage(need: string, platform: NodeJS.Platform = process.platform): string {
  const install = platform === "linux"
    ? "Install an FFmpeg package built with text drawing (libfreetype) from your system’s package manager."
    : installFfmpeg(platform);
  return `This copy of FFmpeg can’t draw text, so Scarlet can’t ${need}. ${install} Then restart Scarlet and try again.`;
}

/** The FFmpeg in use lacks a filter a render needs. Its message is a sentence for the editor; see `missingTextFilterMessage`. */
export class MissingFilterError extends Error {
  constructor(public readonly filter: string, message: string) {
    super(message);
    this.name = "MissingFilterError";
  }
}

/** FFmpeg's own words when a graph names a filter its build doesn't have. */
export const NO_DRAWTEXT = /No such filter: '?drawtext'?|Filter not found[^\n]*drawtext/i;

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly bin: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
    /** False when the program never ran, so the failure says nothing about what it was asked to do. */
    public readonly started = true,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Last ~40 lines of stderr, which is where ffmpeg puts the actual error. */
export function stderrTail(stderr: string, lines = 40): string {
  const all = stderr.trimEnd().split(/\r?\n/);
  return all.slice(-lines).join("\n");
}

/**
 * Why something failed, in one line for a warning. ffmpeg names the cause in the first line it writes and
 * often ends on a line that only says nothing was written, so this is its first line, then its last when
 * that differs. Without the addresses ffmpeg tags its lines with, the same failure reads the same twice.
 * Falls back to the error's own first line.
 */
export function failureReason(error: unknown): string {
  const wrote = error instanceof FfmpegError
    ? error.stderr.split(/\r?\n/).map(line => line.replace(/ @ (?:0x[0-9a-f]+|[0-9a-f]{8,16})(?=\])/gi, "").trim()).filter(Boolean)
    : [];
  const first = wrote[0], last = wrote.at(-1);
  const line = first ? (last === first ? first : `${first}; ${last}`)
    : (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.trim();
  return line.slice(0, 300);
}

export interface CaptureOptions {
  /** Bounded input produced by the renderer, such as a set of thumbnails. */
  stdin?: Buffer;
  /** Consume stdout incrementally instead of retaining it in the result buffer. */
  onStdoutChunk?: (chunk: Buffer) => void;
  onStdoutBytes?: (total: number) => void;
  signal?: AbortSignal;
  /** Maximum stdout size in bytes before the process is killed (default 512 MiB). */
  maxStdout?: number;
  /** Total diagnostic bytes allowed. A streaming consumer retains only a small error tail. */
  maxStderr?: number;
  onStderrLine?: (line: string) => void;
}

export interface CaptureResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/**
 * Told of every FFmpeg and FFprobe this package starts, as it starts. The engine lowers the priority of those started
 * for background work while the editor plays.
 */
export const spawnObserver: { spawned?: (child: ChildProcess) => void } = {};

function countSpawn(bin: string): void {
  if (/ffprobe/i.test(bin)) spawnStats.ffprobe++;
  else spawnStats.ffmpeg++;
}

interface ManagedHooks<T> {
  onSpawn?: (child: ChildProcess) => void;
  getStderr: () => string;
  onClose: (code: number | null) => T;
}

/** Shared subprocess lifecycle: abort check, spawn counting/observer, error wrapping, and cleanup. */
function spawnManaged<T>(
  bin: string,
  args: string[],
  stdio: StdioOptions,
  signal: AbortSignal | undefined,
  hooks: ManagedHooks<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    countSpawn(bin);
    const child = spawn(bin, args, { stdio, windowsHide: true });
    spawnObserver.spawned?.(child);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    hooks.onSpawn?.(child);
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new FfmpegError(mediaToolLaunchError(bin, e, `failed to start ${bin}: ${e.message}`), bin, args, null, hooks.getStderr(), false));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) return reject(new AbortError());
      try {
        resolve(hooks.onClose(code));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Run a binary to completion, collecting stdout as a Buffer and stderr as text.
 * Rejects with FfmpegError on a non-zero exit, AbortError when the signal fires.
 */
export function runCapture(bin: string, args: string[], opts: CaptureOptions = {}): Promise<CaptureResult> {
  const out: Buffer[] = [];
  let outBytes = 0;
  let err = "";
  let errBytes = 0, partialLine = "";
  let failure: Error | undefined;
  const maxStdout = opts.maxStdout ?? (opts.onStdoutChunk ? Infinity : 512 * 1024 * 1024);
  const maxStderr = opts.maxStderr ?? 8 * 1024 * 1024;
  const exceeded = (message: string) => new FfmpegError(message, bin, args, null, err.slice(-8192));

  return spawnManaged(bin, args, [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"], opts.signal, {
    getStderr: () => err,
    onSpawn(child) {
      if (child.stdin && opts.stdin) {
        // FFmpeg can close its input early on failure or cancellation. Its exit reports the cause.
        child.stdin.on("error", () => {});
        child.stdin.end(opts.stdin);
      }
      const stop = (reason: Error) => {
        if (failure) return;
        failure = reason;
        child.kill("SIGKILL");
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (failure) return;
        outBytes += chunk.length;
        if (outBytes > maxStdout) {
          stop(exceeded(`stdout exceeded ${maxStdout} bytes`));
          return;
        }
        if (opts.onStdoutChunk) {
          try { opts.onStdoutChunk(chunk); }
          catch (error) { stop(error as Error); return; }
        } else out.push(chunk);
        opts.onStdoutBytes?.(outBytes);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (failure) return;
        errBytes += chunk.length;
        if (errBytes > maxStderr) { stop(exceeded(`stderr exceeded ${maxStderr} bytes`)); return; }
        const text = chunk.toString("utf8");
        if (!opts.onStderrLine) { err += text; return; }
        err = (err + text).slice(-8192);
        const lines = (partialLine + text).split(/\r?\n/);
        partialLine = lines.pop()!;
        if (partialLine.length > 16_384 || lines.some(line => line.length > 16_384)) {
          stop(exceeded("diagnostic line exceeded 16384 characters"));
          return;
        }
        try { for (const line of lines) opts.onStderrLine(line); }
        catch (error) { stop(error as Error); }
      });
    },
    onClose(code) {
      if (failure) throw failure;
      if (partialLine) opts.onStderrLine?.(partialLine);
      if (code !== 0) {
        throw new FfmpegError(`${bin} exited with code ${code}:\n${stderrTail(err)}`, bin, args, code, err);
      }
      return { stdout: Buffer.concat(out), stderr: err, code: 0 };
    },
  });
}

export interface RunFfmpegOptions {
  ffmpegPath?: string;
  signal?: AbortSignal;
  /** Called with the output timestamp (seconds) each time ffmpeg reports progress. */
  onProgress?: (outTimeSeconds: number) => void;
}

/**
 * Run ffmpeg with `-progress pipe:1` and parse `out_time` for progress.
 * `args` is everything after the binary; `-hide_banner -nostdin -loglevel error`
 * are prepended. Stdout is reserved for progress, so callers that want media on
 * stdout should use `runCapture` instead.
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<{ stderr: string }> {
  const bin = resolveFfmpeg(opts.ffmpegPath);
  const full: string[] = [...FFMPEG_BASE_ARGS];
  if (opts.onProgress) full.push("-progress", "pipe:1", "-nostats");
  full.push(...args);

  let err = "";
  let pending = "";
  return spawnManaged(bin, full, ["ignore", opts.onProgress ? "pipe" : "ignore", "pipe"], opts.signal, {
    getStderr: () => err,
    onSpawn(child) {
      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const t = parseProgressLine(line);
          if (t !== undefined) opts.onProgress?.(t);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err = (err + chunk.toString("utf8")).slice(-65_536);
      });
    },
    onClose(code) {
      if (code !== 0) {
        throw new FfmpegError(`ffmpeg exited with code ${code}:\n${stderrTail(err)}`, bin, full, code, err);
      }
      return { stderr: err };
    },
  });
}

/**
 * Parse one `-progress` line into seconds. Prefers `out_time=HH:MM:SS.micro`
 * (unambiguous); `out_time_us` is accepted as a fallback. ffmpeg's `out_time_ms`
 * has historically been microseconds despite its name, so it is ignored.
 */
export function parseProgressLine(line: string): number | undefined {
  if (line.startsWith("out_time=")) {
    const m = /^out_time=(-?)(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (!m) return undefined;
    const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    return m[1] ? 0 : sec;
  }
  if (line.startsWith("out_time_us=")) {
    const us = Number(line.slice("out_time_us=".length));
    return Number.isFinite(us) ? Math.max(0, us / 1e6) : undefined;
  }
  return undefined;
}

/** Keep an answer, not a failure: a binary that could not start once may start the next time. */
function cachedPerBinary<T>(run: (bin: string) => Promise<T>): (ffmpegPath?: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (ffmpegPath?: string) => {
    const bin = resolveFfmpeg(ffmpegPath);
    let p = cache.get(bin);
    if (!p) {
      p = run(bin);
      cache.set(bin, p);
      p.catch(() => {
        if (cache.get(bin) === p) cache.delete(bin);
      });
    }
    return p;
  };
}

/** The first line a media tool prints for `-version`. */
function versionLine(bin: string): Promise<string> {
  return runCapture(bin, ["-version"]).then((r) => r.stdout.toString("utf8").split(/\r?\n/)[0] ?? "");
}

/** `ffmpeg -version` first line, e.g. "ffmpeg version 9.0.2-full_build ...". Cached per binary. */
export const ffmpegVersion = cachedPerBinary(versionLine);

/** Major version number parsed from `ffmpegVersion()`, or undefined for git builds without one. */
export async function ffmpegMajor(ffmpegPath?: string): Promise<number | undefined> {
  const line = await ffmpegVersion(ffmpegPath);
  const m = /version\s+n?(\d+)\./i.exec(line);
  return m ? Number(m[1]) : undefined;
}

/** Names of encoders this ffmpeg build lists (`ffmpeg -encoders`). Cached per binary. */
export const ffmpegEncoders = cachedPerBinary((bin) =>
  runCapture(bin, ["-hide_banner", "-encoders"]).then((r) => {
    const names = new Set<string>();
    for (const line of r.stdout.toString("utf8").split(/\r?\n/)) {
      // " V....D libx264              libx264 H.264 ..."; the legend above the list reads " V..... = Video".
      const m = /^\s*[VAS][.F][.S][.X][.B][.D]\s+(\S+)/.exec(line);
      if (m?.[1] && m[1] !== "=") names.add(m[1]);
    }
    return names;
  }),
);

/** Names in `ffmpeg -filters` output. Each filter's line reads " TSC drawtext   V->V   Draw text ..." (older builds
 * have two flag columns); the legend above the list reads " T.. = Timeline support" and has no arrow. */
export function parseFilterList(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[T.]?[S.]?[C.]?\s+([A-Za-z0-9_]+)\s+\S*->\S*(?:\s|$)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

/** Names of filters this ffmpeg build lists (`ffmpeg -filters`). Cached per binary. */
export const ffmpegFilters = cachedPerBinary((bin) =>
  runCapture(bin, ["-hide_banner", "-filters"]).then((r) => parseFilterList(r.stdout.toString("utf8"))),
);

/**
 * Whether this ffmpeg build can draw text. A build that can't be asked counts as able, so whatever stops it from
 * running is the error the render reports. So does a list Scarlet couldn't read a filter from, so a change in how a
 * later FFmpeg prints it never blocks captions on a build that has them.
 */
export async function hasDrawtext(ffmpegPath?: string): Promise<boolean> {
  try {
    const filters = await ffmpegFilters(ffmpegPath);
    return filters.size === 0 || filters.has("drawtext");
  } catch { return true; }
}

/** Throw `MissingFilterError` before any work when this ffmpeg can't draw text that `need` requires. */
export async function requireDrawtext(need: string, ffmpegPath?: string): Promise<void> {
  if (!await hasDrawtext(ffmpegPath)) throw new MissingFilterError("drawtext", missingTextFilterMessage(need));
}

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
    out.ffprobe.version = await versionLine(ffprobePath);
  } catch (e) {
    out.ffprobe.error = (e as Error).message;
  }
  if (!out.ffmpeg.error) {
    const enc = await ffmpegEncoders(ffmpegPath).catch(() => new Set<string>());
    out.hwEncoders = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_mf", "h264_vaapi"].filter((e) => enc.has(e));
  }
  out.ok = !out.ffmpeg.error && !out.ffprobe.error;
  return out;
}

/** Format a number for ffmpeg expressions/options: fixed precision, no exponent notation. */
export function fnum(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(digits);
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/\.?0+$/, "");
  return trimmed === "" || trimmed === "-" || trimmed === "-0" ? "0" : trimmed;
}

/** A time to seek to (-ss). JavaScript writes anything under a microsecond as an exponent ("5.5e-17", which is
 * what 0.1 + 0.2 - 0.3 leaves) and ffmpeg refuses that. It resolves nothing finer, so such a time is zero.
 * Not for a length (-t): zero there means no limit. */
export function ffSeconds(seconds: number): string {
  return Math.abs(seconds) < 1e-6 ? "0" : String(seconds);
}
