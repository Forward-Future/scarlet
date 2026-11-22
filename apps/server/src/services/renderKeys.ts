import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DELIVERY_AUDIO_REVISION,
  lutFileStamps,
  MissingFilterError,
  missingTextFilterMessage,
  NO_DRAWTEXT,
  PROXY_CLOCK_REVISION,
  RENDER_REVISION,
  segmentKey,
  snapRange,
  usesRevisedProxyClock,
} from "@scarlet/render";
import type { Render, RenderKind } from "@scarlet/shared";
import {
  clipEnd,
  intervalCandidates,
  planPlaybackSegments,
  planTransitions,
  sha256,
  stableStringify,
  timelineDuration,
  type Clip,
  type Project,
  type Timeline,
  type TimeRange,
  type TransitionJoin,
} from "@scarlet/timeline";
import { engineIsAlive, type Ctx } from "../context.js";
import { HttpError } from "../errors.js";
import { errorMessage, rememberLast, sameStamp } from "../util.js";
import { resolveTimeline } from "./timeline.js";

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

export interface RenderVersion {
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

export type RenderFormat = { height: number; hwaccel: NonNullable<Render["hwaccel"]> };

/**
 * What a playback section reads: the section as asked and the frame-snapped range its cache key names. Older queued
 * sections can have a saved format or endpoints that aren't on a frame, so neither is assumed to hold the other.
 */
export function playbackCoverage(range: TimeRange, fps: number): TimeRange {
  const snapped = snapRange(range, fps);
  return { start: Math.min(snapped.start, range.start), end: Math.max(snapped.end, range.end) };
}

export function workerAlive(ctx: Ctx, pid?: number): boolean {
  return !!pid && engineIsAlive(ctx, pid);
}

/** The engine working on a pending render. A released export keeps its demand mark for the next engine to adopt. */
export function workerPid(render: Pick<Render, "queuePid" | "demandPid" | "export">): number | undefined {
  return render.export ? render.queuePid : render.queuePid ?? render.demandPid;
}

/**
 * Why a render failed, in words the editor can act on. ffmpeg's own output, and the filter graph the renderer adds to
 * it, names files by their place in Scarlet's library and means nothing to the editor: that stays in the log. The
 * queue's own reasons, such as a source that changed while the render waited, are sentences already.
 * `sources`: the files the render read, by the names the editor gave them.
 */
export function renderFailure(error: unknown, sources: ReadonlyArray<{ name: string; file: string }>, what: string): string {
  if (error instanceof HttpError || error instanceof MissingFilterError) return error.message;
  const said = `${errorMessage(error)}\n${(error as { stderr?: unknown } | undefined)?.stderr ?? ""}`;
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

export function isVideoExport(input: Pick<Render, "kind" | "quality">): boolean {
  return input.kind === "export" || (input.kind === "full" && input.quality === "delivery");
}

// An assembly can expire independently of its encoded picture sections.
export function assemblyRevision(input: Pick<Render, "kind" | "quality">): string {
  if (isVideoExport(input)) return `-mix${DELIVERY_AUDIO_REVISION}`;
  return input.kind === "full" ? "-pts1" : "";
}

// Old assemblies can be rebuilt against the same sources after a delivery mix or proxy clock upgrade.
export function sameQueuedSource(previousKey: string, currentKey: string | undefined, assembly: string): boolean {
  if (!currentKey) return false;
  if (currentKey === previousKey) return true;
  const priorAssembly = assembly.startsWith("-mix") ? previousKey.replace(/-mix3(?=-clock\d+$|$)/, "") : previousKey;
  const priorSourceKey = priorAssembly.replace(/-clock2$/, "");
  return [currentKey, currentKey.replace(assembly, "")].some(key =>
    key === priorAssembly || key === priorSourceKey + `-clock${PROXY_CLOCK_REVISION}`);
}

export function renderOutputHeight(ctx: Ctx, projectHeight: number, input: RenderInput): number {
  if (input.kind === "export") return Math.min(projectHeight, input.exportOptions?.height ?? projectHeight);
  return input.quality === "delivery" ? projectHeight : Math.min(ctx.settings().render.previewHeight, projectHeight);
}

export function renderOutputFormat(
  ctx: Ctx,
  project: Pick<Project, "settings">,
  input: RenderInput,
  height = renderOutputHeight(ctx, project.settings.height, input),
): RenderFormat {
  // The editor's choice holds for exports too: "none" encodes in software, a named device uses that one.
  return { height, hwaccel: ctx.settings().render.hwaccel };
}

export function renderKeyFor(
  ctx: Ctx,
  project: Pick<Project, "settings">,
  input: RenderInput,
  format = renderOutputFormat(ctx, project, input),
): string {
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

export function resolveRenderVersion(
  ctx: Ctx,
  versions: Map<string, RenderVersion>,
  project: Pick<Project, "id" | "head">,
  version: string,
): RenderVersion {
  const key = JSON.stringify([project.id, version === "head" ? project.head : version]);
  const previous = versions.get(key);
  if (previous) {
    versions.delete(key);
    versions.set(key, previous);
    return previous;
  }
  const timeline = resolveTimeline(ctx, project, version);
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
  ctx.db.afterCommit(() => { rememberLast(versions, key, entry, 4); });
  return entry;
}

export function renderVersionSections(entry: RenderVersion, project: Pick<Project, "settings">): TimeRange[] {
  const fps = project.settings.fps;
  if (entry.sections?.fps !== fps) {
    let ranges: TimeRange[] = [];
    try { ranges = planPlaybackSegments(project, entry.timeline); } catch { /* Too long to plan: no file is assembled from sections. */ }
    entry.sections = { fps, ranges };
  }
  return entry.sections.ranges;
}

/** The clips a transition joins inside `range`, both sides of each join, wherever those clips start or end. */
function transitionClipsIn(entry: RenderVersion, range: TimeRange, project?: Project) {
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

export function windowRenderVersion(entry: RenderVersion, range: TimeRange, project?: Project) {
  const transitionClips = transitionClipsIn(entry, range, project);
  const key = JSON.stringify([range, [...transitionClips]]);
  const cached = entry.windows.get(key);
  if (cached) return cached;
  const clipsIn = entry.clipsIn ??= entry.timeline.tracks.map(track => intervalCandidates(track.clips, clip => clip.timelineIn, clipEnd));
  const sourceIds = new Set<string>();
  const tracks = entry.timeline.tracks.map((track, i) => {
    let candidates = clipsIn[i]!(range.start, range.end);
    if (transitionClips.size) {
      // A join's clips can lie outside the window: the picture before it has ended, or the next one hasn't begun.
      const where = entry.clipsById ??= new Map(entry.timeline.tracks.flatMap((t, trackIdx) => t.clips.map((clip, index) => [clip.id, { track: trackIdx, index, clip }] as const)));
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
  return rememberLast(entry.windows, key, { timeline: { ...entry.timeline, tracks }, sourceIds }, 4);
}

export function computeRenderContentKey(
  ctx: Ctx,
  versions: Map<string, RenderVersion>,
  project: Project,
  input: RenderInput,
  output: Pick<Render, "height" | "hwaccel"> = renderOutputFormat(ctx, project, input),
  mode?: "local" | "export",
  legacyTransitions = false,
): string | undefined {
  if (input.kind === "export") {
    const source = computeRenderContentKey(ctx, versions, project, { ...input, kind: "full", range: null },
      output, "export", legacyTransitions);
    return source && "export-v1-" + sha256(stableStringify([source, input.version, input.range, input.exportOptions])) + assemblyRevision(input);
  }
  const full = input.kind === "full" && input.range === null;
  if (!full && ((input.kind !== "segment" && input.kind !== "playback") || input.quality !== "preview" || !input.range)) return undefined;
  const entry = resolveRenderVersion(ctx, versions, project, input.version);
  const range = full ? { start: 0, end: entry.duration } : snapRange(input.range!, project.settings.fps);
  if (range.end <= range.start) return undefined;
  const settings = ctx.settings().render;
  const format = { quality: input.quality, height: output?.height ?? renderOutputHeight(ctx, project.settings.height, input),
    encoder: output?.hwaccel ?? settings.hwaccel };
  const { timeline, sourceIds } = full ? entry : windowRenderVersion(entry, range, legacyTransitions ? undefined : project);
  const root = ctx.paths.media(project.id);
  const assets = project.media.filter(asset => sourceIds.has(asset.id)).sort((a, b) => a.id.localeCompare(b.id));
  const luts = entry.hasLut ? lutFileStamps(timeline, root) : [];
  let local = mode !== undefined || !!luts.length || sourceIds.size !== assets.length;
  const files = assets.map(asset => {
    let file;
    try { file = statSync(join(root, asset.path), { throwIfNoEntry: false }); } catch { /* Record unavailable inputs. */ }
    const stamp = asset.fingerprintStamp;
    if (!asset.hash || !file?.isFile() || (stamp && !sameStamp(file, stamp))) local = true;
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
    return rememberLast(entry.fullKeys, signature, key, 4);
  }
  // Playback of a newly imported recording can overlap its background hash. The source
  // path and physical stamp identify its bytes both before and after that hash arrives.
  const content = segmentKey(originals, timeline, range, format, undefined, legacyTransitions);
  return "range-v2-" + sha256(stableStringify([input.kind, input.projectId, input.range, content, stamps, luts, pictureInputs])) + clockSuffix();
}
