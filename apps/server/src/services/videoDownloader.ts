/**
 * Scarlet's copy of yt-dlp, which reads and downloads videos on the web. It starts on the build pinned here, the one
 * the engine was tested with. Sites change what they serve every few weeks and an old yt-dlp then fails, so when a
 * call fails Scarlet looks for a newer release, fetches it by the checksum its release page gives, runs the call again
 * with it and keeps it from then on. Nobody has to move the pin for the editor's downloads to work again.
 */
import { access, chmod, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../errors.js";
import { FfmpegError, run, type RunOptions } from "../render/ffmpeg.js";
import { LocalWhisperModel, type PinnedModel } from "../transcribe/localModel.js";

/** One build of yt-dlp: the release it is from, its file's name there, and its size and checksum. */
export interface DownloaderBuild extends PinnedModel { version: string; asset: string }

const ORIGIN = "https://github.com/yt-dlp/yt-dlp/releases/download/";
const RELEASES = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
/** A failure is as often the video's (private, taken down) as the downloader's: ask what the newest release is once an hour at most. */
const CHECK_EVERY_MS = 60 * 60_000;

const RELEASE = "2026.10.26";
const fileName = (version: string, asset: string) => `yt-dlp-${version}${asset.endsWith(".exe") ? ".exe" : ""}`;
const pinned = (asset: string, size: number, sha256: string): DownloaderBuild =>
  ({ version: RELEASE, asset, name: fileName(RELEASE, asset), url: `${ORIGIN}${RELEASE}/${asset}`, size, sha256 });

/** The builds the engine was tested with, one for each machine Scarlet runs on. */
export const DOWNLOADERS: Record<string, DownloaderBuild> = {
  "darwin-arm64": pinned("yt-dlp_macos", 37466304, "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa"),
  "darwin-x64": pinned("yt-dlp_macos", 37466304, "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa"),
  "win32-x64": pinned("yt-dlp.exe", 23575744, "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d"),
  "win32-arm64": pinned("yt-dlp_arm64.exe", 22809590, "0066dbac3c124028e2dcae2a197fccee33cd91f456313d24f7af89fd54590e98"),
  "linux-x64": pinned("yt-dlp_linux", 41166968, "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795"),
  "linux-arm64": pinned("yt-dlp_linux_aarch64", 40789792, "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483"),
};

const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);

interface Options {
  /** Where the copies are kept. */
  folder: string;
  /** The build to start on; none on a machine yt-dlp has no build for. */
  pinned: DownloaderBuild | undefined;
  /** A yt-dlp of the machine's own (`YT_DLP_PATH`): used as it is, and never replaced. */
  own?: string;
  log(message: string): void;
  /** Where the newest release is described, and where its files may come from. The tests' own. */
  releases?: string;
  origin?: string;
  now?: () => number;
}

export class VideoDownloader {
  private readonly copies = new Map<string, LocalWhisperModel>();
  private newer?: Promise<DownloaderBuild | undefined>;
  private updating?: Promise<boolean>;
  private checked = -Infinity;

  constructor(private readonly options: Options) {}

  private get record() { return join(this.options.folder, "yt-dlp-newer.json"); }

  /** A build as the release page describes it, or nothing when any part of that is missing: a file with no checksum is never run. */
  private build(version: unknown, asset: { name?: unknown; size?: unknown; digest?: unknown; sha256?: unknown; browser_download_url?: unknown; url?: unknown }): DownloaderBuild | undefined {
    const from = this.options.pinned;
    const url = asset.browser_download_url ?? asset.url;
    const sha256 = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : asset.sha256;
    if (!from || typeof version !== "string" || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(version) || version <= from.version) return;
    if (typeof url !== "string" || !url.startsWith(this.options.origin ?? ORIGIN) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return;
    if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) return;
    return { version, asset: from.asset, name: fileName(version, from.asset), url, size: asset.size, sha256 };
  }

  /** The build in use: the newest one an earlier failure fetched, else the pinned one. */
  private async current(): Promise<DownloaderBuild> {
    const from = this.options.pinned;
    if (!from) throw new HttpError(501, "no_downloader", "Scarlet has no video downloader for this kind of machine. Set YT_DLP_PATH to a yt-dlp on it.");
    this.newer ??= readFile(this.record, "utf8").then(saved => {
      const build = JSON.parse(saved) as DownloaderBuild;
      return this.build(build.version, build);
    }).catch(() => undefined);
    return await this.newer ?? from;
  }

  private async file(build: DownloaderBuild, signal: AbortSignal): Promise<string> {
    let copy = this.copies.get(build.name);
    if (!copy) {
      // A build that was replaced is never run again.
      const earlier = [...this.copies.keys(), this.options.pinned!.name].filter(name => name !== build.name);
      this.copies.set(build.name, copy = new LocalWhisperModel(this.options.folder, { ...build, replaces: [...new Set(earlier)] }, this.options.log));
    }
    const file = await copy.get(signal);
    if (!await runnable(file)) await chmod(file, 0o755);
    return file;
  }

  /** Where yt-dlp is, fetched first if this machine doesn't have it yet. */
  async path(signal: AbortSignal): Promise<string> {
    if (this.options.own) return this.options.own;
    const build = await this.current();
    return this.file(build, signal).catch((error: Error) => {
      if (signal.aborted) throw error;
      throw new HttpError(502, "no_downloader", `Scarlet couldn't fetch its video downloader (${(error.cause as Error | undefined)?.message ?? error.message}). Try again once the machine is online.`);
    });
  }

  /**
   * Move to the newest release, if there is one newer than the build in use. True once it is fetched, checked and
   * in use. A release that can't be read, checked or downloaded leaves the build in use where it was.
   */
  update(signal: AbortSignal): Promise<boolean> {
    if (this.options.own || !this.options.pinned) return Promise.resolve(false);
    const now = (this.options.now ?? Date.now)();
    if (this.updating) return this.updating;
    if (now - this.checked < CHECK_EVERY_MS) return Promise.resolve(false);
    this.checked = now;
    const updating = (async () => {
      const using = await this.current();
      const res = await fetch(this.options.releases ?? RELEASES, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const latest = await res.json() as { tag_name?: unknown; assets?: Array<Record<string, unknown>> };
      const found = latest.assets?.find(asset => asset.name === using.asset);
      const build = found && this.build(latest.tag_name, found);
      if (!build || build.version <= using.version) return false;
      this.options.log(`[tools] yt-dlp ${using.version} failed and ${build.version} is out: fetching it`);
      await this.file(build, signal);
      await mkdir(this.options.folder, { recursive: true });
      await writeFile(this.record, JSON.stringify(build));
      this.newer = Promise.resolve(build);
      this.options.log(`[tools] yt-dlp ${build.version} is in use`);
      return true;
    })().catch((error: Error) => {
      if (!signal.aborted) this.options.log(`[tools] yt-dlp: couldn't move to a newer release: ${error.message}`);
      return false;
    }).finally(() => { if (this.updating === updating) this.updating = undefined; });
    return this.updating = updating;
  }

  /** Run yt-dlp. A call that fails is run once more when a newer yt-dlp could be had, or another call just fetched one. */
  async run(args: string[], opts: RunOptions = {}): Promise<Buffer> {
    const signal = opts.signal ?? new AbortController().signal;
    const bin = await this.path(signal);
    try {
      return await run(bin, args, opts);
    } catch (error) {
      if (signal.aborted || !(error instanceof FfmpegError) || this.options.own) throw error;
      const updated = await this.update(signal) || await this.path(signal).then(now => now !== bin, () => false);
      if (!updated) throw error;
      return run(await this.path(signal), args, opts);
    }
  }
}
