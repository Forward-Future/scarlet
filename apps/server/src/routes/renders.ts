import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extractFrame, extractFilmstrip, fileInDirectory, probeMedia, renderTimelineFrame } from "@scarlet/render";
import { clipEnd, FILMSTRIP_SEEK_BATCH, MAX_CUT_PLAYBACK_SECONDS, planPlaybackSegments, planSegments, snapToFrame, timelineDuration, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { Hono } from "hono";
import { z } from "zod/v3";
import { fullRenderContext, RenderKind, RenderRequest, type Render } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { requestAttempt, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requestCutPlaybackFile, waitForPlayback } from "../services/playback.js";
import { serveFile } from "../files.js";
import { clip, throttledLog } from "../logText.js";
import { ensureHead } from "../services/timeline.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { pictureDecoder, pictureLane } from "../services/pictureWork.js";
import { previewPictures } from "../services/previewPictures.js";
import { jsonBody, numberParam, requireProject, requireProjectHeader } from "./util.js";

/** Index visible clip intervals once so one still stats only the files that can contribute to its pixels. */
function frameSources(timeline: Timeline) {
  const clips = timeline.tracks.filter(track => track.kind === "video" && !track.hidden)
    .flatMap(track => track.clips.flatMap(clip => clip.kind === "media" && clip.enabled ? [{
      start: clip.timelineIn, end: clipEnd(clip), mediaId: clip.mediaId,
      luts: clip.effects.flatMap(effect => {
        const file = typeof effect.params.file === "string" ? effect.params.file : effect.params.path;
        return effect.enabled && effect.type === "lut" && typeof file === "string" ? [file] : [];
      }),
    }] : [])).sort((a, b) => a.start - b.start);
  let leaves = 1;
  while (leaves < clips.length) leaves *= 2;
  const maxEnds = new Float64Array(leaves * 2);
  clips.forEach((clip, i) => { maxEnds[leaves + i] = clip.end; });
  for (let i = leaves - 1; i > 0; i--) maxEnds[i] = Math.max(maxEnds[i * 2]!, maxEnds[i * 2 + 1]!);
  return (range: TimeRange, paths: Map<string, string>, root: string) => {
    const files = new Set<string>();
    function visit(node: number, first: number, stop: number) {
      if (maxEnds[node]! <= range.start || first >= clips.length || clips[first]!.start >= range.end) return;
      if (stop - first > 1) {
        const middle = (first + stop) >>> 1;
        visit(node * 2, first, middle);
        visit(node * 2 + 1, middle, stop);
        return;
      }
      const clip = clips[first]!;
      const source = paths.get(clip.mediaId);
      if (source) files.add(source);
      for (const lut of clip.luts) {
        const file = fileInDirectory(root, lut);
        if (file) files.add(file);
      }
    }
    visit(1, 0, leaves);
    return [...files].map(file => {
      try {
        const s = statSync(file);
        return [file, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
      } catch { return [file, null]; }
    });
  };
}

export function renderRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  const frames = new AnalysisCache<Buffer>(jpeg => jpeg.length);
  // A GPU or a preview copy that fails does so for every frame of a scrub, so the retry is logged once a minute.
  const retried = throttledLog(line => ctx.log(line));
  async function requestFrame(request: Request, projectId: string, key: string, priority: boolean, cacheControl: string, decode: (signal: AbortSignal) => Promise<Buffer>, etag?: string) {
    try {
      const headers = { "Cache-Control": cacheControl, ...(etag ? { ETag: etag } : {}) };
      if (etag && request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
      // Frames share the engine's picture lane with the agent's contact sheets. The editor's own requests go first.
      const job = frames.get(key, demand => {
        const signal = AbortSignal.any([demand, ctx.projectSignal(projectId)]);
        return ctx.track(pictureLane(ctx).run(() => decode(signal), { priority, signal }));
      }, { signal: request.signal, priority });
      const jpeg = await ctx.track(job);
      return new Response(new Uint8Array(jpeg), { headers: { ...headers, "Content-Type": "image/jpeg" } });
    } catch (error) {
      if (ctx.shutdown.aborted || request.signal.aborted) return new Response(null, { status: ctx.shutdown.aborted ? 503 : 499 });
      throw error;
    }
  }
  // The strip requests several samples from the same immutable cut. Parse it once.
  let sampledTimeline: Timeline | undefined;
  let sourcesAt: ReturnType<typeof frameSources> | undefined;
  let sampledDuration = 0;
  let sampledProject: { revision: string; project: Project; inputs: string; paths: Map<string, string> } | undefined;
  function frameProject(id: string) {
    // total_changes covers this connection, data_version catches commits by another engine.
    const { revision } = ctx.db.prepare("SELECT total_changes() || ':' || data_version AS revision FROM pragma_data_version").get() as { revision: string };
    if (sampledProject?.project.id === id && sampledProject.revision === revision) return sampledProject;
    const project = requireProject(ctx, id);
    const inputs = createHash("sha256").update(JSON.stringify([project.settings, project.media])).digest("hex");
    const paths = new Map(project.media.map(asset => [asset.id, resolve(ctx.paths.media(id), asset.path)]));
    return sampledProject = { revision, project, inputs, paths };
  }
  let playbackPlan: { projectId: string; version: string; fps: number; timeline: Timeline; ranges: TimeRange[]; legacy?: TimeRange[] } | undefined;
  function playbackRangeAt(project: Pick<Project, "id" | "settings">, version: string, time: number, legacy = false) {
    const fps = project.settings.fps;
    if (!playbackPlan || playbackPlan.projectId !== project.id || playbackPlan.version !== version || playbackPlan.fps !== fps) {
      const timeline = sampledTimeline?.projectId === project.id && sampledTimeline.version === version
        ? sampledTimeline : ctx.repos.versions.get(project.id, version)?.timeline;
      if (!timeline) throw notFound(`version ${version}`);
      playbackPlan = { projectId: project.id, version, fps, timeline, ranges: planPlaybackSegments(project, timeline) };
    }
    const ranges = legacy ? playbackPlan.legacy ??= planSegments(project, playbackPlan.timeline) : playbackPlan.ranges;
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (time >= ranges[mid]!.end) lo = mid + 1;
      else hi = mid;
    }
    return ranges[lo];
  }
  r.get("/projects/:id/versions/:version/frame", async c => {
    const { project, inputs, paths } = frameProject(c.req.param("id"));
    const version = c.req.param("version");
    if (sampledTimeline?.projectId !== project.id || sampledTimeline.version !== version) {
      sampledTimeline = ctx.repos.versions.get(project.id, version)?.timeline;
      sampledDuration = sampledTimeline ? timelineDuration(sampledTimeline) : 0;
      sourcesAt = sampledTimeline && frameSources(sampledTimeline);
    }
    const timeline = sampledTimeline;
    if (!timeline) throw notFound("timeline version");
    const frame = numberParam(c.req.query("frame"), "frame");
    const { fps, width, height } = project.settings;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= Math.ceil(sampledDuration * fps - 1e-6))
      throw badRequest("outside_timeline", "Choose a frame within the timeline.");
    const range = { start: frame / fps, end: (frame + 1) / fps };
    const monitor = c.req.query("view") === "monitor";
    const size = monitor ? 960 : c.req.query("w") === "640" ? 640 : 160;
    const key = createHash("sha256").update(JSON.stringify([project.id, version, frame, size, inputs, sourcesAt!(range, paths, ctx.paths.media(project.id))])).digest("hex");
    const sameFormat = c.req.query("format") === `${width}x${height}@${fps}`;
    return requestFrame(c.req.raw, project.id, key, monitor || c.req.query("priority") === "interactive", sameFormat ? "private, no-cache" : "no-store", async signal => {
      const time = frame / fps;
      const targetHeight = Math.min(height, ctx.settings().render.previewHeight, Math.ceil(size * height / Math.max(width, height)));
      const preview = ctx.renders.coveringPreview(project, version, range, targetHeight);
      const file = preview?.path && fileInDirectory(ctx.paths.renders(project.id), preview.path);
      if (file) {
        try {
          const local = time - (preview.range?.start ?? 0);
          return await extractFrame(file, Math.max(0, local - 0.1 / fps), {
            width: Math.round(width * Math.min(1, size / Math.max(width, height))), signal,
          });
        } catch { signal.throwIfAborted(); } // Sample the timeline if the cached file is damaged.
      }
      const root = ctx.paths.media(project.id);
      const pictures = previewPictures(root, { signal });
      let usedProxy = false;
      // An original recording decodes on the GPU when there is one; the CPU retries if the driver can't.
      const decoder = await pictureDecoder(ctx.settings().render.hwaccel);
      try {
        return await renderTimelineFrame(project, timeline, range, root, signal, size, {
          decoder,
          pictureSource: async (asset, ...args) => {
            const picture = await pictures(asset, ...args);
            if (picture) usedProxy = true;
            return picture;
          },
        });
      } catch (error) {
        if ((!usedProxy && !decoder) || signal.aborted) throw error;
        retried("frame", `[render] reading a frame of ${version} again from the originals on the CPU: ${clip((error as Error).message, 300)}`);
        return renderTimelineFrame(project, timeline, range, root, signal, size);
      }
    }, sameFormat ? `"${key}"` : undefined);
  });

  function requireRender(renderId: string, projectId?: string) {
    const render = ctx.repos.renders.get(renderId);
    if (!render || (projectId !== undefined && render.projectId !== projectId)) throw notFound(`render ${renderId}`);
    return render;
  }
  async function playbackFile(request: Request, render: Render) {
    const file = await waitForPlayback(ctx, render, AbortSignal.any([request.signal, ctx.shutdown]));
    if (!file) return new Response(null, { status: ctx.shutdown.aborted ? 503 : 499 });
    return serveFile(request, file, {
      cacheControl: request.method === "GET" ? "private, max-age=31536000, immutable" : "private, no-store",
    });
  }

  r.post("/projects/:id/versions/:version/prepare-playback", async c => {
    const { times } = await jsonBody(c, z.object({ times: z.array(z.number().finite().nonnegative()).min(1).max(3) }));
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const version = c.req.param("version");
    if (!ctx.repos.versions.exists(project.id, version)) throw notFound(`version ${version}`);
    if (project.mediaPaused) return c.body(null, 204);
    const ranges = new Set(times.map(time => {
      const range = playbackRangeAt(project, version, time);
      if (!range) throw badRequest("outside_timeline", "Choose a position within the timeline.");
      return range;
    }));
    const signal = AbortSignal.any([c.req.raw.signal, ctx.mediaSignal(project.id)]);
    const owner = randomUUID();
    await ctx.track((async () => {
      for (const range of ranges) {
        if (signal.aborted) break;
        const current = ctx.repos.projects.header(project.id);
        if (!current || current.mediaPaused || current.settings.fps !== project.settings.fps || ctx.renders.fullPreview(current, version)) break;
        const render = ctx.renders.request({ projectId: project.id, version, range, kind: "playback", quality: "preview", speculative: true }, owner);
        try { await waitForPlayback(ctx, render, signal); }
        finally { ctx.renders.release(render.id, owner); }
      }
    })());
    if (ctx.shutdown.aborted || c.req.raw.signal.aborted) return new Response(null, { status: ctx.shutdown.aborted ? 503 : 499 });
    return c.body(null, 204);
  });

  // A self-contained review movie lets the player decode both sides of the join before the editor opens it.
  r.post("/projects/:id/versions/:version/cut-playback-file", async c => {
    const seconds = z.number().finite().nonnegative();
    const desired = await jsonBody(c, z.object({ start: seconds, end: seconds }));
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const version = c.req.param("version");
    const savedDuration = ctx.repos.versions.duration(project.id, version);
    if (savedDuration === undefined) throw notFound(`version ${version}`);
    const fps = project.settings.fps;
    const duration = snapToFrame(savedDuration, fps);
    if (desired.end <= desired.start || desired.end - desired.start > MAX_CUT_PLAYBACK_SECONDS + 1e-6 || desired.start >= duration || desired.end > duration + 1 / fps)
      throw badRequest("invalid_review_window", "Choose up to 12 seconds within the cut.");
    if (project.mediaPaused) throw conflict("media_paused", "Media preparation is paused.");
    const range = { start: Math.floor(desired.start * fps + 1e-6) / fps,
      end: Math.min(duration, Math.ceil(desired.end * fps - 1e-6) / fps) };
    const owner = randomUUID();
    const render = requestCutPlaybackFile(ctx, project, version, range, owner);
    const signal = AbortSignal.any([c.req.raw.signal, ctx.mediaSignal(project.id)]);
    try {
      const file = await ctx.track(waitForPlayback(ctx, render, signal));
      if (!file) return new Response(null, { status: ctx.shutdown.aborted ? 503 : 499 });
      return c.json({ renderId: render.id, ...(render.range ?? { start: 0, end: duration, full: true }) });
    } finally { ctx.renders.release(render.id, owner); }
  });

  r.post("/projects/:id/renders", async (c) => {
    const body = await jsonBody(c, RenderRequest);
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    const head = project.head && ctx.repos.versions.exists(project.id, project.head) ? project.head : ctx.db.transaction(() => {
      requireProjectEditAttempt(ctx, attempt, project.id);
      return ensureHead(ctx, project.id).head;
    }, "immediate")();
    const version = body.version && body.version !== "head" ? body.version : head;
    if (version !== head && !ctx.repos.versions.exists(project.id, version)) throw notFound(`version ${version}`);
    if ((body.kind === "segment" || body.kind === "playback") && !body.range) throw badRequest("range_required", "segment renders need a range");
    if (body.range && body.range.end <= body.range.start) throw badRequest("empty_range", "a render range must have a positive duration");
    if (body.kind === "playback") {
      const requested = body.range!;
      const matches = (range?: TimeRange) => range?.start === requested.start && range.end === requested.end;
      // An older desktop may still request its ten-second canonical windows.
      if (body.quality !== "preview" || (!matches(playbackRangeAt(project, version, requested.start)) &&
          !matches(playbackRangeAt(project, version, requested.start, true)))) {
        throw badRequest("invalid_playback_range", "Choose a playback segment from this edit");
      }
    }
    const wait = c.req.query("wait") === "1";
    if (wait && body.kind !== "playback") throw badRequest("invalid_wait", "Only playback fragments support an inline response.");
    if (body.exportOptions && body.kind !== "export") throw badRequest("invalid_export_options", "Use an export render for custom output settings.");
    if (body.kind === "export" && body.range) {
      const timeline = ctx.repos.versions.get(project.id, version)?.timeline;
      if (!timeline) throw notFound("timeline version");
      const fps = project.settings.fps;
      const start = snapToFrame(body.range.start, fps);
      const end = snapToFrame(body.range.end, fps);
      if (start < 0 || end <= start || end > snapToFrame(timelineDuration(timeline), fps))
        throw badRequest("invalid_export_range", "Choose at least one frame within the working edit.");
      body.range = { start, end };
    }
    if (body.owner && body.kind !== "export" && (body.kind !== "full" || body.range))
      throw badRequest("invalid_owner", "Only exports and full-cut renders accept an owner.");
    if (body.export && (!body.owner || (body.kind !== "export" && body.kind !== "full")))
      throw badRequest("invalid_export", "Only an owned export can be kept across a restart.");
    if (wait && c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    const owner = wait ? randomUUID() : body.owner;
    const render = ctx.db.transaction(() => {
      requireProjectEditAttempt(ctx, attempt, project.id);
      return ctx.renders.request({
        projectId: project.id,
        version,
        kind: body.range && body.kind === "full" ? "segment" : body.kind,
        range: body.range ?? null,
        quality: body.quality,
        exportOptions: body.exportOptions,
      }, owner, body.export);
    }, "immediate")();
    if (wait) {
      try { return await playbackFile(c.req.raw, render); }
      finally { ctx.renders.release(render.id, owner!); }
    }
    return c.json({ render }, 201);
  });
  r.get("/exports", c => c.json({ renders: ctx.renders.exports() }));
  r.delete("/renders/:renderId/owners/:owner", c => {
    ctx.renders.release(c.req.param("renderId"), c.req.param("owner"));
    return c.body(null, 204);
  });

  r.on("GET", ["/renders/:renderId", "/projects/:projectId/renders/:renderId"], async (c) => {
    const render = requireRender(c.req.param("renderId"), c.req.param("projectId"));
    if (c.req.query("inspectFile") !== "true" || render.state !== "done") return c.json({ render });
    const file = render.path && fileInDirectory(ctx.paths.renders(render.projectId), render.path);
    if (!file) throw notFound("render file");
    const { duration, width, height, fps, bitrate, videoCodec, audioCodec, hasAudio, sampleRate, channels } = await probeMedia(file);
    return c.json({ render, fileInfo: { duration, width, height, fps, bitrate, videoCodec, audioCodec, hasAudio, sampleRate, channels } });
  });

  r.get("/renders/:renderId/filmstrip", async c => {
    const render = requireRender(c.req.param("renderId"));
    if (render.kind !== "full" || render.quality !== "preview" || render.state !== "done" || !render.path ||
        render.version !== c.req.query("version") || !render.projectSettings || !render.durationSeconds) throw notFound("version preview");
    const { fps } = render.projectSettings;
    const list = c.req.query("frames") ?? "";
    if (!/^\d{1,12}(,\d{1,12}){0,19}$/.test(list)) throw badRequest("bad_frames", "Choose 1 to 20 preview frames.");
    const samples = list.split(",").map(Number);
    const last = samples[samples.length - 1]!;
    if (last >= Math.ceil(render.durationSeconds * fps - 1e-6) || (samples.length > FILMSTRIP_SEEK_BATCH && last - samples[0]! > fps * 60) ||
        samples.some((sample, i) => i > 0 && sample <= samples[i - 1]!)) {
      throw badRequest("bad_frames", `Choose increasing frames within the preview. Beyond a 60-second window, choose up to ${FILMSTRIP_SEEK_BATCH} at once.`);
    }
    const layout = c.req.query("layout") === "source-aspect" ? "source-aspect" : "16:9";
    const key = JSON.stringify(["filmstrip", render.projectId, render.version, render.id, samples, layout]);
    return requestFrame(c.req.raw, render.projectId, key, false, "private, max-age=31536000, immutable",
      signal => extractFilmstrip(join(ctx.paths.renders(render.projectId), render.path!), samples, fps, signal, layout));
  });

  r.get("/renders/:renderId/file", async (c) => {
    const id = c.req.param("renderId");
    const render = requireRender(id);
    if (render.kind === "playback" && c.req.query("wait") === "1") {
      return playbackFile(c.req.raw, render);
    }
    if (render.state !== "done" || !render.path) throw notFound("render file (not finished)");
    return serveFile(c.req.raw, join(ctx.paths.renders(render.projectId), render.path), { cacheControl: "private, max-age=31536000, immutable" });
  });

  r.get("/projects/:id/renders", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const version = c.req.query("version");
    const target = c.req.query("currentDelivery") !== "true" && version && version !== "head" ? version : project.head;
    const full = target && { projectId: project.id, version: target, kind: "full" as const, range: null };
    const fullRenderKeys = full ? {
      context: fullRenderContext({ ...project, head: target }),
      delivery: ctx.renders.keyFor(project, { ...full, quality: "delivery" }),
      preview: ctx.renders.keyFor(project, { ...full, quality: "preview" }),
    } : undefined;
    const currentRows = (rows: Render[]) => {
      if (!fullRenderKeys) return rows;
      let inputs: Project | undefined;
      return rows.filter(row => {
        if (row.state !== "done" || (row.key !== fullRenderKeys.preview && row.key !== fullRenderKeys.delivery)) return true;
        if (!row.path || !fileInDirectory(ctx.paths.renders(project.id), row.path)) return false;
        inputs ??= frameProject(project.id).project;
        return ctx.renders.isCurrent(row, inputs);
      });
    };
    if (c.req.query("currentDelivery") === "true") {
      const key = fullRenderKeys?.delivery ?? null;
      const renders = key ? ctx.repos.renders.select("project_id = ? AND key = ?", [project.id, key], "created_at DESC") : [];
      return c.json({ currentDeliveryKey: key, renders: currentRows(renders) });
    }
    const where = ["project_id = ?"];
    const params: unknown[] = [project.id];
    const kind = c.req.query("kind");
    if (kind) {
      where.push("kind = ?");
      params.push(RenderKind.parse(kind));
    }
    if (version) {
      where.push("version = ?");
      params.push(version === "head" ? project.head : version);
    }
    const rows = ctx.repos.renders.select(where.join(" AND "), params, "created_at DESC");
    return c.json({ fullRenderKeys, renders: version && kind === "full" ? currentRows(rows) : rows });
  });

  return r;
}
