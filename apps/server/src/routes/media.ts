import { readSourceEnergy, sourceLabels, transcriptSourceReader } from "../services/transcriptSources.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MultipartParseError, parseMultipartRequest } from "@remix-run/multipart-parser/future";
import { fileInDirectory, hasIndexedAvc, speechActivity } from "@scarlet/render";
import { Hono } from "hono";
import { z } from "zod/v3";
import { DialogueVoiceRoles, isPlayableMedia, MediaKind, Provenance } from "@scarlet/timeline";
import { flattenWords } from "@scarlet/shared";
import { retakeGroups } from "@scarlet/mcp/media-profile";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { requestAttempt, requireLocalPauseTarget, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { serveFile, serveOriginal } from "../files.js";
import { getTranscriptionProvider, importTranscriptionPolicy } from "../transcribe/index.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { transcriptReader } from "../services/transcriptReader.js";
import { sourceCacheStatuses, sourcePreviews } from "../services/sourcePreviews.js";
import { pictureDecoder, pictureLane } from "../services/pictureWork.js";
import { previewPictures } from "../services/previewPictures.js";
import { getWaveform, ingestMedia, readWaveformCache, removeUnreadableMedia, settleAlignment, startTranscription, transcriptionHeld, writeHashedFile } from "../services/ingest.js";
import { jsonBody, numberParam, requireMedia, requireProjectHeader } from "./util.js";

const ImportRequest = z
  .object({ path: z.string().optional(), url: z.string().url().optional(), kind: MediaKind.optional(), name: z.string().optional(), importId: z.string().uuid().optional(), deferFormat: z.boolean().optional() })
  .refine((b) => !!b.path || !!b.url, { message: "provide `path` or `url`" });

/** A transcript and a waveform are read from a file's sound. */
function requireAudio(media: { name: string; kind: MediaKind; hasAudio?: boolean }) {
  if (media.hasAudio === false || media.kind === "image") throw badRequest("no_audio", `${media.name} has no audio track.`);
}

export function mediaRoutes(ctx: Ctx) {
  const readSources = transcriptSourceReader(ctx);
  const transcripts = transcriptReader(ctx);
  const r = new Hono<AppEnv>();
  const frames = new AnalysisCache<Buffer>(frame => frame.length);
  const speech = new AnalysisCache<Awaited<ReturnType<typeof speechActivity>>>(spans => 48 * spans.length, 1024 * 1024);
  const previews = sourcePreviews;
  const imports = new Map<string, ReturnType<typeof ingestMedia>>();

  r.put("/media/:mediaId/voice-roles", async c => {
    const source = requireMedia(ctx, c.req.param("mediaId"));
    const attempt = requestAttempt(c.req.raw);
    requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, source.projectId));
    const { roles, from, to } = await jsonBody(c, z.object({ roles: DialogueVoiceRoles, from: z.number().finite().nonnegative(), to: z.number().finite().positive() }));
    if (to <= from || to - from > 60 || to > (source.duration ?? 0)) throw badRequest("voice_reference", "Choose a reference of up to one minute with both voices.");
    const file = fileInDirectory(ctx.paths.media(source.projectId), source.path);
    if (!file) throw notFound("source file");
    if (!(await ctx.track(sourceLabels(file, ctx.mediaSignal(source.projectId)))).length) throw badRequest("voice_inputs", "Choose a synchronized recording with a mix and two isolated inputs.");
    const { mix } = await ctx.track(readSourceEnergy(file, from, to, ctx.mediaSignal(source.projectId)));
    if (mix === undefined || mix === roles.me - 1 || mix === roles.other - 1) throw badRequest("voice_inputs", "Could not verify two isolated inputs and their mix in this reference.");
    const media = ctx.db.transaction(() => {
      requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, source.projectId));
      const current = requireMedia(ctx, source.id);
      const saved = ctx.repos.projects.putMedia(current.projectId, { ...current, voiceRoles: roles }, current.status, current.error);
      ctx.bus.publish({ type: "media.updated", projectId: current.projectId, media: saved });
      return saved;
    }, "immediate")();
    return c.json({ media });
  });

  r.post("/projects/:id/media", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, project.id));
    const transcription = await importTranscriptionPolicy(ctx);
    ctx.paths.ensureProject(project.id);
    const signal = AbortSignal.any([ctx.projectSignal(project.id), c.req.raw.signal]);
    const staged = join(ctx.paths.media(project.id), `.${randomUUID()}.part`);
    try {
      let hash: string | undefined;
      let name: string | undefined;
      let kind: string | undefined;
      let provenance: Provenance | undefined;
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
        } else if (part.name === "kind" && !part.isFile) {
          kind = "";
          for await (const chunk of part) {
            if (kind.length + chunk.length > 32) throw badRequest("bad_kind", "Invalid media kind");
            kind += Buffer.from(chunk).toString("latin1");
          }
        }
      }
      if (!name || !hash) throw badRequest("missing_file", "multipart field `file` is required");
      const media = await ingestMedia(ctx, project, { type: "upload", path: staged, hash }, {
        checkAttempt: () => requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, project.id)),
        name, transcription, deferFormat: c.req.query("deferFormat") === "true",
        kind: kind ? MediaKind.parse(kind) : undefined,
        by: provenance ?? { by: "human", name: c.var.user.name, createdAt: new Date().toISOString() },
        uploadedBy: c.var.user.id,
      });
      return c.json({ media }, 201);
    } catch (error) {
      if (error instanceof MultipartParseError) throw badRequest("bad_upload", "Incomplete or invalid upload. Please try again.");
      throw error;
    } finally {
      await rm(staged, { force: true });
    }
  });

  // Show the first frame while a large original is still being copied into the project.
  r.post("/projects/:id/media/import-frame", async c => {
    requireProjectHeader(ctx, c.req.param("id"));
    const { path } = await jsonBody(c, z.object({ path: z.string() }));
    if (!isAbsolute(path) || !(await stat(path).catch(() => null))?.isFile()) throw notFound("source file");
    const jpeg = await ctx.render.extractFrame(path, 0, { width: 960, signal: c.req.raw.signal });
    return new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
  });

  r.post("/projects/:id/media/import", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, project.id));
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
      checkAttempt: () => requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, project.id)),
      kind: body.kind,
      by: { by: "human", name: c.var.user.name, createdAt: new Date().toISOString() },
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
    requireLocalPauseTarget(requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), project.id));
    await removeUnreadableMedia(ctx, project.id, c.req.param("mediaId"), c.var.user);
    return c.json({});
  });

  r.get("/projects/:id/playback-caches", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json({ caches: await sourceCacheStatuses(ctx, project.id) });
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
    ctx.track(done.catch(() => null));
    return c.json({ state: "processing", taskId: task.id }, 202);
  });

  r.get("/media/:mediaId/file", (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    return serveOriginal(c.req.raw, join(ctx.paths.media(media.projectId), media.path));
  });

  r.get("/media/:mediaId/proxy", (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const proxy = join(ctx.paths.proxies(media.projectId), `${media.id}.mp4`);
    // ffmpeg creates its output before the MP4 is playable.
    return !media.previewMode && isPlayableMedia(media) && existsSync(proxy)
      ? serveFile(c.req.raw, proxy)
      : serveOriginal(c.req.raw, join(ctx.paths.media(media.projectId), media.path));
  });

  r.on(["GET", "POST"], "/media/:mediaId/playback-cache", async c => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const { status } = await previews.full(ctx, media, c.req.method === "POST");
    return c.json(status);
  });
  r.get("/media/:mediaId/playback-cache/file", async c => {
    const file = await previews.fullFile(ctx, requireMedia(ctx, c.req.param("mediaId")), c.req.query("fileKey"));
    if (!file) throw notFound("cached preview");
    return serveFile(c.req.raw, file);
  });

  r.get("/media/:mediaId/preview/:index", async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"));
    const file = await previews.get(ctx, media, Number(c.req.param("index")), c.req.raw.signal);
    return serveFile(c.req.raw, file);
  });

  r.on("GET", ["/media/:mediaId/waveform", "/projects/:projectId/media/:mediaId/waveform"], async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    // The timeline's drawing never asks for voice activity. A read that does is a tool's, such as a running edit's
    // inspection of a cut, so a waveform it lacks is prepared for it while the project's media work is paused too.
    const cache = c.req.query("cachedOnly") === "1"
      ? await readWaveformCache(ctx, media.projectId, media.id, media.status === "failed" ? undefined : media.path)
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
      if (from < 0 || to > duration + 0.000001 || to <= from || to > from + 60) {
        throw badRequest("bad_speech_range", "Choose up to 60 seconds within the source audio.");
      }
      const file = fileInDirectory(ctx.paths.media(media.projectId), media.path);
      if (!file) throw notFound("source file");
      const info = await stat(file);
      const key = JSON.stringify(["vad", file, media.hash, info.size, info.ctimeMs, info.mtimeMs, from, to]);
      // Up to a minute, read because someone asked: a running edit checks its joins with it while caching is paused too.
      const spans = await speech.get(key, () => ctx.track(speechActivity(file, from, to, ctx.projectSignal(media.projectId))));
      return c.json({ mediaId: media.id, from, to, ...wf, speechActivity: spans });
    }
    return c.json({ mediaId: media.id, from, to, peaks: wf.peaks, rms: wf.rms });
  });

  r.on("GET", ["/media/:mediaId/transcript", "/projects/:projectId/media/:mediaId/transcript"], async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    const from = c.req.query("from") !== undefined ? numberParam(c.req.query("from"), "from") : null;
    const to = c.req.query("to") !== undefined ? numberParam(c.req.query("to"), "to") : null;
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
      return c.json(transcripts.search(transcript, search, contextWords));
    }
    return c.json(c.req.query("audioSources") === "1" && from !== null && to !== null && !omitWords
      ? await ctx.track(readSources(media.projectId, media, transcript, from, to)) : transcript);
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
    // Runs in the background; the task is returned immediately and updated over WS.
    const { task, done } = startTranscription(ctx, projectId, asset, body.provider, "refuse");
    ctx.track(done.catch(() => null));
    return c.json({ task }, 202);
  });

  r.on("GET", ["/media/:mediaId/frame", "/projects/:projectId/media/:mediaId/frame"], async (c) => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    if (media.kind === "audio") throw badRequest("no_video", "audio media has no frames");
    const t = numberParam(c.req.query("t"), "t", 0);
    const w = Math.min(3840, Math.max(16, numberParam(c.req.query("w"), "w", 640)));
    const file = join(ctx.paths.media(media.projectId), media.path);
    // A recording moved or deleted outside Scarlet is asked for with every scrub.
    const source = await stat(file).catch(() => null);
    if (!source) throw notFound("source file");
    const preview = c.req.query("preview") === "1";
    const key = JSON.stringify([file, media.hash, source.size, source.mtimeMs, source.ctimeMs, t, w, preview]);
    const frame = async (demand: AbortSignal) => {
      const signal = AbortSignal.any([demand, ctx.projectSignal(media.projectId)]);
      if (preview && media.fps && media.width && media.height) {
        const minimumHeight = Math.ceil(w * media.height / media.width);
        const picture = await previewPictures(ctx.paths.media(media.projectId), { signal })(media, t, t + 1 / media.fps, minimumHeight);
        if (picture) {
          try { return await ctx.render.extractFrame(picture.file, Math.max(0, t - picture.start), { width: w, signal, indexedMp4: true }); }
          catch { signal.throwIfAborted(); } // An evicted or damaged preview can be sampled from the original.
        }
      }
      const indexedMp4 = preview && !!media.previewClock && hasIndexedAvc(media);
      // The original decodes on an NVIDIA GPU when there is one.
      const decoder = await pictureDecoder(ctx.settings().render.hwaccel) === "cuda" ? "cuda" as const : undefined;
      return ctx.render.extractFrame(file, t, { width: w, signal, indexedMp4, decoder });
    };
    try {
      // Frames share the engine’s picture lane with contact sheets. The editor’s own requests go first.
      const priority = c.req.query("priority") === "interactive";
      const jpeg = await frames.get(key, signal => ctx.track(pictureLane(ctx).run(() => frame(signal), { priority, signal })), {
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
