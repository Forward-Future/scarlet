/**
 * In-memory stand-in for ScarletClient (native desktop demo). Same method
 * signatures (see ScarletApi), fixture data from ./fixtures, and a small
 * event emitter that plays the role of the WebSocket: renders progress,
 * tasks stream log lines, a change becomes ready, uploads finish ingesting.
 */
import { buildThreads, threadRevision, threadTimeline, taskNeedsTranscripts, taskRecoveryAction, ScarletApiError, isAsideTask, isSkillEdit, ReviseLearningRequest } from "@scarlet/shared";
import { appliedReviewChange } from "@scarlet/timeline";
import type { ApproveLearningRequest, EditSkillRequest, Learning, RunChoice, UsageGroupBy, UsageResponse } from "@scarlet/shared";
import type {
  AgentHost,
  BatchSummariesRequest,
  BatchSummariesResponse,
  CreateNoteRequest,
  ReviseRequest,
  CreateTaskRequest,
  FullRenderKeys,
  PlaybackCacheStatus,
  SourceCacheStatus,
  ProjectSummary,
  Render,
  RenderRequest,
  ServerSettings,
  Skill,
  SkillVersion,
  StorageCleanup,
  StorageProject,
  TaskAttachment,
  Task,
  TaskEvent,
  UpsertSkillRequest,
  User,
  VersionSummary,
} from "@scarlet/shared";
import type { AudioTrackSelection, Change, MediaAsset, Note, Project, Timeline, TimelineDiff, TimeRange, Transcript } from "@scarlet/timeline";
import { adjustCut, adjustEdit, applyOps, diffTimelines, frameAligned, newId, putBackCut, timelineDuration, ASPECT_PRESETS } from "@scarlet/timeline";
import type { ActivityEntry, ApproveResponse, HandoffResponse, StagedCutRevision, TrashedProject } from "@scarlet/shared";
import type { ScarletApi } from "../api";
import { bootBackgroundActivity } from "./background";
import { reviewCuts } from "./cutReview";
import type { Emitter } from "./emitter";
import { captionDataUrl, handoffFiles, otioDataUrl } from "./exportFiles";
import { addImportedMedia, removeMedia, setMediaAudioTrack, setMediaNote, transcribe, uploadMedia } from "./media";
import { releaseRender, renders, requestRender } from "./renderJobs";
import { createNote, rejectChange, reopenChange, reviseChange, unapproveChange } from "./review";
import { applyChange, retryAttempt, runRetry, stopTask } from "./runs";
import { approveLearning, createSkill, declineLearning, editSkill, reviseLearning, skillFromChange, updateSkill } from "./skills";
import { MockStore } from "./store";
import { answerTask, createTask, holdForRewording, resumeEditing, rewordTask, startBeforeCalls, stopEditing } from "./taskActions";
import { Trash } from "./trash";
import { isFinished, notFound, now, sleep } from "./util";
import { checkout, historyEdit } from "./versions";
import { sampleWaveform } from "./waveform";

function emptyUsage(by: UsageGroupBy): UsageResponse {
  return { by, total: { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, firstAt: null, lastAt: null }, groups: [] };
}

export class MockClient implements ScarletApi {
  readonly events: Emitter;
  private readonly store: MockStore;
  private readonly trashBin = new Trash();

  constructor(tokenSource: () => string | undefined, chatLayouts = false) {
    this.store = new MockStore(tokenSource, chatLayouts);
    this.events = this.store.events;
    bootBackgroundActivity(this.store);
  }

  // --- plumbing ------------------------------------------------------------
  get token(): string | undefined {
    return this.store.token;
  }
  url(path: string): string {
    return `/api${path}`;
  }
  fileUrl(path: string): string {
    return `/api${path}`;
  }
  wsUrl(): string {
    return "ws://mock.invalid/ws";
  }

  private async latency<T>(value: T, ms = 120): Promise<T> {
    await sleep(ms);
    return value;
  }
  private requireAuth() {
    this.store.requireAuth();
  }

  // --- auth ---------------------------------------------------------------------
  async me(): Promise<{ user: User }> {
    this.requireAuth();
    return this.latency({ user: this.store.currentUser() }, 80);
  }

  // --- projects -----------------------------------------------------------------
  async projects(): Promise<{ projects: ProjectSummary[] }> {
    this.requireAuth();
    const projects = this.store.db.projects.filter(p => !this.trashBin.has(p.id)).map(p => ({ ...this.store.summary(p.id) }));
    return this.latency({ projects }, 200);
  }
  async createProject(body: { name: string; settings?: Partial<Project["settings"]> }): Promise<{ project: Project }> {
    this.requireAuth();
    const aspect = body.settings?.aspect ?? "16:9";
    const dims = ASPECT_PRESETS[aspect] ?? { width: 1920, height: 1080 };
    const project: Project = {
      id: newId("prj"),
      name: body.name,
      settings: { fps: 30, sampleRate: 48000, audioChannels: 2, aspect, ...dims, ...body.settings },
      media: [],
      head: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.db.projects.unshift(project);
    this.store.db.summaries[project.id] = { id: project.id, name: project.name, settings: project.settings, head: null, mediaCount: 0, pendingChanges: 0, openNotes: 0, createdAt: project.createdAt, updatedAt: project.updatedAt };
    this.store.db.media[project.id] = [];
    this.store.db.versions[project.id] = [];
    return this.latency({ project }, 250);
  }
  async createSampleProject(): Promise<{ project: Project }> {
    this.requireAuth();
    const demo = this.store.db.projects[0];
    if (demo) return this.latency({ project: demo }, 250);
    return this.createProject({ name: "Sample project" });
  }
  async workspace(id: string) {
    this.requireAuth();
    const project = this.store.projectById(id);
    return this.latency({ project: { ...project, media: this.store.db.media[id] ?? [] },
      timeline: project.head ? this.store.db.timelines[project.head] ?? null : null }, 180);
  }
  async stopEditing(id: string): Promise<{ project: Project; tasks: Task[] }> {
    this.requireAuth();
    return this.latency(stopEditing(this.store, id));
  }
  async resumeEditing(id: string, choice?: RunChoice): Promise<{ project: Project; tasks: Task[] }> {
    this.requireAuth();
    return this.latency(resumeEditing(this.store, id, choice));
  }
  private projectThread(id: string, threadId: string) {
    const thread = buildThreads({ changes: this.store.db.changes.filter(c => c.projectId === id),
      tasks: this.store.db.tasks.filter(t => t.projectId === id), notes: this.store.db.notes.filter(n => n.projectId === id) }).find(t => t.id === threadId);
    if (!thread) throw notFound("thread");
    return thread;
  }

  async recordEditReview(): Promise<void> { /* The demo has no analytics engine. */ }
  /** The demo has no runs to tell: this window remembers its Keeps. */
  async keepEdits(): Promise<void> {}
  async unkeepEdits(): Promise<void> {}
  async threadEdits(id: string, threadId: string) {
    const project = this.store.projectById(id);
    const thread = this.projectThread(id, threadId);
    const head = project.head && this.store.db.timelines[project.head];
    return { version: project.head, edits: head ? threadTimeline(thread, head, this.store.db.versions[id] ?? [],
      version => this.store.db.timelines[version], project.settings.fps, this.store.db.media[id]) : [] };
  }

  async summarizeBatches(id: string, body: BatchSummariesRequest): Promise<BatchSummariesResponse> {
    this.requireAuth();
    this.store.projectById(id);
    const summaries: Record<string, string> = {};
    for (const batch of body.batches) {
      const labels = batch.samples.map(s => s.label.toLowerCase());
      const desc = (batch.descriptions ?? []).join(" ").toLowerCase();
      if (batch.isDialoguePass) {
        const parts = Object.entries(batch.breakdown ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 2);
        summaries[batch.key] = parts.length
          ? `${batch.count} dialogue cuts: ${parts.join(" & ")}`
          : `${batch.count} dialogue cuts: pauses & retakes`;
      } else if (labels.includes("music bed") && labels.includes("wrap")) {
        summaries[batch.key] = "Tightened wrap & music bed";
      } else if (desc.includes("false start") && desc.includes("tangent")) {
        summaries[batch.key] = "Cut false start & 14 s tangent";
      } else {
        const names = [...new Set(batch.samples.map(s => s.label.trim()).filter(Boolean))];
        const kindNoun: Record<string, string> = {
          cut: "cuts", graphic: "graphics", zoom: "zooms", reframe: "reframes",
          broll: "B-roll shots", overlay: "overlays", text: "text edits", audio: "audio edits",
          dip: "music dips", voice: "voice cleanups", transition: "transitions",
          speed: "speed changes", split: "split edits", restore: "restored passages", insert: "inserts",
        };
        const noun = (batch.kind && kindNoun[batch.kind]) ?? "edits";
        summaries[batch.key] = names.length >= 2 && names.length <= 2
          ? `${batch.count} ${noun}: ${names.join(" & ")}`.slice(0, 52)
          : `${batch.count} ${noun}`;
      }
    }
    return this.latency({ summaries, pending: [] }, 60);
  }

  async setThreadDone(id: string, threadId: string, done: boolean, revision: string) {
    const project = this.store.projectById(id);
    const thread = this.projectThread(id, threadId);
    if (threadRevision(thread) !== revision || (done && (thread.active || thread.question || thread.status === "working")))
      throw new ScarletApiError(409, "thread_changed", "Wait for the thread to finish.");
    const completedThreads = { ...project.completedThreads };
    if (done) completedThreads[thread.id] = revision;
    else delete completedThreads[thread.id];
    project.completedThreads = completedThreads;
    this.store.emit({ type: "project.updated", projectId: id, project: { ...project } });
    return { completedThreads };
  }

  async updateProject(id: string, body: Record<string, unknown>): Promise<{ project: Project }> {
    this.requireAuth();
    const project = this.store.projectById(id);
    const s = this.store.summary(id);
    const expected = body.expectedFormat as Pick<Project, "head" | "settings"> | undefined;
    if (expected && (project.head !== expected.head || JSON.stringify(project.settings) !== JSON.stringify(expected.settings))) return { project };
    if (typeof body.mediaPaused === "boolean") project.mediaPaused = body.mediaPaused;
    if (typeof body.archived === "boolean") {
      project.archived = body.archived;
      s.archived = body.archived;
    }
    if (typeof body.name === "string") {
      project.name = body.name;
      s.name = body.name;
    }
    if (body.settings && typeof body.settings === "object") {
      const settings = body.settings as Partial<Project["settings"]>;
      project.settings = { ...project.settings, ...settings };
      const preset = ASPECT_PRESETS[project.settings.aspect];
      if (preset && settings.aspect && !settings.width) {
        project.settings = { ...project.settings, ...preset };
      }
      s.settings = project.settings;
      // As in the engine: "Last edited" moves when the video's settings change, not for a new name or an archive.
      project.updatedAt = now();
      s.updatedAt = project.updatedAt;
    }
    this.store.emitProject(id);
    return this.latency({ project });
  }
  async deleteProject(id: string): Promise<Record<string, never>> {
    this.requireAuth();
    const project = this.store.db.projects.find((p) => p.id === id);
    if (project) this.trashBin.add(project);
    this.store.db.projects = this.store.db.projects.filter((p) => p.id !== id);
    this.store.log(id, "project.deleted", `${this.store.currentUser().name} moved the project to the trash`);
    return this.latency({});
  }
  async storage(): Promise<{ projects: StorageProject[] }> {
    this.requireAuth();
    return { projects: [
      ...this.store.db.projects.map(p => ({ id: p.id, name: p.name, deletedAt: null, busy: false, missingSource: false, segments: [] })),
      ...this.trashBin.rows().map(row => ({ ...row, busy: false, missingSource: false, segments: [] })),
    ] };
  }
  async cleanStorage(selection: StorageCleanup) {
    const current = (await this.storage()).projects;
    for (const p of selection.projects) {
      if (!current.some(row => row.id === p.id && row.deletedAt === p.deletedAt) ||
          (selection.kind === "trash") !== (p.deletedAt !== null)) throw new Error("The project changed. Rescan storage.");
    }
    if (selection.kind === "trash") this.trashBin.purge(new Set(selection.projects.map(p => p.id)));
    return { projects: selection.projects.length };
  }
  async trash(): Promise<{ projects: TrashedProject[] }> {
    this.requireAuth();
    return this.latency({ projects: this.trashBin.rows() });
  }
  async restoreProject(id: string): Promise<{ project: Project }> {
    this.requireAuth();
    const t = this.trashBin.take(id);
    if (!t) throw notFound("Project in the trash");
    t.project.archived = false;
    this.store.db.projects.unshift(t.project);
    this.store.summary(id).archived = false;
    this.store.log(id, "project.restored", `${this.store.currentUser().name} restored the project from the trash`);
    return this.latency({ project: t.project });
  }
  async activity(projectId: string, q: { before?: string; beforeId?: string; limit?: number; type?: string } = {}): Promise<{ activity: ActivityEntry[] }> {
    this.requireAuth();
    const list = this.store.activityLog.filter((a) => a.projectId === projectId && (!q.before || a.createdAt < q.before || (a.createdAt === q.before && q.beforeId && a.id < q.beforeId)) && (!q.type || a.type.startsWith(q.type)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return this.latency({ activity: list.slice(0, q.limit ?? 200) }, 150);
  }
  async serverActivity(q: { before?: string; beforeId?: string; limit?: number } = {}): Promise<{ activity: ActivityEntry[] }> {
    this.requireAuth();
    const list = this.store.activityLog.filter((a) => a.projectId === null && (!q.before || a.createdAt < q.before || (a.createdAt === q.before && q.beforeId && a.id < q.beforeId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return this.latency({ activity: list.slice(0, q.limit ?? 200) });
  }
  // --- media ----------------------------------------------------------------------
  async media(projectId: string): Promise<{ media: MediaAsset[] }> {
    this.requireAuth();
    return this.latency({ media: this.store.db.media[projectId] ?? [] });
  }
  async uploadMedia(projectId: string, file: Blob, name: string, kind?: string): Promise<{ media: MediaAsset }> {
    this.requireAuth();
    return this.latency(uploadMedia(this.store, projectId, file, name, kind), 200);
  }
  async expandMediaPaths(paths: string[]): Promise<{ files: string[]; folders: number; emptyFolders: Array<{ path: string; name: string }> }> {
    this.requireAuth();
    return { files: [...paths], folders: 0, emptyFolders: [] };
  }
  async importMedia(projectId: string, body: { path?: string; url?: string; kind?: string; importId?: string }, signal?: AbortSignal): Promise<{ media: MediaAsset }> {
    this.requireAuth();
    if (signal) {
      await sleep(400);
      signal.throwIfAborted();
    }
    const saved = body.importId && this.store.db.media[projectId]?.find(asset => asset.importId === body.importId);
    if (saved) return { media: saved };
    const media = addImportedMedia(this.store, projectId, body);
    return signal ? { media } : this.latency({ media }, 400);
  }
  async removeMedia(projectId: string, mediaId: string): Promise<Record<string, never>> {
    this.requireAuth();
    return this.latency(removeMedia(this.store, projectId, mediaId));
  }
  async setMediaNote(mediaId: string, note: string): Promise<{ media: MediaAsset }> {
    this.requireAuth();
    return this.latency(setMediaNote(this.store, mediaId, note));
  }
  async setMediaAudioTrack(mediaId: string, audioTrack: AudioTrackSelection): Promise<{ media: MediaAsset }> {
    this.requireAuth();
    return this.latency(setMediaAudioTrack(this.store, mediaId, audioTrack));
  }
  /** The demo groups no retakes. */
  async retakes(_projectId: string, mediaId: string, _from: number, _to: number): Promise<{ mediaId: string; groups: [] }> {
    this.requireAuth();
    return this.latency({ mediaId, groups: [] });
  }
  async transcript(mediaId: string, opts: { from?: number; to?: number; granularity?: "word" | "segment" } = {}): Promise<Transcript> {
    this.requireAuth();
    const t = this.store.db.transcripts[mediaId];
    if (!t) throw notFound("Transcript");
    const segments = t.segments.filter((s) => (opts.from === undefined || s.end > opts.from) && (opts.to === undefined || s.start < opts.to));
    return this.latency({ ...t, segments: opts.granularity === "segment" ? segments.map((s) => ({ ...s, words: [] })) : segments }, 220);
  }
  async transcribe(mediaId: string, provider?: string): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(transcribe(this.store, mediaId, provider));
  }
  async waveform(mediaId: string, from: number, to: number, points = 1000) {
    return sampleWaveform(mediaId, from, to, points);
  }

  frameUrl(mediaId: string, t: number, w = 640): string {
    // Small stills from the 20-second sample, served only in the native demo.
    if (w === 160) return `/scrub/${Math.max(0, Math.min(19, Math.floor(t)))}.webp`;
    return `/sample-frame.jpg?m=${encodeURIComponent(mediaId)}&t=${t}&w=${w}`;
  }

  // --- timeline / versions -----------------------------------------------------------
  async timeline(projectId: string, version = "head"): Promise<{ timeline: Timeline }> {
    this.requireAuth();
    const id = version === "head" ? this.store.projectById(projectId).head : version;
    const tl = id ? this.store.db.timelines[id] : undefined;
    if (!tl) throw notFound("Timeline");
    return this.latency({ timeline: tl });
  }
  async versions(projectId: string): Promise<{ versions: VersionSummary[] }> {
    this.requireAuth();
    const head = this.store.projectById(projectId).head;
    const list = (this.store.db.versions[projectId] ?? []).map((v) => ({ ...v, isHead: v.version === head }));
    return this.latency({ versions: list });
  }
  /** The sample project has no engine to put an edit back: the × asks Scarlet, as it does wherever the engine can't. */
  async rejectEdits(): Promise<{ project: Project; change: Change }> {
    this.requireAuth();
    throw new ScarletApiError(409, "needs_scarlet", "This edit can’t be put back as it was.");
  }
  async adjustCut(projectId: string, body: { expectedHead: string; branch: string; threadId: string;
    cut: { changeId: string; spot: number; label: string; range: TimeRange; at: number; before: { version: string; removed: TimeRange } };
    removed: TimeRange }): Promise<{ project: Project; change: Change }> {
    this.requireAuth();
    const project = this.store.projectById(projectId);
    if (!project.head || project.head !== body.expectedHead) throw new ScarletApiError(409, "cut_changed", "The video changed. Try again.");
    const head = this.store.db.timelines[project.head];
    if (!head) throw notFound("Timeline");
    const fps = project.settings.fps;
    const oldRemoved = body.cut.before.removed;
    const oldLen = oldRemoved.end - oldRemoved.start;
    const alignMoved = (oldRange: TimeRange, nextRange: TimeRange): TimeRange => {
      const half = 0.5 / fps;
      if (nextRange.end - nextRange.start <= half) return { start: nextRange.start, end: nextRange.start };
      const aligned = frameAligned(nextRange, fps);
      const start = Math.abs(nextRange.start - oldRange.start) >= half ? aligned.start : oldRange.start;
      const end = Math.abs(nextRange.end - oldRange.end) >= half ? aligned.end : oldRange.end;
      return end > start ? { start, end } : { start, end: start };
    };
    const target = alignMoved(oldRemoved, body.removed);
    const rejects = target.end - target.start <= 0.5 / fps;
    const media = this.store.db.media[projectId] ?? project.media;
    const dur = timelineDuration(head);
    const isOpening = body.cut.at <= 0.5 / fps;
    if (isOpening && oldRemoved.start > 1 / fps) throw new ScarletApiError(409, "needs_scarlet", "This cut can’t be adjusted directly. Use Revise instead.");
    const isClosing = !isOpening && dur > 0.5 / fps && !head.tracks.some(t => t.clips.some(c => c.timelineIn >= body.cut.at - 0.5 / fps));
    const fullDelta = isOpening
      ? { ds: 0, de: -oldLen }
      : isClosing
        ? { ds: oldLen, de: 0 }
        : { ds: target.start - oldRemoved.start, de: target.end - oldRemoved.end };
    const next = rejects
      ? (putBackCut(head, body.cut.at, oldLen, fps) ?? adjustCut(head, body.cut.at, oldLen, fullDelta.ds, fullDelta.de, fps, media))
      : adjustCut(head, body.cut.at, oldLen, target.start - oldRemoved.start, target.end - oldRemoved.end, fps, media);
    if (!next) throw new ScarletApiError(409, "needs_scarlet", "This cut can’t be adjusted directly. Use Revise instead.");
    const version = newId("ver");
    const createdAt = now();
    const saved: Timeline = { ...next, version, parent: project.head, createdAt };
    this.store.db.timelines[version] = saved;
    const id = newId("chg");
    const newJoinAt = Math.max(0, body.cut.at + (target.start - oldRemoved.start));
    const description = rejects ? `Rejected · ${body.cut.label}` : `Adjusted · ${body.cut.label}`;
    const change: Change = {
      id, projectId, description, author: this.store.human(), decidedBy: this.store.human(), state: "approved", threadId: body.threadId,
      ...(rejects && { rejects: true as const }),
      fromVersion: project.head, toVersion: version, appliedOnto: project.head, appliedVersion: version,
      timelineEdits: [{
        label: body.cut.label,
        range: rejects ? { start: body.cut.at, end: body.cut.at + oldLen } : { start: newJoinAt, end: newJoinAt },
        replaces: { changeId: body.cut.changeId, spot: body.cut.spot },
      }],
      ...(!rejects && { leftOut: { version: body.cut.before.version, joins: [{ at: newJoinAt, removed: target }] } }),
      noteIds: [], renders: [], ranges: diffTimelines(head, saved, fps).ranges, createdAt, updatedAt: createdAt,
    };
    this.store.db.changes.unshift(change);
    project.head = version;
    project.updatedAt = createdAt;
    this.store.summary(projectId).head = version;
    const versions = this.store.db.versions[projectId] ?? [];
    for (const v of versions) v.isHead = false;
    versions.push({ version, parent: change.fromVersion, name: saved.name, author: change.author, changeId: id, description, duration: timelineDuration(saved), isHead: true, createdAt });
    this.store.db.versions[projectId] = versions;
    this.store.emitChange(change);
    this.store.emitProject(projectId);
    return { project: { ...project }, change };
  }
  async adjustEdit(projectId: string, body: { expectedHead: string; branch: string; threadId: string;
    edit: { changeId: string; spot: number; label: string; range: TimeRange; kind?: string };
    nextRange: TimeRange }): Promise<{ project: Project; change: Change }> {
    this.requireAuth();
    const project = this.store.projectById(projectId);
    if (!project.head || project.head !== body.expectedHead) throw new ScarletApiError(409, "cut_changed", "The video changed. Try again.");
    const head = this.store.db.timelines[project.head];
    if (!head) throw notFound("Timeline");
    const fps = project.settings.fps;
    const prior = this.store.db.changes.find(c => c.id === body.edit.changeId);
    const clipIds = prior?.ops?.flatMap(op => {
      if (op.op === "addClip" && op.clip && typeof op.clip === "object" && typeof (op.clip as { id?: unknown }).id === "string") return [(op.clip as { id: string }).id];
      if (op.op === "updateClip" && typeof op.clipId === "string") return [op.clipId];
      return [];
    });
    const half = 0.5 / fps;
    const aligned = frameAligned(body.nextRange, fps);
    const target = body.nextRange.end - body.nextRange.start <= half
      ? { start: body.nextRange.start, end: body.nextRange.start }
      : {
        start: Math.abs(body.nextRange.start - body.edit.range.start) >= half ? aligned.start : body.edit.range.start,
        end: Math.abs(body.nextRange.end - body.edit.range.end) >= half ? aligned.end : body.edit.range.end,
      };
    const result = adjustEdit(head, body.edit.range, target, fps, this.store.db.media[projectId] ?? project.media, {
      kind: body.edit.kind,
      ...(clipIds?.length && { clipIds }),
    });
    if (!result) throw new ScarletApiError(409, "needs_scarlet", "This edit can’t be adjusted directly. Use Revise instead.");
    const version = newId("ver");
    const createdAt = now();
    const saved: Timeline = { ...result.timeline, version, parent: project.head, createdAt };
    this.store.db.timelines[version] = saved;
    const id = newId("chg");
    const rejects = !!result.removed;
    const description = rejects ? `Rejected · ${body.edit.label}` : `Adjusted · ${body.edit.label}`;
    const priorNamed = prior?.timelineEdits?.[body.edit.spot];
    const change: Change = {
      id, projectId, description, author: this.store.human(), decidedBy: this.store.human(), state: "approved", threadId: body.threadId,
      ...(rejects && { rejects: true as const }),
      fromVersion: project.head, toVersion: version, appliedOnto: project.head, appliedVersion: version,
      ops: result.ops as unknown as Array<Record<string, unknown>>,
      timelineEdits: [{
        label: body.edit.label,
        range: rejects ? body.edit.range : result.range,
        ...(priorNamed?.reason && { reason: priorNamed.reason }),
        ...(priorNamed?.summary && { summary: priorNamed.summary }),
        ...(priorNamed?.check && { check: priorNamed.check }),
        replaces: { changeId: body.edit.changeId, spot: body.edit.spot },
      }],
      noteIds: [], renders: [], ranges: diffTimelines(head, saved, fps).ranges, createdAt, updatedAt: createdAt,
    };
    this.store.db.changes.unshift(change);
    project.head = version;
    project.updatedAt = createdAt;
    this.store.summary(projectId).head = version;
    const versions = this.store.db.versions[projectId] ?? [];
    for (const v of versions) v.isHead = false;
    versions.push({ version, parent: change.fromVersion, name: saved.name, author: change.author, changeId: id, description, duration: timelineDuration(saved), isHead: true, createdAt });
    this.store.db.versions[projectId] = versions;
    this.store.emitChange(change);
    this.store.emitProject(projectId);
    return { project: { ...project }, change };
  }
  async historyEdit(projectId: string, target: string, action: "revert" | "restore", expectedHead: string, branch: string) {
    this.requireAuth();
    return historyEdit(this.store, projectId, target, action, expectedHead, branch);
  }
  async checkout(projectId: string, version: string): Promise<{ project: Project }> {
    this.requireAuth();
    return this.latency(checkout(this.store, projectId, version), 250);
  }
  otioUrl(projectId: string, version: string): string {
    const project = this.store.projectById(projectId);
    return otioDataUrl({ ...project, media: this.store.db.media[projectId] ?? project.media }, this.store.versionTimeline(project, version));
  }
  srtUrl(projectId: string, version: string, opts?: { trackId?: string; start?: number; end?: number }): string {
    return this.captionUrl(projectId, version, "srt", opts);
  }
  vttUrl(projectId: string, version: string, opts?: { trackId?: string; start?: number; end?: number }): string {
    return this.captionUrl(projectId, version, "vtt", opts);
  }
  private captionUrl(projectId: string, version: string, format: "srt" | "vtt", opts?: { trackId?: string; start?: number; end?: number }): string {
    const tl = this.store.versionTimeline(this.store.projectById(projectId), version);
    if (!tl) throw notFound("Version");
    return captionDataUrl(tl, format, opts);
  }

  /** The demo's folder for another app: real timeline files, with the sample video standing in for every clip. */
  async handoff(projectId: string, version: string, folder: string): Promise<HandoffResponse> {
    const stored = this.store.projectById(projectId);
    const project = { ...stored, media: this.store.db.media[projectId] ?? stored.media };
    const tl = this.store.versionTimeline(project, version);
    if (!tl) throw notFound("Version");
    return this.latency({ files: handoffFiles(project, tl, folder), mediaBytes: 0 }, 250);
  }

  // --- changes -------------------------------------------------------------------------
  async changes(projectId: string, state?: string): Promise<{ changes: Change[] }> {
    this.requireAuth();
    return this.latency({ changes: this.store.db.changes.filter((c) => c.projectId === projectId && (!state || c.state === state)) }, 150);
  }
  async change(changeId: string): Promise<{ change: Change; diff: TimelineDiff }> {
    this.requireAuth();
    const change = this.store.changeById(changeId);
    const viewed = appliedReviewChange(change);
    const a = this.store.db.timelines[viewed.fromVersion];
    const b = this.store.db.timelines[viewed.toVersion];
    const diff = a && b ? diffTimelines(a, b, this.store.projectById(change.projectId).settings.fps) : { clips: [], tracks: [], markersChanged: false, timelineFieldsChanged: [], ranges: [], beforeRanges: [], spots: [], durationBefore: 0, durationAfter: 0 };
    return this.latency({ change, diff }, 200);
  }
  async saveCutChoices(changeId: string, body: { choices: Array<{ index: number; choice: "cut" | "keep" }>; applyWhenDone?: boolean }) {
    this.requireAuth();
    const change = this.store.changeById(changeId);
    const { review } = await this.cutReview(changeId);
    change.cutChoices = body.choices.flatMap(({ index, choice }) => {
      const removed = review?.cuts[index]?.removed;
      return removed ? [{ index, start: removed.start, end: removed.end, choice }] : [];
    });
    if (body.applyWhenDone !== undefined) change.applyWhenDone = body.applyWhenDone ? { userId: "usr_mock", at: new Date().toISOString() } : undefined;
    this.store.emitChange(change);
    return { change: { ...change } };
  }
  async reviseStagedCut(changeId: string, index: number, body: StagedCutRevision): Promise<{ change: Change; replaced?: string; index?: number; carried?: true }> {
    this.requireAuth();
    const prior = this.store.changeById(changeId);
    const project = this.store.projectById(prior.projectId);
    const { review } = await this.cutReview(changeId);
    if (!review?.cuts[index]) throw new ScarletApiError(400, "wrong_cut", "Choose a staged cut in this pass.");
    const aligned = frameAligned({ start: body.start, end: body.end }, project.settings.fps);
    const ranges = review.cuts.map((c, i) => i === index ? aligned : c.removed);
    const ops = [...ranges].reverse().map(r => ({ op: "rippleDelete" as const, start: r.start, end: r.end }));
    const base = this.store.db.timelines[prior.fromVersion];
    if (!base) throw notFound("Timeline");
    const version = newId("ver");
    const createdAt = now();
    const proposed: Timeline = { ...applyOps(base, ops), version, parent: prior.fromVersion, createdAt };
    this.store.db.timelines[version] = proposed;
    const id = newId("chg");
    const cutAssessments = prior.cutAssessments?.map(a => a.index === index ? { ...a, start: aligned.start, end: aligned.end, reason: body.reason, ...(body.summary && { summary: body.summary }) } : a);
    const revised: Change = {
      ...prior,
      id,
      toVersion: version,
      ops: ops as unknown as Array<Record<string, unknown>>,
      cutAssessments,
      cutChoices: prior.cutChoices?.filter(c => c.index !== index),
      updatedAt: createdAt,
    };
    prior.state = "rejected";
    prior.rejectedFrom = "ready";
    prior.rejectReason = "Replaced by a newer revision of this pass.";
    prior.replacedBy = id;
    prior.updatedAt = createdAt;
    this.store.db.changes.unshift(revised);
    this.store.emitChange(prior);
    this.store.emitChange(revised);
    return { change: { ...revised }, replaced: prior.id, index };
  }

  async cutReviewDraft(changeId: string, restoredCuts: number[], ontoVersion?: string) {
    const { review: _, ...result } = await this.cutReview(changeId, restoredCuts, ontoVersion);
    return result;
  }

  cutReview(changeId: string, restoredCuts?: number[], ontoVersion?: string) {
    return reviewCuts(this.store, changeId, restoredCuts, ontoVersion);
  }
  async approveChange(changeId: string, spots?: number[], restoredCuts?: number[]): Promise<ApproveResponse> {
    this.requireAuth();
    await sleep(350);
    return applyChange(this.store, changeId, spots, restoredCuts);
  }
  async unapproveChange(changeId: string): Promise<{ change: Change; project: Project }> {
    this.requireAuth();
    await sleep(250);
    return unapproveChange(this.store, changeId);
  }
  async rejectChange(changeId: string, reason?: string): Promise<{ change: Change }> {
    this.requireAuth();
    await sleep(300);
    return rejectChange(this.store, changeId, reason);
  }
  async reopenChange(changeId: string): Promise<{ change: Change }> {
    this.requireAuth();
    return reopenChange(this.store, changeId);
  }
  async reviseChange(changeId: string, body: ReviseRequest): Promise<{ change: Change; note: Note; task?: Task }> {
    this.requireAuth();
    return this.latency(reviseChange(this.store, changeId, body), 250);
  }

  // --- notes ---------------------------------------------------------------------------
  async createNote(projectId: string, body: CreateNoteRequest): Promise<{ note: Note; task?: Task }> {
    this.requireAuth();
    return this.latency(createNote(this.store, projectId, body), 200);
  }
  async speechToText(_audio: Blob): Promise<{ text: string }> {
    this.requireAuth();
    this.store.requireTranscription();
    await sleep(500);
    return { text: "Keep the pause a little longer, maybe a third of a second, so it still breathes." };
  }
  async createVoiceNote(projectId: string, audio: Blob, fields: { time: number; end?: number; version?: string; clipIds?: string[]; assignTo?: string; changeId?: string }): Promise<{ note: Note; task?: Task }> {
    this.requireAuth();
    if (this.store.db.settings.transcription.provider === "none") return this.createNote(projectId, { ...fields, text: "[voice note — transcription not configured]" });
    await sleep(900); // "transcribing…"
    const seconds = Math.max(1, Math.round(audio.size / 6000));
    const voiceTranscript = `uh so right here, ${seconds > 3 ? "the pacing drags a bit, can we tighten this section" : "tighten this up"}`;
    const text = seconds > 3 ? "The pacing drags here; tighten this section." : "Tighten this up.";
    return this.createNote(projectId, { ...fields, text, voiceTranscript });
  }
  async notes(projectId: string, state?: string): Promise<{ notes: Note[] }> {
    this.requireAuth();
    return this.latency({ notes: this.store.db.notes.filter((n) => n.projectId === projectId && (!state || n.state === state)) }, 150);
  }

  // --- renders -------------------------------------------------------------------------
  // The demo plays a bundled sample with no fragments to prepare.
  async preparePlayback(): Promise<void> {}
  async cutPlaybackFile(projectId: string, version: string, _range: TimeRange, signal: AbortSignal) {
    const { timeline } = await this.timeline(projectId, version);
    signal.throwIfAborted();
    return { url: this.renderFileUrl(version), start: 0, end: timelineDuration(timeline), full: true as const };
  }

  async requestRender(projectId: string, body: Partial<RenderRequest>): Promise<{ render: Render }> {
    this.requireAuth();
    return this.latency(requestRender(this.store, projectId, body));
  }
  async exports(): Promise<{ renders: Render[] }> {
    return { renders: [] };
  }
  async releaseRender(id: string, owner: string): Promise<void> {
    this.requireAuth();
    return releaseRender(this.store, id, owner);
  }
  async render(renderId: string): Promise<{ render: Render }> {
    this.requireAuth();
    const render = this.store.db.renders.find((r) => r.id === renderId);
    if (!render) throw notFound("Render");
    return this.latency({ render });
  }
  async renders(projectId: string, q: { kind?: string; version?: string; currentDelivery?: boolean } = {}): Promise<{ renders: Render[]; currentDeliveryKey?: string | null; fullRenderKeys?: FullRenderKeys }> {
    this.requireAuth();
    return this.latency(renders(this.store, projectId, q), 150);
  }
  renderFileUrl(renderId: string): string {
    return `/sample.mp4#render=${renderId}`;
  }
  mediaFileUrl(mediaId: string, proxy = false, audioTrack?: AudioTrackSelection): string {
    return `/sample.mp4#media=${mediaId}${proxy ? "&proxy" : ""}${proxy && audioTrack !== undefined ? `&track=${audioTrack}` : ""}`;
  }
  async sourceCache(_mediaId: string, _prepare = false): Promise<PlaybackCacheStatus> { return { state: "ready" }; }
  async sourceCaches(projectId: string): Promise<{ caches: SourceCacheStatus[] }> {
    return { caches: (this.store.db.media[projectId] ?? []).filter(m => m.kind === "video").map(m => ({ mediaId: m.id, state: "ready" })) };
  }
  sourceCacheUrl(mediaId: string) { return this.mediaFileUrl(mediaId, true); }
  sourcePreviewUrl(mediaId: string, index: number): string {
    return `/sample.mp4#media=${mediaId}&chunk=${index}`;
  }

  // --- tasks ---------------------------------------------------------------------------
  async createTask(projectId: string, body: CreateTaskRequest): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(createTask(this.store, projectId, body), 200);
  }
  async tasks(projectId: string, state?: string, events?: "conversation") {
    this.requireAuth();
    const tasks = this.store.db.tasks.filter((t) => t.projectId === projectId && !isAsideTask(t) && (!state || t.state === state));
    const conversation = events && Object.fromEntries(tasks.filter(t => t.kind !== "transcribe").map(t => [t.id, this.store.conversation(t.id)]));
    return this.latency({ tasks, conversation }, 150);
  }
  /** The demo runs no real agent, so it has no tokens to report. */
  async projectUsage(_projectId: string, by: Exclude<UsageGroupBy, "project"> = "thread"): Promise<UsageResponse> {
    this.requireAuth();
    return this.latency(emptyUsage(by), 100);
  }
  async usage(by: UsageGroupBy = "project"): Promise<UsageResponse> {
    this.requireAuth();
    return this.latency(emptyUsage(by), 100);
  }
  async task(taskId: string, scope: "all" | "conversation" = "all"): Promise<{ task: Task; events: TaskEvent[] }> {
    this.requireAuth();
    const task = this.store.taskById(taskId);
    const events = scope === "all" ? this.store.db.taskEvents[taskId] ?? [] : this.store.conversation(taskId);
    return this.latency({ task, events });
  }
  async cancelTask(taskId: string, queuedOnly = false): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.store.taskById(taskId);
    if (isFinished(task.state)) return { task };
    if (queuedOnly && (task.state !== "queued" || task.startedAt || (task.resumeRootId && !task.resumesAfterProjectStop))) {
      throw new ScarletApiError(409, "already_started", "Scarlet has already started on this request.");
    }
    stopTask(this.store, task);
    return this.latency({ task });
  }
  async startBeforeCalls(taskId: string): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(startBeforeCalls(this.store, taskId));
  }
  async holdForRewording(taskId: string, on: boolean): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(holdForRewording(this.store, taskId, on));
  }
  async rewordTask(taskId: string, text: string, skillIds?: string[]): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(rewordTask(this.store, taskId, text, skillIds));
  }
  async continueWhenReady(taskId: string, on: boolean): Promise<{ task: Task; resumed?: Task }> {
    this.requireAuth();
    const task = this.store.taskById(taskId);
    if (task.retryTaskId) return this.latency({ task, resumed: this.store.db.tasks.find(t => t.id === task.retryTaskId) });
    if (!taskNeedsTranscripts(task)) throw new ScarletApiError(409, "not_waiting", "This edit isn’t waiting for a transcript.");
    // The sample project's transcripts are always ready, so asking to wait resumes the run at once.
    if (on) return this.latency({ task, resumed: (await this.retryTask(taskId)).task });
    this.store.updateTask(task, { continueWhenReady: undefined });
    return this.latency({ task });
  }
  async retryTask(taskId: string, body: RunChoice = {}): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.store.taskById(taskId);
    if (task.retryTaskId) return this.task(task.retryTaskId);
    const action = taskRecoveryAction(task, this.store.db.changes.some(c => c.taskId === taskId));
    if (!action) throw new ScarletApiError(409, "not_retryable", "This request cannot be retried.");
    const retry = retryAttempt(this.store, task, body, action);
    this.store.updateTask(task, { retryTaskId: retry.id });
    runRetry(this.store, retry);
    return { task: retry };
  }
  async answerTask(taskId: string, text: string, skillIds?: string[], runWith?: RunChoice, files?: Parameters<typeof answerTask>[5]): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(answerTask(this.store, taskId, text, skillIds, runWith, files));
  }

  // --- hosts / skills / settings ---------------------------------------------------------
  async hosts(): Promise<{ hosts: AgentHost[] }> {
    this.requireAuth();
    return this.latency({ hosts: this.store.db.hosts }, 150);
  }
  async refreshHostQuota(): Promise<{ ok: boolean }> {
    this.requireAuth();
    return this.latency({ ok: true }, 50);
  }
  async skills(): Promise<{ skills: Skill[] }> {
    this.requireAuth();
    return this.latency({ skills: this.store.db.skills }, 150);
  }
  // --- attachments ----------------------------------------------------------------------
  async uploadAttachment(projectId: string, file: Blob | { path: string }, name?: string): Promise<{ attachment: TaskAttachment }> {
    this.requireAuth();
    this.store.projectById(projectId);
    const named = name ?? (file instanceof Blob ? (typeof File !== "undefined" && file instanceof File ? file.name : "attachment") : file.path.split(/[\\/]/).pop() || "attachment");
    const attachment: TaskAttachment = { id: newId("att"), name: named, size: file instanceof Blob ? file.size : 0,
      ...(file instanceof Blob && file.type && { mime: file.type }) };
    (this.store.db.attachments[projectId] ??= []).push(attachment);
    return this.latency({ attachment }, 200);
  }
  async createSkill(body: UpsertSkillRequest): Promise<{ skill: Skill }> {
    this.requireAuth();
    return this.latency(createSkill(this.store, body), 200);
  }
  async skill(skillId: string): Promise<{ skill: Skill; versions: SkillVersion[]; edits: Task[] }> {
    this.requireAuth();
    const skill = this.store.skillById(skillId);
    // The demo adds new tasks at the front. The page reads them in the order asked.
    const edits = this.store.db.tasks.filter(t => isSkillEdit(t) && t.context.skillId === skillId).map(t => ({ ...t })).reverse();
    return this.latency({ skill, versions: this.store.db.skillVersions[skillId] ?? [], edits });
  }
  async editSkill(skillId: string, body: EditSkillRequest): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(editSkill(this.store, skillId, body), 200);
  }
  // --- learnings ---------------------------------------------------------------------------
  async learnings(projectId: string): Promise<{ learnings: Learning[] }> {
    this.requireAuth();
    return this.latency({ learnings: this.store.db.learnings.filter(l => l.projectId === projectId && (l.state === "suggested" || l.state === "saving")).map(l => ({ ...l })) }, 120);
  }
  async approveLearning(projectId: string, learningId: string, body: ApproveLearningRequest = {}): Promise<{ learning: Learning }> {
    this.requireAuth();
    return this.latency(approveLearning(this.store, projectId, learningId, body), 150);
  }
  async reviseLearning(projectId: string, learningId: string, body: ReviseLearningRequest): Promise<{ learning: Learning }> {
    this.requireAuth();
    return this.latency(reviseLearning(this.store, projectId, learningId, body), 120);
  }
  async declineLearning(projectId: string, learningId: string): Promise<{ learning: Learning }> {
    this.requireAuth();
    return this.latency(declineLearning(this.store, projectId, learningId), 120);
  }

  async updateSkill(skillId: string, body: Partial<UpsertSkillRequest>): Promise<{ skill: Skill }> {
    this.requireAuth();
    return this.latency(updateSkill(this.store, skillId, body), 200);
  }
  async deleteSkill(skillId: string): Promise<Record<string, never>> {
    this.requireAuth();
    this.store.db.skills = this.store.db.skills.filter((s) => s.id !== skillId);
    return this.latency({});
  }
  async skillFromChange(changeId: string, name: string, agent?: string): Promise<{ task: Task }> {
    this.requireAuth();
    return this.latency(skillFromChange(this.store, changeId, name, agent), 200);
  }
  async styleGuides(): Promise<{ styleGuides: import("@scarlet/shared").StyleGuideRecord[] }> {
    this.requireAuth();
    return this.latency({ styleGuides: [...this.store.db.styleGuides] }, 100);
  }
  async styleGuide(styleGuideId: string): Promise<{ styleGuide: import("@scarlet/shared").StyleGuideRecord; edits: Task[] }> {
    this.requireAuth();
    const styleGuide = this.store.db.styleGuides.find(g => g.id === styleGuideId);
    if (!styleGuide) throw new ScarletApiError(404, "not_found", "style guide not found");
    const edits = this.store.db.tasks.filter(t => t.kind === "style_guide_edit" && t.context.styleGuideId === styleGuideId).map(t => ({ ...t })).reverse();
    return this.latency({ styleGuide, edits }, 100);
  }
  async createStyleGuide(body: import("@scarlet/shared").CreateStyleGuideRequest): Promise<{ styleGuide: import("@scarlet/shared").StyleGuideRecord }> {
    this.requireAuth();
    if (this.store.db.styleGuides.some(g => g.name.toLowerCase() === body.name.toLowerCase())) {
      throw new ScarletApiError(409, "style_guide_exists", `A style guide named "@${body.name}" already exists.`);
    }
    const ts = new Date().toISOString();
    if (body.isDefault) for (const g of this.store.db.styleGuides) g.isDefault = false;
    const styleGuide: import("@scarlet/shared").StyleGuideRecord = {
      id: newId("sg"), name: body.name, description: body.description?.trim() ?? "", instructions: body.instructions ?? "",
      ...(body.captionStyle && Object.keys(body.captionStyle).length && { captionStyle: body.captionStyle }),
      isDefault: Boolean(body.isDefault), assets: [], createdAt: ts, updatedAt: ts,
    };
    this.store.db.styleGuides.push(styleGuide);
    this.store.emit({ type: "style_guide.updated", styleGuide });
    return this.latency({ styleGuide }, 150);
  }
  async createStyleGuideFromGraphic(body: import("@scarlet/shared").StyleGuideFromGraphicRequest): Promise<{ styleGuide: import("@scarlet/shared").StyleGuideRecord }> {
    this.requireAuth();
    return this.createStyleGuide({ name: body.name, description: body.description || "Saved from project graphic", isDefault: body.isDefault });
  }
  async updateStyleGuide(styleGuideId: string, body: import("@scarlet/shared").UpdateStyleGuideRequest): Promise<{ styleGuide: import("@scarlet/shared").StyleGuideRecord }> {
    this.requireAuth();
    const guide = this.store.db.styleGuides.find(g => g.id === styleGuideId);
    if (!guide) throw new ScarletApiError(404, "not_found", "style guide not found");
    if (body.name && this.store.db.styleGuides.some(g => g.id !== styleGuideId && g.name.toLowerCase() === body.name!.toLowerCase())) {
      throw new ScarletApiError(409, "style_guide_exists", `A style guide named "@${body.name}" already exists.`);
    }
    if (body.isDefault) for (const g of this.store.db.styleGuides) if (g.id !== styleGuideId) g.isDefault = false;
    Object.assign(guide, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description.trim() }),
      ...(body.instructions !== undefined && { instructions: body.instructions }),
      ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      updatedAt: new Date().toISOString(),
    });
    if (body.captionStyle === null) delete guide.captionStyle;
    else if (body.captionStyle !== undefined) {
      if (Object.keys(body.captionStyle).length) guide.captionStyle = body.captionStyle;
      else delete guide.captionStyle;
    }
    this.store.emit({ type: "style_guide.updated", styleGuide: { ...guide } });
    return this.latency({ styleGuide: { ...guide } }, 120);
  }
  async deleteStyleGuide(styleGuideId: string): Promise<Record<string, never>> {
    this.requireAuth();
    this.store.db.styleGuides = this.store.db.styleGuides.filter(g => g.id !== styleGuideId);
    this.store.emit({ type: "style_guide.deleted", styleGuideId });
    return this.latency({});
  }
  async editStyleGuide(styleGuideId: string, body: import("@scarlet/shared").EditStyleGuideRequest): Promise<{ task: Task }> {
    this.requireAuth();
    const guide = this.store.db.styleGuides.find(g => g.id === styleGuideId);
    if (!guide) throw new ScarletApiError(404, "not_found", "style guide not found");
    const home = this.store.db.projects[0];
    if (!home) throw new ScarletApiError(409, "no_project", "Create a project first. Scarlet runs its requests from one.");
    const task = this.store.makeTask(home.id, {
      kind: "style_guide_edit",
      agent: body.agent ?? this.store.db.settings.defaultAgent,
      model: body.model,
      effort: body.effort,
      serviceTier: body.serviceTier,
      instruction: body.prompt,
      context: { styleGuideId: guide.id, ...(body.attachments?.length && { attachments: body.attachments }) },
    });
    setTimeout(() => {
      guide.description = body.prompt.trim().slice(0, 80)
        || (body.attachments?.length ? `Based on ${body.attachments.map(a => a.name).join(", ")}`.slice(0, 80) : guide.description);
      guide.updatedAt = new Date().toISOString();
      this.store.emit({ type: "style_guide.updated", styleGuide: { ...guide } });
      this.store.updateTask(task, { state: "done", resultStyleGuideId: guide.id, summary: `Updated @${guide.name}.`, finishedAt: new Date().toISOString() });
    }, 300);
    return this.latency({ task }, 150);
  }
  async uploadStyleGuideAsset(styleGuideId: string, file: Blob | { path: string }, name?: string): Promise<{ asset: import("@scarlet/shared").StyleGuideAsset; styleGuide: import("@scarlet/shared").StyleGuideRecord }> {
    this.requireAuth();
    const guide = this.store.db.styleGuides.find(g => g.id === styleGuideId);
    if (!guide) throw new ScarletApiError(404, "not_found", "style guide not found");
    const named = name ?? (file instanceof Blob ? (typeof File !== "undefined" && file instanceof File ? file.name : "asset") : file.path.split(/[\\/]/).pop() || "asset");
    const asset: import("@scarlet/shared").StyleGuideAsset = {
      id: newId("sga"), name: named, size: file instanceof Blob ? file.size : 0,
      ...(file instanceof Blob && file.type && { mime: file.type }), createdAt: new Date().toISOString(),
    };
    guide.assets = [...guide.assets, asset];
    guide.updatedAt = new Date().toISOString();
    this.store.emit({ type: "style_guide.updated", styleGuide: { ...guide } });
    return this.latency({ asset, styleGuide: { ...guide } }, 150);
  }
  styleGuideAssetUrl(styleGuideId: string, assetId: string) {
    return this.fileUrl(`/style-guides/${encodeURIComponent(styleGuideId)}/assets/${encodeURIComponent(assetId)}`);
  }
  styleGuidePreviewUrl(styleGuideId: string, updatedAt?: string) {
    const query = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return this.fileUrl(`/style-guides/${encodeURIComponent(styleGuideId)}/preview${query}`);
  }
  async localModelStatus() { return { state: "ready" as const }; }
  async settings(): Promise<{ settings: ServerSettings; transcriptionAvailable: boolean; transcriptionIssue?: string }> {
    this.requireAuth();
    return this.latency({ settings: this.store.db.settings, transcriptionAvailable: this.store.db.settings.transcription.provider !== "none" });
  }
  async updateSettings(body: Partial<ServerSettings>): Promise<{ settings: ServerSettings }> {
    this.requireAuth();
    const previous = this.store.db.settings.render;
    this.store.db.settings = { ...this.store.db.settings, ...body, transcription: { ...this.store.db.settings.transcription, ...body.transcription }, noteCleanup: { ...this.store.db.settings.noteCleanup, ...body.noteCleanup }, render: { ...this.store.db.settings.render, ...body.render } };
    if (previous.hwaccel !== this.store.db.settings.render.hwaccel || previous.previewHeight !== this.store.db.settings.render.previewHeight) this.store.emit({ type: "render.settings.updated" });
    return this.latency({ settings: this.store.db.settings }, 250);
  }

  // --- YouTube demo stand-in -----------------------------------------------------------
  private ytStatus: import("@scarlet/shared").YouTubeConnectionStatus = {
    state: "disconnected",
    configured: false,
    configSource: "none",
    hasCustomClientId: false,
    hasCustomClientSecret: false,
  };
  private ytUploads: import("@scarlet/shared").YouTubeUploadJob[] = [];

  async youtubeStatus() {
    this.requireAuth();
    return this.latency({ status: { ...this.ytStatus } }, 60);
  }
  async youtubeUpdateConfig(body: import("@scarlet/shared").YouTubeConfigRequest) {
    this.requireAuth();
    const id = body.clientId === undefined ? (this.ytStatus.hasCustomClientId ? "custom" : "") : (body.clientId?.trim() ?? "");
    const hasSecret = body.clientSecret === undefined ? !!this.ytStatus.hasCustomClientSecret : !!body.clientSecret?.trim();
    this.ytStatus = {
      ...this.ytStatus,
      configured: !!id,
      configSource: id ? "custom" : "none",
      hasCustomClientId: !!id,
      hasCustomClientSecret: hasSecret,
      clientIdHint: id ? `${id.slice(0, 8)}…` : undefined,
    };
    this.store.emit({ type: "youtube.connection.updated", status: { ...this.ytStatus } });
    return this.latency({ status: { ...this.ytStatus } }, 80);
  }
  async youtubeConnect() {
    this.requireAuth();
    if (!this.ytStatus.configured) {
      throw new ScarletApiError(400, "youtube_not_configured", "Add a Google OAuth Client ID in Settings before connecting YouTube.");
    }
    this.ytStatus = {
      ...this.ytStatus,
      state: "connected",
      channel: { id: "UC_demo", title: "Demo Channel", handle: "@scarletdemo" },
      connectedAt: now(),
      error: undefined,
      needsReconnect: false,
    };
    this.store.emit({ type: "youtube.connection.updated", status: { ...this.ytStatus } });
    return this.latency({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth", status: { ...this.ytStatus } }, 120);
  }
  async youtubeCancelConnect() {
    this.requireAuth();
    this.ytStatus = { ...this.ytStatus, state: "disconnected", authUrl: undefined };
    this.store.emit({ type: "youtube.connection.updated", status: { ...this.ytStatus } });
    return this.latency({ status: { ...this.ytStatus } }, 60);
  }
  async youtubeDisconnect() {
    this.requireAuth();
    this.ytStatus = { ...this.ytStatus, state: "disconnected", channel: undefined, connectedAt: undefined, needsReconnect: false, error: undefined };
    this.store.emit({ type: "youtube.connection.updated", status: { ...this.ytStatus } });
    return this.latency({ status: { ...this.ytStatus } }, 80);
  }
  async youtubeChapters(projectId: string) {
    this.requireAuth();
    const project = this.store.projectById(projectId);
    const tl = project.head ? this.store.db.timelines[project.head] : undefined;
    const duration = tl ? timelineDuration(tl) : 20;
    const chapters = [
      { time: 0, timestamp: "0:00", title: "Intro" },
      { time: Math.min(7, Math.floor(duration / 3)), timestamp: `0:0${Math.min(7, Math.floor(duration / 3))}`, title: "Main discussion" },
      { time: Math.min(14, Math.floor((duration * 2) / 3)), timestamp: `0:${String(Math.min(14, Math.floor((duration * 2) / 3))).padStart(2, "0")}`, title: "Wrap-up" },
    ];
    return this.latency({
      version: project.head ?? "ver_1",
      duration,
      chapters,
      chaptersText: chapters.map(c => `${c.timestamp} ${c.title}`).join("\n"),
    }, 100);
  }
  async youtubePublish(projectId: string, body: import("@scarlet/shared").YouTubePublishRequest) {
    this.requireAuth();
    if (this.ytStatus.state !== "connected") {
      throw new ScarletApiError(401, "youtube_not_connected", "Connect your YouTube account in Settings before uploading.");
    }
    const project = this.store.projectById(projectId);
    const job: import("@scarlet/shared").YouTubeUploadJob = {
      id: newId("ytup"),
      projectId,
      version: project.head ?? "ver_1",
      context: `${projectId}:${project.head ?? "ver_1"}`,
      phase: "done",
      progress: 1,
      title: body.title,
      visibility: body.visibility,
      videoId: "demoVideoId",
      studioUrl: "https://studio.youtube.com/video/demoVideoId/edit",
      watchUrl: "https://www.youtube.com/watch?v=demoVideoId",
      createdAt: now(),
      finishedAt: now(),
    };
    this.ytUploads = [job, ...this.ytUploads];
    this.store.emit({ type: "youtube.upload.updated", projectId, upload: job });
    return this.latency({ upload: job }, 200);
  }
  async youtubeUploads(projectId: string) {
    this.requireAuth();
    return this.latency({ uploads: this.ytUploads.filter(u => u.projectId === projectId) }, 60);
  }
  async youtubeUpload(uploadId: string) {
    this.requireAuth();
    const found = this.ytUploads.find(u => u.id === uploadId);
    if (!found) throw notFound("YouTube upload");
    return this.latency({ upload: found }, 60);
  }
  async youtubeCancelUpload(uploadId: string) {
    this.requireAuth();
    const found = this.ytUploads.find(u => u.id === uploadId);
    if (!found) throw notFound("YouTube upload");
    found.phase = "cancelled";
    return this.latency({ upload: { ...found } }, 60);
  }
}
