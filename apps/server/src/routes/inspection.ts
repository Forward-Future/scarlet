import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { audition, soundPicture, contactSheet, renderTimelineFrame, fileInDirectoryAsync, heardAudio, heardAudioKey, pictureActivity, PREVIEW_COPY_ACTIVITY_THRESHOLD, reviewWindow, snapRange, type HeardAudio, type PictureActivity } from "@scarlet/render";
import { AcousticWordsRequest, InspectionReviewRequest, PictureActivityRequest, SheetRequest, TimelinePicturesRequest, SourceAudioRequest, SoundPictureRequest, DialogueRangeRequest, DialogueScanRequest, DialogueWindowRequest, type CutEvent, type InspectionResult, type InspectionWindow, type PictureActivityWindow } from "@scarlet/shared";
import { applyOps, diffTimelines, timelineDuration, TimelineOp, type MediaAsset, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { prepareCutReview } from "../services/changes.js";
import { sharedDialogueDetector } from "../services/dialogueDetections.js";
import { transcribeForDialogue } from "../services/transcription.js";
import { inspectionPictures } from "../services/inspectionPictures.js";
import { pictureDecoder, pictureLane } from "../services/pictureWork.js";
import { previewCopyByTime, previewPictures } from "../services/previewPictures.js";
import { AnalysisCache } from "../services/analysisCache.js";
import { resolveTimeline } from "../services/timeline.js";
import { emissionStorePaths } from "../services/recordingAudio.js";
import { transcriptLanguage } from "../services/transcriptReader.js";
import { readCachedAcousticWords } from "../transcribe/acousticWords.js";
import { readsEnglishSpeech } from "../transcribe/wordAlign.js";
import { jsonBody, requireMedia, requireProject, requireProjectHeader } from "./util.js";

type WindowPlan = {
  label: string;
  id: string;
  range: TimeRange;
  focus?: number;
} & ({ clock: "source"; media: MediaAsset } | { clock: "timeline"; media?: never });
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
  const dialogue = sharedDialogueDetector(ctx);
  // One transcript attempt per source per pass, so a failing provider is not retried on every page.
  const transcribing = new Set<string>();
  const pictures = inspectionPictures(ctx);
  type Analysis = Pick<InspectionWindow, "jpeg" | "columns" | "timestamps" | "events" | "wav" | "note">;
  const cache = new AnalysisCache<Analysis>(a =>
    a.jpeg.length + (a.wav?.length ?? 0) + (a.events?.length ?? 0) * 64 + a.timestamps.length * 8, 24 * 1024 * 1024);

  // Sheet tiles are at most 320x180 and activity compares 192x108 frames, so a source's verified
  // preview copy shows what its original would, decoding about six times faster than 4K.
  async function sourcePicture(project: Pick<Project, "id">, media: MediaAsset, range: TimeRange, mode: WindowOptions["mode"]) {
    const height = Math.min(Math.max(mode === "activity" ? 540 : 180, ctx.settings().render.previewHeight), media.height ?? 0);
    if (!height) return;
    const root = ctx.paths.media(project.id);
    // A sheet's tiles and a window's activity are pictures at their times, so a recording without a steady frame rate
    // is read from its whole copy too.
    return await previewPictures(root)(media, range.start, range.end, height).catch(() => undefined)
      ?? await previewCopyByTime(root, media, height).catch(() => undefined);
  }

  /** The file to listen to, and what to hear from it: a confirmed voice's input, or the track the editor chose. */
  async function audioSource(projectId: string, { mediaId, to, voice }: { mediaId: string; to: number; voice?: string }) {
    const media = requireMedia(ctx, mediaId, projectId);
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "Choose a source with audio.");
    if (!media.duration || to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
    const file = await fileInDirectoryAsync(ctx.paths.media(projectId), media.path);
    if (!file) throw notFound("source file");
    if (voice && !media.voiceRoles) throw badRequest("voice_roles_missing", "This recording has no confirmed voice inputs.");
    const audio: HeardAudio = voice ? { audioTrack: media.voiceRoles![voice === "me" ? "me" : "other"] - 1 } : heardAudio(media);
    return { file, audio };
  }

  async function collect(project: Pick<Project, "id" | "settings">, plans: WindowPlan[], options: WindowOptions): Promise<InspectionResult> {
    const signal = ctx.projectSignal(project.id);
    const renderIds: string[] = [];
    const inputs = await Promise.all(plans.map(async ({ media, ...plan }) => {
      if (media) {
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
        origin, local, plan.focus, fps, options, input.media?.color?.hdr, input.media && heardAudioKey(heardAudio(input.media))]);
      const analysis = await cache.get(key, () => ctx.track((async () => {
        const sheetOptions = { ...options, focus: plan.focus, fps, sourceWidth: input.sourceWidth, signal };
        // Decodes take turns in the engine's picture lane.
        const lane = pictureLane(ctx);
        if (options.review) return lane.run(() => reviewWindow(file, local, { ...sheetOptions, origin, tempDir: ctx.paths.tmp, audio: input.media && heardAudio(input.media) }), { signal });
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
        // An HDR original's pictures are tone-mapped to SDR, as its preview copy's already are.
        return fromCopy || lane.run(() => contactSheet(file, local, { ...sheetOptions, origin, decoder, hdr: input.media?.color?.hdr }), { signal });
      })(), project.id));
      return { ...plan, range: { start: origin + local.start, end: origin + local.end }, ...analysis };
    }));
    return { state: "ready", windows };
  }

  r.post("/projects/:id/contact-sheet", async c => {
    const body = await jsonBody(c, SheetRequest);
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const range = { start: body.from, end: body.to };
    let plan: WindowPlan;
    if (body.mediaId) {
      const media = requireMedia(ctx, body.mediaId, project.id);
      if (media.kind === "audio" || !media.duration) throw badRequest("no_video", "Choose a moving video source.");
      if (body.to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
      plan = { label: "Source", clock: "source", media, id: media.id, range, focus: body.focus };
    } else {
      const timeline = resolveTimeline(ctx, project, body.version);
      if (body.to > timelineDuration(timeline) + 0.000001) throw badRequest("outside_timeline", "Window exceeds timeline duration.");
      const projectSignal = ctx.projectSignal(project.id);
      try {
        const window = await pictures(ctx.repos.projects.withMedia(project), timeline, range, body.mode, body.count, body.focus, c.req.raw.signal);
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
  // Moments of an edit as the viewer would see them. With `ops`, the edit is laid on the version and drawn without
  // being saved, so an agent can look at a framing before it is in the video.
  r.post("/projects/:id/timeline-pictures", async c => {
    const body = await jsonBody(c, TimelinePicturesRequest);
    const project = requireProject(ctx, c.req.param("id"));
    let timeline = resolveTimeline(ctx, project, body.version);
    if (body.ops?.length) {
      const checked = TimelineOp.array().safeParse(body.ops);
      if (!checked.success) throw badRequest("bad_ops", checked.error.issues.slice(0, 5).map(i => `ops[${i.path.join(".")}]: ${i.message}`).join("; "));
      try { timeline = applyOps(timeline, checked.data); }
      catch (error) { throw badRequest("bad_ops", (error as Error).message); }
    }
    const { fps } = project.settings, duration = timelineDuration(timeline);
    const root = ctx.paths.media(project.id);
    const signal = AbortSignal.any([c.req.raw.signal, ctx.projectSignal(project.id)]);
    const lane = pictureLane(ctx);
    const pictures = await Promise.all(body.times.map(async asked => {
      const frame = Math.min(Math.max(0, Math.ceil(duration * fps - 1e-6) - 1), Math.floor(asked * fps + 1e-6));
      const range = { start: frame / fps, end: (frame + 1) / fps };
      const lutRoots = [ctx.paths.styleGuidesLibrary];
      const jpeg = await ctx.track(lane.run(() =>
        renderTimelineFrame(project, timeline, range, root, signal, body.width, { pictureSource: previewPictures(root, { signal }), lutRoots })
          .catch(error => { signal.throwIfAborted(); ctx.log(`[inspection] drawing ${range.start.toFixed(2)} s from the originals: ${(error as Error).message}`);
            return renderTimelineFrame(project, timeline, range, root, signal, body.width, { lutRoots }); }), { signal }), project.id);
      return { time: asked, jpeg: jpeg.toString("base64") };
    }));
    return c.json({ pictures });
  });

  r.post("/projects/:id/picture-activity", async c => {
    const { windows } = await jsonBody(c, PictureActivityRequest);
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const signal = ctx.projectSignal(project.id);
    const assets = ctx.repos.projects.assets(project.id, new Set(windows.map(w => w.mediaId)));
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    const measured = await Promise.all(windows.map(async ({ mediaId, from, to }): Promise<PictureActivityWindow> => {
      const media = byId.get(mediaId);
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
      })(), project.id));
      return { mediaId, from, to, ...result };
    }));
    return c.json({ windows: measured });
  });

  r.post("/projects/:id/dialogue-detections", async c => {
    const { mediaId, from, to, taskId, startedAt, keptSide } = await jsonBody(c, DialogueWindowRequest);
    const projectId = c.req.param("id");
    const media = requireMedia(ctx, mediaId, projectId);
    return c.json(await dialogue.detect(projectId, media, from, to, taskId, startedAt, keptSide));
  });

  r.post("/projects/:id/dialogue-acoustic-words", async c => {
    const { mediaId, from, to, audioStream } = await jsonBody(c, AcousticWordsRequest);
    const media = requireMedia(ctx, mediaId, c.req.param("id"));
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "Choose a source with dialogue.");
    if (!media.duration || to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
    const language = transcriptLanguage(ctx, media.projectId, media) || ctx.settings().transcription.language;
    if (language !== "auto" && !readsEnglishSpeech(language)) return c.json([]);
    const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
    if (!file) throw notFound("source file");
    const imported = join(ctx.paths.media(media.projectId), media.path);
    // A pass names a stream other than the first only for a voice's own input. Otherwise it hears the chosen track.
    for (const path of await emissionStorePaths(ctx, media.projectId, file, imported, audioStream ? { audioTrack: audioStream } : heardAudio(media))) {
      const runs = await readCachedAcousticWords(path, from, to);
      if (runs.length) return c.json(runs);
    }
    return c.json([]);
  });

  r.post("/projects/:id/dialogue-scan", async c => {
    const { mediaId, from, to, taskId, startedAt } = await jsonBody(c, DialogueScanRequest);
    const projectId = c.req.param("id");
    const media = requireMedia(ctx, mediaId, projectId);
    const scan = await dialogue.start(projectId, media, from, to, taskId, startedAt);
    const key = `${taskId}/${media.id}`;
    if (!transcribing.has(key)) {
      transcribing.add(key);
      transcribeForDialogue(ctx, projectId, media);
    }
    return c.json(scan);
  });

  r.post("/projects/:id/dialogue-checkpoints", async c => {
    const { mediaId, from, to } = await jsonBody(c, DialogueRangeRequest);
    const projectId = c.req.param("id");
    const media = requireMedia(ctx, mediaId, projectId);
    return c.json(await dialogue.checkpoints(projectId, media, from, to));
  });

  // The verbatim words a pass's scan pages saved, without reading any more: the transcript tidies a restart away.
  r.post("/projects/:id/dialogue-verbatim", async c => {
    const { mediaId, from, to } = await jsonBody(c, DialogueRangeRequest);
    const projectId = c.req.param("id");
    return c.json(await dialogue.savedWords(projectId, requireMedia(ctx, mediaId, projectId), from, to));
  });

  r.post("/projects/:id/source-audio", async c => {
    const { mediaId, from, to, voice } = await jsonBody(c, SourceAudioRequest);
    const projectId = c.req.param("id");
    const { file, audio } = await audioSource(projectId, { mediaId, to, voice });
    return c.json({ wav: await ctx.track(audition(file, { start: from, end: to }, ctx.projectSignal(projectId), audio), projectId) });
  });

  r.post("/projects/:id/sound-picture", async c => {
    const { mediaId, from, to, remove, voice, words } = await jsonBody(c, SoundPictureRequest);
    const projectId = c.req.param("id");
    const { file, audio } = await audioSource(projectId, { mediaId, to, voice });
    const { jpeg, layout } = await ctx.track(soundPicture(file, { range: { start: from, end: to }, remove, words, audio, signal: ctx.projectSignal(projectId) }), projectId);
    return c.json({ jpeg: jpeg.toString("base64"), layout });
  });

  r.post("/projects/:id/review-cut", async c => {
    const body = await jsonBody(c, InspectionReviewRequest);
    const project = requireProjectHeader(ctx, c.req.param("id"));
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
