import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Render } from "@scarlet/shared";
import { newId, spanningSections, stableStringify, timelineDuration, type Project, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict } from "../errors.js";
import { clip, logId } from "../logText.js";
import type { RenderEncoding } from "../render/adapter.js";
import { recordRenderFinished } from "../telemetry/events.js";
import { errorMessage } from "../util.js";
import { logActivity } from "./activity.js";
import { editorFirst } from "./editorFirst.js";
import { quietProgress } from "./progressSave.js";
import {
  assemblyRevision,
  computeRenderContentKey,
  isVideoExport,
  playbackCoverage,
  renderFailure,
  renderKeyFor,
  renderOutputFormat,
  renderVersionSections,
  resolveRenderVersion,
  sameQueuedSource,
  windowRenderVersion,
  workerAlive,
  workerPid,
  type RenderFormat,
  type RenderInput,
  type RenderVersion,
} from "./renderKeys.js";
import { prepareSourceProxies } from "./sourcePreviews.js";

export type { RenderInput } from "./renderKeys.js";

const yieldCacheWorker = Symbol("yield cache worker");
enum Priority { Playback, Requested, Preparation, FullCache }

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

  private assertQueuedSourceUnchanged(render: Render, project: Project, currentKey = this.contentKeyOf(render, project), assembly = assemblyRevision(render)): void {
    const previousKey = render.previewContentKey;
    if (!previousKey) return;
    if (!sameQueuedSource(previousKey, currentKey, assembly) &&
        !sameQueuedSource(previousKey, this.contentKeyOf(render, project, true), assembly)) {
      throw conflict("render_source_changed", "A source changed after this render was queued. Request a new render.");
    }
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
              this.ctx.log(`[render] ${render.id} couldn’t remove the file its engine left unfinished: ${errorMessage(error)}`);
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
            this.assertQueuedSourceUnchanged(render, saved);
            const format = renderOutputFormat(this.ctx, saved, input, render.height);
            render = { ...render, ...format, key: this.keyFor(saved, input, format),
              previewContentKey: this.renderContentKey(saved, input, format, mode) };
          } catch (error) {
            this.finish(render.id, { state: "failed", error: errorMessage(error), finishedAt: now() });
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

  keyFor(project: Pick<Project, "settings">, input: RenderInput, format?: RenderFormat): string {
    return renderKeyFor(this.ctx, project, input, format);
  }

  private version(project: Pick<Project, "id" | "head">, version: string): RenderVersion {
    return resolveRenderVersion(this.ctx, this.versions, project, version);
  }

  /**
   * A cut's playback window widened to whole playback sections. Its file is then assembled from the sections the full
   * preview and the cut player cache, so a window beside one already played encodes only the sections around its join.
   */
  sectionWindow(project: Pick<Project, "id" | "settings">, version: string, range: TimeRange): TimeRange {
    return spanningSections(renderVersionSections(this.version({ id: project.id, head: null }, version), project), range) ?? range;
  }

  private projectFor(input: Pick<RenderInput, "projectId" | "kind" | "range" | "version"> & { projectSettings?: Project["settings"] }) {
    if ((input.kind !== "playback" && input.kind !== "segment") || !input.range) return this.ctx.repos.projects.get(input.projectId);
    const header = this.ctx.repos.projects.header(input.projectId);
    if (!header) return null;
    const entry = this.version(header, input.version);
    if (entry.hasTransitions) return this.ctx.repos.projects.get(input.projectId);
    const { sourceIds } = windowRenderVersion(entry, playbackCoverage(input.range, (input.projectSettings ?? header.settings).fps));
    return { ...header, media: this.ctx.repos.projects.assets(header.id, sourceIds) };
  }

  private renderContentKey(project: Project, input: RenderInput, output?: Pick<Render, "height" | "hwaccel">, mode?: "local" | "export", legacyTransitions = false): string | undefined {
    return computeRenderContentKey(this.ctx, this.versions, project, input, output, mode, legacyTransitions);
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
    const format = renderOutputFormat(this.ctx, project, input);
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
          .catch((e) => this.ctx.log(`[render] ${id} crashed: ${errorMessage(e)}`))
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
        if (previousKey && !(oldRange && currentKey)) {
          this.assertQueuedSourceUnchanged(render, project, currentKey, assembly);
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
      const scope = render.kind === "playback" && render.range ? windowRenderVersion(entry, playbackCoverage(render.range, project.settings.fps), project) : entry;
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
          ? spanningSections(renderVersionSections(entry, project), range) : undefined;
        // A preview window on whole sections is assembled from the section cache: only what isn't cached is encoded.
        const assembled = sections && Math.abs(sections.start - range.start) < 1e-6 && Math.abs(sections.end - range.end) < 1e-6 &&
          await this.ctx.render.renderFullCached(project, timeline, this.ctx.paths.segments(project.id), output,
            { ...opts, exportRange: sections, concurrency: 1 }).then(() => true, (error: unknown) => {
            if (signal.aborted) throw error;
            this.ctx.log(`[render] ${id} couldn’t assemble its window from sections, rendering it whole: ${clip(errorMessage(error), 300)}`);
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
      const message = errorMessage(e);
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
