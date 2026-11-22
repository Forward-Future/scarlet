import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeWaveformCache,
  encodeWaveformCache,
  fileInDirectory,
  MAX_WAVEFORM_CACHE_BYTES,
  MAX_WAVEFORM_POINTS,
  WAVEFORM_CACHE_VERSION,
} from "@scarlet/render";
import { newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import type { WaveformCache } from "../render/adapter.js";
import type { MediaWithStatus } from "../repo/projects.js";
import { atomicWriteFile, errorMessage } from "../util.js";

/**
 * 10 ms a point. The dip between two words said in one breath is often 20-40 ms wide: at 20 ms it averaged into the
 * sound either side, and edges an editor puts on the trough a waveform shows went to review as having no quiet point.
 */
const WAVEFORM_POINTS_PER_SECOND = 100;

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
  }), media.projectId);
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
  await atomicWriteFile(
    file,
    "pointsPerSecond" in wf ? encodeWaveformCache(wf) : JSON.stringify(cache),
    file + "." + newId("tmp") + ".part",
  );
  // Drop caches from an older decode.
  await Promise.all(olderWaveforms(ctx, media.projectId, media.id).map(old => rm(old, { force: true })));
  return cache;
}

export function olderWaveforms(ctx: Ctx, projectId: string, mediaId: string) {
  const base = join(ctx.paths.waveforms(projectId), mediaId);
  return [".v4", ".v3", ".v2", ""].flatMap(version => [base + version + ".waveform", base + version + ".json"]);
}

export function waveformBase(ctx: Ctx, projectId: string, mediaId: string) {
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
  const path = p;
  try {
    return await ctx.waveformReads.get(key, async () => {
      if (path.endsWith(".waveform")) return decodeWaveformCache(await readFile(path));
      const cache = JSON.parse(await readFile(path, "utf8")) as WaveformCache;
      if (!Array.isArray(cache.peaks) || cache.peaks.length > MAX_WAVEFORM_POINTS ||
          (cache.rms && (!Array.isArray(cache.rms) || cache.rms.length > MAX_WAVEFORM_POINTS))) throw new Error("Invalid waveform cache.");
      return cache;
    });
  } catch (err) {
    // A waveform cut short as it was saved, by a power cut, can't be read. It is built again, not failed for good.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || !sourceForRebuild) throw err;
    ctx.log(`[media] ${mediaId}: the saved waveform can’t be read and is built again: ${errorMessage(err)}`);
    await rm(path, { force: true });
    return null;
  }
}
