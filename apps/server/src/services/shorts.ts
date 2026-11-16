import { execFile } from "node:child_process";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { ASPECT_PRESETS, createProject, newId, timelineDuration, type MediaAsset, type Project, type Timeline } from "@scarlet/timeline";
import type { MakeShortsRequest, ShortsPlanRequest, Task, User } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { createTask } from "./tasks.js";
import { resolveTimeline, storeVersion } from "./timeline.js";
import { recoverSourcePreviews } from "./sourcePreviews.js";
import { cloneOrSteadyCopy } from "./steadyCopy.js";
import { discardProjects } from "./trash.js";

const run = promisify(execFile);

async function cloneDirectory(from: string, to: string) {
  if (!(await stat(from).catch(() => null))?.isDirectory()) return;
  await mkdir(to, { recursive: true });
  if (process.platform === "darwin") await run("/bin/cp", ["-cR", from + "/.", to]);
  else await cp(from, to, { recursive: true });
}

const SHAPE: Record<MakeShortsRequest["aspect"], string> = { "9:16": "vertical", "1:1": "square", "4:5": "portrait" };

function length(seconds: number) {
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** The request as the editor made it in the form, which is what their chat says they asked. */
export function shortsInstruction(req: Pick<MakeShortsRequest, "count" | "aspect" | "maxSeconds" | "captions">) {
  const shape = SHAPE[req.aspect];
  const what = req.count === 1 ? `a ${shape} short under ${length(req.maxSeconds)}` : `up to ${req.count} ${shape} shorts, each under ${length(req.maxSeconds)}`;
  return `Make ${what}${req.captions ? "" : ", without captions"}.`;
}

/** The shorts guide pinned to each request, while the editor has it. Without it the request still runs. */
function shortsSkillIds(ctx: Ctx): string[] | undefined {
  const skill = ctx.repos.skills.select("json_extract(json, '$.name') = ?", ["make-shorts"])[0];
  return skill?.enabled ? [skill.id] : undefined;
}

/**
 * Copy one file of the long video into a short's project: the recording itself, its transcript and the caches made
 * from it, so the short neither imports nor transcribes it again. Caches are best effort: anything missing is made
 * again when it is needed.
 *
 * A recording without a transcript yet doesn't carry the request to transcribe it on import: at the next launch that
 * would start one transcription per short, unasked, beside the long video's own. A short's run that needs its words
 * waits for them, and the copy it reads is transcribed then.
 */
async function copyMedia(ctx: Ctx, from: Project, to: string, asset: MediaAsset, signal?: AbortSignal): Promise<MediaAsset> {
  const id = newId("med");
  const path = id + extname(asset.path);
  await cloneOrSteadyCopy(join(ctx.paths.media(from.id), asset.path), join(ctx.paths.media(to), path), signal);
  // The clone is byte for byte the file that was fingerprinted, so the fingerprint holds for it: its previews can be
  // shared under the recording's hash.
  const info = await stat(join(ctx.paths.media(to), path));
  const fingerprintStamp = asset.fingerprintStamp && asset.hash ? { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } : undefined;
  let transcriptId: string | undefined;
  const transcript = asset.transcriptId ? ctx.repos.transcripts.get(asset.transcriptId) : null;
  if (transcript) {
    transcriptId = newId("trs");
    ctx.repos.transcripts.put({ ...transcript, id: transcriptId, mediaId: id, projectId: to });
  }
  const copy: MediaAsset = { ...asset, id, path, importId: undefined, fingerprintStamp, transcriptId, preparation: undefined, status: undefined,
    transcriptionOnImport: undefined, transcriptionRevisionOnImport: undefined };
  ctx.repos.projects.putMedia(to, copy, "ready");
  // Kept ready to play in the long video, it is kept ready in the short.
  if (ctx.db.prepare("SELECT 1 FROM source_cache_requests WHERE media_id = ?").get(asset.id))
    ctx.db.prepare("INSERT OR IGNORE INTO source_cache_requests (media_id) VALUES (?)").run(id);
  await Promise.all([
    copyCaches(ctx.paths.waveforms(from.id), ctx.paths.waveforms(to), asset.id, id, signal),
    copyCaches(ctx.paths.proxies(from.id), ctx.paths.proxies(to), asset.id, id, signal),
  ]).catch(error => ctx.log(`[shorts] caches for ${asset.id} weren't copied: ${(error as Error).message}`));
  return copy;
}

/** Files named for the recording take the copy's id. Files named for their content are shared as they are. */
async function copyCaches(from: string, to: string, oldId: string, newMediaId: string, signal?: AbortSignal) {
  const names = await readdir(from).catch(() => [] as string[]);
  await mkdir(to, { recursive: true });
  await Promise.all(names.map(async name => {
    const own = name.startsWith(oldId + ".");
    if (!own && !name.startsWith("cached-") && !name.startsWith("emissions-")) return;
    const target = join(to, own ? newMediaId + name.slice(oldId.length) : name);
    if (await stat(target).catch(() => null)) return;
    if ((await stat(join(from, name))).isFile()) await cloneOrSteadyCopy(join(from, name), target, signal);
  }));
}

function remapMedia(timeline: Timeline, ids: Map<string, string>, projectId: string): Timeline {
  return {
    ...timeline, projectId,
    tracks: timeline.tracks.map(track => ({ ...track, clips: track.clips.map(clip => clip.kind === "media" && ids.has(clip.mediaId) ? { ...clip, mediaId: ids.get(clip.mediaId)! } : clip) })),
  };
}

/**
 * Make shorts: one new project per short, each starting as the long video's finished edit on the shape the editor
 * chose, with the same footage, transcripts and style guide. The long video isn't changed. The first short's run
 * chooses every short's moment and starts the others (`planShorts`).
 *
 * Only the files the edit plays come along: a short is cut from the finished edit, and a file the edit doesn't use
 * would be copied once per short for nothing. `signal` stops the copying, as when the request that asked goes away;
 * shorts made part-way are then removed with their files.
 */
export async function makeShorts(ctx: Ctx, user: User, sourceId: string, req: MakeShortsRequest, signal?: AbortSignal): Promise<{ projects: Project[]; task: Task }> {
  const source = ctx.repos.projects.get(sourceId);
  if (!source) throw notFound("project");
  if (source.source) throw badRequest("already_a_short", "This project is a short. Make shorts from the video it was made from.");
  if (!source.head) throw badRequest("no_edit", "There’s no video to make shorts from yet.");
  const timeline = resolveTimeline(ctx, source, source.head);
  const used = new Set(timeline.tracks.flatMap(t => t.clips.flatMap(c => c.kind === "media" ? [c.mediaId] : [])));
  if (!timelineDuration(timeline) || !used.size) throw badRequest("no_edit", "There’s no video to make shorts from yet.");
  const media = ctx.repos.projects.listMedia(source.id);
  if (media.some(m => used.has(m.id) && m.status !== "ready")) throw conflict("media_not_ready", "Wait until this video’s footage has finished preparing.");

  const dims = ASPECT_PRESETS[req.aspect]!;
  const instruction = shortsInstruction(req);
  const projects: Project[] = [];
  for (let index = 1; index <= req.count; index++) {
    const project = createProject(`Short ${index} of ${req.count}`, { ...source.settings, ...dims, aspect: req.aspect });
    ctx.repos.projects.insert({ ...project, source: { projectId: source.id, name: source.name, notice: true } }, true);
    ctx.paths.ensureProject(project.id);
    projects.push(project);
  }
  const stop = signal ? AbortSignal.any([signal, ctx.shutdown]) : ctx.shutdown;
  try {
    for (const project of projects) {
      const ids = new Map<string, string>();
      for (const asset of media.filter(m => used.has(m.id))) {
        stop.throwIfAborted();
        const { status: _s, error: _e, ...plain } = asset;
        ids.set(asset.id, (await copyMedia(ctx, source, project.id, plain, stop)).id);
      }
      await cloneDirectory(ctx.paths.graphics(source.id), ctx.paths.graphics(project.id));
      if (source.styleGuide) {
        await cloneDirectory(ctx.paths.styleGuides(source.id), ctx.paths.styleGuides(project.id));
        ctx.repos.projects.saveStyleGuide(project.id, source.styleGuide);
      }
      const first = storeVersion(ctx, project.id, remapMedia(timeline, ids, project.id), {
        parent: null, author: { type: "scarlet", name: "Scarlet" }, description: `Made from ${quote(source.name)}`,
      });
      ctx.repos.projects.update(project.id, { head: first.version });
    }
  } catch (error) {
    // The editor never saw these projects: they go with their copied footage, not to the Trash.
    await discardProjects(ctx, projects.map(p => p.id), `as making shorts from ${source.id} failed`)
      .catch(cleanup => ctx.log(`[shorts] the unfinished shorts weren't all removed: ${(cleanup as Error).message}`));
    throw error;
  }

  const projectIds = projects.map(p => p.id);
  const short = (index: number) => ({ index, count: req.count, sourceProjectId: source.id, sourceName: source.name, sourceVersion: source.head!,
    aspect: req.aspect, maxSeconds: req.maxSeconds, captions: req.captions, projectIds });
  const task = createTask(ctx, {
    projectId: projects[0]!.id, kind: "edit", agent: req.agent, model: req.model, effort: req.effort, fast: req.fast, serviceTier: req.serviceTier,
    instruction, context: { short: short(1), skillIds: shortsSkillIds(ctx) }, createdBy: actorFor(user),
  });
  logActivity(ctx, { projectId: source.id, actor: actorFor(user), type: "project.shorts",
    summary: `${user.name} made ${req.count === 1 ? "a short" : `${req.count} shorts`} from ${quote(source.name)}`, data: { projectIds } });
  const made = projectIds.map(id => ctx.repos.projects.get(id)!);
  for (const project of made) {
    ctx.bus.publish({ type: "project.updated", projectId: project.id, project });
    recoverSourcePreviews(ctx, project.id);
  }
  return { projects: made, task };
}

/**
 * The moments the first short's run chose, one per short. Each short is named for its moment, and every short after
 * the first gets a run of its own, started with its moment. Projects left without a moment, when the run found fewer
 * than the editor allowed, go to the trash: the editor asked for up to that many.
 */
export function planShorts(ctx: Ctx, user: User, taskId: string, plan: ShortsPlanRequest) {
  const task = ctx.repos.tasks.get(taskId);
  if (!task) throw notFound("task");
  const short = task.context.short;
  if (!short || short.index !== 1) throw badRequest("not_first_short", "Only the first short’s run chooses the moments, in a request Make shorts started.");
  if (plan.moments.length > short.count) throw badRequest("too_many_moments", `The editor asked for up to ${short.count}.`);
  if (!ctx.repos.projects.header(task.projectId)) throw notFound("project");
  // Every short starts as a copy of the same version of the long video, so the moments are times on it.
  const duration = ctx.repos.versions.duration(short.sourceProjectId, short.sourceVersion) ?? 0;
  const sorted = [...plan.moments].sort((a, b) => a.start - b.start);
  for (const [i, m] of sorted.entries()) {
    if (!(m.end > m.start) || m.end > duration + 0.5) throw badRequest("bad_moment", `“${m.title}” must run forward, within 0–${duration.toFixed(2)} s.`);
    const next = sorted[i + 1];
    if (next && next.start < m.end) throw badRequest("overlapping_moments", `“${m.title}” and “${next.title}” overlap. Each short is its own moment.`);
  }
  const already = ctx.repos.tasks.select("json_extract(json, '$.context.short.sourceProjectId') = ? AND json_extract(json, '$.context.short.index') > 1 AND project_id IN (SELECT value FROM json_each(?))",
    [short.sourceProjectId, JSON.stringify(short.projectIds)]);
  if (already.length) throw conflict("moments_chosen", "The moments are already chosen and the other shorts have started.");
  return ctx.db.transaction(() => {
    const started: Array<{ projectId: string; name: string; moment: { start: number; end: number; title: string }; taskId?: string }> = [];
    plan.moments.forEach((moment, i) => {
      const projectId = short.projectIds[i]!;
      const sibling = ctx.repos.projects.header(projectId);
      if (!sibling) return;
      const named = ctx.repos.projects.update(projectId, { name: moment.title });
      ctx.bus.publish({ type: "project.updated", projectId, project: named });
      const entry: (typeof started)[number] = { projectId, name: moment.title, moment };
      if (i > 0) {
        entry.taskId = createTask(ctx, {
          projectId, kind: "edit", agent: task.agent, model: task.model, effort: task.effort, fast: task.fast, serviceTier: task.serviceTier,
          instruction: task.instruction, context: { short: { ...short, index: i + 1, moment }, skillIds: task.context.skillIds }, createdBy: task.createdBy,
        }).id;
      }
      started.push(entry);
    });
    for (const projectId of short.projectIds.slice(plan.moments.length)) {
      if (!ctx.repos.projects.header(projectId)) continue;
      ctx.repos.projects.softDelete(projectId);
      logActivity(ctx, { projectId, actor: actorFor(user), type: "project.deleted", summary: "Scarlet found fewer moments than the editor allowed, so this short wasn’t needed" });
    }
    return { shorts: started, removed: short.projectIds.slice(plan.moments.length) };
  }, "immediate")();
}
