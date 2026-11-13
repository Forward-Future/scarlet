import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PlaybackCacheStatus, SourceCacheStatus } from "@scarlet/shared";
import { isPlayableMedia, SOURCE_PREVIEW_SECONDS } from "@scarlet/timeline";
import { engineIsAlive, type Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { throttledLog } from "../logText.js";
import type { MediaWithStatus } from "../repo/projects.js";
import { fullProxyVariants, legacyFullPicture, previewIdentity, sourceCheckpointDir } from "./previewPictures.js";

type SourceMedia = MediaWithStatus & { projectId: string };
type CacheRequest = { worker_pid: number | null };
interface CachePoll {
  requests: Map<string, CacheRequest>;
  previewHeight: number;
  files?: Set<string>;
}

/**
 * About how long a cache still needs, in seconds, from the pace of this run. A resumed cache reports the parts it kept
 * from an earlier run in its first moments, so the pace is measured from where its own encoding began.
 */
export function cacheTimeLeft(now: () => number = () => performance.now()) {
  let first: number | undefined;
  let from: { at: number; fraction: number } | undefined;
  return (fraction: number): number | undefined => {
    const at = now();
    first ??= at;
    if (!from || at - first < 2000) from = { at, fraction };
    const elapsed = (at - from.at) / 1000, done = fraction - from.fraction;
    return elapsed >= 5 && done >= 0.01 && fraction < 1 ? Math.ceil(elapsed * (1 - fraction) / done) : undefined;
  };
}

/** Bounded, persistent cache. Readers can only see complete, independently playable MP4s. */
export class SourcePreviews {
  private readonly encoding = new Map<string, Promise<void>>();

  private readonly fullJobs = new Map<string, PlaybackCacheStatus>();
  private readonly fullRuns = new Map<string, Promise<void>>();

  private async fullTarget(ctx: Ctx, media: SourceMedia, fileKey?: string, poll?: CachePoll) {
    const dir = ctx.paths.proxies(media.projectId);
    const identity = await previewIdentity(ctx.paths.media(media.projectId), media);
    const { local, shared } = identity;
    const variants = fullProxyVariants(dir, shared ? [shared, local] : [local], media.height);
    const minimum = Math.min(poll?.previewHeight ?? ctx.settings().render.previewHeight, variants.at(-1)!.height);
    const candidates = variants.filter(v => v.height >= minimum);
    // Pin range requests to the published file even if the editor changes preview height mid-playback.
    const files = (fileKey === undefined ? candidates : variants).map(v => v.file);
    if (!media.previewMode && (!media.fingerprintStamp || shared) && isPlayableMedia(media)) {
      files.unshift(join(dir, media.id + ".mp4"));
    }
    let readyFile: string | undefined;
    for (const file of files) {
      if (fileKey !== undefined && basename(file) !== fileKey) continue;
      if (poll?.files && !poll.files.has(basename(file))) continue;
      if ((await stat(file).catch(() => null))?.size) { readyFile = file; break; }
    }
    if (!readyFile && identity.present && (!media.fingerprintStamp || shared)) {
      const legacy = await legacyFullPicture(ctx.paths.media(media.projectId), media, identity.legacyKeys,
        fileKey === undefined ? minimum : 0, undefined, fileKey, poll?.files);
      readyFile = legacy?.file;
    }
    const target = candidates.find(v => this.fullJobs.get(v.file)?.state === "caching") ?? candidates[0]!;
    return { identity, target, readyFile };
  }

  async fullFile(ctx: Ctx, media: SourceMedia, fileKey?: string) {
    return (await this.fullTarget(ctx, media, fileKey)).readyFile;
  }

  async full(ctx: Ctx, media: SourceMedia, prepare: boolean, poll?: CachePoll): Promise<{ status: PlaybackCacheStatus; run?: Promise<void> }> {
    if (media.kind !== "video") throw badRequest("not_video", "Choose a video to cache.");
    const signal = prepare ? ctx.mediaSignal(media.projectId) : undefined;
    const { identity, target: { file, height, suffix }, readyFile } = await this.fullTarget(ctx, media, undefined, poll);
    const request = poll ? poll.requests.get(media.id) :
      ctx.db.prepare("SELECT worker_pid FROM source_cache_requests WHERE media_id = ?").get(media.id) as CacheRequest | undefined;
    const active = request?.worker_pid && engineIsAlive(ctx, request.worker_pid);
    if (readyFile) {
      if (prepare && request && !active) ctx.db.prepare("DELETE FROM source_cache_requests WHERE media_id = ? AND worker_pid IS ?").run(media.id, request.worker_pid);
      return { status: { state: "ready", fileKey: basename(readyFile) } };
    }
    const existing = this.fullJobs.get(file);
    if (existing?.state === "caching") return { status: existing, run: this.fullRuns.get(file) };
    if (active) return { status: { state: "caching" } };
    if (!signal || signal.aborted) return { status: existing ?? { state: "uncached" } };
    // Only one engine publishes or cleans up a recording's checkpoint directory.
    const claimed = ctx.db.prepare(`INSERT INTO source_cache_requests VALUES (?, ?)
      ON CONFLICT(media_id) DO UPDATE SET worker_pid = excluded.worker_pid WHERE worker_pid IS ?`)
      .run(media.id, process.pid, request?.worker_pid ?? null);
    if (!claimed.changes) return { status: { state: "caching" } };
    const job: PlaybackCacheStatus = { state: "caching", progress: 0 };
    this.fullJobs.set(file, job);
    const run = ctx.track((async () => {
      const temp = file + "." + randomUUID() + ".part.mp4";
      const checkpointDir = sourceCheckpointDir(ctx.paths.proxies(media.projectId), identity.local, suffix);
      const timeLeft = cacheTimeLeft();
      try {
        await mkdir(ctx.paths.proxies(media.projectId), { recursive: true });
        await ctx.render.makeProxy(identity.file, temp, {
          height, hwaccel: ctx.settings().render.hwaccel, signal, checkpointDir,
          onProgress: p => { job.progress = p; job.remainingSeconds = timeLeft(p); },
        });
        await identity.check();
        signal.throwIfAborted();
        await rename(temp, file);
        ctx.bus.publish({ type: "media.previewReady", projectId: media.projectId, mediaId: media.id });
        // A scrub may still have a finished checkpoint open on Windows.
        await rm(checkpointDir, { recursive: true, force: true, maxRetries: 5 }).catch(error => ctx.log(`[media] ${media.id} couldn’t remove its source checkpoints: ${error}`));
        this.fullJobs.delete(file);
      } catch (error) {
        job.state = "failed";
        delete job.remainingSeconds;
        if (signal.aborted) this.fullJobs.delete(file);
        else ctx.log(`[media] ${media.id} couldn’t cache its source preview: ${error}`);
      } finally {
        if (signal.aborted) ctx.db.prepare("UPDATE source_cache_requests SET worker_pid = NULL WHERE media_id = ? AND worker_pid = ?").run(media.id, process.pid);
        else ctx.db.prepare("DELETE FROM source_cache_requests WHERE media_id = ? AND worker_pid = ?").run(media.id, process.pid);
        this.fullRuns.delete(file);
        await rm(temp, { force: true }).catch(() => {});
      }
    })());
    this.fullRuns.set(file, run);
    return { status: job, run };
  }

  /**
   * What is kept on disk for this file alone: its proxy, its preview chunks, its full cache and that cache's
   * checkpoints. A cache under its hash serves every copy of the file, so it isn't one of them.
   */
  async filesOf(ctx: Ctx, media: SourceMedia): Promise<string[]> {
    const root = ctx.paths.proxies(media.projectId);
    const { local } = await previewIdentity(ctx.paths.media(media.projectId), media);
    return [join(root, media.id + ".mp4"), join(root, "source-" + local),
      ...fullProxyVariants(root, [local], media.height).flatMap(v => [v.file, sourceCheckpointDir(root, local, v.suffix)])];
  }

  async get(ctx: Ctx, media: MediaWithStatus & { projectId: string }, index: number, signal: AbortSignal): Promise<string> {
    const lifetime = ctx.projectSignal(media.projectId);
    const start = index * SOURCE_PREVIEW_SECONDS;
    if (media.kind !== "video" || !media.duration || !Number.isSafeInteger(index) || index < 0 || start >= media.duration) {
      throw badRequest("bad_preview_range", "Preview chunk is outside the video");
    }
    const range = { start, end: Math.min(media.duration, start + SOURCE_PREVIEW_SECONDS) };
    const height = Math.min(480, ctx.settings().render.previewHeight, media.height ?? 480);
    const root = ctx.paths.proxies(media.projectId);
    const identity = await previewIdentity(ctx.paths.media(media.projectId), media);
    const early = join(root, "source-" + identity.local);
    // A fallback decoder may already be playing from the asset-local cache when hashing finishes.
    const dir = !identity.shared || (await stat(early).catch(() => null))?.isDirectory()
      ? early : join(root, "source-" + identity.shared);
    const file = join(dir, `v1-${height}-${index}.mp4`);
    const now = new Date();
    if (await utimes(file, now, now).then(() => true, () => false)) return file;

    // Coalesce range requests from the media element and avoid encoding stale queued seeks.
    while (true) {
      signal.throwIfAborted();
      lifetime.throwIfAborted();
      const same = this.encoding.get(file);
      if (same) { await same; return file; }
      if (this.encoding.size < 2) break;
      await Promise.race([...this.encoding.values()].map(job => job.catch(() => {})));
    }
    const job = ctx.track((async () => {
      await mkdir(dir, { recursive: true });
      if ((await stat(file).catch(() => null))?.size) return;
      const temp = file + "." + randomUUID() + ".part.mp4";
      try {
        await ctx.render.makeProxy(identity.file, temp, { height, range, hwaccel: ctx.settings().render.hwaccel, signal: lifetime });
        await identity.check();
        try { await rename(temp, file); }
        catch (error) { if (!(await stat(file).catch(() => null))?.size) throw error; }
      } finally {
        await rm(temp, { force: true });
      }
      // Include every preview height in the per-source budget. Open files can be retried next time.
      const names = (await readdir(dir)).filter(name => /^v1-\d+-\d+\.mp4$/.test(name));
      if (names.length > 32) {
        const files = await Promise.all(names.map(async name => {
          const path = join(dir, name);
          return { path, time: (await stat(path).catch(() => null))?.mtimeMs ?? 0 };
        }));
        files.sort((a, b) => a.time - b.time);
        await Promise.all(files.filter(entry => entry.path !== file).slice(0, names.length - 32)
          .map(entry => rm(entry.path, { force: true }).catch(() => {})));
      }
    })().finally(() => this.encoding.delete(file)));
    this.encoding.set(file, job);
    await job;
    return file;
  }
}

/** One per engine, so imports, cut previews and the media routes join the same encodes. */
export const sourcePreviews = new SourcePreviews();

const proxyQueue = new WeakMap<Ctx, { queued: Set<string>; tail: Promise<void> }>();
// The window polls every cache's status, so a status that can't be read is logged once a minute, not once a poll.
const statusFailures = new WeakMap<Ctx, ReturnType<typeof throttledLog>>();

/**
 * Prepare complete proxies at the editing resolution, one source at a time, when the GPU can encode them.
 * Cut previews then decode small pictures with frequent keyframes instead of the originals.
 */
export function prepareSourceProxies(ctx: Ctx, mediaIds: Iterable<string>, requested = false): void {
  if (ctx.shutdown.aborted || (!requested && (!ctx.options.prepareSourceProxies || !ctx.render.hardwareProxies))) return;
  const ids = [...mediaIds];
  if (requested) return queueSourceProxies(ctx, ids);
  if (!ids.length) return;
  // The GPU answers before a video joins the queue, so only one that will be cached is written down as waiting.
  void ctx.track(ctx.render.hardwareProxies!(ctx.settings().render.hwaccel)
    .then(gpu => { if (gpu) queueSourceProxies(ctx, ids); })
    .catch(error => { if (!ctx.shutdown.aborted) ctx.log(`[media] couldn’t check for a GPU to prepare ${ids.length} source ${ids.length === 1 ? "proxy" : "proxies"}: ${error}`); }));
}

/**
 * Each video waits its turn. Its request is written down as it joins, with no worker yet, so one still waiting when
 * the project pauses or Scarlet quits reads as held and is cached after resume or the next launch.
 */
function queueSourceProxies(ctx: Ctx, mediaIds: string[]): void {
  if (ctx.shutdown.aborted) return;
  let queue = proxyQueue.get(ctx);
  if (!queue) proxyQueue.set(ctx, queue = { queued: new Set(), tail: Promise.resolve() });
  for (const id of mediaIds) {
    if (queue.queued.has(id)) continue;
    ctx.db.prepare("INSERT OR IGNORE INTO source_cache_requests SELECT id, NULL FROM media WHERE id = ?").run(id);
    queue.queued.add(id);
    const q = queue;
    q.tail = q.tail.then(async () => {
      try {
        // Nothing to cache after all, so nothing is left waiting.
        if (!(await cacheInTurn(ctx, id))) ctx.db.prepare("DELETE FROM source_cache_requests WHERE media_id = ? AND worker_pid IS NULL").run(id);
      } catch (error) {
        if (!ctx.shutdown.aborted) ctx.log(`[media] ${id} couldn’t prepare its source proxy: ${error}`);
      } finally {
        q.queued.delete(id);
      }
    });
    void ctx.track(q.tail);
  }
}

/** One queued video's turn. False when it isn't a video Scarlet can cache, so its request can go. */
async function cacheInTurn(ctx: Ctx, id: string): Promise<boolean> {
  // A quit or a pause keeps the request for the next launch or resume.
  if (ctx.shutdown.aborted) return true;
  const media = ctx.repos.projects.getMedia(id);
  if (!media || media.kind !== "video" || media.status !== "ready" || !media.duration) return false;
  if (ctx.mediaSignal(media.projectId).aborted) return true;
  const { run } = await sourcePreviews.full(ctx, media, true);
  await run;
  return true;
}

export function recoverSourcePreviews(ctx: Ctx, projectId?: string) {
  const requests = ctx.db.prepare(`SELECT m.id, r.worker_pid FROM source_cache_requests r JOIN media m ON m.id = r.media_id
    JOIN projects p ON p.id = m.project_id WHERE p.deleted_at IS NULL AND p.media_paused = 0
    AND (? IS NULL OR p.id = ?)`).all(projectId ?? null, projectId ?? null) as { id: string; worker_pid: number | null }[];
  prepareSourceProxies(ctx, requests.filter(r => !r.worker_pid || !engineIsAlive(ctx, r.worker_pid)).map(row => row.id), true);
}

/** Every ready video's full-length cache. Only reads files and state, so the UI can poll it. */
export async function sourceCacheStatuses(ctx: Ctx, projectId: string): Promise<SourceCacheStatus[]> {
  const queue = proxyQueue.get(ctx)?.queued;
  const videos = ctx.repos.projects.listMedia(projectId).filter(m => m.kind === "video" && m.status === "ready" && m.duration);
  if (!videos.length) return [];
  const requests = ctx.db.prepare(`SELECT r.media_id, r.worker_pid FROM source_cache_requests r JOIN media m ON m.id = r.media_id
    WHERE m.project_id = ?`).all(projectId) as Array<CacheRequest & { media_id: string }>;
  const poll: CachePoll = { requests: new Map(requests.map(row => [row.media_id, row])), previewHeight: ctx.settings().render.previewHeight };
  // All resolutions and legacy encodes live in one directory. Check the sizes of
  // present candidates only. The next poll sees any file published in the meantime.
  try { poll.files = new Set(await readdir(ctx.paths.proxies(projectId))); }
  catch { /* A directory that cannot be listed may still allow individual files to be read. */ }
  let failed = statusFailures.get(ctx);
  if (!failed) statusFailures.set(ctx, failed = throttledLog(line => ctx.log(line)));
  return Promise.all(videos.map(async media => {
    const { status } = await sourcePreviews.full(ctx, { ...media, projectId }, false, poll)
      .catch((error): { status: PlaybackCacheStatus } => {
        failed(media.id, `[media] ${media.id} couldn’t read its playback cache: ${(error as Error).message}`);
        return { status: { state: "failed" } };
      });
    const { fileKey: _fileKey, ...rest } = status;
    const queued = rest.state === "uncached" && (queue?.has(media.id) || poll.requests.has(media.id));
    return { mediaId: media.id, ...rest, ...(queued ? { queued } : {}) };
  }));
}
