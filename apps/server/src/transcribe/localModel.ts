import { hashFile } from "@scarlet/render";
import type { LocalModelStatus } from "@scarlet/shared";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, createWriteStream, readFileSync, statSync, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { isSea } from "node:sea";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { humanDuration } from "../logText.js";
import { AnalysisCache } from "../services/analysisCache.js";

/** A model file pinned by URL, size and checksum. `replaces`: earlier files of the same model, removed once this one is in place. */
export interface PinnedModel { name: string; url: string; size: number; sha256: string; replaces?: readonly string[] }

/**
 * Whisper large-v3-turbo, quantized to 5 bits. Base misspelled names and wrote a stutter or a restart as the sentence
 * the speaker meant, which hid exactly what a dialogue pass cuts.
 */
export const bundledWhisperModel: PinnedModel & { displayName: string } = {
  name: "ggml-large-v3-turbo-q5_0.bin",
  displayName: "Whisper large-v3-turbo",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
  size: 574041195,
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  replaces: ["ggml-base.bin"],
};

/**
 * The whisper.cpp revision the bundled `whisper-cli` is built from (apps/desktop/scripts/build-whisper.mjs). Readings
 * saved by the bundled runtime are keyed on it: every update installs the executable again, with new file times and a
 * new signature, and a key on the file's stat or bytes threw away every saved scan page on each update (2026-11-20).
 */
export const BUNDLED_WHISPER_CPP = "d1be6fde11ac6e0407606b4e42fe72d34add8037";

/** Every CPU the scheduler can use must support the instructions in the optimized Linux whisper.cpp build. */
export function supportsWhisperAvx2(cpuInfo: string): boolean {
  const cores = cpuInfo.trim().split(/\n\s*\n/);
  return cores.every(core => {
    const flags = new Set(/^flags\s*:\s*(.*)$/m.exec(core)?.[1]?.split(/\s+/));
    return ["sse4_2", "avx", "f16c", "fma", "avx2", "bmi2"].every(flag => flags.has(flag));
  });
}

function canRunWhisperAvx2() {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  try { return supportsWhisperAvx2(readFileSync("/proc/cpuinfo", "utf8")); } catch { return false; }
}

export function bundledWhisperCli(env: NodeJS.ProcessEnv, avx2 = canRunWhisperAvx2()): string | undefined {
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const names = avx2 ? [join("whisper-cpu", name), name] : [name];
  for (const dir of [env.SCARLET_BIN_DIR, dirname(process.execPath)]) {
    if (!dir) continue;
    for (const candidate of names) {
      const file = join(dir, candidate);
      const info = statSync(file, { throwIfNoEntry: false });
      if (info?.isFile() && info.size > 0) return file;
    }
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  const lower = name.toLowerCase();
  const key = Object.keys(env).find(k => k.toLowerCase() === lower);
  return key ? env[key] : undefined;
}

function usableExecutable(file: string): boolean {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size === 0) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback `whisper-cli` for development checkouts and fresh worktrees where `build.rs` wrote a zero-byte placeholder.
 * Packaged SEA builds never fall back here: they must use the `whisper-cli` bundled beside the engine.
 */
export function devWhisperCli(env: NodeJS.ProcessEnv, sea = isSea()): string | undefined {
  if (sea) return;
  const explicit = envValue(env, "SCARLET_WHISPER_CLI")?.trim();
  if (explicit && usableExecutable(explicit)) return explicit;
  const pathValue = envValue(env, "PATH");
  if (!pathValue) return;
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  for (const raw of pathValue.split(delimiter)) {
    const dir = raw.replace(/^"|"$/g, "").trim();
    if (!dir) continue;
    const file = join(dir, name);
    if (usableExecutable(file)) return file;
  }
}

/**
 * The GPU build of whisper-cli. Windows bundles a Vulkan build beside the CPU one, which runs on any recent NVIDIA,
 * AMD or Intel GPU. It needs the driver's Vulkan loader, so the CPU build stays as the fallback. macOS's single build
 * already runs on Metal.
 */
export function bundledWhisperGpu(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "win32") return;
  for (const dir of [env.SCARLET_BIN_DIR, dirname(process.execPath)]) {
    if (!dir) continue;
    const file = join(dir, "whisper-gpu", "whisper-cli.exe");
    const info = statSync(file, { throwIfNoEntry: false });
    if (info?.isFile() && info.size > 0) return file;
  }
}

/** Tuning hooks for LocalWhisperModel download retries, stall timeouts, and Windows rename retries. */
export interface LocalModelOptions {
  /** Total download attempts before failing (default 3). */
  maxAttempts?: number;
  /** Base delay in ms before retrying a transient download failure; doubles on each retry (default 1500). */
  retryDelayMs?: number;
  /** Abort and retry a download attempt if no bytes arrive for this long (default 60_000 ms). */
  stallTimeoutMs?: number;
  /** Retries when renaming the finished .part file hits transient Windows AV/indexer locks (default 6). */
  renameRetries?: number;
  /** Base delay in ms between rename retries (default 250). */
  renameDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_RENAME_RETRIES = 6;
const DEFAULT_RENAME_DELAY_MS = 250;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const NON_RETRYABLE_FS_CODES = new Set(["ENOSPC", "EROFS", "EACCES", "EPERM"]);

class DownloadError extends Error {
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options);
  }
}

function isRetryableDownloadError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof DownloadError) return error.retryable;
  const code = (error as NodeJS.ErrnoException)?.code ?? ((error as { cause?: NodeJS.ErrnoException })?.cause)?.code;
  if (code && NON_RETRYABLE_FS_CODES.has(code)) return false;
  return true;
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal.throwIfAborted();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Rename a finished partial model file, retrying briefly on Windows AV/indexer locks so 574 MB isn't discarded. */
export async function renameWithRetry(
  from: string,
  to: string,
  signal: AbortSignal,
  options: { retries?: number; delayMs?: number; renameFn?: typeof rename } = {},
): Promise<void> {
  const retries = Math.max(1, options.retries ?? DEFAULT_RENAME_RETRIES);
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_RENAME_DELAY_MS);
  const doRename = options.renameFn ?? rename;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      await doRename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= retries) throw error;
      await waitAbortable(delayMs * attempt, signal);
    }
  }
}

/** One verified model per library. Only a transcription request calls get(). */
export class LocalWhisperModel {
  // Share an in-flight download until its last caller leaves. The on-disk
  // checksum and stamp govern reuse after it completes.
  private readonly requests = new AnalysisCache<string>(() => 0, 0, 1);
  private transfer?: LocalModelStatus;
  private failed = false;
  private verifiedStamp?: string;
  /** A saved file of the right size whose checksum was wrong. Settings asks every few seconds, and hashing ~574 MB each time is too much. */
  private damagedStamp?: string;

  /** `log`: where a download's start and its end go. The engine's log is its console. */
  constructor(private readonly directory: string, private readonly model: PinnedModel = bundledWhisperModel,
    private readonly log: (message: string) => void = message => console.log(message),
    private readonly options: LocalModelOptions = {}) {}

  async status(): Promise<LocalModelStatus> {
    if (this.transfer) return this.transfer;
    if (this.failed) return { state: "failed" };
    return { state: await this.cachedState() };
  }

  get(signal: AbortSignal): Promise<string> {
    return this.requests.get(this.model.name, async demand => {
      this.failed = false;
      this.transfer = { state: "checking" };
      try {
        return await this.prepare(demand);
      } catch (error) {
        this.failed = !demand.aborted;
        throw error;
      } finally {
        this.transfer = undefined;
      }
    }, { signal });
  }

  private async cachedState(signal?: AbortSignal): Promise<"ready" | "missing" | "invalid"> {
    const file = join(this.directory, this.model.name);
    const existing = statSync(file, { throwIfNoEntry: false });
    if (existing?.isFile() && existing.size === this.model.size) {
      const stamp = `${existing.ino}/${existing.ctimeMs}/${existing.mtimeMs}`;
      if (stamp === this.verifiedStamp) return "ready";
      if (stamp === this.damagedStamp) return "invalid";
      if (await hashFile(file, undefined, signal) === this.model.sha256) {
        this.verifiedStamp = stamp;
        return "ready";
      }
      this.damagedStamp = stamp;
    }
    return existing ? "invalid" : "missing";
  }

  private async prepare(signal: AbortSignal): Promise<string> {
    const file = join(this.directory, this.model.name);
    const cached = await this.cachedState(signal);
    if (cached === "ready") return file;
    signal.throwIfAborted();
    const progress = { state: "downloading" as const, received: 0, total: this.model.size };
    this.transfer = progress;
    const started = Date.now();
    const megabytes = Math.max(1, Math.round(this.model.size / 1e6));
    this.log(`[model] ${this.model.name}: ${cached === "invalid" ? "the saved copy is damaged, " : ""}downloading ${megabytes} MB`);
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const retryDelayMs = Math.max(0, this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    const stallTimeoutMs = Math.max(0, this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
    try {
      await mkdir(this.directory, { recursive: true });
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        progress.received = 0;
        const partial = `${file}.${randomUUID()}.part`;
        let saving: WriteStream | undefined;
        let stalled = false;
        let stallTimer: NodeJS.Timeout | undefined;
        const attemptAbort = new AbortController();
        const onParentAbort = () => attemptAbort.abort(signal.reason);
        signal.addEventListener("abort", onParentAbort, { once: true });
        const resetStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          if (stallTimeoutMs <= 0) return;
          stallTimer = setTimeout(() => {
            stalled = true;
            attemptAbort.abort(new DownloadError("download stalled", true));
          }, stallTimeoutMs);
          stallTimer.unref();
        };
        try {
          resetStallTimer();
          const response = await fetch(this.model.url, { signal: attemptAbort.signal });
          if (signal.aborted) {
            await response.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          if (!response.ok || !response.body) {
            await response.body?.cancel().catch(() => {});
            const retryable = response.status >= 500 || RETRYABLE_HTTP_STATUSES.has(response.status);
            throw new DownloadError(`HTTP ${response.status}`, retryable);
          }
          const hash = createHash("sha256");
          const expected = this.model.size;
          // Wrap the Web stream so pipeline's abort signal cancels a stalled body instead of hanging on reader.read().
          await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), async function* (chunks) {
            for await (const chunk of chunks) {
              resetStallTimer();
              const bytes = chunk as Uint8Array;
              progress.received += bytes.byteLength;
              if (progress.received > expected) throw new DownloadError("model exceeds expected size", false);
              hash.update(bytes);
              yield bytes;
            }
          }, saving = createWriteStream(partial, { flags: "wx" }), { signal: attemptAbort.signal });
          if (stallTimer) clearTimeout(stallTimer);
          if (progress.received < expected) throw new DownloadError("model download ended early", true);
          if (progress.received !== expected || hash.digest("hex") !== this.model.sha256) throw new DownloadError("model checksum mismatch", false);
          signal.throwIfAborted();
          await renameWithRetry(partial, file, signal, {
            retries: this.options.renameRetries,
            delayMs: this.options.renameDelayMs,
          });
          const info = await stat(file);
          this.verifiedStamp = `${info.ino}/${info.ctimeMs}/${info.mtimeMs}`;
          this.log(`[model] ${this.model.name}: downloaded in ${humanDuration(Date.now() - started)}`);
          // The file this one replaces is never read again. Only the bundled model's own copy is removed: a model chosen in
          // Settings is read from its own path and never fetched here.
          for (const earlier of this.model.replaces ?? []) {
            await rm(join(this.directory, earlier), { force: true }).catch(() => {});
          }
          return file;
        } catch (error) {
          if (stallTimer) clearTimeout(stallTimer);
          const failure = !signal.aborted && stalled ? new DownloadError("download stalled", true) : error;
          // A download that fails on its first bytes ends while its file is still being opened. Removed before the file
          // was there, it stayed behind empty, so wait until the file is closed.
          if (saving && !saving.closed) await new Promise<void>(resolve => saving!.once("close", () => resolve()));
          await rm(partial, { force: true });
          if (attempt < maxAttempts && isRetryableDownloadError(failure, signal)) {
            const delay = retryDelayMs * 2 ** (attempt - 1);
            const cause = (failure as Error).cause;
            this.log(`[model] ${this.model.name}: attempt ${attempt}/${maxAttempts} failed (${(failure as Error).message}${cause instanceof Error ? ` (${cause.message})` : ""}); retrying`);
            await waitAbortable(delay, signal);
            continue;
          }
          throw failure;
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
          signal.removeEventListener("abort", onParentAbort);
          if (saving && !saving.closed) await new Promise<void>(resolve => saving!.once("close", () => resolve()));
          await rm(partial, { force: true });
        }
      }
    } catch (error) {
      const after = humanDuration(Date.now() - started);
      if (signal.aborted) this.log(`[model] ${this.model.name}: download stopped after ${after}`);
      signal.throwIfAborted();
      // fetch says only "fetch failed": the reason, such as a host that can't be found, is its cause.
      const cause = (error as Error).cause;
      this.log(`[model] ${this.model.name}: download failed after ${after}: ${(error as Error).message}${cause instanceof Error ? ` (${cause.message})` : ""}`);
      throw new Error(`Could not download the local model ${this.model.name}: ${(error as Error).message}. Retry transcription to try again.`, { cause: error });
    }
  }
}
