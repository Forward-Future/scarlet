import { createHash } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { copyFile, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { downloadImport } from "./importUrl.js";
import { hasInitialTimeline, newId, ProjectSettings, videoFormat, type MediaAsset, type MediaKind, type Project, type Transcript, type TranscriptSegment } from "@scarlet/timeline";
import { engineIsAlive, type Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { humanDuration } from "../logText.js";
import type { MediaWithStatus } from "../repo/projects.js";
import type { Task, User } from "@scarlet/shared";
import { cancelTask, createTask, hasTranscript, saveTask } from "./tasks.js";
import { recordTaskFinished } from "../telemetry/events.js";
import { availableTranscriptionProvider, getTranscriptionProvider, effectiveProviderName, type importTranscriptionPolicy, type TranscriptionProvider } from "../transcribe/index.js";
import { claimTranscriptionWork, openTranscriptionWork, transcriptionIdentity, type TranscriptionResume } from "./transcriptionWork.js";
import { alignsLanguage, alignTranscript, type AlignmentCheckpoint } from "../transcribe/wordAlign.js";
import { fillTranscriptHoles } from "../transcribe/transcriptHoles.js";
import { extractWav } from "../render/ffmpeg.js";
import { audioLane, whisperLane, type AudioWork } from "./audioWork.js";
import { decodeWaveformCache, encodeWaveformCache, fileInDirectory, MAX_WAVEFORM_CACHE_BYTES, MAX_WAVEFORM_POINTS, WAVEFORM_CACHE_VERSION } from "@scarlet/render";
import type { WaveformCache } from "../render/adapter.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { matchesSpeakerStream, savedSpeakerTurns } from "./recordingSpeakers.js";
import { emissionStore, emissionStorePaths } from "./recordingAudio.js";
import { prepareSourceProxies, sourcePreviews } from "./sourcePreviews.js";

export const WAVEFORM_POINTS_PER_SECOND = 50;
const runFile = promisify(execFile);
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
    await backgroundIngest(ctx, projectId, asset);
  }
}

/** The same in the background. Nothing awaits it, so a failure is logged here. */
export function recoverIngestInBackground(ctx: Ctx, projectId?: string): void {
  void ctx.track(recoverIngest(ctx, projectId).catch(error => {
    if (!ctx.shutdown.aborted) ctx.log(`[ingest] preparing unfinished imports stopped part-way: ${(error as Error).message}`);
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
  if (m?.[1]) {
    // A plain name can hold a "%" that isn't an escape: "100% done.mp4".
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  const path = new URL(url).pathname.split("/").pop();
  return path && path.includes(".") ? path : "download";
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
  opts: { name?: string; kind?: MediaKind; deferFormat?: boolean; by?: MediaAsset["provenance"]; uploadedBy?: string; transcription: Awaited<ReturnType<typeof importTranscriptionPolicy>>; checkAttempt?: () => void },
): Promise<MediaWithStatus> {
  const signal = ctx.projectSignal(project.id);
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
    const downloadSignal = AbortSignal.any(source.signal ? [signal, source.signal, deadline] : [signal, deadline]);
    const timeout = () => new HttpError(408, "download_timed_out", "This URL import exceeded six hours. Download the recording locally and add the file.");
    const cancelled = () => new HttpError(408, "download_cancelled", "The URL import was cancelled.");
    const res = await downloadImport(new URL(url), downloadSignal).catch(error => {
      if (deadline.aborted) throw timeout();
      if (source.signal?.aborted) throw cancelled();
      // A lookup, connection, certificate or timeout failure is about the address, not a fault in the engine.
      if (error instanceof HttpError || signal.aborted) throw error;
      throw badRequest("download_failed", `Couldn’t download that URL: ${(error as Error).message}`);
    });
    const partial = join(mediaDir, `.${mediaId}.part`);
    try {
      if (!opts.name) name = filenameFromResponse(res.headers["content-disposition"], url);
      hash = await writeHashedFile(partial, downloadChunks(mediaDir, res, ctx.options.env ?? process.env), downloadSignal);
      downloadSignal.throwIfAborted();
      await rename(partial, join(mediaDir, mediaId + safeExt(name)));
    } catch (error) {
      if (deadline.aborted) throw timeout();
      if (source.signal?.aborted) throw cancelled();
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
    try {
      if (process.platform === "darwin" && info.size >= 16 * 1024 * 1024) {
        // macOS cp uses clonefile on APFS and copies normally across volumes. The project owns an independent file.
        await runFile("/bin/cp", ["-c", await realpath(source.path), destination], { signal });
      } else {
        await copyFile(source.path, destination, constants.COPYFILE_FICLONE);
      }
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
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
      uploadedBy: opts.uploadedBy,
      ...(opts.transcription.provider && !opts.transcription.signal.aborted && {
        transcriptionOnImport: opts.transcription.provider,
        transcriptionRevisionOnImport: opts.transcription.revision,
      }),
    };
  } catch (e) {
    await rm(dest, { force: true });
    throw badRequest("probe_failed", `ffprobe could not read the file: ${(e as Error).message}`);
  }
  let stored: MediaWithStatus;
  try {
    stored = ctx.db.transaction(() => {
      opts.checkAttempt?.();
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
    if (!ctx.shutdown.aborted) ctx.log(`[ingest] ${asset.id} stopped part-way and stays unfinished until Scarlet restarts: ${(error as Error).message}`);
  }));
  return stored;
}

async function backgroundIngest(ctx: Ctx, projectId: string, asset: MediaAsset) {
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
      publish("ingesting", preparation);
    };
  }
  try {
    signal.throwIfAborted();
    if (preparation?.stage === "fingerprint" && !asset.hash) {
      const previous = hashQueue.get(ctx);
      const job = (async () => {
        await previous;
        signal.throwIfAborted();
        const { size, mtimeMs, ctimeMs } = await stat(src);
        const report = reportStage("fingerprint");
        asset.hash = await ctx.render.hashFile(src, bytes => report(size ? bytes / size : 1), signal);
        const latest = await stat(src);
        if (latest.size !== size || latest.mtimeMs !== mtimeMs || latest.ctimeMs !== ctimeMs) throw new Error("Source changed while fingerprinting. Reimport the recording.");
        asset.fingerprintStamp = {size,mtimeMs,ctimeMs};
      })();
      hashQueue.set(ctx, job.catch(() => {}));
      await job;
    }
    if (asset.kind === "video" && !asset.previewMode && !(preparation?.stage === "waveform" && existsSync(proxy))) {
      const height = Math.min(ctx.settings().render.previewHeight, asset.height ?? 720);
      const onProgress = reportStage("preview");
      onProgress(0);
      await ctx.render.makeProxy(src, proxy, { height, onProgress, signal });
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
    ctx.log(`[ingest] ${asset.id} failed: ${(e as Error).message}`);
    publish("failed", preparation, (e as Error).message);
    logActivity(ctx, { projectId, actor: { type: "scarlet", name: "Scarlet" }, type: "media.failed", summary: `${quote(asset.name)} couldn’t be read: ${(e as Error).message.slice(0, 160)}`, data: { mediaId: asset.id } });
    return;
  }
  if (!asset.transcriptionOnImport || !asset.hasAudio || asset.kind === "image" || !ctx.repos.projects.header(projectId)) return;
  const policy = ctx.repos.settings.transcriptionPolicy();
  if (asset.transcriptionOnImport !== policy.settings.provider || asset.transcriptionRevisionOnImport !== policy.revision) return;
  const provider = await availableTranscriptionProvider(ctx, policy);
  if (!provider || policy.signal.aborted) return;
  // runTranscription logs the outcome.
  await startWithProvider(ctx, projectId, asset, provider, provider.name, undefined, "interrupt", "missing").done.catch(() => undefined);
}

/**
 * Whether a pause of the project's media work holds its transcriptions, and the speaker labels of its transcripts. It
 * doesn't while Scarlet is working on a request there: the editor asked for that request, a pass can't plan or cut
 * without its transcripts, and pausing the caching isn't stopping it. With no request under way the pause stops a
 * transcription, also as it starts, and resume starts it again. Only a request that edits the project counts: a
 * skill's edit only borrows the project, and the read of a request for a standing rule uses no transcript.
 */
export function transcriptionHeld(ctx: Ctx, projectId: string): boolean {
  return !!ctx.repos.projects.header(projectId)?.mediaPaused &&
    !ctx.repos.tasks.count("project_id = ? AND kind IN ('edit','revise','note') AND state IN ('claimed','running')", [projectId]);
}

/** Stop the transcriptions a pause of the project holds. Each reads as interrupted, and starts again on resume. */
export function holdTranscriptions(ctx: Ctx, projectId: string): void {
  if (!transcriptionHeld(ctx, projectId)) return;
  for (const task of ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND state = 'running'", [projectId])) {
    ctx.transcriptions.get(task.id)?.controller.abort(new Error("Project media processing stopped."));
  }
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
  for (const task of ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND state = 'running' AND json_extract(json, '$.context.mediaId') = ?", [projectId, id])) {
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
    .map(path => path && rm(path, { recursive: true, force: true }).catch(error => ctx.log(`[media] ${id} left ${path} behind: ${(error as Error).message}`))));
}

/** Run transcription for an asset (as a server-side `transcribe` task), store the transcript, link it on the asset. */
export function transcribeMedia(ctx: Ctx, projectId: string, asset: MediaAsset, providerOverride?: string): Promise<Transcript | null> {
  return startTranscription(ctx, projectId, asset, providerOverride).done;
}

/** Same as transcribeMedia but hands back the task row synchronously (for the HTTP route). */
export function startTranscription(
  ctx: Ctx,
  projectId: string,
  asset: MediaAsset,
  providerOverride?: string,
  whilePaused: "interrupt" | "refuse" = "interrupt",
  resume?: TranscriptionResume | "missing",
): { task: Task; done: Promise<Transcript | null> } {
  const policy = ctx.repos.settings.transcriptionPolicy();
  const name = effectiveProviderName(policy.settings.provider, providerOverride);
  return startWithProvider(ctx, projectId, asset, getTranscriptionProvider(ctx, providerOverride, policy), name, providerOverride, whilePaused, resume);
}

/**
 * The first-cut dialogue scan keeps its own window transcripts. Start the editor's transcript of the same
 * source alongside it, so Media and the transcript pane don't wait for a separate Transcribe click.
 */
export function transcribeForDialogue(ctx: Ctx, projectId: string, media: MediaAsset): Task | null {
  if (media.kind === "image" || media.hasAudio === false || transcriptionHeld(ctx, projectId)) return null;
  if (hasTranscript(ctx, media.id)) return null;
  const provider = getTranscriptionProvider(ctx);
  if (!provider) return null;
  const { task, done } = startWithProvider(ctx, projectId, media, provider, provider.name, undefined, "interrupt", "missing");
  ctx.track(done.catch(() => null));
  return task.state === "failed" ? null : task;
}

/** `chosen`: a provider the editor picked for this run, kept on the task so an interrupted run starts again with it. */
function startWithProvider(ctx: Ctx, projectId: string, asset: MediaAsset, provider: TranscriptionProvider | null, name: string, chosen?: string, whilePaused: "interrupt" | "refuse" = "interrupt", resume?: TranscriptionResume | "missing") {
  const { task, started } = ctx.db.transaction(() => {
    const project = ctx.repos.projects.header(projectId);
    if (!project) throw notFound(`project ${projectId}`);
    if (whilePaused === "refuse" && project.mediaPaused) throw conflict("media_paused", "Resume caching to transcribe this recording.");
    const [active] = ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND state = 'running' AND json_extract(json, '$.context.mediaId') = ?", [projectId, asset.id]);
    if (active) return { task: active, started: false };
    let inherit = resume === "missing" ? undefined : resume;
    if (resume === "missing" || inherit?.interrupted) {
      // Another engine may have recovered and even finished this job since the recovery sweep listed it.
      const [latest] = ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?",
        [projectId, asset.id], "created_at DESC, rowid DESC LIMIT 1");
      if (inherit?.interrupted && latest && latest.id !== inherit.interrupted.id) return { task: latest, started: false };
      if (resume === "missing" && latest?.state === "done" && hasTranscript(ctx, asset.id)) return { task: latest, started: false };
      // A resumed pass can ask for its missing transcript while caching is paused, before the recovery sweep runs.
      // Its preparation is the same interrupted job, including when a pause stops it again before its first chunk.
      if (resume === "missing" && latest?.state === "failed" && latest.interrupted) {
        chosen = latest.context.transcriptionProvider;
        if (chosen && chosen !== name) {
          const policy = ctx.repos.settings.transcriptionPolicy();
          name = effectiveProviderName(policy.settings.provider, chosen);
          provider = getTranscriptionProvider(ctx, chosen, policy);
        }
        const ranWith = latest.context.transcribedWith;
        if (!provider || (name !== "whispercpp" && ranWith && name !== ranWith)) {
          return { task: latest, started: false };
        }
        inherit = { interrupted: latest };
      }
    }
    const task = createTask(ctx, {
      projectId, kind: "transcribe", agent: "api", instruction: `Transcribe ${asset.name}`,
      context: { mediaId: asset.id, transcribedWith: name, localModel: provider?.localModel, ...(chosen && { transcriptionProvider: chosen }) }, createdBy: { type: "scarlet", name: "Scarlet" }, state: "running",
    });
    ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = ? WHERE id = ?").run(process.pid, now(), task.id);
    claimTranscriptionWork(ctx, asset.id, task, inherit);
    return { task, started: true };
  }, "immediate")();
  if (!started) return { task, done: ctx.transcriptions.get(task.id)?.done ?? Promise.resolve(null) };
  if (!provider) {
    const failed = saveTask(ctx, {
      ...task,
      state: "failed",
      error: `transcription provider "${name}" is not configured`,
      finishedAt: now(),
    });
    recordTaskFinished(ctx, failed);
    ctx.log(`[transcribe] ${asset.id} failed: ${failed.error}`);
    return { task: failed, done: Promise.resolve(null) };
  }
  const controller = new AbortController();
  const done = runTranscription(ctx, projectId, asset, provider, task, controller).finally(() => ctx.transcriptions.delete(task.id));
  ctx.transcriptions.set(task.id, { controller, done });
  return { task, done };
}

/**
 * One progress figure for a transcription and its word alignment, saved on the task so Media and a run
 * waiting for the transcript can show it. Ten minutes of dialogue took about 25 s in local Whisper and
 * 50 s in word alignment on a Core Ultra 9, so Whisper is the first third. A cloud provider only uploads.
 * `words` is the same figure for the words alone, which is all a dialogue pass waits for.
 */
function transcriptionProgress(ctx: Ctx, task: Task, provider: TranscriptionProvider["name"]) {
  type Stage = NonNullable<Task["progress"]>["stage"];
  const share = provider === "whispercpp" ? 1 / 3 : 1 / 2;
  let started: { at: number; fraction: number; words: number } | undefined;
  let saved: { stage: Stage; percent: number; at: number } | undefined;
  function save(stage: Stage, fraction: number, words: number) {
    const at = performance.now();
    if (stage !== "queued") started ??= { at, fraction, words };
    const percent = Math.floor(fraction * 100);
    // A new stage saves at once. Within one, a whole percent more at most once a second, or a jump of five.
    if (saved?.stage === stage && (percent <= saved.percent || (at - saved.at < 1000 && percent < saved.percent + 5))) return;
    saved = { stage, percent, at };
    const elapsed = started === undefined ? 0 : (at - started.at) / 1000;
    const left = (done: number, initial = 0) => elapsed >= 5 && done - initial >= 0.02 && done < 1
      ? Math.ceil(elapsed * (1 - done) / (done - initial)) : undefined;
    ctx.db.transaction(() => {
      const current = ctx.repos.tasks.get(task.id);
      if (current?.state === "running") saveTask(ctx, { ...current, progress: { stage, fraction: Math.min(1, fraction), remainingSeconds: left(fraction, started?.fraction),
        words: { fraction: Math.min(1, words), remainingSeconds: left(words, started?.words) } } });
    }, "immediate")();
  }
  return {
    queued: () => save("queued", 0, 0),
    transcribing: (fraction: number) => save("transcribing", fraction * share, fraction),
    aligning: (fraction: number) => save("aligning", share + fraction * (1 - share), 1),
  };
}

async function runTranscription(ctx: Ctx, projectId: string, asset: MediaAsset, provider: TranscriptionProvider, task: Task, controller: AbortController): Promise<Transcript | null> {
  // Trash and a quit stop it. So does `controller`: its task was cancelled, or a pause holds the project's transcriptions.
  const interrupted = AbortSignal.any([ctx.projectSignal(projectId), controller.signal]);
  // A local model can be changed while its audio is queued or while the old model's first words are being aligned.
  const signal = AbortSignal.any([interrupted, ctx.repos.settings.transcriptionSignal]);
  if (transcriptionHeld(ctx, projectId)) controller.abort(new Error("Project media processing stopped."));
  const wav = provider.name === "whispercpp" && matchesSpeakerStream(asset)
    ? join(ctx.paths.tmp, newId("recording") + ".wav") : undefined;
  let labeling: Promise<void> | undefined;
  /** The transcript was saved with its alignment still to come. */
  let early = false;
  const started = Date.now();
  const audio = asset.duration ? ` (${humanDuration(asset.duration * 1000)} of audio)` : "";
  ctx.log(`[transcribe] ${asset.id} started with ${provider.localModel ?? provider.name}${audio} for ${task.id}`);
  try {
    const src = join(ctx.paths.media(projectId), asset.path);
    const stamp = statSync(src, { throwIfNoEntry: false });
    const checkRunning = () => {
      ctx.settings(); // Another engine may have changed the selected model or cancelled this job.
      if (ctx.repos.tasks.get(task.id)?.state !== "running") controller.abort();
      signal.throwIfAborted();
    };
    const identity = await transcriptionIdentity(ctx, asset, stamp, provider);
    const saved = ctx.db.transaction(() => {
      checkRunning();
      return openTranscriptionWork(ctx, task, identity, checkRunning);
    }, "immediate")();
    early = !!saved.alignment;
    const work: AudioWork = { mediaId: asset.id, kind: "transcript" };
    const progress = transcriptionProgress(ctx, task, provider.name);
    ctx.speakers.begin(ctx, projectId, asset);
    const recognized = saved.fraction ?? (asset.duration ? Math.min(1, saved.recognition.through / asset.duration) : 0);
    const transcribe = () => {
      progress.transcribing(recognized);
      return provider.transcribe({ path: src, duration: asset.duration, tmpDir: ctx.paths.tmp, signal, keepWavAt: wav,
        checkpoint: saved.recognition, onProgress: progress.transcribing, beforeUpload: checkRunning,
      });
    };
    // Local Whisper takes its turn in the audio lane. A cloud provider only uploads, so it runs right away.
    if (saved.alignment) progress.aligning(saved.alignment.fraction ?? 0);
    else if (recognized > 0) progress.transcribing(recognized);
    else if (provider.name === "whispercpp") progress.queued();
    // Word alignment follows. In the same lane, the lane waits for it rather than starting another recording.
    const lane = whisperLane(ctx, provider.gpu);
    const result = saved.aligned ?? (provider.name === "whispercpp" ? await lane.run(work, signal, transcribe, { more: lane === audioLane(ctx) }) : await transcribe());
    // A rerun keeps the readable transcript, including a speaker-labelled revision or an older unlinked one,
    // until the replacement is complete. A first transcript can publish its words while alignment runs.
    const previous = ctx.db.prepare(`SELECT t.id, json_extract(t.json, '$.aligning') IS NULL AS complete
      FROM media m JOIN transcripts t ON t.media_id = m.id AND t.project_id = m.project_id
      WHERE m.id = ? AND m.project_id = ? AND t.id = COALESCE(json_extract(m.json, '$.transcriptId'), t.id)
      ORDER BY t.created_at DESC LIMIT 1`).get(asset.id, projectId) as { id: string; complete: number } | undefined;
    const replacing = previous?.complete === 1;
    const id = replacing ? newId("trs") : previous?.id ?? newId("trs");
    const model = provider.localModel === "custom" ? result.modelLabel ?? provider.modelLabel : provider.modelLabel;
    /** Save the transcript and link it on the recording. `aligning`: how far its word times are final. Absent, the job is done. */
    const save = (segments: TranscriptSegment[], aligning?: AlignmentCheckpoint) => ctx.db.transaction(() => {
      ctx.settings(); // Observe a model change saved by another engine before committing this revision.
      signal.throwIfAborted();
      if (ctx.repos.tasks.get(task.id)?.state !== "running") return null;
      if (aligning) {
        saved.saveAlignment(aligning, { segments, language: result.language, modelLabel: model }, replacing ? undefined : id);
        if (replacing) return null; // The previous completed transcript remains the readable one.
      }
      const savedAt = now();
      const transcript: Transcript = { id, mediaId: asset.id, language: result.language, provider: provider.name, localModel: provider.localModel, modelLabel: model, segments,
        createdAt: savedAt, ...(aligning && { aligning: { through: aligning.through } }) };
      ctx.repos.transcripts.put({ ...transcript, projectId });
      const current = ctx.repos.projects.getMedia(asset.id);
      let speakerSource: MediaAsset | undefined;
      if (current) {
        speakerSource = current;
        // Each turn of alignment rewrites the same transcript. Tell open pages when it appears and when it is final.
        if (current.transcriptId !== id || !aligning) {
          const { status, error, projectId: _p, ...a } = current;
          speakerSource = ctx.repos.projects.putMedia(projectId, { ...a, transcriptId: id,
            ...(!aligning && { lastTranscription: { completedAt: savedAt, model } }) }, status, error);
          ctx.bus.publish({ type: "media.updated", projectId, media: speakerSource });
        }
      }
      if (!aligning) recordTaskFinished(ctx, saveTask(ctx, { ...task, state: "done", summary: `${segments.length} segments`, finishedAt: savedAt }));
      return { transcript, speakerSource };
    }, "immediate")();
    // ASR word times drift by 100–300 ms, and alignment places each word on the recorded audio. On a long recording
    // that takes several times as long as Whisper, so the words are saved first: a dialogue pass reads them and its
    // scan pages run while alignment goes on. `aligning.through` says how far the times are final, and whatever
    // turns a word into a cut edge waits for alignment to pass it.
    const alignable = alignsLanguage(result.language) && result.segments.some(s => s.words.length);
    if (alignable && !saved.alignment) early = !!save(result.segments, { through: 0, nextWord: 0, fraction: 0 });
    progress.aligning(saved.alignment?.fraction ?? 0);
    // The old process's scratch WAV is gone. Recreate the shared decode before alignment or the gap check reads it.
    if (saved.aligned && wav) await extractWav(src, wav, { signal });
    // While a pass is reading this recording, its alignment lets the speakers a pass waits for finish first
    // (RecordingSpeakers.awaitedByPass). Nothing a pass reads needs word times before its first page.
    // A pass reading any recording of the project counts: it turns to this one next, and its first page here waits
    // for these speakers just the same.
    const passReading = () => ctx.repos.projects.listMedia(projectId).some(m => audioLane(ctx).focusedOn(m.id));
    const speakersFirst = () => ctx.speakers.beside && passReading() ? ctx.speakers.awaitedByPass(projectId) : undefined;
    // Local Whisper can skip a remark after a long wait. Once the words are placed, the recording shows where: sound at
    // speaking level with no word on it. Those stretches are read again, and the transcript is saved with what they held.
    // A read that fails leaves the transcript as it was aligned.
    const withoutHoles = async (segments: TranscriptSegment[]) => {
      if (!alignable || provider.name !== "whispercpp") return segments;
      const full = wav ?? join(ctx.paths.tmp, newId("recording") + ".wav");
      try {
        if (!wav) await extractWav(src, full, { signal });
        return await fillTranscriptHoles({ wav: full, segments, tmpDir: ctx.paths.tmp, signal, log: message => ctx.log(`${message} (${asset.id})`),
          read: async laid => (await lane.run(work, signal, () => provider.transcribe({ path: laid, dialogueWindow: {}, tmpDir: ctx.paths.tmp, signal, language: result.language }))).segments,
          align: async found => alignTranscript(ctx, { source: src, wav: full, language: result.language, segments: found, signal,
            emissions: await emissionStore(ctx, projectId, src), work: { mediaId: asset.id, kind: "alignment" } }) });
      } catch (error) {
        signal.throwIfAborted();
        ctx.log(`[transcribe] ${asset.id}: couldn’t read the stretches without words again: ${(error as Error).message}`);
        return segments;
      } finally { if (!wav) await rm(full, { force: true }); }
    };
    let publishedThrough = saved.alignment?.through ?? 0;
    const finishedAlignment = saved.alignment?.complete;
    const aligned = finishedAlignment ? result.segments : await alignTranscript(ctx, { source: src, wav, language: result.language, segments: result.segments, signal, resume: saved.alignment,
      emissions: alignable ? await emissionStore(ctx, projectId, src) : undefined, hold: speakersFirst,
      work: { mediaId: asset.id, kind: "alignment" }, onProgress: progress.aligning,
      onTurn: (soFar, through, cursor) => {
        publishedThrough = through;
        save(soFar, cursor);
      } });
    // A gap reread may still insert words. Keep the public boundary where readers last saw it while saving
    // the finished alignment so a quit during the reread only repeats that final check.
    if (alignable && provider.name === "whispercpp" && !finishedAlignment) {
      save(aligned, { through: publishedThrough, fraction: 1, complete: true });
    }
    const stored = save(await withoutHoles(aligned));
    // The run was cancelled while it aligned, so nobody will finish: the saved transcript keeps the times it has.
    if (!stored && early) keepTimes(ctx, asset.id, task.id);
    if (stored?.speakerSource) {
      const decoded = wav && stamp && asset.path === stored.speakerSource.path
        ? { wav, size: stamp.size, mtimeMs: stamp.mtimeMs, ctimeMs: stamp.ctimeMs } : undefined;
      labeling = ctx.speakers.ensure(ctx, projectId, stored.speakerSource, stored.transcript, decoded, transcriptionHeld(ctx, projectId));
    }
    ctx.log(stored
      ? `[transcribe] ${asset.id} done in ${humanDuration(Date.now() - started)}: ${stored.transcript.segments.length} segments`
      : `[transcribe] ${asset.id} finished in ${humanDuration(Date.now() - started)} but was discarded: ${task.id} was no longer running`);
    return stored?.transcript ?? null;
  } catch (e) {
    ctx.log(`[transcribe] ${asset.id} ${interrupted.aborted ? "interrupted" : "failed"} after ${humanDuration(Date.now() - started)}: ${(e as Error).message}`);
    const running = ctx.repos.tasks.get(task.id)?.state === "running";
    if (running) {
      recordTaskFinished(ctx, saveTask(ctx, { ...task, state: "failed", interrupted: interrupted.aborted || undefined,
        error: interrupted.aborted ? "Transcription was interrupted." : (e as Error).message, finishedAt: now() }));
    }
    // An interruption keeps the cursor. Any other ending leaves nobody to finish the
    // alignment, so the transcript keeps the times it has.
    if (early && !(running && interrupted.aborted)) keepTimes(ctx, asset.id, task.id);
    throw e;
  } finally {
    if (wav) {
      const remove = () => rm(wav, { force: true });
      // Make the transcript available immediately, and retain the scratch file for the worker reading it.
      if (labeling) ctx.track(labeling.finally(remove)).catch(error => ctx.log(`[speakers] audio cleanup: ${error}`));
      else await remove();
    }
  }
}

/** Stop waiting for word alignment on a recording's transcript: its times are as final as they will get. */
function keepTimes(ctx: Ctx, mediaId: string, owner?: string) {
  ctx.db.transaction(() => {
    if (owner && ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?",
      [mediaId], "created_at DESC, rowid DESC LIMIT 1")[0]?.id !== owner) return;
    for (const { aligning: _a, ...transcript } of ctx.repos.transcripts.select("media_id = ? AND json_extract(json, '$.aligning') IS NOT NULL", [mediaId])) {
      ctx.repos.transcripts.put(transcript);
    }
  }, "immediate")();
}

/**
 * A transcript still marked as aligning with no transcription running was left by a run that ended early. Readers
 * wait on that mark, so settle it: continue aligning the saved words when that can start now,
 * and otherwise keep the times it has. A paused project resumes its own transcriptions.
 */
export function settleAlignment(ctx: Ctx, media: MediaWithStatus & { projectId: string }, transcriptId: string) {
  const { projectId } = media;
  if (ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND state = 'running' AND json_extract(json, '$.context.mediaId') = ?", [projectId, media.id]).length) return;
  if (transcriptionHeld(ctx, projectId)) return;
  const provider = media.status === "ready" ? getTranscriptionProvider(ctx) : null;
  // Reading a transcript never sends a recording to a cloud service, and never repeats a run that failed by itself:
  // both wait for the editor's Retry, and the transcript keeps the times it has.
  const [last] = ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?", [projectId, media.id], "created_at DESC, rowid DESC LIMIT 1");
  if (!provider || provider.name !== "whispercpp" || last?.state === "cancelled" || (last?.state === "failed" && !last.interrupted)) return keepTimes(ctx, media.id);
  // A read may continue an existing local transcript, but a different preset is a new transcription request.
  const partial = ctx.db.prepare(`SELECT json_extract(json, '$.provider') AS provider, json_extract(json, '$.localModel') AS model
    FROM transcripts WHERE id = ? AND media_id = ? AND json_extract(json, '$.aligning') IS NOT NULL`).get(transcriptId, media.id) as
    { provider: string | null; model: string | null } | undefined;
  if (!partial) return;
  if ((partial.provider && partial.provider !== provider.name) || (partial.model && partial.model !== provider.localModel)) return keepTimes(ctx, media.id);
  const { projectId: _p, status: _s, error: _e, ...asset } = media;
  const { task, done } = startWithProvider(ctx, projectId, asset, provider, provider.name, undefined, "interrupt",
    { interrupted: last?.interrupted ? last : undefined, stranded: transcriptId });
  ctx.track(done.catch(() => null));
  ctx.log(`[transcribe] ${media.id} is continuing its word alignment as ${task.id}`);
}

/**
 * `asked`: it was asked to be prepared now, as a running edit's tools do, so it is read while the project's media work
 * is paused too. That holds for a build the ask joins, such as the one the timeline's drawing began. Read only for
 * the timeline's own drawing, it waits for resume.
 */
export function getWaveform(ctx: Ctx, media: MediaWithStatus & { projectId: string }, asked = false): Promise<WaveformCache | null> {
  // Noted before anything is awaited, so a pause that lands while it builds finds it asked for.
  if (asked) ctx.waveformsAsked.add(media.id);
  const pending = ctx.waveforms.get(media.id);
  if (pending) return pending;
  const job = ctx.track(loadOrBuildWaveform(ctx, media).finally(() => {
    ctx.waveforms.delete(media.id);
    ctx.waveformsAsked.delete(media.id);
  }));
  ctx.waveforms.set(media.id, job);
  return job;
}

async function loadOrBuildWaveform(ctx: Ctx, media: MediaWithStatus & { projectId: string }): Promise<WaveformCache | null> {
  const canBuild = media.hasAudio !== false && media.kind !== "image" && media.status !== "failed";
  const cached = await readWaveformCache(ctx, media.projectId, media.id, canBuild ? media.path : undefined);
  if (cached) return cached;
  if (!canBuild) return null;
  // Trash and a quit stop the build whoever waits for it. The pause stops it only while nobody has asked for it.
  const always = ctx.projectSignal(media.projectId), pause = ctx.mediaSignal(media.projectId);
  const stop = new AbortController();
  const stopped = () => stop.abort(always.reason);
  const paused = () => { if (!ctx.waveformsAsked.has(media.id)) stop.abort(pause.reason); };
  if (always.aborted) stopped(); else always.addEventListener("abort", stopped, { once: true });
  if (pause.aborted) paused(); else pause.addEventListener("abort", paused, { once: true });
  try {
    if (stop.signal.aborted) return null;
    return await buildWaveform(ctx, media, stop.signal);
  } catch (err) {
    // The ask came as the pause was stopping the build: it is read again for whoever asked.
    if (stop.signal.aborted && !always.aborted && ctx.waveformsAsked.has(media.id)) return loadOrBuildWaveform(ctx, media);
    throw err;
  } finally {
    always.removeEventListener("abort", stopped);
    pause.removeEventListener("abort", paused);
  }
}

async function buildWaveform(ctx: Ctx, media: MediaWithStatus & { projectId: string }, signal: AbortSignal) {
  const duration = media.duration ?? 0;
  const src = join(ctx.paths.media(media.projectId), media.path);
  const wf = await ctx.render.extractWaveformFull(src, duration, WAVEFORM_POINTS_PER_SECOND, undefined, signal);
  signal.throwIfAborted();
  const cache = "pointsPerSecond" in wf ? wf : { ...wf, duration, pointsPerSecond: WAVEFORM_POINTS_PER_SECOND };
  const base = waveformBase(ctx, media.projectId, media.id);
  const file = base + ("pointsPerSecond" in wf ? ".waveform" : ".json");
  const temp = file + "." + newId("tmp") + ".part";
  try {
    await writeFile(temp, "pointsPerSecond" in wf ? encodeWaveformCache(wf) : JSON.stringify(cache));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  // Drop caches from an older decode.
  await Promise.all(olderWaveforms(ctx, media.projectId, media.id).map(file => rm(file, { force: true })));
  return cache;
}

function olderWaveforms(ctx: Ctx, projectId: string, mediaId: string) {
  const base = join(ctx.paths.waveforms(projectId), mediaId);
  return [".v3", ".v2", ""].flatMap(version => [base + version + ".waveform", base + version + ".json"]);
}

function waveformBase(ctx: Ctx, projectId: string, mediaId: string) {
  return join(ctx.paths.waveforms(projectId), `${mediaId}.v${WAVEFORM_CACHE_VERSION}`);
}

function waveformFile(path: string) {
  return stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function readWaveformCache(ctx: Ctx, projectId: string, mediaId: string, sourceForRebuild?: string): Promise<WaveformCache | null> {
  const base = waveformBase(ctx, projectId, mediaId);
  const binary = await waveformFile(base + ".waveform");
  let p = base + (binary ? ".waveform" : ".json");
  let file = binary ?? await waveformFile(p);
  if (!file && (!sourceForRebuild || !fileInDirectory(ctx.paths.media(projectId), sourceForRebuild))) {
    // Offline recordings keep their newest readable waveform. With the original available, build on its corrected clock.
    for (const older of olderWaveforms(ctx, projectId, mediaId)) {
      const info = await waveformFile(older);
      if (!info?.isFile() || info.size > MAX_WAVEFORM_CACHE_BYTES) continue;
      p = older;
      file = info;
      break;
    }
  }
  if (!file || file.size > MAX_WAVEFORM_CACHE_BYTES) return null;
  // Sync and multi-mic timelines alternate between recordings. Share their
  // decoded arrays within one byte budget and invalidate on file replacement.
  const key = JSON.stringify([p, file.size, file.ino, file.ctimeMs, file.mtimeMs]);
  return ctx.waveformReads.get(key, async () => {
    if (p.endsWith(".waveform")) return decodeWaveformCache(await readFile(p));
    const cache = JSON.parse(await readFile(p, "utf8")) as WaveformCache;
    if (!Array.isArray(cache.peaks) || cache.peaks.length > MAX_WAVEFORM_POINTS ||
        (cache.rms && (!Array.isArray(cache.rms) || cache.rms.length > MAX_WAVEFORM_POINTS))) throw new Error("Invalid waveform cache.");
    return cache;
  });
}
