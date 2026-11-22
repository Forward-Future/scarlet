import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileInDirectory } from "@scarlet/render";
import { decodeImportFilename, importLinkFilename, type User } from "@scarlet/shared";
import { hasInitialTimeline, newId, ProjectSettings, videoFormat, type MediaAsset, type MediaKind, type Project } from "@scarlet/timeline";
import { engineIsAlive, type Ctx } from "../context.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { logId } from "../logText.js";
import type { MediaWithStatus } from "../repo/projects.js";
import type { importTranscriptionPolicy } from "../transcribe/index.js";
import { errorMessage, sameStamp } from "../util.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { audioLane } from "./audioWork.js";
import { editorFirst } from "./editorFirst.js";
import { downloadImport } from "./importUrl.js";
import { quietProgress } from "./progressSave.js";
import { emissionStorePaths } from "./recordingAudio.js";
import { savedSpeakerTurns } from "./recordingSpeakers.js";
import { prepareSourceProxies, sourcePreviews } from "./sourcePreviews.js";
import { cloneOrSteadyCopy } from "./steadyCopy.js";
import { cancelTask } from "./tasks.js";
import { recoverImportTranscriptions, startImportTranscription } from "./transcription.js";
import { olderWaveforms, waveformBase } from "./waveforms.js";

const GiB = 1024 ** 3;
const URL_IMPORT_BYTES = 64 * GiB;
const DOWNLOAD_RESERVE = GiB;
const DOWNLOAD_DISK_CHECK = 8 * 1024 ** 2;
const URL_IMPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
function configuredBytes(text: string | undefined, fallback: number) {
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const byteCount = (bytes: number) => bytes % GiB === 0 ? `${bytes / GiB} GiB` : `${bytes} bytes`;

/** The original is already on disk when an ingest row is created. Replay unfinished
 * preparations one at a time so reopening a library does not flood ffmpeg. */
export async function recoverIngest(ctx: Ctx, projectId?: string) {
  const pending = ctx.db.prepare(`SELECT m.id, m.ingest_pid, (p.deleted_at IS NOT NULL OR p.media_paused) AS stopped
    FROM media m JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'ingesting' AND (? IS NULL OR p.id = ?) ORDER BY m.created_at`)
    .all(projectId ?? null, projectId ?? null) as Array<{ id: string; ingest_pid: number | null; stopped: number }>;
  const claim = ctx.db.prepare("UPDATE media SET ingest_pid = ? WHERE id = ? AND status = 'ingesting' AND ingest_pid IS ?");
  for (const { id, ingest_pid: owner, stopped } of pending) {
    if (owner !== null && engineIsAlive(ctx, owner)) continue;
    if (stopped) {
      if (owner !== null) ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = ? AND ingest_pid = ?").run(id, owner);
      continue;
    }
    if (!claim.run(process.pid, id, owner).changes) continue;
    const media = ctx.repos.projects.getMedia(id);
    if (!media) continue;
    const { projectId, status: _s, error: _e, ...asset } = media;
    // A pre-upgrade encode may have left a partial MP4. Never publish it as playable.
    if (asset.kind === "video" && asset.duration && asset.preparation?.stage !== "waveform") {
      asset.previewMode = "on-demand";
    }
    await ctx.track(backgroundIngest(ctx, projectId, asset), projectId);
  }
}

/** Resume unfinished preparations without holding up the caller. */
export function recoverIngestInBackground(ctx: Ctx, projectId?: string): void {
  void ctx.track(recoverIngest(ctx, projectId).catch(error => {
    if (!ctx.shutdown.aborted) ctx.log(`[ingest] preparing unfinished imports stopped part-way: ${errorMessage(error)}`);
  }));
}

/**
 * Take up a library's or a project's imports when it comes back: at launch, out of the Trash, unpaused or unarchived.
 * Unfinished preparations go on, and imports left ready without their transcription begin it, side by side: the
 * preparations run one at a time and each waits for its own transcription, so the imports already ready don't wait
 * behind them. One finishing during the sweep can't be transcribed twice, since a transcription is claimed only once.
 */
export function resumeImportsInBackground(ctx: Ctx, projectId?: string): void {
  void ctx.track(recoverIngest(ctx, projectId).catch(error => {
    if (!ctx.shutdown.aborted) ctx.log(`[ingest] preparing unfinished imports stopped part-way: ${errorMessage(error)}`);
  }));
  void ctx.track(recoverImportTranscriptions(ctx, projectId).catch(error => {
    if (!ctx.shutdown.aborted) ctx.log(`[ingest] starting transcriptions left unbegun stopped part-way: ${errorMessage(error)}`);
  }));
}

export type IngestSource =
  | { type: "upload"; path: string; hash: string }
  | { type: "path"; path: string; importId?: string }
  | { type: "url"; url: string; signal?: AbortSignal; importId?: string };

/** Google Drive share links → direct download; other URLs unchanged. */
export function normalizeImportUrl(url: string): string {
  const m = /drive\.google\.com\/file\/d\/([^/?#]+)/.exec(url) ?? /drive\.google\.com\/open\?id=([^&#]+)/.exec(url);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}&confirm=t`;
  return url;
}

function safeExt(name: string): string {
  const ext = extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext && ext.length <= 8 ? ext : ".bin";
}

function filenameFromResponse(cd: string | undefined, url: string): string {
  const m = cd && (/filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd));
  return m?.[1] ? decodeImportFilename(m[1]) : importLinkFilename(url)?.name ?? "download";
}

/** Hash incoming bytes as they are staged, without rereading an upload or download. */
export async function writeHashedFile(file: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  const hash = createHash("sha256");
  async function* chunks() {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }
  await writeFile(file, chunks(), { flag: "wx", signal });
  return hash.digest("hex");
}

// Share the balance across simultaneous URL imports on the same volume. A filesystem sample
// can still include blocks that an in-flight write is about to consume.
type DownloadSpace = { available: number; written: number; pending: number; users: number; refresh?: Promise<void> };
const downloadSpace = new Map<number, DownloadSpace>();

async function* downloadChunks(directory: string, response: Awaited<ReturnType<typeof downloadImport>>, env: NodeJS.ProcessEnv) {
  const maxBytes = configuredBytes(env.SCARLET_URL_IMPORT_MAX_BYTES, URL_IMPORT_BYTES);
  const reserve = configuredBytes(env.SCARLET_URL_IMPORT_RESERVE_BYTES, DOWNLOAD_RESERVE);
  const tooLarge = () => new HttpError(413, "download_too_large", `URL imports can be up to ${byteCount(maxBytes)}. For a larger recording, add a local file.`);
  const noSpace = () => new HttpError(507, "insufficient_space", `There is not enough free space for this import. Keep at least ${byteCount(reserve)} free on the library drive.`);
  const declared = Number(response.headers["content-length"]);
  if (declared > maxBytes) throw tooLarge();
  const { dev } = await stat(directory);
  const space: DownloadSpace = downloadSpace.get(dev) ?? { available: 0, written: 0, pending: 0, users: 0 };
  downloadSpace.set(dev, space);
  space.users++;
  const refresh = () => {
    if (!space.refresh) {
      const pending = space.pending;
      space.refresh = statfs(directory).then(disk => {
        space.available = disk.bavail * disk.bsize - pending;
        space.written = 0;
      }).finally(() => { space.refresh = undefined; });
    }
    return space.refresh;
  };
  try {
    await refresh();
    if (declared > space.available - reserve) throw noSpace();
    let received = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      const bytes = chunk.byteLength;
      received += bytes;
      if (received > maxBytes) throw tooLarge();
      if (space.refresh || space.written >= DOWNLOAD_DISK_CHECK || bytes > space.available - reserve) await refresh();
      if (bytes > space.available - reserve) throw noSpace();
      space.available -= bytes;
      space.written += bytes;
      space.pending += bytes;
      try { yield chunk; }
      finally { space.pending -= bytes; }
    }
  } finally {
    if (--space.users === 0) downloadSpace.delete(dev);
  }
}

// File-picker imports can publish several large recordings in quick succession.
const hashQueue = new WeakMap<Ctx, Promise<void>>();

export async function ingestMedia(
  ctx: Ctx,
  project: Pick<Project, "id">,
  source: IngestSource,
  opts: { name?: string; kind?: MediaKind; deferFormat?: boolean; by?: MediaAsset["provenance"]; source?: MediaAsset["source"]; uploadedBy?: string; transcription: Awaited<ReturnType<typeof importTranscriptionPolicy>>; checkAttempt?: () => void },
): Promise<MediaWithStatus> {
  const projectSignal = ctx.projectSignal(project.id);
  const clientSignal = source.type === "url" ? source.signal : undefined;
  const cancelled = () => new HttpError(408, "download_cancelled", "The URL import was cancelled.");
  if (clientSignal?.aborted) throw cancelled();
  const signal = clientSignal ? AbortSignal.any([projectSignal, clientSignal]) : projectSignal;
  signal.throwIfAborted();
  ctx.paths.ensureProject(project.id);
  const mediaId = newId("med");
  let name = opts.name ?? "media";
  const mediaDir = ctx.paths.media(project.id);
  let hash = source.type === "upload" ? source.hash : undefined;
  let onBytesRead: ((bytes: number) => void) | undefined;

  if (source.type === "url") {
    const url = normalizeImportUrl(source.url);
    const deadline = AbortSignal.timeout(URL_IMPORT_TIMEOUT_MS);
    const downloadSignal = AbortSignal.any([signal, deadline]);
    const timeout = () => new HttpError(408, "download_timed_out", "This URL import exceeded six hours. Download the recording locally and add the file.");
    const res = await downloadImport(new URL(url), downloadSignal).catch(error => {
      if (deadline.aborted) throw timeout();
      if (clientSignal?.aborted) throw cancelled();
      // A lookup, connection, certificate or timeout failure is about the address, not a fault in the engine.
      if (error instanceof HttpError || signal.aborted) throw error;
      throw badRequest("download_failed", `Couldn’t download that URL: ${errorMessage(error)}`);
    });
    const partial = join(mediaDir, `.${mediaId}.part`);
    try {
      if (!opts.name) name = filenameFromResponse(res.headers["content-disposition"], url);
      hash = await writeHashedFile(partial, downloadChunks(mediaDir, res, ctx.options.env ?? process.env), downloadSignal);
      downloadSignal.throwIfAborted();
      await rename(partial, join(mediaDir, mediaId + safeExt(name)));
    } catch (error) {
      if (deadline.aborted) throw timeout();
      if (clientSignal?.aborted) throw cancelled();
      throw error;
    } finally {
      res.destroy();
      await rm(partial, { force: true });
    }
  } else if (source.type === "path") {
    const info = await stat(source.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!info?.isFile()) throw badRequest("path_not_found", `no file at ${source.path}`);
    if (!opts.name) name = basename(source.path);
    const destination = join(mediaDir, mediaId + safeExt(name));
    // The project owns an independent file: a clone where the disk allows it, a throttled copy otherwise.
    await cloneOrSteadyCopy(source.path, destination, signal);
    const { importId } = source;
    if (importId && info.size > 0) {
      let lastReport = -Infinity;
      onBytesRead = (bytes) => {
        const time = performance.now();
        if (time - lastReport < 250 && bytes < info.size) return;
        lastReport = time;
        ctx.bus.publish({ type: "media.import.checking", projectId: project.id, importId, fraction: Math.min(1, bytes / info.size) });
      };
      onBytesRead(0);
    }
  }

  const ext = safeExt(name);
  const relPath = `${mediaId}${ext}`;
  const dest = join(mediaDir, relPath);
  if (source.type === "upload") await rename(source.path, dest);

  let asset: MediaAsset;
  try {
    signal.throwIfAborted();
    const probe = await ctx.render.probeMedia(dest, signal);
    const kind = opts.kind ?? probe.kind;
    // Native playable media is already in project-owned storage. Its identifier
    // isolates it from other assets until the background fingerprint is known.
    const deferHash = !hash && (kind === "video" || kind === "audio") && probe.duration > 0;
    if (!hash && !deferHash) hash = await ctx.render.hashFile(dest, onBytesRead, signal);
    signal.throwIfAborted();
    asset = {
      id: mediaId,
      importId: source.type === "upload" ? undefined : source.importId,
      kind,
      name,
      path: relPath,
      hash,
      preparation: deferHash ? { stage: "fingerprint", fraction: 0 } : undefined,
      previewClock: probe.previewClock,
      originalPlaybackType: probe.originalPlaybackType,
      previewMode: (opts.kind ?? probe.kind) === "video" && probe.duration > 0 ? "on-demand" : undefined,
      duration: probe.duration,
      fps: probe.fps,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      hasAlpha: probe.hasAlpha,
      provenance: opts.by,
      source: opts.source,
      uploadedBy: opts.uploadedBy,
      ...(opts.transcription.provider && !opts.transcription.signal.aborted && {
        transcriptionOnImport: opts.transcription.provider,
        transcriptionRevisionOnImport: opts.transcription.revision,
      }),
    };
  } catch (e) {
    await rm(dest, { force: true });
    ctx.shutdown.throwIfAborted();
    if (clientSignal?.aborted) throw cancelled();
    // An import stopped, by its project going to the trash, says so rather than blaming the file.
    signal.throwIfAborted();
    throw badRequest("probe_failed", `ffprobe could not read the file: ${errorMessage(e)}`);
  }
  let stored: MediaWithStatus;
  try {
    stored = ctx.db.transaction(() => {
      opts.checkAttempt?.();
      if (clientSignal?.aborted) throw cancelled();
      // Another instance may have trashed the project while the original was being copied.
      const current = ctx.repos.projects.header(project.id);
      if (!current) throw notFound(`project ${project.id}`);
      const saved = asset.importId && ctx.repos.projects.importedMedia(project.id, asset.importId);
      if (saved) return saved;
      const format = !opts.deferFormat && videoFormat(asset);
      // Reading a new timeline can initialize its empty head before the first video has finished importing.
      const match = format && !ctx.repos.projects.formatSet(project.id) && hasInitialTimeline(current) &&
        JSON.stringify(current.settings) === JSON.stringify(ProjectSettings.parse({}));
      const media = ctx.repos.projects.putMedia(project.id, asset, "ingesting");
      if (match) {
        const updated = ctx.repos.projects.update(project.id, { settings: format });
        ctx.bus.publish({ type: "project.updated", projectId: project.id, project: updated });
      }
      return media;
    }, "immediate")();
  } catch (error) {
    await rm(dest, { force: true });
    throw error;
  }
  if (stored.id !== asset.id) {
    // A second engine finished the same import during this copy.
    await rm(dest, { force: true });
    return stored;
  }
  ctx.bus.publish({ type: "media.updated", projectId: project.id, media: stored });
  void ctx.track(backgroundIngest(ctx, project.id, asset).catch(error => {
    // It keeps this engine's claim, so it is picked up again when Scarlet next starts.
    if (!ctx.shutdown.aborted) ctx.log(`[ingest] ${asset.id} stopped part-way and stays unfinished until Scarlet restarts: ${errorMessage(error)}`);
  }), project.id);
  return stored;
}

/** An import's proxy and transcript are nobody's to wait for until a pass reads the recording (editorFirst.ts). */
function backgroundIngest(ctx: Ctx, projectId: string, asset: MediaAsset) {
  return editorFirst.run(() => !audioLane(ctx).focusedOn(asset.id), () => ingestInBackground(ctx, projectId, asset));
}

async function ingestInBackground(ctx: Ctx, projectId: string, asset: MediaAsset) {
  const signal = ctx.mediaSignal(projectId);
  const src = join(ctx.paths.media(projectId), asset.path);
  const proxy = join(ctx.paths.proxies(projectId), `${asset.id}.mp4`);
  let preparation = asset.preparation;
  const publish = ctx.db.transaction((status: MediaWithStatus["status"], preparation?: MediaAsset["preparation"], error?: string) => {
    // A manual transcription can finish while the proxy is being built, and the recording's voice roles can be saved.
    const current = ctx.repos.projects.getMedia(asset.id);
    const media = ctx.repos.projects.putMedia(projectId, { ...asset, transcriptId: current?.transcriptId,
      lastTranscription: current?.lastTranscription, voiceRoles: current?.voiceRoles, preparation }, status, error);
    ctx.bus.publish({ type: "media.updated", projectId, media });
    return media;
  }, "immediate");
  function reportStage(stage: NonNullable<MediaAsset["preparation"]>["stage"]) {
    const started = performance.now();
    let lastReport = -Infinity;
    let lastFraction = -1;
    return (value: number) => {
      const time = performance.now();
      const fraction = Math.min(1, Math.max(0, value));
      if (!Number.isFinite(fraction) || fraction <= lastFraction || (time - lastReport < 1000 && fraction < 1)) return;
      lastReport = time;
      lastFraction = fraction;
      const elapsed = (time - started) / 1000;
      const remainingSeconds = elapsed >= 2 && fraction > 0 && fraction < 1
        ? Math.ceil(elapsed * (1 - fraction) / fraction)
        : undefined;
      preparation = { stage, fraction, remainingSeconds };
      const shown = preparation;
      quietProgress(ctx, `import progress (${asset.id})`, () => publish("ingesting", shown));
    };
  }
  try {
    signal.throwIfAborted();
    if (preparation?.stage === "fingerprint" && !asset.hash) {
      // A pause ends the wait for its turn at once, and the next file still waits for the one ahead.
      const previous = hashQueue.get(ctx);
      const job = (async () => {
        if (previous) await new Promise<void>((resolve, reject) => {
          const stop = () => reject(signal.reason);
          signal.addEventListener("abort", stop, { once: true });
          previous.then(resolve).finally(() => signal.removeEventListener("abort", stop));
        });
        signal.throwIfAborted();
        const { size, mtimeMs, ctimeMs } = await stat(src);
        const report = reportStage("fingerprint");
        asset.hash = await ctx.render.hashFile(src, bytes => report(size ? bytes / size : 1), signal);
        const latest = await stat(src);
        if (!sameStamp(latest, { size, mtimeMs, ctimeMs })) throw new Error("Source changed while fingerprinting. Reimport the recording.");
        asset.fingerprintStamp = { size, mtimeMs, ctimeMs };
      })();
      hashQueue.set(ctx, Promise.all([previous, job.catch(() => {})]).then(() => {}));
      await job;
    }
    if (asset.kind === "video" && !asset.previewMode && !(preparation?.stage === "waveform" && existsSync(proxy))) {
      const height = Math.min(ctx.settings().render.previewHeight, asset.height ?? 720);
      const onProgress = reportStage("preview");
      onProgress(0);
      await ctx.render.makeProxy(src, proxy, { height, onProgress, signal,
        onFallback: stage => ctx.log(`[media] proxy_fallback media=${logId(asset.id)} project=${logId(projectId)} height=${height} stage=${stage}`),
      });
    }
    signal.throwIfAborted();
    asset = publish("ready");
    if (asset.kind === "video") prepareSourceProxies(ctx, [asset.id]);
    logActivity(ctx, { projectId, actor: { type: "scarlet", name: "Scarlet" }, type: "media.added", summary: `${quote(asset.name)} was added${asset.duration ? ` (${Math.round(asset.duration)} s)` : ""}`, data: { mediaId: asset.id } });
    if (asset.transcriptId) return;
  } catch (e) {
    if (signal.aborted) {
      ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = ? AND status = 'ingesting' AND ingest_pid = ?").run(asset.id, process.pid);
      return;
    }
    const message = errorMessage(e);
    ctx.log(`[ingest] ${asset.id} failed: ${message}`);
    publish("failed", preparation, message);
    logActivity(ctx, { projectId, actor: { type: "scarlet", name: "Scarlet" }, type: "media.failed", summary: `${quote(asset.name)} couldn’t be read: ${message.slice(0, 160)}`, data: { mediaId: asset.id } });
    return;
  }
  if (!asset.hasAudio) return;
  const job = await startImportTranscription(ctx, projectId, asset);
  await job?.done.catch(() => null);
}

/**
 * Take a file Scarlet couldn't read out of its project: its row and transcript, its original, and what preparing,
 * previewing or transcribing it left on disk. A request can read such a file too (a dialogue scan takes a file of any
 * status and starts its transcript), so the file stays while one is at work, as it does once a version names it.
 * Each reason to refuse is checked before anything is stopped and again as the row goes, since a clip can be placed,
 * a request started or the same removal sent twice while this waits. A transcription of the file stops first.
 */
export async function removeUnreadableMedia(ctx: Ctx, projectId: string, id: string, by: User) {
  const removable = () => {
    const media = ctx.repos.projects.getMedia(id);
    if (!media || media.projectId !== projectId) throw notFound(`media ${id}`);
    if (media.status !== "failed") throw conflict("media_readable", `Scarlet read ${media.name}, and can only remove a file it couldn’t read.`);
    // A clip placed while the file was still being added plays only with the file, in every version that has it.
    if (ctx.repos.versions.usesMedia(projectId, id)) throw conflict("media_in_use", `${media.name} is in the video or its history, so it can’t be removed.`);
    // Which files a request will read can't be known, and another engine process may be running it: the saved state decides.
    if (ctx.repos.tasks.count("project_id = ? AND kind <> 'transcribe' AND state IN ('claimed', 'running', 'waiting_for_user')", [projectId])) {
      throw conflict("media_busy", `Scarlet is working on a request, so ${media.name} can’t be removed until it’s done.`);
    }
    return media;
  };
  const media = removable();
  for (const task of ctx.repos.tasks.runningTranscriptions(projectId, id)) {
    ctx.db.transaction(() => cancelTask(ctx, task), "immediate")();
    await ctx.transcriptions.get(task.id)?.done.catch(() => null);
  }
  const original = fileInDirectory(ctx.paths.media(projectId), media.path);
  const waveform = waveformBase(ctx, projectId, id);
  // Its previews, aligner emissions and speaker turns are named for the file as it is on disk, so they are found
  // before the file goes. This includes stores kept under an older spelling of the source path.
  const named = (await Promise.all([sourcePreviews.filesOf(ctx, media), savedSpeakerTurns(ctx, projectId, media),
    original && emissionStorePaths(ctx, projectId, original, join(ctx.paths.media(projectId), media.path)).catch(() => [])])).flat();
  ctx.db.transaction(() => {
    removable();
    ctx.db.prepare("DELETE FROM transcripts WHERE media_id = ?").run(id);
    ctx.repos.projects.removeMedia(id);
    ctx.bus.publish({ type: "media.removed", projectId, mediaId: id });
    logActivity(ctx, { projectId, actor: actorFor(by), type: "media.removed", summary: `${by.name} removed ${quote(media.name)}, which couldn't be read`, data: { mediaId: id } });
  }, "immediate")();
  ctx.log(`[media] ${id} removed from ${projectId}: "${media.name.slice(0, 80)}"`);
  // The file is out of the project either way. An original that can't be deleted now goes with the next sweep of leftovers.
  await Promise.all([original, waveform + ".waveform", waveform + ".json", ...olderWaveforms(ctx, projectId, id), ...named]
    .map(path => path && rm(path, { recursive: true, force: true }).catch(error => ctx.log(`[media] ${id} left ${path} behind: ${errorMessage(error)}`))));
}
