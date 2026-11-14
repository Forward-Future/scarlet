import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { audition, soundPicture, contactSheet, fileInDirectoryAsync, pictureActivity, PREVIEW_COPY_ACTIVITY_THRESHOLD, qualityEvents, snapRange, type PictureActivity } from "@scarlet/render";
import { AcousticWordsRequest, InspectionReviewRequest, PictureActivityRequest, SheetRequest, SourceAudioRequest, SoundPictureRequest, DialogueRangeRequest, DialogueScanRequest, DialogueWindowRequest, type CutEvent, type InspectionResult, type InspectionWindow, type PictureActivityWindow } from "@scarlet/shared";
import { diffTimelines, timelineDuration, type MediaAsset, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { prepareCutReview } from "../services/changes.js";
import { dialogueDetector } from "../services/dialogueDetections.js";
import { transcribeForDialogue } from "../services/ingest.js";
import { inspectionPictures } from "../services/inspectionPictures.js";
import { pictureDecoder, pictureLane } from "../services/pictureWork.js";
import { previewPictures } from "../services/previewPictures.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { resolveTimeline } from "../services/timeline.js";
import { emissionStorePaths } from "../services/recordingAudio.js";
import { transcriptLanguage } from "../services/transcriptReader.js";
import { readCachedAcousticWords } from "../transcribe/acousticWords.js";
import { alignsLanguage } from "../transcribe/wordAlign.js";
import { jsonBody, requireMedia, requireProject } from "./util.js";

interface WindowPlan {
  label: string;
  clock: "source" | "timeline";
  id: string;
  range: TimeRange;
  focus?: number;
}
interface WindowOptions { count: number; mode: "uniform" | "scene" | "activity"; review?: boolean; includeAudio?: boolean }

// Align each baseline with the proposed join. For a removal, only the retained
// side of each original boundary explains events seen on the corresponding side.
export function newCutEvents(before: InspectionWindow[], after: InspectionWindow, fps: number) {
  const events: CutEvent[] = [];
  for (const event of after.events ?? []) {
    const audio = event.kind.startsWith("level-");
    const tolerance = audio ? 0.12 : 1 / fps;
    let pieces: TimeRange[] = [{ start: event.start, end: event.end }];
    for (const window of before) {
      const shift = after.focus! - window.focus!;
      for (const original of window.events ?? []) {
        if (original.kind !== event.kind) continue;
        if (audio && Math.abs(event.deltaDb!) > Math.abs(original.deltaDb!) + 6) continue;
        const a = Math.max(original.start, window.label === "Before incoming" ? window.focus! : -Infinity);
        const b = Math.min(original.end, window.label === "Before outgoing" ? window.focus! : Infinity);
        if (a > b) continue;
        const lo = a + shift - tolerance, hi = b + shift + tolerance;
        pieces = pieces.flatMap(p => {
          if (p.end < lo || p.start > hi) return [p];
          const rest: TimeRange[] = [];
          if (p.start < lo) rest.push({ start: p.start, end: lo });
          if (p.end > hi) rest.push({ start: hi, end: p.end });
          return rest;
        });
      }
    }
    events.push(...pieces.filter(p => audio || p.end - p.start >= tolerance - 0.000001).map(p => ({ ...event, ...p })));
  }
  return events;
}

export function inspectionRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const dialogue = dialogueDetector(ctx);
  // One transcript attempt per source per pass, so a failing provider is not retried on every page.
  const transcribing = new Set<string>();
  const pictures = inspectionPictures(ctx);
  type Analysis = Pick<InspectionWindow, "jpeg" | "columns" | "timestamps" | "events" | "wav">;
  const cache = new AnalysisCache<Analysis>(a =>
    a.jpeg.length + (a.wav?.length ?? 0) + (a.events?.length ?? 0) * 64 + a.timestamps.length * 8, 24 * 1024 * 1024);

  // Sheet tiles are at most 320x180 and activity compares 192x108 frames, so a source's verified
  // preview copy shows what its original would, decoding about six times faster than 4K.
  async function sourcePicture(project: Project, media: MediaAsset, range: TimeRange, mode: WindowOptions["mode"]) {
    const height = Math.min(Math.max(mode === "activity" ? 540 : 180, ctx.settings().render.previewHeight), media.height ?? 0);
    if (!height) return;
    return previewPictures(ctx.paths.media(project.id))(media, range.start, range.end, height).catch(() => undefined);
  }

  async function collect(project: Project, plans: WindowPlan[], options: WindowOptions): Promise<InspectionResult> {
    const signal = ctx.projectSignal(project.id);
    const renderIds: string[] = [];
    const inputs = await Promise.all(plans.map(async plan => {
      if (plan.clock === "source") {
        const media = project.media.find(m => m.id === plan.id);
        if (!media) throw notFound("media");
        const file = await fileInDirectoryAsync(ctx.paths.media(project.id), media.path);
        if (!file) throw notFound("source file");
        return { plan, file, origin: 0, local: plan.range, sourceWidth: media.width, fps: media.fps || project.settings.fps, media };
      }
      const range = snapRange(plan.range, project.settings.fps);
      const render = ctx.renders.request({ projectId: project.id, version: plan.id, range, kind: "segment", quality: "preview" });
      if (render.state !== "done" || !render.path) {
        renderIds.push(render.id);
        return;
      }
      const file = await fileInDirectoryAsync(ctx.paths.renders(project.id), render.path);
      if (!file) throw notFound("preview file");
      return { plan, file, origin: range.start, local: { start: 0, end: range.end - range.start }, fps: project.settings.fps, media: undefined };
    }));
    if (renderIds.length) return { state: "preparing", renderIds };
    const windows = await Promise.all(inputs.map(async input => {
      if (!input) throw new Error("Missing inspection input");
      const { plan, file, origin, local, fps } = input;
      const info = await stat(file);
      const picture = input.media && !options.review ? await sourcePicture(project, input.media, local, options.mode) : undefined;
      const copy = picture && await stat(picture.file).catch(() => undefined);
      const key = JSON.stringify([project.id, plan.id, file, info.size, info.ctimeMs, info.mtimeMs, picture?.file, picture?.start, copy?.mtimeMs,
        origin, local, plan.focus, fps, options]);
      const analysis = await cache.get(key, () => ctx.track((async () => {
        const sheetOptions = { ...options, focus: plan.focus, fps, sourceWidth: input.sourceWidth, signal };
        // Decodes take turns in the engine's picture lane.
        const lane = pictureLane(ctx);
        // The copy's clock runs `start` seconds behind the source. Timestamps stay in source seconds.
        const fromCopy = picture && copy && await lane.run(() => contactSheet(picture.file, { start: local.start - picture.start, end: local.end - picture.start },
          { ...sheetOptions, origin: origin + picture.start, activityThreshold: PREVIEW_COPY_ACTIVITY_THRESHOLD }), { signal }).catch((err: Error) => {
            signal.throwIfAborted();
            ctx.log(`[inspection] Reading ${plan.id} from its original: ${err.message}`);
            return undefined;
          });
        // An original recording is full size, so it decodes on the GPU when there is one. Preview copies and rendered
        // segments are small enough for the CPU.
        const decoder = fromCopy || !input.media ? undefined : await pictureDecoder(ctx.settings().render.hwaccel);
        const sheet = fromCopy || await lane.run(() => contactSheet(file, local, { ...sheetOptions, origin, decoder }), { signal });
        const events = options.review ? await qualityEvents(file, local, origin, signal) : undefined;
        const wav = options.includeAudio ? await audition(file, local, signal) : undefined;
        return { ...sheet, events, wav };
      })()));
      return { ...plan, range: { start: origin + local.start, end: origin + local.end }, ...analysis };
    }));
    return { state: "ready", windows };
  }

  r.post("/projects/:id/contact-sheet", async c => {
    const body = await jsonBody(c, SheetRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const range = { start: body.from, end: body.to };
    let plan: WindowPlan;
    if (body.mediaId) {
      const media = project.media.find(m => m.id === body.mediaId);
      if (!media) throw notFound("media in this project");
      if (media.kind === "audio" || !media.duration) throw badRequest("no_video", "Choose a moving video source.");
      if (body.to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
      plan = { label: "Source", clock: "source", id: media.id, range, focus: body.focus };
    } else {
      const timeline = resolveTimeline(ctx, project, body.version);
      if (body.to > timelineDuration(timeline) + 0.000001) throw badRequest("outside_timeline", "Window exceeds timeline duration.");
      const projectSignal = ctx.projectSignal(project.id);
      try {
        const window = await pictures(project, timeline, range, body.mode, body.count, body.focus, c.req.raw.signal);
        return c.json({ state: "ready", windows: [window] } satisfies InspectionResult);
      } catch (err) {
        projectSignal.throwIfAborted();
        c.req.raw.signal.throwIfAborted();
        ctx.log(`[inspection] Using the rendered preview: ${(err as Error).message}`);
      }
      plan = { label: "Composite", clock: "timeline", id: timeline.version, range, focus: body.focus };
    }
    return c.json(await collect(project, [plan], { count: body.count, mode: body.mode }));
  });

  // A dialogue scan asks about every silence on a page, so the answers are numbers and stay small.
  const activity = new AnalysisCache<PictureActivity>(() => 96, 1024 * 1024);
  r.post("/projects/:id/picture-activity", async c => {
    const { windows } = await jsonBody(c, PictureActivityRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const signal = ctx.projectSignal(project.id);
    const measured = await Promise.all(windows.map(async ({ mediaId, from, to }): Promise<PictureActivityWindow> => {
      const media = project.media.find(m => m.id === mediaId);
      if (!media) throw notFound("media in this project");
      if (media.kind === "audio" || !media.duration) throw badRequest("no_video", "Choose a moving video source.");
      if (to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
      const file = await fileInDirectoryAsync(ctx.paths.media(project.id), media.path);
      if (!file) throw notFound("source file");
      const range = { start: from, end: to }, fps = media.fps || project.settings.fps;
      const [info, picture] = await Promise.all([stat(file), sourcePicture(project, media, range, "activity")]);
      const copy = picture && await stat(picture.file).catch(() => undefined);
      const key = JSON.stringify([project.id, mediaId, file, info.size, info.mtimeMs, picture?.file, picture?.start, copy?.mtimeMs, range, fps]);
      const result = await activity.get(key, () => ctx.track((async () => {
        const lane = pictureLane(ctx);
        // The copy's clock runs `start` seconds behind the source. Times stay in source seconds.
        const fromCopy = picture && copy && await lane.run(() => pictureActivity(picture.file, { start: from - picture.start, end: to - picture.start },
          { origin: picture.start, fps, threshold: PREVIEW_COPY_ACTIVITY_THRESHOLD, signal }), { signal }).catch((err: Error) => {
            signal.throwIfAborted();
            ctx.log(`[inspection] Measuring ${mediaId} from its original: ${err.message}`);
            return undefined;
          });
        if (fromCopy) return fromCopy;
        const decoder = await pictureDecoder(ctx.settings().render.hwaccel);
        return lane.run(() => pictureActivity(file, range, { origin: 0, fps, decoder, signal }), { signal });
      })()));
      return { mediaId, from, to, ...result };
    }));
    return c.json({ windows: measured });
  });

  r.post("/projects/:id/dialogue-detections", async c => {
    const { mediaId, from, to, taskId, startedAt, keptSide } = await jsonBody(c, DialogueWindowRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const media = project.media.find(m => m.id === mediaId);
    if (!media) throw notFound("media in this project");
    return c.json(await dialogue.detect(project.id, media, from, to, taskId, startedAt, keptSide));
  });

  r.post("/projects/:id/dialogue-acoustic-words", async c => {
    const { mediaId, from, to, audioStream } = await jsonBody(c, AcousticWordsRequest);
    const media = requireMedia(ctx, mediaId, c.req.param("id"));
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "Choose a source with dialogue.");
    if (!media.duration || to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
    const language = transcriptLanguage(ctx, media.projectId, media) || ctx.settings().transcription.language;
    if (language !== "auto" && !alignsLanguage(language)) return c.json([]);
    const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
    if (!file) throw notFound("source file");
    const imported = join(ctx.paths.media(media.projectId), media.path);
    for (const path of await emissionStorePaths(ctx, media.projectId, file, imported, audioStream)) {
      const runs = await readCachedAcousticWords(path, from, to);
      if (runs.length) return c.json(runs);
    }
    return c.json([]);
  });

  r.post("/projects/:id/dialogue-scan", async c => {
    const { mediaId, from, to, taskId, startedAt } = await jsonBody(c, DialogueScanRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const media = project.media.find(m => m.id === mediaId);
    if (!media) throw notFound("media in this project");
    const scan = await dialogue.start(project.id, media, from, to, taskId, startedAt);
    const key = `${taskId}/${media.id}`;
    if (!transcribing.has(key)) {
      transcribing.add(key);
      transcribeForDialogue(ctx, project.id, media);
    }
    return c.json(scan);
  });

  r.post("/projects/:id/dialogue-checkpoints", async c => {
    const { mediaId, from, to } = await jsonBody(c, DialogueRangeRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const media = project.media.find(m => m.id === mediaId);
    if (!media) throw notFound("media in this project");
    return c.json(await dialogue.checkpoints(project.id, media, from, to));
  });

  r.post("/projects/:id/source-audio", async c => {
    const { mediaId, from, to, voice } = await jsonBody(c, SourceAudioRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const media = project.media.find(m => m.id === mediaId);
    if (!media) throw notFound("media in this project");
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "Choose a source with audio.");
    if (!media.duration || to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
    const file = await fileInDirectoryAsync(ctx.paths.media(project.id), media.path);
    if (!file) throw notFound("source file");
    if (voice && !media.voiceRoles) throw badRequest("voice_roles_missing", "This recording has no confirmed voice inputs.");
    const stream = voice ? media.voiceRoles![voice === "me" ? "me" : "other"] - 1 : 0;
    return c.json({ wav: await ctx.track(audition(file, { start: from, end: to }, ctx.projectSignal(project.id), stream)) });
  });

  r.post("/projects/:id/sound-picture", async c => {
    const { mediaId, from, to, remove, voice, words } = await jsonBody(c, SoundPictureRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const media = project.media.find(m => m.id === mediaId);
    if (!media) throw notFound("media in this project");
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "Choose a source with audio.");
    if (!media.duration || to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
    const file = await fileInDirectoryAsync(ctx.paths.media(project.id), media.path);
    if (!file) throw notFound("source file");
    if (voice && !media.voiceRoles) throw badRequest("voice_roles_missing", "This recording has no confirmed voice inputs.");
    const stream = voice ? media.voiceRoles![voice === "me" ? "me" : "other"] - 1 : 0;
    const { jpeg, layout } = await ctx.track(soundPicture(file, { range: { start: from, end: to }, remove, words, stream, signal: ctx.projectSignal(project.id) }));
    return c.json({ jpeg: jpeg.toString("base64"), layout });
  });

  r.post("/projects/:id/review-cut", async c => {
    const body = await jsonBody(c, InspectionReviewRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const change = ctx.repos.changes.get(body.changeId);
    if (!change || change.projectId !== project.id) throw notFound("change in this project");
    // Inspect the immutable proposal, including after approval or revision.
    const review = prepareCutReview(ctx, change).review;
    const before = review?.original ?? resolveTimeline(ctx, project, change.fromVersion);
    const after = review?.proposed ?? resolveTimeline(ctx, project, change.toVersion);
    const spots = review ? review.cuts.map(cut => ({ before: cut.removed, after: { start: cut.at, end: cut.at } }))
      : diffTimelines(before, after, project.settings.fps).spots;
    const spot = spots[body.index];
    if (!spot) throw badRequest("no_spot", `Proposal has ${spots.length} reviewable cuts or spots (zero-based index).`);
    const plans: WindowPlan[] = [];
    function add(label: string, tl: Timeline, focus: number) {
      const duration = timelineDuration(tl);
      const range = { start: Math.max(0, focus - body.handles), end: Math.min(duration, focus + body.handles) };
      if (range.end > range.start) plans.push({ label, id: tl.version, clock: "timeline", range, focus });
    }
    if (spot.before.end > spot.before.start && spot.after.end === spot.after.start) {
      add("Before outgoing", before, spot.before.start);
      add("Before incoming", before, spot.before.end);
    } else {
      add("Before", before, spot.before[body.edge]);
    }
    add("After", after, spot.after[body.edge]);
    if (!plans.length) throw conflict("empty_cut", "Neither version has playable footage at this boundary.");
    const result = await collect(project, plans, { count: 6, mode: "uniform", review: true, includeAudio: body.includeAudio });
    if (result.state === "preparing") return c.json(result);
    const original = result.windows.filter(w => w.label !== "After");
    const edited = result.windows.find(w => w.label === "After");
    const newEvents = edited && original.length ? newCutEvents(original, edited, project.settings.fps) : undefined;
    return c.json({ ...result, index: body.index, total: spots.length, newEvents });
  });
  return r;
}
