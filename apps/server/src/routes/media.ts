import { sourceEnergyReader, transcriptSourceReader } from "../services/sourceEnergy.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MultipartParseError, parseMultipartRequest } from "@remix-run/multipart-parser/future";
import { fileInDirectoryAsync, hasIndexedAvc, heardAudio, heardAudioKey, isStillAsset } from "@scarlet/render";
import { Hono } from "hono";
import { z } from "zod/v3";
import { AudioTrackSelection, DialogueVoiceRoles, isPlayableMedia, MediaKind, Provenance, WebSource } from "@scarlet/timeline";
import { flattenWords } from "@scarlet/shared";
import { retakeGroups } from "@scarlet/mcp/media-profile";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { requestAttempt, requireProjectEditAttempt, requireProjectLocalPauseTarget } from "../services/taskAttempt.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { clip, logId, throttledLog } from "../logText.js";
import { serveFile, serveOriginal } from "../files.js";
import { getTranscriptionProvider, importTranscriptionPolicy } from "../transcribe/index.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { transcriptReader } from "../services/transcriptReader.js";
import { otherInputReader } from "../services/otherInput.js";
import { afterAudioTrackChange } from "../services/audioTrackChange.js";
import { sourceCacheStatuses, sourcePreviews } from "../services/sourcePreviews.js";
import { frameDecoder, frameGoesToGpu, framePriority, pictureLane } from "../services/pictureWork.js";
import { previewPictures } from "../services/previewPictures.js";
import { expandMediaPaths } from "../services/folderMedia.js";
import { ingestMedia, removeUnreadableMedia, writeHashedFile } from "../services/ingest.js";
import { settleAlignment, startTranscription, transcriptionHeld } from "../services/transcription.js";
import { getWaveform, readWaveformCache } from "../services/waveforms.js";
import { realignTranscript } from "../services/realign.js";
import { fixTranscriptWords } from "../services/transcriptFix.js";
import { recordingSpeechActivity } from "../services/recordingAudio.js";
import { jsonBody, numberParam, optionalNumberParam, requireMedia, requireProjectHeader } from "./util.js";
import { editorFirst } from "../services/editorFirst.js";

const ImportRequest = z
  .object({ path: z.string().optional(), url: z.string().url().optional(), kind: MediaKind.optional(), name: z.string().optional(), importId: z.string().uuid().optional(), deferFormat: z.boolean().optional() })
  .refine((b) => !!b.path || !!b.url, { message: "provide `path` or `url`" });

/** How large a captured page can be. A full-page capture of a long article is a few megabytes. */
const CAPTURE_BYTES = 32 * 1024 * 1024;

/** The kind of picture a capture is, from its first bytes: a PNG, JPEG or WebP, or none of them. */
function pictureType(head: Buffer) {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
}

/** Keep the page a picture from the web was taken from, as captured, beside the project's media. Returns where, from the project's folder. */
async function saveCapture(ctx: Ctx, projectId: string, part: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of part) {
    size += chunk.length;
    if (size > CAPTURE_BYTES) throw badRequest("bad_capture", "The captured page is too large.");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  const type = pictureType(data);
  if (!type) throw badRequest("bad_capture", "A captured page is a PNG, JPEG or WebP picture.");
  const folder = ctx.paths.sources(projectId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.${type}`;
  await writeFile(join(folder, name), data, { flag: "wx", signal });
  return `sources/${name}`;
}

/** A transcript and a waveform are read from a file's sound. */
function requireAudio(media: { name: string; kind: MediaKind; hasAudio?: boolean }) {
  if (media.hasAudio === false || media.kind === "image") throw badRequest("no_audio", `${media.name} has no audio track.`);
}

export function mediaRoutes(ctx: Ctx) {
  const readSources = transcriptSourceReader(ctx);
  const transcripts = transcriptReader(ctx);
  const r = new Hono<AppEnv>();
  // The picture lane alone decides how many frames decode at once, and keeps a slot for the editor's.
  const frames = new AnalysisCache<Buffer>(frame => frame.length, undefined, Infinity);
  // A window reads the recording's one decode and runs the detector, so a few at once don't contend for ffmpeg.
  const speech = new AnalysisCache<Awaited<ReturnType<typeof recordingSpeechActivity>>>(spans => 48 * spans.length, 1024 * 1024, 4);
  const imports = new Map<string, ReturnType<typeof ingestMedia>>();
  const frameFallback = throttledLog(ctx.log);

  r.put("/media/:mediaId/voice-roles", async c => {
    const source = requireMedia(ctx, c.req.param("mediaId"));
    const attempt = requestAttempt(c.req.raw);
    requireProjectLocalPauseTarget(ctx, attempt, source.projectId);
    const { roles, from, to } = await jsonBody(c, z.object({ roles: DialogueVoiceRoles, from: z.number().finite().nonnegative(), to: z.number().finite().positive() }));
    if (to <= from || to - from > 60 || to > (source.duration ?? 0)) throw badRequest("voice_reference", "Choose a reference of up to one minute with both voices.");
    const file = await fileInDirectoryAsync(ctx.paths.media(source.projectId), source.path);
    if (!file) throw notFound("source file");
    const signal = AbortSignal.any([ctx.projectSignal(source.projectId), c.req.raw.signal]);
    const labels = await ctx.track(sourceEnergyReader(ctx).labels(file, signal), source.projectId);
    if (!labels.length) throw badRequest("voice_inputs", "Choose a synchronized recording with a mix and two isolated inputs.");
    const { mix } = await ctx.track(sourceEnergyReader(ctx).energy(file, from, to, signal), source.projectId);
    if (mix === undefined || mix === roles.me - 1 || mix === roles.other - 1) throw badRequest("voice_inputs", "Could not verify two isolated inputs and their mix in this reference.");
    const media = ctx.db.transaction(() => {
      requireProjectLocalPauseTarget(ctx, attempt, source.projectId);
      const current = requireMedia(ctx, source.id);
      const saved = ctx.repos.projects.putMedia(current.projectId, { ...current, voiceRoles: roles }, current.status, current.error);
      ctx.bus.publish({ type: "media.updated", projectId: current.projectId, media: saved });
      return saved;
    }, "immediate")();
    return c.json({ media });
  });

  // The editor's note on a file: what it is and how to use it. An empty note takes it off.
  r.put("/media/:mediaId/note", async c => {
    const { note } = await jsonBody(c, z.object({ note: z.string().max(2000) }));
    const text = note.trim();
    const media = ctx.db.transaction(() => {
      const current = requireMedia(ctx, c.req.param("mediaId"));
      const { status, error, projectId, editorNote: _old, ...rest } = current;
      const saved = ctx.repos.projects.putMedia(projectId, { ...rest, ...(text && { editorNote: text }) }, status, error);
      ctx.bus.publish({ type: "media.updated", projectId, media: saved });
      return saved;
    }, "immediate")();
    return c.json({ media });
  });

  r.put("/media/:mediaId/audio-track", async c => {
    const source = requireMedia(ctx, c.req.param("mediaId"));
    requireAudio(source);
    const attempt = requestAttempt(c.req.raw);
    requireProjectLocalPauseTarget(ctx, attempt, source.projectId);
    const { audioTrack } = await jsonBody(c, z.object({ audioTrack: AudioTrackSelection }));
    let streams = source.audioStreams;
    if (!streams) {
      const file = await fileInDirectoryAsync(ctx.paths.media(source.projectId), source.path);
      if (file) {
        const signal = AbortSignal.any([ctx.projectSignal(source.projectId), c.req.raw.signal]);
        const probed = await ctx.track(ctx.render.probeMedia(file, signal), source.projectId).catch(error => {
          // The choice is then checked against one track, and a valid second track is refused.
          if (!signal.aborted) ctx.log(`[media] ${logId(source.id)}: couldn't read its audio tracks: ${clip((error as Error)?.message ?? String(error))}`);
          return undefined;
        });
        if (probed?.audioStreams && probed.audioStreams.length > 1) streams = probed.audioStreams;
      }
    }
    const count = streams?.length ?? 1;
    if (typeof audioTrack === "number" && audioTrack >= count) {
      throw badRequest("bad_audio_track", `This file only has ${count} audio ${count === 1 ? "track" : "tracks"}.`);
    }
    const normalized = audioTrack === 0 ? undefined : audioTrack;
    const media = ctx.db.transaction(() => {
      requireProjectLocalPauseTarget(ctx, attempt, source.projectId);
      const current = requireMedia(ctx, source.id);
      const { status, error, projectId: _p, ...rest } = current;
      const saved = ctx.repos.projects.putMedia(current.projectId, {
        ...rest,
        ...(streams && streams.length > 1 ? { audioStreams: streams } : {}),
        audioTrack: normalized,
      }, status, error);
      ctx.bus.publish({ type: "media.updated", projectId: current.projectId, media: saved });
      return { before: current, saved };
    }, "immediate")();
    // What was made from the old track is made again from the new one: its transcript and its previews.
    await ctx.track(afterAudioTrackChange(ctx, media.before, { ...media.saved, projectId: media.before.projectId }), source.projectId);
    return c.json({ media: ctx.repos.projects.getMedia(media.saved.id) ?? media.saved });
  });

  r.post("/projects/:id/media", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    requireProjectLocalPauseTarget(ctx, attempt, project.id);
    const transcription = await importTranscriptionPolicy(ctx);
    ctx.paths.ensureProject(project.id);
    const signal = AbortSignal.any([ctx.projectSignal(project.id), c.req.raw.signal]);
    const staged = join(ctx.paths.media(project.id), `.${randomUUID()}.part`);
    // The page as captured, from the project's folder, until the file it belongs to is in the project.
    let capture: string | undefined;
    try {
      let hash: string | undefined;
      let name: string | undefined;
      let kind: string | undefined;
      let provenance: Provenance | undefined;
      let source: WebSource | undefined;
      for await (const part of parseMultipartRequest(c.req.raw, { maxFileSize: Infinity })) {
        if (part.name === "file" && part.isFile) {
          if (name) throw badRequest("duplicate_file", "Send one file per upload");
          name = part.filename || "upload";
          // The part is an async iterable. Each chunk is written before reading the next.
          hash = await writeHashedFile(staged, part, signal);
        } else if (part.name === "provenance" && !part.isFile) {
          if (provenance) throw badRequest("bad_provenance", "Send one provenance field per upload");
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of part) {
            size += chunk.length;
            if (size > 65536) throw badRequest("bad_provenance", "Provenance is too large");
            chunks.push(chunk);
          }
          try {
            provenance = Provenance.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            throw badRequest("bad_provenance", "Invalid media provenance");
          }
        } else if (part.name === "source" && !part.isFile) {
          // Where a picture or clip from the web came from. The page as captured, if any, comes as its own file.
          if (source) throw badRequest("bad_source", "Send one source field per upload");
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of part) {
            size += chunk.length;
            if (size > 16384) throw badRequest("bad_source", "The source is too large");
            chunks.push(chunk);
          }
          try {
            source = WebSource.omit({ capture: true }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            throw badRequest("bad_source", "A source needs the web address of the page it came from.");
          }
        } else if (part.name === "capture" && part.isFile) {
          if (capture) throw badRequest("bad_capture", "Send one captured page per upload");
          capture = await saveCapture(ctx, project.id, part, signal);
        } else if (part.name === "kind" && !part.isFile) {
          kind = "";
          for await (const chunk of part) {
            if (kind.length + chunk.length > 32) throw badRequest("bad_kind", "Invalid media kind");
            kind += Buffer.from(chunk).toString("latin1");
          }
        }
      }
      if (!name || !hash) throw badRequest("missing_file", "multipart field `file` is required");
      if (capture && !source) throw badRequest("bad_capture", "A captured page comes with the address it was captured from.");
      const media = await ingestMedia(ctx, project, { type: "upload", path: staged, hash }, {
        checkAttempt: () => requireProjectLocalPauseTarget(ctx, attempt, project.id),
        name, transcription, deferFormat: c.req.query("deferFormat") === "true",
        kind: kind ? MediaKind.parse(kind) : undefined,
        // Which run added it is the engine's to say, from the run's own attempt.
        by: provenance ? { ...provenance, taskId: attempt?.taskId || undefined } : { by: "human", name: c.var.user.name, createdAt: now() },
        source: source && { ...source, ...(capture && { capture }) },
        uploadedBy: c.var.user.id,
      });
      capture = undefined;
      return c.json({ media }, 201);
    } catch (error) {
      if (error instanceof MultipartParseError) throw badRequest("bad_upload", "Incomplete or invalid upload. Please try again.");
      throw error;
    } finally {
      await rm(staged, { force: true });
      // A capture whose file didn't go into the project isn't kept.
      if (capture) await rm(join(ctx.paths.project(project.id), capture), { force: true });
    }
  });

  // Expand dropped folders into the video files inside them; individual files and URLs pass through unchanged.
  r.post("/media/expand-paths", async (c) => {
    const { paths } = await jsonBody(c, z.object({ paths: z.array(z.string().min(1).max(4096)).max(1000) }));
    return c.json(await expandMediaPaths(paths, { signal: c.req.raw.signal, log: line => ctx.log(line) }));
  });

  // Show the first frame while a large original is still being copied into the project.
  r.post("/projects/:id/media/import-frame", async c => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const { path } = await jsonBody(c, z.object({ path: z.string() }));
    if (!isAbsolute(path) || !(await stat(path).catch(() => null))?.isFile()) throw notFound("source file");
    const probed = await ctx.render.probeMedia(path, c.req.raw.signal).catch(error => {
      if (!c.req.raw.signal.aborted) ctx.log(`[media] import_frame project=${logId(project.id)}: couldn't read the original's colour, showing it without HDR tone mapping: ${clip((error as Error)?.message ?? String(error))}`);
      return undefined;
    });
    // An MP4 camera original's index is read as the frame route reads it: the same picture, without scanning the file first.
    const indexedMp4 = !!probed?.previewClock && hasIndexedAvc({ kind: probed.kind, hasAlpha: probed.hasAlpha, originalPlaybackType: probed.originalPlaybackType });
    const jpeg = await ctx.render.extractFrame(path, 0, { width: 960, signal: c.req.raw.signal, hdr: probed?.color?.hdr, indexedMp4, fps: probed?.fps });
    return new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
  });

  r.post("/projects/:id/media/import", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    requireProjectLocalPauseTarget(ctx, attempt, project.id);
    const transcription = await importTranscriptionPolicy(ctx);
    const body = await jsonBody(c, ImportRequest);
    // A renderer can reopen while its original HTTP request is still copying, or just after it saved the asset.
    const { importId } = body;
    const key = JSON.stringify([project.id, importId]);
    if (importId) {
      for (let running = imports.get(key); running; running = imports.get(key)) {
        try {
          return c.json({ media: await running }, 201);
        } catch (error) {
          // The former window disconnected. A still-connected retry can take its place.
          if (!(error instanceof HttpError) || error.code !== "download_cancelled" || c.req.raw.signal.aborted) throw error;
        }
      }
      const saved = ctx.repos.projects.importedMedia(project.id, importId);
      if (saved) return c.json({ media: saved }, 201);
    }
    const source = body.path ? ({ type: "path", path: body.path, importId } as const) : ({ type: "url", url: body.url!, importId, signal: c.req.raw.signal } as const);
    const importing = ingestMedia(ctx, project, source, {
      name: body.name, transcription, deferFormat: body.deferFormat,
      checkAttempt: () => requireProjectLocalPauseTarget(ctx, attempt, project.id),
      kind: body.kind,
      by: { by: "human", name: c.var.user.name, createdAt: now() },
      uploadedBy: c.var.user.id,
    });
    if (importId) imports.set(key, importing);
    try {
      return c.json({ media: await importing }, 201);
    } finally {
      if (importId) imports.delete(key);
    }
  });

  r.get("/projects/:id/media", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json({ media: ctx.repos.projects.listMedia(project.id) });
  });

  /**
   * Take a file Scarlet couldn't read out of the project. A file it read stays for now: it may be caching or
   * transcribing, and its caches can serve another copy of the same recording.
   */
  r.delete("/projects/:id/media/:mediaId", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    requireProjectLocalPauseTarget(ctx, requestAttempt(c.req.raw), project.id);
    await removeUnreadableMedia(ctx, project.id, c.req.param("mediaId"), c.var.user);
    return c.json({});
  });

  r.get("/projects/:id/playback-caches", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json({ caches: await sourceCacheStatuses(ctx, project.id) });
  });

  // Place a saved transcript's words again with the current aligner. The words and their indices stay.
  r.post("/projects/:id/media/:mediaId/realign", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const media = requireMedia(ctx, c.req.param("mediaId"), project.id);
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id);
    requireAudio(media);
    return c.json(await ctx.track(realignTranscript(ctx, project.id, media.id, ctx.projectSignal(project.id)), project.id));
  });

  // Correct a word or phrase in the project's transcripts, keeping word times. The fix stays with each transcript.
  r.post("/projects/:id/transcripts/fix", async (c) => {
    const body = await jsonBody(c, z.object({
      find: z.string().trim().min(1).max(200),
      replace: z.string().trim().min(1).max(200),
      mediaIds: z.array(z.string()).min(1).max(100).optional(),
      from: z.number().min(0).optional(),
      to: z.number().min(0).optional(),
    }));
    const project = requireProjectHeader(ctx, c.req.param("id"));
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id);
    return c.json(fixTranscriptWords(ctx, project.id, body));
  });

  r.post("/projects/:id/media/:mediaId/prepare", async (c) => {
    const { kind } = await jsonBody(c, z.object({ kind: z.enum(["transcript", "waveform"]) }));
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const media = requireMedia(ctx, c.req.param("mediaId"), project.id);
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id);
    requireAudio(media);
    if (kind === "waveform") {
      if (!await getWaveform(ctx, media, true)) throw conflict("waveform_unavailable", media.error || "The source audio is unavailable.");
      return c.json({ state: "ready" });
    }
    if (ctx.db.prepare("SELECT id FROM transcripts WHERE media_id = ? LIMIT 1").get(media.id)) return c.json({ state: "ready" });
    if (!getTranscriptionProvider(ctx)) {
      const provider = ctx.settings().transcription.provider;
      throw conflict("transcription_unavailable", provider === "none"
        ? "Transcription isn't available in this build of Scarlet. Waveform analysis is still available."
        : `The selected transcription provider (${provider}) is missing its configuration in Scarlet Settings.`);
    }
    const { task, done } = startTranscription(ctx, project.id, media, undefined, "interrupt", "missing");
    if (task.state === "done") return c.json({ state: "ready" });
    if (task.state === "failed" && task.interrupted) throw conflict("transcription_unavailable",
      "The interrupted transcription cannot resume with the current provider. Retry it from Media.");
    // The transcription logs its own outcome ([transcribe]) and fails its task.
    ctx.track(done.catch(() => null), project.id);
    return c.json({ state: "processing", taskId: task.id }, 202);
  });

  r.get("/media/:mediaId/file", (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    return serveOriginal(c.req.raw, join(ctx.paths.media(media.projectId), media.path));
  });

  // The page a picture from the web was taken from, as captured, for the card of the edit that uses it.
  r.get("/media/:mediaId/source-capture", async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const capture = media.source?.capture;
    const file = capture?.startsWith("sources/") && await fileInDirectoryAsync(ctx.paths.sources(media.projectId), capture.slice("sources/".length));
    if (!file) throw notFound("captured page");
    return serveFile(c.req.raw, file, { contentType: `image/${/\.png$/.test(file) ? "png" : /\.webp$/.test(file) ? "webp" : "jpeg"}` });
  });

  r.get("/media/:mediaId/proxy", async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const proxy = join(ctx.paths.proxies(media.projectId), `${media.id}.mp4`);
    // ffmpeg creates its output before the MP4 is playable.
    if (!media.previewMode && isPlayableMedia(media) && existsSync(proxy)) return serveFile(c.req.raw, proxy);
    // A recording with several audio tracks would play whichever track the player picks. Video plays its playback cache
    // (or parts made on demand); sound-only plays a single-track AAC preview made of the chosen track.
    if (media.kind === "video" && (media.audioStreams?.length ?? 0) > 1) {
      const cached = await sourcePreviews.fullFile(ctx, media);
      if (cached) return serveFile(c.req.raw, cached);
      throw notFound("preview of the chosen audio track");
    }
    if (media.kind === "audio" && (media.audioStreams?.length ?? 0) > 1) {
      try {
        const preview = await sourcePreviews.audioPreview(ctx, media, c.req.raw.signal);
        return serveFile(c.req.raw, preview, { contentType: "audio/mp4" });
      } catch (error) {
        if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
    }
    return serveOriginal(c.req.raw, join(ctx.paths.media(media.projectId), media.path));
  });

  r.on(["GET", "POST"], "/media/:mediaId/playback-cache", async c => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const { status } = await sourcePreviews.full(ctx, media, c.req.method === "POST");
    return c.json(status);
  });
  r.get("/media/:mediaId/playback-cache/file", async c => {
    const file = await sourcePreviews.fullFile(ctx, requireMedia(ctx, c.req.param("mediaId")), c.req.query("fileKey"));
    if (!file) throw notFound("cached preview");
    return serveFile(c.req.raw, file);
  });

  r.get("/media/:mediaId/preview/:index", async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    // The editor is playing a source: background work yields meanwhile (editorFirst.ts).
    editorFirst.touch();
    const file = await sourcePreviews.get(ctx, media, Number(c.req.param("index")), c.req.raw.signal);
    return serveFile(c.req.raw, file);
  });

  r.on("GET", ["/media/:mediaId/waveform", "/projects/:projectId/media/:mediaId/waveform"], async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    // The timeline's drawing never asks for voice activity. A read that does is a tool's, such as a running edit's
    // inspection of a cut, so a waveform it lacks is prepared for it while the project's media work is paused too.
    const cache = c.req.query("cachedOnly") === "1"
      ? await readWaveformCache(ctx, media.projectId, media.id, media.status === "failed" ? undefined : media.path, media.audioTrack)
      : await getWaveform(ctx, media, c.req.query("speechActivity") === "1");
    if (!cache) throw notFound("waveform (media has no audio or is still ingesting)");
    const from = numberParam(c.req.query("from"), "from", 0);
    // Prefer exact container seconds only when they agree with the measured sound to one bucket.
    const duration = cache.peaks instanceof Float32Array && media.duration !== undefined &&
      Math.abs(media.duration - cache.duration) <= 1 / cache.pointsPerSecond ? media.duration : cache.duration;
    const to = numberParam(c.req.query("to"), "to", duration);
    const points = Math.min(20000, Math.max(1, Math.floor(numberParam(c.req.query("points"), "points", 1000))));
    const wf = ctx.render.waveformFromCache(cache, from, to, points);
    if (c.req.query("speechActivity") === "1") {
      // A video container can run slightly past its audio stream; accept ranges up to either duration and read speech up to the audio end.
      const maxDuration = Math.max(duration, media.duration ?? duration);
      if (from < 0 || to > maxDuration + 0.000001 || to <= from || to > from + 60) {
        throw badRequest("bad_speech_range", "Choose up to 60 seconds within the source audio.");
      }
      const speechTo = Math.min(to, cache.duration);
      if (from >= speechTo) {
        return c.json({ mediaId: media.id, from, to, ...wf, speechActivity: [] });
      }
      const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
      if (!file) throw notFound("source file");
      const info = await stat(file);
      const audio = heardAudio(media);
      const key = JSON.stringify(["vad", file, media.hash, info.size, info.ctimeMs, info.mtimeMs, from, speechTo, heardAudioKey(audio)]);
      // Up to a minute, read because someone asked: a running edit checks its joins with it while caching is paused too.
      const spans = await speech.get(key, () => ctx.track(recordingSpeechActivity(ctx, file, from, speechTo, ctx.projectSignal(media.projectId), audio), media.projectId));
      return c.json({ mediaId: media.id, from, to, ...wf, speechActivity: spans });
    }
    if (c.req.query("format") === "peaks-f64le") {
      // Legacy JSON caches may contain more precision than the current float32 cache.
      const data = new DataView(new ArrayBuffer(wf.peaks.length * 8));
      for (let i = 0; i < wf.peaks.length; i++) data.setFloat64(i * 8, wf.peaks[i]!, true);
      return c.body(data.buffer, 200, { "Content-Type": "application/octet-stream" });
    }
    return c.json({ mediaId: media.id, from, to, peaks: wf.peaks, rms: wf.rms });
  });

  r.on("GET", ["/media/:mediaId/transcript", "/projects/:projectId/media/:mediaId/transcript"], async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    const from = optionalNumberParam(c.req.query("from"), "from") ?? null;
    const to = optionalNumberParam(c.req.query("to"), "to") ?? null;
    const omitWords = c.req.query("granularity") === "segment";
    const transcript = await transcripts.read(media, from, to, omitWords);
    if (!transcript) throw notFound("transcript");
    if (transcript.aligning) {
      try { settleAlignment(ctx, media, transcript.id); } catch (err) { ctx.log(`[transcribe] ${media.id}: ${(err as Error).message}`); }
    }
    void ctx.speakers.ensure(ctx, media.projectId, media, transcript, undefined, transcriptionHeld(ctx, media.projectId));
    const search = c.req.query("search");
    if (search !== undefined) {
      const contextWords = z.coerce.number().int().min(0).max(30).parse(c.req.query("contextWords") ?? 6);
      return c.json(transcripts.search(transcript, search, contextWords, c.req.query("wordSnapshot")));
    }
    return c.json(c.req.query("audioSources") === "1" && from !== null && to !== null && !omitWords
      ? await ctx.track(readSources(media.projectId, media, transcript, from, to), media.projectId) : transcript);
  });

  /**
   * Which of the given words were heard only on the input a recording's dialogue isn't on, and what sounded there alone
   * in the given gaps. Source seconds. `available` is false for a recording without a mix and two such inputs.
   */
  r.post("/projects/:projectId/media/:mediaId/other-input", async c => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    const range = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).refine(([a, b]) => b >= a);
    const { words, gaps } = await jsonBody(c, z.object({ words: z.array(range).max(5000).default([]), gaps: z.array(range).max(2000).default([]) }));
    const toRange = ([start, end]: [number, number]) => ({ start, end });
    return c.json(await ctx.track(otherInputReader(ctx).classify(media.projectId, media, words.map(toRange), gaps.map(toRange)), media.projectId));
  });

  /** Attempts at the same line near a source range, for comparing takes in review. Source seconds. */
  r.get("/projects/:projectId/media/:mediaId/retakes", async c => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    const from = numberParam(c.req.query("from"), "from"), to = numberParam(c.req.query("to"), "to");
    if (!(to > from)) throw badRequest("invalid_range", "Choose from < to.");
    // retakeGroups pairs clauses up to 90 s apart. Read that far either side.
    const transcript = await transcripts.read(media, Math.max(0, from - 90), to + 90, false);
    if (!transcript) return c.json({ mediaId: media.id, groups: [] });
    const words = flattenWords(transcript).filter(w => w.end > w.start && w.text.trim()).sort((a, b) => a.start - b.start);
    const groups = retakeGroups(words).filter(g => g.takes.some(t => t.end > from && t.start < to))
      .map(({ score, takes }) => ({ score, takes: takes.map(({ start, end, text }) => ({ start, end, text })) }));
    return c.json({ mediaId: media.id, groups });
  });

  r.post("/media/:mediaId/transcribe", async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const body = await jsonBody(c, z.object({ provider: z.enum(["openai", "whispercpp"]).optional() }));
    requireAudio(media);
    const { status: _s, error: _e, projectId, ...asset } = media;
    // Runs in the background; the task is returned immediately and updated over WS. It logs its own outcome ([transcribe]).
    const { task, done } = startTranscription(ctx, projectId, asset, body.provider, "refuse");
    ctx.track(done.catch(() => null), projectId);
    return c.json({ task }, 202);
  });

  r.on("GET", ["/media/:mediaId/frame", "/projects/:projectId/media/:mediaId/frame"], async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    if (media.kind === "audio") throw badRequest("no_video", "audio media has no frames");
    // A time past the end shows the last frame, as one before the start shows the first, rather than finding none.
    const requested = numberParam(c.req.query("t"), "t", 0);
    // A still has one picture, shown for as long as its clip is: any time in the clip is that picture. The asset says
    // it is a still, as the render reads it; the frame reader goes by the file's name alone, and found nothing later
    // than 2 s into a still it didn't know the spelling of (.jfif, .heif).
    const still = isStillAsset(media);
    const t = still ? 0 : media.duration && media.duration > 0 ? Math.min(requested, media.duration) : requested;
    const w = Math.min(3840, Math.max(16, numberParam(c.req.query("w"), "w", 640)));
    const file = join(ctx.paths.media(media.projectId), media.path);
    // A recording moved or deleted outside Scarlet is asked for with every scrub.
    const source = await stat(file).catch(() => null);
    if (!source) throw notFound("source file");
    const preview = c.req.query("preview") === "1";
    // An agent's closer look: one area of the picture, in percent of it, and lines at round percents to name an area by.
    const asked = c.req.query("area")?.split(",").map(Number);
    if (asked && !(asked.length === 4 && asked.every(n => Number.isFinite(n) && n >= 0 && n <= 100) && asked[2]! - asked[0]! >= 1 && asked[3]! - asked[1]! >= 1))
      throw badRequest("bad_area", "area is left,top,right,bottom in percent of the picture, at least 1 percent each way.");
    const area = asked?.map(n => n / 100) as [number, number, number, number] | undefined;
    const grid = c.req.query("grid") === "1" && media.width && media.height ? { width: media.width, height: media.height } : undefined;
    // A file imported before Scarlet read colour has it read here: an HDR original's frame is tone-mapped to SDR.
    const hdr = media.color ? media.color.hdr : (await ctx.render.probeMedia(file).catch(error => {
      // Asked again with every scrub of an older import, so once a minute per file.
      frameFallback(`color/${media.id}`, `[media] color_probe_failed media=${logId(media.id)} project=${logId(media.projectId)}, frames shown without HDR tone mapping: ${clip((error as Error)?.message ?? String(error))}`);
      return undefined;
    }))?.color?.hdr;
    const key = JSON.stringify([file, media.hash, source.size, source.mtimeMs, source.ctimeMs, t, w, preview, area, !!grid, hdr]);
    const frame = async (demand: AbortSignal) => {
      const signal = AbortSignal.any([demand, ctx.projectSignal(media.projectId)]);
      if (preview && !area && !grid && media.fps && media.width && media.height) {
        const minimumHeight = Math.ceil(w * media.height / media.width);
        const picture = await previewPictures(ctx.paths.media(media.projectId), { signal })(media, t, t + 1 / media.fps, minimumHeight);
        if (picture) {
          try { return await ctx.render.extractFrame(picture.file, Math.max(0, t - picture.start), { width: w, signal, indexedMp4: true, fps: media.fps }); }
          catch (error) {
            signal.throwIfAborted();
            frameFallback(media.id, `[media] frame_fallback media=${logId(media.id)} project=${logId(media.projectId)} reason=cached_preview: ${clip((error as Error)?.message ?? String(error))}`);
          }
        }
      }
      // The agent's frames read the movie's index too: the same picture, a third sooner on a long recording.
      const indexedMp4 = !!media.previewClock && hasIndexedAvc(media);
      // The original decodes on an NVIDIA GPU when there is one, and an agent's video frame on a Mac's while the editor looks.
      const decoder = await frameDecoder(ctx.settings().render.hwaccel, priority, pictureLane(ctx), cpuOnly);
      return ctx.render.extractFrame(file, t, { width: w, signal, indexedMp4, decoder, area, grid, fps: media.fps, hdr, still });
    };
    // Frames share the engine’s picture lane with contact sheets. The editor’s own requests go first, then the timeline’s.
    const priority = framePriority(c.req.query("priority"));
    // The editor is looking at a source's pictures: background work yields meanwhile (editorFirst.ts), as for a cut's.
    if (priority === true) editorFirst.touch();
    // An HDR frame is tone-mapped on the CPU, and a still has no video to hand to a Mac's media engine.
    const cpuOnly = !!hdr || still;
    // An agent's frame that goes to the GPU while the editor looks may run past the lane's slots then.
    const gpu = await frameGoesToGpu(ctx.settings().render.hwaccel, priority, cpuOnly);
    try {
      const jpeg = await frames.get(key, signal => ctx.track(pictureLane(ctx).run(() => frame(signal), { priority, signal, gpu }), media.projectId), {
        priority, signal: c.req.raw.signal,
      });
      return new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
    } catch (error) {
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      throw error;
    }
  });

  return r;
}
