import { mkdirSync, rmSync, statSync } from "node:fs";
import { quietProgress } from "./progressSave.js";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { DELIVERY_AUDIO_REVISION, lutFileStamps, MissingFilterError, missingTextFilterMessage, NO_DRAWTEXT, PROXY_CLOCK_REVISION, RENDER_REVISION, segmentKey, snapRange,
  usesRevisedProxyClock } from "@scarlet/render";
import type { Render, RenderKind } from "@scarlet/shared";
import { clipEnd, intervalCandidates, newId, planPlaybackSegments, planTransitions, sha256, spanningSections, stableStringify, timelineDuration, type Clip, type Project, type Timeline, type TimeRange, type TransitionJoin } from "@scarlet/timeline";
import { engineIsAlive, type Ctx } from "../context.js";
import { conflict, HttpError } from "../errors.js";
import { now } from "../db.js";
import { clip, logId } from "../logText.js";
import type { RenderEncoding } from "../render/adapter.js";
import { recordRenderFinished } from "../telemetry/events.js";
import { prepareSourceProxies } from "./sourcePreviews.js";
import { resolveTimeline } from "./timeline.js";
import { editorFirst } from "./editorFirst.js";
import { logActivity } from "./activity.js";

export interface RenderInput {
  projectId: string;
  version: string;
  kind: RenderKind;
  range: TimeRange | null;
  quality: "preview" | "delivery";
  /** A viewer may need this playback fragment next. Its bytes are identical to an opened fragment. */
  speculative?: boolean;
  changeId?: string;
  exportOptions?: Render["exportOptions"];
}

interface RenderVersion {
  timeline: Timeline;
  duration: number;
  sourceIds: Set<string>;
  hasLut: boolean;
  fullKeys: Map<string, string>;
  clipsIn?: Array<(start: number, end: number) => Clip[]>;
  /** Where each clip is: its track, and its place there, which is its stacking order. */
  clipsById?: Map<string, { track: number; index: number; clip: Clip }>;
  hasTransitions: boolean;
  /**
   * The version's transition joins, indexed by time. Planned once: the version never changes, and only its sources'
   * lengths and the frame rate, named by `key`, could change the plan.
   */
  joins?: { key: string; overlapping: (start: number, end: number) => TransitionJoin[] };
  windows: Map<string, { timeline: Timeline; sourceIds: Set<string> }>;
  /** The version's playback sections at a frame rate. Empty when the timeline is past the planning limits. */
  sections?: { fps: number; ranges: TimeRange[] };
}

/**
 * What a playback section reads: the section as asked and the frame-snapped range its cache key names. Older queued
 * sections can have a saved format or endpoints that aren't on a frame, so neither is assumed to hold the other.
 */
function playbackCoverage(range: TimeRange, fps: number): TimeRange {
  const snapped = snapRange(range, fps);
  return { start: Math.min(snapped.start, range.start), end: Math.max(snapped.end, range.end) };
}

function workerAlive(ctx: Ctx, pid?: number): boolean {
  return !!pid && engineIsAlive(ctx, pid);
}

/** The engine working on a pending render. A released export keeps its demand mark for the next engine to adopt. */
function workerPid(render: Pick<Render, "queuePid" | "demandPid" | "export">): number | undefined {
  return render.export ? render.queuePid : render.queuePid ?? render.demandPid;
}

/**
 * Why a render failed, in words the editor can act on. ffmpeg's own output, and the filter graph the renderer adds to
 * it, names files by their place in Scarlet's library and means nothing to the editor: that stays in the log. The
 * queue's own reasons, such as a source that changed while the render waited, are sentences already.
 * `sources`: the files the render read, by the names the editor gave them.
 */
function renderFailure(error: unknown, sources: ReadonlyArray<{ name: string; file: string }>, what: string): string {
  if (error instanceof HttpError || error instanceof MissingFilterError) return error.message;
  const said = `${error instanceof Error ? error.message : String(error)}\n${(error as { stderr?: unknown } | undefined)?.stderr ?? ""}`;
  // The renderer checks for drawtext before it draws captions. Anything else that asks for it says so here.
  if (NO_DRAWTEXT.test(said)) return missingTextFilterMessage("draw the video’s captions");
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC" || /no space left on device/i.test(said))
    return "There isn’t enough free disk space to render this: free some space, then try again.";
  // Every source is Scarlet's own copy in the project's files. Only the one ffmpeg names is the one it couldn't use.
  const named = sources.find(source => said.includes(source.file) || said.includes(basename(source.file)));
  const present = (file: string) => { try { return !!statSync(file, { throwIfNoEntry: false })?.size; } catch { return false; } };
  if (named && !present(named.file)) return `Scarlet can’t find “${named.name}” in this project’s files: export the logs from Settings → Advanced to report it.`;
  if (named && /invalid data|moov atom not found|error opening input|permission denied/i.test(said))
    return `Scarlet can’t read “${named.name}” in this project’s files: export the logs from Settings → Advanced to report it.`;
  return `Scarlet couldn’t render ${what}: try once more, or export the logs from Settings → Advanced to report it.`;
}

type RenderFormat = { height: number; hwaccel: NonNullable<Render["hwaccel"]> };

function isVideoExport(input: Pick<Render, "kind" | "quality">): boolean {
  return input.kind === "export" || (input.kind === "full" && input.quality === "delivery");
}

const yieldCacheWorker = Symbol("yield cache worker");
enum Priority { Playback, Requested, Preparation, FullCache }
// An assembly can expire independently of its encoded picture sections.
function assemblyRevision(input: Pick<Render, "kind" | "quality">): string {
  if (isVideoExport(input)) return `-mix${DELIVERY_AUDIO_REVISION}`;
  return input.kind === "full" ? "-pts1" : "";
}

// Old assemblies can be rebuilt against the same sources after a delivery mix or proxy clock upgrade.
function sameQueuedSource(previousKey: string, currentKey: string | undefined, assembly: string): boolean {
  if (!currentKey) return false;
  if (currentKey === previousKey) return true;
  const priorAssembly = assembly.startsWith("-mix") ? previousKey.replace(/-mix3(?=-clock\d+$|$)/, "") : previousKey;
  const priorSourceKey = priorAssembly.replace(/-clock2$/, "");
  return [currentKey, currentKey.replace(assembly, "")].some(key =>
    key === priorAssembly || key === priorSourceKey + `-clock${PROXY_CLOCK_REVISION}`);
}

/**
 * In-process render queue. Concurrency comes from settings.render.concurrency.
 * Equivalent requests share completed files. Each full export retains its own immutable output.
 */
export class RenderQueue {
  private readonly queue: Array<{ id: string; projectId: string; key: string; playback?: boolean }> = [];
  private readonly activeKeys = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly owners = new Map<string, Map<string, "viewer" | "preparation">>();
  private readonly backgroundCaches = new Set<string>();
  private readonly versions = new Map<string, RenderVersion>();

  constructor(private readonly ctx: Ctx) {
    ctx.shutdown.addEventListener("abort", () => {
      // An export waits for the next launch. Playback fragments and preview caches end with their viewer.
      for (const id of this.owners.keys()) if (!this.ctx.repos.renders.get(id)?.export) this.cancel(id);
      for (const job of this.queue.splice(0)) this.releaseWorker(job.id);
    }, { once: true });
  }

  // An export destination or its owner can change while the encoder is working on the same row.
  private update(id: string, patch: (current: Render) => Partial<Render> | undefined): Render | null {
    const write = () => {
      const current = this.ctx.repos.renders.get(id);
      if (!current) return null;
      const changes = patch(current);
      return changes ? this.ctx.repos.renders.put({ ...current, ...changes }) : null;
    };
    return this.ctx.db.inTransaction ? write() : this.ctx.db.transaction(write, "immediate")();
  }

  private releaseWorker(id: string) {
    const queued = this.update(id, r => r.queuePid === process.pid && (r.state === "running" || r.state === "queued")
      ? { state: "queued", progress: 0, queuePid: undefined } : undefined);
    if (queued && queued.kind !== "playback") this.ctx.db.afterCommit(() => {
      this.ctx.log(`[render] requeued render=${logId(id)} project=${logId(queued.projectId)} reason=shutdown`);
    });
  }

  /**
   * Replay persisted jobs only after change-render completion listeners are installed.
   * `inherited`: an engine that was killed had the process id this one was then given, so the renders under it are that engine's.
   */
  recover(inherited = false): void {
    const alive = (pid?: number) => !(inherited && pid === process.pid) && workerAlive(this.ctx, pid);
    const pending = this.ctx.db.prepare(`SELECT id, json_extract(json,'$.queuePid') AS queuePid, json_extract(json,'$.demandPid') AS demandPid,
      json_extract(json,'$.export.owner') AS owner FROM renders WHERE state IN ('queued','running') ORDER BY created_at`).all() as
      { id: string; queuePid?: number; demandPid?: number; owner?: string }[];
    const candidates = pending.filter(r => !alive(r.owner ? r.queuePid ?? undefined : r.queuePid ?? r.demandPid ?? undefined));
    if (!candidates.length) return;
    this.ctx.db.transaction(() => {
      for (const candidate of candidates) {
        // A peer may have claimed or finished this row between the read and the write lock.
        let render = this.ctx.repos.renders.get(candidate.id);
        if (!render || (render.state !== "queued" && render.state !== "running") || alive(workerPid(render))) continue;
        const project = this.ctx.repos.projects.header(render.projectId);
        if (!project || (project.mediaPaused && render.kind === "full" && render.quality === "preview") || (render.demandPid && !render.export)) {
          this.cancel(render.id, true);
          const target = `render=${logId(render.id)} project=${logId(render.projectId)}`;
          const reason = !project ? "project_unavailable" : project.mediaPaused && render.kind === "full" && render.quality === "preview" ? "media_paused" : "viewer_gone";
          this.ctx.db.afterCommit(() => this.ctx.log(`[render] recovered ${target} outcome=cancelled reason=${reason}`));
          // A killed engine leaves the file its encoder was writing.
          if (render.demandPid) {
            // Windows refuses while another program holds the file. The render is given up either way.
            try {
              rmSync(join(this.ctx.paths.renders(render.projectId), `${render.id}.mp4`), { force: true });
            } catch (error) {
              this.ctx.log(`[render] ${render.id} couldn’t remove the file its engine left unfinished: ${(error as Error).message}`);
            }
          }
          continue;
        }
        if (!render.projectSettings || (!render.hwaccel && !isVideoExport(render))) {
          this.finish(render.id, { state: "failed", error: "Interrupted render has no saved settings. Request a new render.", finishedAt: now() });
          continue;
        }
        // An older engine could queue an export with the preview's software-only setting.
        // It goes on with the editor's setting as it is now.
        // Check its original source identity before changing either of its cache keys.
        if (isVideoExport(render) && (!render.hwaccel || render.hwaccel === "none")) {
          try {
            const saved = { ...this.ctx.repos.projects.get(render.projectId)!, settings: render.projectSettings };
            const input: RenderInput = { ...render, quality: render.quality ?? "preview" };
            const mode = render.previewContentKey?.startsWith("local-v1-") ? "local" : undefined;
            if (render.previewContentKey) {
              const originalKey = this.contentKeyOf(render, saved);
              if (!sameQueuedSource(render.previewContentKey, originalKey, assemblyRevision(render)) &&
                  !sameQueuedSource(render.previewContentKey, this.contentKeyOf(render, saved, true), assemblyRevision(render))) {
                throw conflict("render_source_changed", "A source changed after this render was queued. Request a new render.");
              }
            }
            const format = this.outputFormat(saved, input, render.height);
            render = { ...render, ...format, key: this.keyFor(saved, input, format),
              previewContentKey: this.renderContentKey(saved, input, format, mode) };
          } catch (error) {
            this.finish(render.id, { state: "failed", error: (error as Error).message, finishedAt: now() });
            continue;
          }
        }
        const owner = render.demandPid && render.export?.owner;
        const queued = this.ctx.repos.renders.put({ ...render, state: "queued", progress: 0, queuePid: process.pid, ...(owner && { demandPid: process.pid }) });
        this.ctx.db.afterCommit(() => {
          this.ctx.log(`[render] recovered render=${logId(queued.id)} project=${logId(queued.projectId)} outcome=queued reason=worker_gone`);
          if (owner) this.owners.set(queued.id, new Map([[owner, "viewer"]]));
          this.queue.push({ id: queued.id, projectId: queued.projectId, key: queued.previewContentKey ?? queued.key });
        });
      }
    }, "immediate")();
    this.pump();
  }

  private outputHeight(projectHeight: number, input: RenderInput): number {
    if (input.kind === "export") return Math.min(projectHeight, input.exportOptions?.height ?? projectHeight);
    return input.quality === "delivery" ? projectHeight : Math.min(this.ctx.settings().render.previewHeight, projectHeight);
  }

  private outputFormat(project: Pick<Project, "settings">, input: RenderInput,
    height = this.outputHeight(project.settings.height, input)): RenderFormat {
    // The editor's choice holds for exports too: "none" encodes in software, a named device uses that one.
    return { height, hwaccel: this.ctx.settings().render.hwaccel };
  }

  keyFor(project: Pick<Project, "settings">, input: RenderInput, format = this.outputFormat(project, input)): string {
    const key = sha256(
      stableStringify({
        renderer: RENDER_REVISION,
        ...(input.kind === "full" && input.quality === "delivery" ? { programAudio: 1 } : {}),
        ...(input.kind === "export" ? { exportOptions: input.exportOptions } : {}),
        version: input.version,
        range: input.range,
        kind: input.kind,
        quality: input.quality,
        projectId: input.projectId,
        settings: { project: project.settings, ...format },
      }),
    );
    return key + assemblyRevision(input);
  }

  private version(project: Pick<Project, "id" | "head">, version: string): RenderVersion {
    const key = JSON.stringify([project.id, version === "head" ? project.head : version]);
    const previous = this.versions.get(key);
    if (previous) {
      this.versions.delete(key);
      this.versions.set(key, previous);
      return previous;
    }
    const timeline = resolveTimeline(this.ctx, project, version);
    const sourceIds = new Set<string>();
    let hasLut = false;
    let hasTransitions = false;
    for (const track of timeline.tracks) for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false) continue;
      sourceIds.add(clip.mediaId);
      if (clip.effects.some(effect => effect.enabled && effect.type === "lut")) hasLut = true;
      if (track.kind === "video" && !track.hidden && clip.transitionIn) hasTransitions = true;
    }
    const entry: RenderVersion = { timeline, duration: timelineDuration(timeline), sourceIds, hasLut, hasTransitions, fullKeys: new Map(), windows: new Map() };
    // A proposal can enqueue a new version within its own database transaction.
    // Reviewing a cut plays the working cut, the call's version and the one before it in turn: keep all of them planned.
    this.ctx.db.afterCommit(() => {
      this.versions.set(key, entry);
      if (this.versions.size > 4) this.versions.delete(this.versions.keys().next().value!);
    });
    return entry;
  }

  private sections(entry: RenderVersion, project: Pick<Project, "settings">): TimeRange[] {
    const fps = project.settings.fps;
    if (entry.sections?.fps !== fps) {
      let ranges: TimeRange[] = [];
      try { ranges = planPlaybackSegments(project, entry.timeline); } catch { /* Too long to plan: no file is assembled from sections. */ }
      entry.sections = { fps, ranges };
    }
    return entry.sections.ranges;
  }

  /**
   * A cut's playback window widened to whole playback sections. Its file is then assembled from the sections the full
   * preview and the cut player cache, so a window beside one already played encodes only the sections around its join.
   */
  sectionWindow(project: Pick<Project, "id" | "settings">, version: string, range: TimeRange): TimeRange {
    return spanningSections(this.sections(this.version({ id: project.id, head: null }, version), project), range) ?? range;
  }

  /** The clips a transition joins inside `range`, both sides of each join, wherever those clips start or end. */
  private transitionClips(entry: RenderVersion, range: TimeRange, project?: Project) {
    const clips = new Set<string>();
    if (!project || !entry.hasTransitions) return clips;
    const sources = project.media.filter(asset => entry.sourceIds.has(asset.id)).map(asset => [asset.id, asset.kind, asset.duration ?? null]);
    const key = stableStringify([project.settings.fps, sources]);
    if (entry.joins?.key !== key) {
      const { joins } = planTransitions(entry.timeline, new Map(project.media.map(asset => [asset.id, asset])), project.settings.fps);
      entry.joins = { key, overlapping: intervalCandidates(joins, join => join.start, join => join.end) };
    }
    for (const join of entry.joins.overlapping(range.start, range.end)) {
      if (join.start >= range.end || join.end <= range.start || join.start === join.end) continue;
      clips.add(join.clipId);
      if (join.outgoingClipId) clips.add(join.outgoingClipId);
    }
    return clips;
  }

  private window(entry: RenderVersion, range: TimeRange, project?: Project) {
    const transitionClips = this.transitionClips(entry, range, project);
    const key = JSON.stringify([range, [...transitionClips]]);
    const cached = entry.windows.get(key);
    if (cached) return cached;
    const clipsIn = entry.clipsIn ??= entry.timeline.tracks.map(track => intervalCandidates(track.clips, clip => clip.timelineIn, clipEnd));
    const sourceIds = new Set<string>();
    const tracks = entry.timeline.tracks.map((track, i) => {
      let candidates = clipsIn[i]!(range.start, range.end);
      if (transitionClips.size) {
        // A join's clips can lie outside the window: the picture before it has ended, or the next one hasn't begun.
        const where = entry.clipsById ??= new Map(entry.timeline.tracks.flatMap((t, track) => t.clips.map((clip, index) => [clip.id, { track, index, clip }] as const)));
        const extra = [...transitionClips].map(id => where.get(id)).filter(found => found?.track === i && !candidates.includes(found.clip));
        if (extra.length) candidates = [...candidates, ...extra.map(found => found!.clip)].sort((a, b) => where.get(a.id)!.index - where.get(b.id)!.index);
      }
      const clips = candidates.filter(clip => {
        if (clip.enabled === false || (!transitionClips.has(clip.id) && (clip.timelineIn >= range.end || clipEnd(clip) <= range.start))) return false;
        if (clip.kind === "media") sourceIds.add(clip.mediaId);
        return true;
      });
      return { ...track, clips };
    });
    const part = { timeline: { ...entry.timeline, tracks }, sourceIds };
    entry.windows.set(key, part);
    if (entry.windows.size > 4) entry.windows.delete(entry.windows.keys().next().value!);
    return part;
  }

  private projectFor(input: Pick<RenderInput, "projectId" | "kind" | "range" | "version"> & { projectSettings?: Project["settings"] }) {
    if ((input.kind !== "playback" && input.kind !== "segment") || !input.range) return this.ctx.repos.projects.get(input.projectId);
    const header = this.ctx.repos.projects.header(input.projectId);
    if (!header) return null;
    const entry = this.version(header, input.version);
    if (entry.hasTransitions) return this.ctx.repos.projects.get(input.projectId);
    const { sourceIds } = this.window(entry, playbackCoverage(input.range, (input.projectSettings ?? header.settings).fps));
    return { ...header, media: this.ctx.repos.projects.assets(header.id, sourceIds) };
  }

  private renderContentKey(project: Project, input: RenderInput, output: Pick<Render, "height" | "hwaccel"> = this.outputFormat(project, input), mode?: "local" | "export", legacyTransitions = false): string | undefined {
    if (input.kind === "export") {
      const source = this.renderContentKey(project, { ...input, kind: "full", range: null },
        output, "export", legacyTransitions);
      return source && "export-v1-" + sha256(stableStringify([source, input.version, input.range, input.exportOptions])) + assemblyRevision(input);
    }
    const full = input.kind === "full" && input.range === null;
    if (!full && ((input.kind !== "segment" && input.kind !== "playback") || input.quality !== "preview" || !input.range)) return undefined;
    const entry = this.version(project, input.version);
    const range = full ? { start: 0, end: entry.duration } : snapRange(input.range!, project.settings.fps);
    if (range.end <= range.start) return undefined;
    const settings = this.ctx.settings().render;
    const format = { quality: input.quality, height: output?.height ?? this.outputHeight(project.settings.height, input),
      encoder: output?.hwaccel ?? settings.hwaccel };
    const { timeline, sourceIds } = full ? entry : this.window(entry, range, legacyTransitions ? undefined : project);
    const root = this.ctx.paths.media(project.id);
    const assets = project.media.filter(asset => sourceIds.has(asset.id)).sort((a,b) => a.id.localeCompare(b.id));
    const luts = entry.hasLut ? lutFileStamps(timeline, root) : [];
    let local = mode !== undefined || !!luts.length || sourceIds.size !== assets.length;
    const files = assets.map(asset => {
      let file;
      try { file = statSync(join(root, asset.path), { throwIfNoEntry: false }); } catch { /* Record unavailable inputs. */ }
      const stamp = asset.fingerprintStamp;
      if (!asset.hash || !file?.isFile() || (stamp && (file.size !== stamp.size || file.ctimeMs !== stamp.ctimeMs || file.mtimeMs !== stamp.mtimeMs))) local = true;
      return [asset.id, asset.hash ?? null, asset.path, file?.size, file?.mtimeMs, file?.ctimeMs];
    });
    const pictureInputs = assets.map(a => [a.width, a.height, a.fps, a.hasAlpha, a.previewClock, a.originalPlaybackType]);
    const originals = { ...project, media: assets.map(asset => ({ ...asset, hash: asset.id })) };
    const stamps = files.map(([id, _hash, ...file]) => [id, ...file]);
    const clockSuffix = () => mode !== "export" && input.quality === "preview" &&
      usesRevisedProxyClock(originals, timeline, range, format.height) ? `-clock${PROXY_CLOCK_REVISION}` : "";
    if (full) {
      // The source files and their mutable catalog rows need checking on every use. The
      // immutable version's track serialization and digest can be reused after that check.
      const signature = createHash("sha256").update(stableStringify([mode, project.settings, format, files, assets, luts, legacyTransitions])).digest("hex");
      const previous = entry.fullKeys.get(signature);
      if (previous) return previous;
      const content = segmentKey(local ? originals : project, timeline, range, format, undefined, legacyTransitions);
      const material: unknown[] = ["full-program-v1", project.id, input.quality, content, local ? stamps : files, timeline.tracks];
      material.push(pictureInputs);
      if (local) material.push(input.version, luts);
      const prefix = local ? "local-v1-" : "full-v1-";
      const assembly = mode === "export" ? "" : assemblyRevision(input);
      const key = prefix + createHash("sha256").update(stableStringify(material)).digest("hex") + assembly + clockSuffix();
      entry.fullKeys.set(signature, key);
      if (entry.fullKeys.size > 4) entry.fullKeys.delete(entry.fullKeys.keys().next().value!);
      return key;
    }
    // Playback of a newly imported recording can overlap its background hash. The source
    // path and physical stamp identify its bytes both before and after that hash arrives.
    const content = segmentKey(originals, timeline, range, format, undefined, legacyTransitions);
    return "range-v2-" + sha256(stableStringify([input.kind, input.projectId, input.range, content, stamps, luts, pictureInputs])) + clockSuffix();
  }

  inspectionKey(project: Project, version: string) {
    return this.renderContentKey(project, { projectId: project.id, version, kind: "full", quality: "preview", range: null }, undefined, "local");
  }

  fullPreview(project: Pick<Project, "id" | "settings">, version: string): Render | undefined {
    const key = this.keyFor(project, { projectId: project.id, version, kind: "full", range: null, quality: "preview" });
    const candidates = this.ctx.repos.renders.select("project_id = ? AND key = ? AND state = 'done'", [project.id, key]);
    let inputs: Project | null | undefined;
    return candidates.find(render => {
      if (!this.available(render)) return false;
      inputs ??= this.ctx.repos.projects.get(project.id);
      return !!inputs && this.isCurrent(render, inputs);
    });
  }

  coveringPreview(project: Project, version: string, range: TimeRange, minHeight: number) {
    const candidates = this.ctx.repos.renders.select(`project_id = ? AND version = ? AND state = 'done'
      AND kind IN ('full', 'playback', 'segment') AND json_extract(json, '$.quality') = 'preview'
      AND json_extract(json, '$.height') >= ?
      AND (kind = 'full' OR (json_extract(json, '$.range.start') <= ? AND json_extract(json, '$.range.end') >= ?))`,
      [project.id, version, minHeight, range.start, range.end],
      "coalesce(json_extract(json, '$.range.end') - json_extract(json, '$.range.start'), 1e20), created_at DESC");
    return candidates.find(r => r.previewContentKey && r.projectSettings &&
      stableStringify(r.projectSettings) === stableStringify(project.settings) && this.available(r) && this.isCurrent(r, project));
  }

  /** The content key a saved render has now, in the format and project settings it was queued with. */
  private contentKeyOf(render: Render, project: Project, legacyTransitions = false): string | undefined {
    return this.renderContentKey({ ...project, settings: render.projectSettings ?? project.settings },
      { ...render, quality: render.quality ?? "preview" }, render, render.previewContentKey?.startsWith("local-v1-") ? "local" : undefined, legacyTransitions);
  }

  isCurrent(render: Render, project: Project): boolean {
    return render.previewContentKey === this.contentKeyOf(render, project);
  }

  private available(render: Render): boolean {
    if (render.state !== "done" || !render.path) return false;
    try {
      const file = statSync(join(this.ctx.paths.renders(render.projectId), render.path), { throwIfNoEntry: false });
      return !!file?.isFile() && file.size > 0;
    } catch {
      return false;
    }
  }

  private cachedPreview(contentKey: string): Render | undefined {
    const [latest] = this.ctx.repos.renders.select("json_extract(json, '$.previewContentKey') = ? AND state = 'done'", [contentKey], "created_at DESC LIMIT 1");
    return latest && this.available(latest) ? latest : undefined;
  }

  /** Enqueue (or return the existing equivalent render). */
  request(input: RenderInput, owner?: string, save?: Omit<NonNullable<Render["export"]>, "owner">): Render {
    const project = this.projectFor(input);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    if (project.mediaPaused && input.kind === "full" && input.quality === "preview") throw conflict("media_paused", "Resume caching to cache this edit.");
    const format = this.outputFormat(project, input);
    const key = this.keyFor(project, input, format);
    const previewContentKey = this.renderContentKey(project, input, format);
    const kept = owner && save ? { ...save, owner } : undefined;
    const enqueue = () => this.enqueue(project, input, format, key, previewContentKey, owner, kept);
    return this.ctx.db.inTransaction ? enqueue() : this.ctx.db.transaction(enqueue, "immediate")();
  }

  private enqueue(project: Project, input: RenderInput, format: RenderFormat, key: string, previewContentKey?: string, owner?: string, kept?: Render["export"]): Render {
    const existing = this.ctx.repos.renders.select("key = ? AND version = ? AND state IN ('queued','running','done')", [key, input.version], "created_at DESC");
    const found = existing.find(r =>
      (!r.demandPid || r.state === "done" || this.owners.has(r.id)) &&
      (r.previewContentKey === previewContentKey ||
        (r.state === "done" && r.previewContentKey?.startsWith("local-v1-") && previewContentKey?.startsWith("full-v1-") && this.isCurrent(r, project))) &&
      (r.state !== "done" || this.available(r))
    );
    if (found) {
      // The export follows whichever render supplies its file, including one already finished.
      const same = kept ? this.ctx.repos.renders.put({ ...found, export: kept }) : found;
      // A finished local export can acquire a verified hash after the import completes.
      if (same.previewContentKey !== previewContentKey) return this.ctx.repos.renders.put({ ...same, previewContentKey });
      if (same.state !== "done" && !workerAlive(this.ctx, workerPid(same))) this.ctx.db.afterCommit(() => this.recover());
      const owners = this.owners.get(same.id);
      if (owners && owner) this.ctx.db.afterCommit(() => owners.set(owner, input.speculative ? "preparation" : "viewer"));
      else if (owners) {
        // An explicit long-lived request now needs the same bytes, even if every viewer leaves.
        this.ctx.db.afterCommit(() => {
          this.owners.delete(same.id);
          this.backgroundCaches.delete(same.id);
        });
        return this.ctx.repos.renders.put({ ...same, demandPid: undefined });
      }
      if (owner && !input.speculative && input.kind === "playback" && same.state !== "done") {
        this.ctx.db.afterCommit(() => {
          const queued = this.queue.find(job => job.id === same.id);
          if (queued) queued.playback = true;
          this.pump();
        });
      }
      return same;
    }
    let cached = previewContentKey ? this.cachedPreview(previewContentKey) : undefined;
    if (!cached && format.hwaccel === "auto" && isVideoExport(input)) {
      // A complete software export already on disk can be delivered without encoding again.
      const legacy = { ...format, hwaccel: "none" as const };
      cached = this.ctx.repos.renders.select("key = ? AND state = 'done'", [this.keyFor(project, input, legacy)], "created_at DESC")
        .find(row => row.hwaccel === "none" && row.previewContentKey && this.available(row) && this.isCurrent(row, project));
    }
    const { height, hwaccel } = format;
    const width = Math.round((project.settings.width * height) / project.settings.height / 2) * 2;
    const duration = input.range ? input.range.end - input.range.start : undefined;
    const render: Render = this.ctx.repos.renders.put({
      id: newId("rnd"),
      projectId: input.projectId,
      version: input.version,
      kind: input.kind,
      quality: input.quality,
      exportOptions: input.exportOptions,
      export: kept,
      projectSettings: project.settings,
      hwaccel,
      range: input.range,
      key,
      previewContentKey,
      demandPid: owner && !cached ? process.pid : undefined,
      queuePid: cached ? undefined : process.pid,
      path: cached?.path ?? null,
      state: cached ? "done" : "queued",
      progress: cached ? 1 : 0,
      finishedAt: cached ? now() : undefined,
      durationSeconds: cached?.durationSeconds ?? duration,
      width,
      height,
      changeId: input.changeId,
      createdAt: now(),
    });
    this.ctx.bus.publish({ type: "render.updated", projectId: render.projectId, render });
    if (cached) {
      if (kept) this.recordExportActivity(render);
      return render;
    }
    this.ctx.db.afterCommit(() => {
      if (owner) this.owners.set(render.id, new Map([[owner, input.speculative ? "preparation" : "viewer"]]));
      if (owner && input.kind === "full" && input.quality === "preview") this.backgroundCaches.add(render.id);
      const playback = !!owner && input.kind === "playback" && !input.speculative;
      if (playback) editorFirst.touch();
      this.queue.push({ id: render.id, projectId: render.projectId, key: render.previewContentKey ?? render.key, playback });
      this.pump();
    });
    return render;
  }

  /** The owner no longer needs this render: it saved the file, gave up, or the editor cancelled. */
  release(id: string, owner: string) {
    // Releasing an ordinary playback reader only touches the in-memory owners.
    if (this.ctx.repos.renders.get(id)?.export?.owner === owner) {
      this.update(id, r => r.export?.owner === owner ? { export: undefined } : undefined);
    }
    const owners = this.owners.get(id);
    if (!owners?.delete(owner)) return;
    if (!owners.size) this.cancel(id);
    else if (this.preparingOnly(id)) this.pump();
  }

  /** Exports the desktop app still has to save, or to report as failed. */
  exports(): Render[] {
    return this.ctx.repos.renders.select("json_extract(json, '$.export.owner') IS NOT NULL AND state IN ('queued','running','done','failed')", [], "created_at");
  }

  stopProject(projectId: string, previewsOnly = false) {
    const jobs = this.ctx.repos.renders.select("project_id = ? AND state IN ('queued','running')", [projectId]);
    for (const job of jobs) {
      if (!previewsOnly || (job.kind === "full" && job.quality === "preview")) this.cancel(job.id);
    }
  }

  /** `orphaned`: recovery found that the engine working on it is gone. */
  cancel(renderId: string, orphaned = false): Render | null {
    const render = this.ctx.repos.renders.get(renderId);
    if (!render) return null;
    const i = this.queue.findIndex(job => job.id === renderId);
    if (!orphaned && i < 0 && !this.running.has(renderId) && workerAlive(this.ctx, workerPid(render))) return render;
    if (i >= 0) this.queue.splice(i, 1);
    this.running.get(renderId)?.abort();
    if (render.state === "queued" || render.state === "running") {
      return this.finish(renderId, { state: "cancelled", finishedAt: now() });
    }
    return render;
  }

  private finish(id: string, outcome: Partial<Render> & { state: "done" | "failed" | "cancelled" }): Render | null {
    const saved = this.update(id, () => ({ ...outcome, queuePid: undefined, demandPid: undefined,
      ...(outcome.state === "cancelled" && { export: undefined }) }));
    this.owners.delete(id);
    this.backgroundCaches.delete(id);
    if (!saved) return null;
    this.ctx.bus.publish({ type: "render.updated", projectId: saved.projectId, render: saved });
    this.ctx.bus.renderFinished({ renderId: saved.id, projectId: saved.projectId, state: outcome.state });
    recordRenderFinished(this.ctx, saved);
    if (outcome.state === "done" && saved.export) this.recordExportActivity(saved);
    return saved;
  }

  /** Record a completed video export in the permanent project log without storing local file paths or names. */
  private recordExportActivity(render: Render) {
    logActivity(this.ctx, {
      projectId: render.projectId,
      actor: { type: "scarlet", name: "Scarlet" },
      type: "export.completed",
      summary: "Exported video (.mp4)",
      data: {
        format: "mp4",
        renderId: render.id,
        version: render.version,
        kind: render.kind,
        quality: render.quality,
        ...(render.range && { range: render.range }),
        ...(render.exportOptions && { exportOptions: render.exportOptions }),
        ...(render.durationSeconds !== undefined && { durationSeconds: render.durationSeconds }),
        ...(render.width && { width: render.width }),
        ...(render.height && { height: render.height }),
      },
    });
  }

  private preparingOnly(id: string): boolean {
    const owners = this.owners.get(id);
    return !!owners?.size && ![...owners.values()].includes("viewer");
  }

  private priority(job: { id: string; playback?: boolean }): Priority {
    if (this.backgroundCaches.has(job.id)) return Priority.FullCache;
    if (this.preparingOnly(job.id)) return Priority.Preparation;
    return job.playback ? Priority.Playback : Priority.Requested;
  }

  private pump() {
    // Keep waiting jobs durable during shutdown. Recovery reuses their original IDs.
    if (this.ctx.shutdown.aborted) return;
    const concurrency = Math.max(1, this.ctx.settings().render.concurrency);
    while (this.queue.length) {
      // An equivalent job can reuse its predecessor's finished file. Let unrelated work run meanwhile.
      let index = -1, priority = Priority.FullCache;
      for (const [i, job] of this.queue.entries()) {
        if (this.activeKeys.has(job.key)) continue;
        const rank = this.priority(job);
        if (index >= 0 && rank >= priority) continue;
        index = i;
        priority = rank;
        if (rank === Priority.Playback) break;
      }
      if (index < 0) break;
      if (this.running.size >= concurrency) {
        // Free one slot for the editor, even on a single-worker machine. Completed segments survive the interruption.
        if (priority < Priority.FullCache && ![...this.running.values()].some(worker => worker.signal.aborted)) {
          for (const [id, worker] of this.running) {
            if (this.backgroundCaches.has(id) || (priority < Priority.Preparation && this.preparingOnly(id))) {
              this.ctx.log(`[render] preempted render=${logId(id)} blocker=${logId(this.queue[index]!.id)} reason=higher_priority`);
              worker.abort(yieldCacheWorker);
              break;
            }
          }
        }
        break;
      }
      const { id, projectId, key } = this.queue.splice(index, 1)[0]!;
      this.activeKeys.add(key);
      const ac = new AbortController();
      this.running.set(id, ac);
      // The editor is waiting for a playback section however long it takes. A full preview cache is nobody's to
      // wait for, so its encoders yield to them (editorFirst.ts). Either way the render doesn't inherit the priority
      // of whatever work called pump.
      const editorWaits = priority === Priority.Playback ? editorFirst.hold() : undefined;
      this.ctx.track(
        editorFirst.run(() => this.backgroundCaches.has(id), () => this.run(id, AbortSignal.any([ac.signal, this.ctx.shutdown])))
          .catch((e) => this.ctx.log(`[render] ${id} crashed: ${(e as Error).message}`))
          .finally(() => {
            editorWaits?.();
            // Release durable work only after the cancelled encoder has closed its file.
            if (this.ctx.shutdown.aborted) this.releaseWorker(id);
            else if (ac.signal.reason === yieldCacheWorker) {
              const queued = this.update(id, r => r.state === "running" ? { state: "queued", progress: 0 } : undefined);
              if (queued) {
                this.ctx.log(`[render] requeued render=${logId(id)} project=${logId(projectId)} reason=higher_priority`);
                this.ctx.bus.publish({ type: "render.updated", projectId: queued.projectId, render: queued });
                this.queue.push({ id, projectId, key, playback: queued.kind === "playback" && this.owners.has(id) });
              }
            }
            this.running.delete(id);
            this.activeKeys.delete(key);
            this.pump();
          }),
        projectId,
      );
    }
  }

  private async run(id: string, signal: AbortSignal) {
    let render = this.update(id, r => r.state === "queued" ? { state: "running", progress: 0 } : undefined);
    if (!render) return;
    this.ctx.bus.publish({ type: "render.updated", projectId: render.projectId, render });

    let unpublished: string | undefined;
    let read = new Set<string>();
    // The failure sentence names the sources this render read, so the project outlives the try.
    let project: Project | undefined;
    let encoding: RenderEncoding | void = undefined;
    try {
      const current = this.projectFor(render);
      if (!current) throw new Error("project not found");
      project = { ...current, settings: render.projectSettings ?? current.settings };
      // Queued jobs from older engines had no source stamps for range renders. Build
      // those bytes against the current inputs before publishing anything reusable.
      const oldRange = render.quality === "preview" && (render.kind === "playback" || render.kind === "segment") &&
        !render.previewContentKey?.startsWith("range-v2-");
      const oldFull = render.kind === "full" && !render.previewContentKey;
      const previousKey = render.previewContentKey;
      if (oldRange || oldFull || previousKey) {
        const assembly = assemblyRevision(render);
        const currentKey = this.contentKeyOf(render, project);
        if (previousKey && !(oldRange && currentKey) && !sameQueuedSource(previousKey, currentKey, assembly) &&
            !sameQueuedSource(previousKey, this.contentKeyOf(render, project, true), assembly)) {
          throw conflict("render_source_changed", "A source changed after this render was queued. Request a new render.");
        }
        const upgradeAssembly = assembly && !render.key.endsWith(assembly);
        if (upgradeAssembly || currentKey !== previousKey) {
          const rekeyed = this.update(id, r => ({ key: upgradeAssembly ? r.key.replace(/-mix3$/, "") + assembly : r.key, previewContentKey: currentKey }));
          if (!rekeyed) return;
          render = rekeyed;
        }
      }
      const queuedKey = render.previewContentKey;
      if (render.previewContentKey) {
        const cached = this.cachedPreview(render.previewContentKey);
        if (cached) {
          this.finish(id, { state: "done", path: cached.path, durationSeconds: cached.durationSeconds ?? render.durationSeconds, progress: 1, finishedAt: now() });
          return;
        }
      }
      const entry = this.version(project, render.version);
      // The window holds what is rendered, the section as asked, and the frame-snapped range its cache key names.
      const scope = render.kind === "playback" && render.range ? this.window(entry, playbackCoverage(render.range, project.settings.fps), project) : entry;
      const { timeline } = scope;
      read = scope.sourceIds;
      // Later preview sections of this cut read small proxies instead of the originals.
      if ((render.quality ?? "preview") === "preview" && render.kind !== "export" && !this.preparingOnly(id)) prepareSourceProxies(this.ctx, entry.sourceIds);
      const dir = this.ctx.paths.renders(project.id);
      mkdirSync(dir, { recursive: true });
      const uniqueOutput = render.demandPid || render.kind === "full" || render.kind === "export" || ((render.kind === "segment" || render.kind === "playback") && render.quality === "preview");
      const file = uniqueOutput ? `${render.id}.mp4` : `${render.key}.mp4`;
      const output = join(dir, file);
      if (uniqueOutput) unpublished = output;
      let last = 0, progress = 0;
      const publishProgress = (cachedRanges?: TimeRange[]) => {
        const t = Date.now();
        if (!cachedRanges && t - last < 500 && progress < 1) return;
        last = t;
        quietProgress(this.ctx, `render progress (${id})`, () => {
          const upd = this.update(id, r => r.state === "running" ? { progress, ...(cachedRanges && { cachedRanges }) } : undefined);
          if (upd) this.ctx.bus.publish({ type: "render.updated", projectId: upd.projectId, render: upd });
        });
      };
      const onProgress = (p: number) => { progress = Math.min(1, Math.max(0, p)); publishProgress(); };
      const onWarning = (warning: string) => this.ctx.log(`[render] ${id} warning: ${clip(warning, 300)}`);
      const opts = { mediaRoot: this.ctx.paths.media(project.id), quality: render.quality ?? "preview", height: render.height, hwaccel: render.hwaccel, onProgress, onWarning, signal } as const;
      if (render.kind === "full" || render.kind === "export") {
        const custom = render.kind === "export" ? {
          exportHeight: render.height, exportRange: render.range ?? undefined, omitCaptions: render.exportOptions?.omitCaptions,
          best: render.exportOptions?.bestQuality,
        } : {};
        encoding = await this.ctx.render.renderFullCached(project, timeline, this.ctx.paths.segments(project.id), output, {
          ...opts, ...custom, concurrency: Math.max(1, this.ctx.settings().render.concurrency),
          onCachedRanges: render.kind === "full" && render.quality === "preview" ? publishProgress : undefined,
        });
      } else if (render.kind === "playback" && render.range) {
        await this.ctx.render.renderPlaybackSegment(project, timeline, render.range, this.ctx.paths.segments(project.id), output, opts);
      } else {
        const range = render.range ?? { start: 0, end: timelineDuration(timeline) };
        const sections = render.kind === "segment" && (render.quality ?? "preview") === "preview" && render.range
          ? spanningSections(this.sections(entry, project), range) : undefined;
        // A preview window on whole sections is assembled from the section cache: only what isn't cached is encoded.
        const assembled = sections && Math.abs(sections.start - range.start) < 1e-6 && Math.abs(sections.end - range.end) < 1e-6 &&
          await this.ctx.render.renderFullCached(project, timeline, this.ctx.paths.segments(project.id), output,
            { ...opts, exportRange: sections, concurrency: 1 }).then(() => true, (error: unknown) => {
            if (signal.aborted) throw error;
            this.ctx.log(`[render] ${id} couldn’t assemble its window from sections, rendering it whole: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
            rmSync(output, { force: true });
            return false;
          });
        if (!assembled) await this.ctx.render.renderRange(project, timeline, range, output, opts);
      }
      if (signal.aborted) return;
      if (queuedKey) {
        const latest = this.projectFor(render);
        if (!latest || !this.isCurrent(render, latest)) throw conflict("render_source_changed", "A source changed during the render. Request a new render.");
      }
      const size = statSync(output).size;
      if (size === 0) throw new Error("render produced an empty file");
      const duration = render.range ? render.range.end - render.range.start : timelineDuration(timeline);
      this.finish(id, { state: "done", progress: 1, path: file, durationSeconds: duration, finishedAt: now() });
      unpublished = undefined;
      if (encoding && isVideoExport(render)) {
        let mode: string;
        if (encoding.encoder === "copy") mode = "copied original video";
        else if (encoding.rendered === 0) mode = "assembled cached video";
        else mode = (encoding.encoder === "libx264" ? "software encoder " : "hardware encoder ") + encoding.encoder;
        this.ctx.log(`[render] ${id} export video: ${mode}`);
      }
    } catch (e) {
      if (signal.aborted) return;
      const message = e instanceof Error ? e.message : String(e);
      this.ctx.log(`[render] ${id} failed: ${message}`);
      const media = project ? this.ctx.paths.media(project.id) : "";
      const sources = (project?.media ?? []).filter(asset => read.has(asset.id))
        .map(asset => ({ name: asset.name, file: join(media, asset.path) }));
      const what = render.kind === "full" || render.kind === "export" ? "the video" : "this part of the video";
      const error = renderFailure(e, sources, what);
      // ffmpeg's own words stay with the render for an agent to read, as far as they say anything the sentence doesn't.
      this.finish(id, { state: "failed", error, ...(error !== message && { errorDetail: message.slice(0, 4000) }), finishedAt: now() });
    } finally {
      if (unpublished) rmSync(unpublished, { force: true });
    }
  }
}
