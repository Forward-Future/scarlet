import type { LocalModelStatus } from "@scarlet/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
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

/** One verified model per library. Only a transcription request calls get(). */
export class LocalWhisperModel {
  // Share an in-flight download until its last caller leaves. The on-disk
  // checksum and stamp govern reuse after it completes.
  private readonly requests = new AnalysisCache<string>(() => 0, 0, 1);
  private transfer?: LocalModelStatus;
  private failed = false;
  private verifiedStamp?: string;

  /** `log`: where a download's start and its end go. The engine's log is its console. */
  constructor(private readonly directory: string, private readonly model: PinnedModel = bundledWhisperModel,
    private readonly log: (message: string) => void = message => console.log(message)) {}

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
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
      if (hash.digest("hex") === this.model.sha256) {
        this.verifiedStamp = stamp;
        return "ready";
      }
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
    await mkdir(this.directory, { recursive: true });
    const partial = `${file}.${randomUUID()}.part`;
    let saving: WriteStream | undefined;
    try {
      const response = await fetch(this.model.url, { signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = createHash("sha256");
      const expected = this.model.size;
      await pipeline(response.body, async function* (chunks) {
        for await (const chunk of chunks) {
          const bytes = chunk as Uint8Array;
          progress.received += bytes.byteLength;
          if (progress.received > expected) throw new Error("model exceeds expected size");
          hash.update(bytes);
          yield bytes;
        }
      }, saving = createWriteStream(partial, { flags: "wx" }), { signal });
      if (progress.received !== expected || hash.digest("hex") !== this.model.sha256) throw new Error("model checksum mismatch");
      signal.throwIfAborted();
      await rename(partial, file);
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
      const after = humanDuration(Date.now() - started);
      if (signal.aborted) this.log(`[model] ${this.model.name}: download stopped after ${after}`);
      signal.throwIfAborted();
      // fetch says only "fetch failed": the reason, such as a host that can't be found, is its cause.
      const cause = (error as Error).cause;
      this.log(`[model] ${this.model.name}: download failed after ${after}: ${(error as Error).message}${cause instanceof Error ? ` (${cause.message})` : ""}`);
      throw new Error(`Could not download the local model ${this.model.name}: ${(error as Error).message}. Retry transcription to try again.`, { cause: error });
    } finally {
      // A download that fails on its first bytes ends while its file is still being opened. Removed before the file
      // was there, it stayed behind empty, so wait until the file is closed.
      if (saving && !saving.closed) await new Promise<void>(resolve => saving!.once("close", () => resolve()));
      await rm(partial, { force: true });
    }
  }
}
