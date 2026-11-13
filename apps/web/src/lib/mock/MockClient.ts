/**
 * In-memory stand-in for ScarletClient (native desktop demo). Same method
 * signatures (see ScarletApi), fixture data from ./fixtures, and a small
 * event emitter that plays the role of the WebSocket: renders progress,
 * tasks stream log lines, a change becomes ready, uploads finish ingesting.
 */
import { dialogueCommand, AGENT_LABEL, beginRevision, buildThreads, restoredReviewState, threadRevision, threadTimeline, countReviewDecisions, fullRenderContext, taskNeedsTranscripts, taskRecoveryAction, reviewItemPath, splitAgentTarget, ScarletApiError, SkillSlug, DialoguePreferences, isAsideTask, isSkillEdit, ReviseLearningRequest } from "@scarlet/shared";
import { appliedCutReview, appliedReviewChange, applyReviewRemovals, makeStagedCutMapper, contentHash, planCutReview, reviewedTimeline } from "@scarlet/timeline";
import type { ApproveLearningRequest, EditSkillRequest, Learning, RunChoice, UsageGroupBy, UsageResponse, UsageTotals } from "@scarlet/shared";
import type {
  AgentHost,
  AgentId,
  CreateNoteRequest,
  ReviseRequest,
  CreateTaskRequest,
  FullRenderKeys,
  PlaybackCacheStatus,
  SourceCacheStatus,
  ProjectDetail,
  ProjectSummary,
  Render,
  RenderRequest,
  ServerSettings,
  Skill,
  SkillVersion,
  Task,
  TaskEvent,
  UpdateNoteRequest,
  UpsertSkillRequest,
  User,
  VersionSummary,
  WsEvent,
} from "@scarlet/shared";
import type { Author, Change, MediaAsset, Note, Project, Timeline, TimelineDiff, TimeRange, Transcript } from "@scarlet/timeline";
import { planRevert, fromOtio, otioSourceVersion, OtioImportError, toOtio, applyOps, canApproveSpots, clipEnd, withHandles, describeDiff, diffTimelines, emptyTimeline, formatTimecode, newId, planApply, timelineDuration, ASPECT_PRESETS, TimelineOp } from "@scarlet/timeline";
import type { ActivityEntry, ApproveResponse, TrashedProject } from "@scarlet/shared";
import type { ScarletApi } from "../api";
import { buildDb, mc, SAMPLE_TRANSCRIPTION_MODEL, type MockDb } from "./fixtures";
import sampleWaveform from "./sample-waveform.json";

class Emitter {
  private fns = new Set<(ev: WsEvent) => void>();
  on(fn: (ev: WsEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(ev: WsEvent) {
    // Deliver asynchronously, like a socket would.
    setTimeout(() => this.fns.forEach((fn) => fn(ev)), 0);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
/** The sample library's Trash keeps a project 30 days, as the engine's does. */
const purgeDate = (deletedAt: string) => new Date(Date.parse(deletedAt) + 30 * 86400000).toISOString();
const notFound = (what: string) => new ScarletApiError(404, "not_found", `${what} not found`);

const AGENT_NAMES = AGENT_LABEL;

function emptyUsageTotals(): UsageTotals {
  return { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, firstAt: null, lastAt: null };
}

export class MockClient implements ScarletApi {
  readonly events = new Emitter();
  private db: MockDb;
  private readonly tokenSource: () => string | undefined;

  private activityLog: ActivityEntry[] = [];
  private trashed: Array<{ project: Project; deletedAt: string }> = [];

  constructor(tokenSource: () => string | undefined, private readonly chatLayouts = false) {
    this.db = buildDb(chatLayouts);
    this.tokenSource = tokenSource;
    for (const render of this.db.renders) {
      if (render.kind === "full" && !render.range) render.key = this.fullKey(this.projectById(render.projectId), render.version, render.quality ?? "preview");
    }
    for (const change of this.db.changes) {
      const base = this.db.timelines[change.fromVersion];
      change.canApproveSpots = !!base && canApproveSpots(base, change.ops as TimelineOp[] | undefined, change.ranges, this.projectById(change.projectId).settings.fps);
    }
    this.seedActivity();
    this.bootBackgroundActivity();
  }

  /** History for the fixtures, so the log isn't empty in demo mode. */
  private seedActivity() {
    const q = (t: string) => `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”`;
    const add = (projectId: string | null, actor: Author, type: string, summary: string, at: string | undefined, data: Record<string, unknown> = {}) =>
      this.activityLog.push({ id: newId("act"), projectId, actor, type, summary, data, createdAt: at ?? now() });
    for (const [pid, list] of Object.entries(this.db.media)) for (const m of list) add(pid, { type: "scarlet", name: "Scarlet" }, "media.added", `${q(m.name)} was added`, m.provenance?.createdAt ?? new Date(Date.now() - 86400000 * 2).toISOString(), { mediaId: m.id });
    for (const t of this.db.tasks) add(t.projectId, t.createdBy, "request.created", `${t.createdBy.name} asked ${AGENT_NAMES[t.agent]}: ${q(t.context.message ?? t.instruction)}`, t.createdAt, { taskId: t.id });
    for (const n of this.db.notes) add(n.projectId, n.author, "note.added", `${n.author.name} noted at ${Math.floor(n.time / 60)}:${String(Math.floor(n.time % 60)).padStart(2, "0")}: ${q(n.text)}`, n.createdAt, { noteId: n.id });
    for (const c of this.db.changes) {
      add(c.projectId, c.author, "change.proposed", `${c.author.name} proposed ${q(c.description)}`, c.createdAt, { changeId: c.id });
      const by = c.decidedBy ?? this.db.me;
      if (c.state === "approved") add(c.projectId, { type: "human", id: by.id, name: by.name }, "change.approved", `${by.name} approved ${q(c.description)}`, c.updatedAt, { changeId: c.id });
      if (c.state === "rejected") add(c.projectId, { type: "human", id: by.id, name: by.name }, "change.rejected", `${by.name} rejected ${q(c.description)}`, c.updatedAt, { changeId: c.id });
    }
    this.activityLog.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  private log(projectId: string | null, type: string, summary: string, data: Record<string, unknown> = {}, actor?: Author) {
    const entry: ActivityEntry = { id: newId("act"), projectId, actor: actor ?? this.human(), type, summary, data, createdAt: now() };
    this.activityLog.unshift(entry);
    this.emit({ type: "activity.added", projectId, entry });
  }

  // --- plumbing ------------------------------------------------------------
  get token(): string | undefined {
    return this.tokenSource();
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
    if (!this.token) throw new ScarletApiError(401, "unauthorized", "Missing access token");
  }
  private emit(ev: WsEvent) {
    this.events.emit(ev);
  }
  private summary(projectId: string): ProjectSummary {
    const s = this.db.summaries[projectId];
    if (!s) throw notFound("Project");
    s.pendingChanges = countReviewDecisions({
      changes: this.db.changes.filter(c => c.projectId === projectId),
      tasks: this.db.tasks.filter(t => t.projectId === projectId),
      notes: this.db.notes.filter(n => n.projectId === projectId),
    }, this.projectById(projectId).completedThreads);
    const head = this.db.timelines[this.projectById(projectId).head ?? ""];
    s.duration = head && timelineDuration(head);
    return s;
  }
  private projectById(id: string): Project {
    const p = this.db.projects.find((x) => x.id === id);
    if (!p) throw notFound("Project");
    return p;
  }
  private refreshCounts(projectId: string) {
    const s = this.db.summaries[projectId];
    if (!s) return;
    s.openNotes = this.db.notes.filter((n) => n.projectId === projectId && (n.state === "open" || n.state === "in_progress")).length;
    s.mediaCount = (this.db.media[projectId] ?? []).length;
    s.updatedAt = now();
  }
  private currentUser(): User {
    return this.db.me;
  }
  private human(): Author {
    const u = this.currentUser();
    return { type: "human", id: u.id, name: u.name };
  }
  private emitProject(projectId: string) {
    this.emit({ type: "project.updated", projectId, project: this.projectById(projectId) });
  }

  // --- auth ---------------------------------------------------------------------
  async me(): Promise<{ user: User }> {
    this.requireAuth();
    return this.latency({ user: this.currentUser() }, 80);
  }

  // --- projects -----------------------------------------------------------------
  async projects(): Promise<{ projects: ProjectSummary[] }> {
    this.requireAuth();
    return this.latency({ projects: this.db.projects.filter((p) => !this.trashed.some((t) => t.project.id === p.id)).map((p) => this.summary(p.id)) }, 200);
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
    this.db.projects.unshift(project);
    this.db.summaries[project.id] = { id: project.id, name: project.name, settings: project.settings, head: null, mediaCount: 0, pendingChanges: 0, openNotes: 0, createdAt: project.createdAt, updatedAt: project.updatedAt };
    this.db.media[project.id] = [];
    this.db.versions[project.id] = [];
    return this.latency({ project }, 250);
  }
  async project(id: string): Promise<ProjectDetail> {
    this.requireAuth();
    const project = this.projectById(id);
    const timeline = project.head ? (this.db.timelines[project.head] ?? null) : null;
    return this.latency({ project, summary: this.summary(id), timeline }, 180);
  }
  async workspace(id: string) {
    this.requireAuth();
    const project = this.projectById(id);
    return this.latency({ project: { ...project, media: this.db.media[id] ?? [] },
      timeline: project.head ? this.db.timelines[project.head] ?? null : null }, 180);
  }
  private projectThread(id: string, threadId: string) {
    const thread = buildThreads({ changes: this.db.changes.filter(c => c.projectId === id),
      tasks: this.db.tasks.filter(t => t.projectId === id), notes: this.db.notes.filter(n => n.projectId === id) }).find(t => t.id === threadId);
    if (!thread) throw notFound("thread");
    return thread;
  }

  async recordEditReview(): Promise<void> { /* The demo has no analytics engine. */ }
  async threadEdits(id: string, threadId: string) {
    const project = this.projectById(id);
    const thread = this.projectThread(id, threadId);
    const head = project.head && this.db.timelines[project.head];
    return { version: project.head, edits: head ? threadTimeline(thread, head, this.db.versions[id] ?? [],
      version => this.db.timelines[version], project.settings.fps) : [] };
  }

  async setThreadDone(id: string, threadId: string, done: boolean, revision: string) {
    const project = this.projectById(id);
    const thread = this.projectThread(id, threadId);
    if (threadRevision(thread) !== revision || (done && (thread.active || thread.question || thread.status === "working")))
      throw new ScarletApiError(409, "thread_changed", "Wait for the thread to finish.");
    const completedThreads = { ...project.completedThreads };
    if (done) completedThreads[thread.id] = revision;
    else delete completedThreads[thread.id];
    project.completedThreads = completedThreads;
    this.emit({ type: "project.updated", projectId: id, project: { ...project } });
    return { completedThreads };
  }

  async updateProject(id: string, body: Record<string, unknown>): Promise<{ project: Project }> {
    this.requireAuth();
    const project = this.projectById(id);
    const s = this.summary(id);
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
      project.settings = { ...project.settings, ...(body.settings as Partial<Project["settings"]>) };
      const preset = ASPECT_PRESETS[project.settings.aspect];
      if (preset && (body.settings as Partial<Project["settings"]>).aspect && !(body.settings as Partial<Project["settings"]>).width) {
        project.settings = { ...project.settings, ...preset };
      }
      s.settings = project.settings;
      // As in the engine: "Last edited" moves when the video's settings change, not for a new name or an archive.
      project.updatedAt = now();
      s.updatedAt = project.updatedAt;
    }
    this.emitProject(id);
    return this.latency({ project });
  }
  async deleteProject(id: string): Promise<Record<string, never>> {
    this.requireAuth();
    const project = this.db.projects.find((p) => p.id === id);
    if (project) this.trashed.unshift({ project, deletedAt: now() });
    this.db.projects = this.db.projects.filter((p) => p.id !== id);
    this.log(id, "project.deleted", `${this.currentUser().name} moved the project to the trash`);
    return this.latency({});
  }
  async storage(): Promise<{ projects: import("@scarlet/shared").StorageProject[] }> {
    this.requireAuth();
    return { projects: [
      ...this.db.projects.map(p => ({ id: p.id, name: p.name, deletedAt: null, busy: false, missingSource: false, segments: [] })),
      ...this.trashed.map(t => ({ id: t.project.id, name: t.project.name, deletedAt: t.deletedAt, purgeAt: purgeDate(t.deletedAt), busy: false, missingSource: false, segments: [] })),
    ] };
  }
  async cleanStorage(selection: import("@scarlet/shared").StorageCleanup) {
    const current = (await this.storage()).projects;
    for (const p of selection.projects) {
      if (!current.some(row => row.id === p.id && row.deletedAt === p.deletedAt) ||
          (selection.kind === "trash") !== (p.deletedAt !== null)) throw new Error("The project changed. Rescan storage.");
    }
    if (selection.kind === "trash") {
      const ids = new Set(selection.projects.map(p => p.id));
      this.trashed = this.trashed.filter(t => !ids.has(t.project.id));
    }
    return { projects: selection.projects.length };
  }
  async trash(): Promise<{ projects: TrashedProject[] }> {
    this.requireAuth();
    return this.latency({ projects: this.trashed.map((t) => ({ id: t.project.id, name: t.project.name, deletedAt: t.deletedAt, purgeAt: purgeDate(t.deletedAt) })) });
  }
  async restoreProject(id: string): Promise<{ project: Project }> {
    this.requireAuth();
    const t = this.trashed.find((x) => x.project.id === id);
    if (!t) throw notFound("Project in the trash");
    this.trashed = this.trashed.filter((x) => x.project.id !== id);
    t.project.archived = false;
    this.db.projects.unshift(t.project);
    this.summary(id).archived = false;
    this.log(id, "project.restored", `${this.currentUser().name} restored the project from the trash`);
    return this.latency({ project: t.project });
  }
  async activity(projectId: string, q: { before?: string; beforeId?: string; limit?: number; type?: string } = {}): Promise<{ activity: ActivityEntry[] }> {
    this.requireAuth();
    const list = this.activityLog.filter((a) => a.projectId === projectId && (!q.before || a.createdAt < q.before || (a.createdAt === q.before && q.beforeId && a.id < q.beforeId)) && (!q.type || a.type.startsWith(q.type)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return this.latency({ activity: list.slice(0, q.limit ?? 200) }, 150);
  }
  async serverActivity(q: { before?: string; limit?: number } = {}): Promise<{ activity: ActivityEntry[] }> {
    this.requireAuth();
    return this.latency({ activity: this.activityLog.filter((a) => a.projectId === null && (!q.before || a.createdAt < q.before)).slice(0, q.limit ?? 200) });
  }
  async importOtio(projectId: string, otio: unknown): Promise<{ change: Change; timeline: Timeline }> {
    this.requireAuth();
    await sleep(500);
    const project = this.projectById(projectId);
    const exported = otioSourceVersion(otio);
    const fromVersion = exported && this.db.timelines[exported] ? exported : (project.head ?? "");
    const base = this.db.timelines[fromVersion];
    if (!base) throw new ScarletApiError(400, "otio_import", "This project has no edit to compare against yet.");
    let tl: Timeline;
    try {
      tl = fromOtio(otio, { ...project, media: this.db.media[projectId] ?? project.media }, base);
    } catch (e) {
      throw new ScarletApiError(400, "otio_import", e instanceof OtioImportError ? e.message : `Couldn’t read that timeline: ${(e as Error).message}`);
    }
    tl = { ...tl, version: newId("ver"), parent: fromVersion, createdAt: now() };
    this.db.timelines[tl.version] = tl;
    const diff = diffTimelines(base, tl, project.settings.fps);
    const change: Change = {
      id: newId("chg"),
      projectId,
      fromVersion,
      toVersion: tl.version,
      description: "Hand edits from DaVinci Resolve",
      author: this.human(),
      noteIds: [],
      ranges: diff.ranges,
      state: "ready",
      renders: [],
      threadId: undefined,
      createdAt: now(),
      updatedAt: now(),
    };
    change.threadId = change.id;
    this.db.changes.unshift(change);
    this.refreshCounts(projectId);
    this.emit({ type: "change.updated", projectId, change: { ...change } });
    this.log(projectId, "import.davinci", `${this.currentUser().name} brought back hand edits from DaVinci Resolve`, { changeId: change.id });
    return { change, timeline: tl };
  }

  // --- media ----------------------------------------------------------------------
  async media(projectId: string): Promise<{ media: MediaAsset[] }> {
    this.requireAuth();
    return this.latency({ media: this.db.media[projectId] ?? [] });
  }
  async uploadMedia(projectId: string, file: Blob, name: string, kind?: string): Promise<{ media: MediaAsset }> {
    this.requireAuth();
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const guessed: MediaAsset["kind"] = /^(wav|mp3|aac|m4a|flac|ogg)$/.test(ext) ? "audio" : /^(png|jpe?g|webp|gif)$/.test(ext) ? "image" : "video";
    const mediaKind = (kind as MediaAsset["kind"] | undefined) ?? guessed;
    const media: MediaAsset = { id: newId("med"), kind: mediaKind, name, path: `media/${name}`, status: "ingesting", ...(mediaKind === "video" ? { fps: 30, width: 640, height: 360 } : {}) };
    (this.db.media[projectId] ??= []).push(media);
    const project = this.projectById(projectId);
    project.media = this.db.media[projectId] ?? [];
    this.refreshCounts(projectId);
    void this.simulateIngest(projectId, media, file.size);
    return this.latency({ media }, 200);
  }
  async importMedia(projectId: string, body: { path?: string; url?: string; kind?: string; importId?: string }): Promise<{ media: MediaAsset }> {
    this.requireAuth();
    const saved = body.importId && this.db.media[projectId]?.find(asset => asset.importId === body.importId);
    if (saved) return { media: saved };
    const src = body.url ?? body.path ?? "import";
    const name = decodeURIComponent(src.split(/[\\/?#]/).filter(Boolean).pop() ?? "import.mp4").slice(0, 60) || "import.mp4";
    const guessed = /\.(wav|mp3|aac|m4a|flac|ogg)$/i.test(name) ? "audio" : /\.(png|jpe?g|webp|gif)$/i.test(name) ? "image" : "video";
    const kind = (body.kind as MediaAsset["kind"] | undefined) ?? guessed;
    const media: MediaAsset = { id: newId("med"), importId: body.importId, kind, name: /drive\.google/.test(src) ? `drive-${name}.mp4` : name, path: `media/${name}`, status: "ingesting", ...(kind === "video" ? { fps: 30, width: 640, height: 360 } : {}) };
    (this.db.media[projectId] ??= []).push(media);
    this.projectById(projectId).media = this.db.media[projectId] ?? [];
    this.refreshCounts(projectId);
    void this.simulateIngest(projectId, media, 50_000_000);
    return this.latency({ media }, 400);
  }
  async removeMedia(projectId: string, mediaId: string): Promise<Record<string, never>> {
    this.requireAuth();
    const list = this.db.media[projectId] ?? [];
    const media = list.find(m => m.id === mediaId);
    if (!media) throw notFound("Media");
    if (media.status !== "failed") throw new ScarletApiError(409, "media_readable", `Scarlet read ${media.name}, and can only remove a file it couldn’t read.`);
    if (Object.values(this.db.timelines).some(tl => tl.projectId === projectId && JSON.stringify(tl).includes(JSON.stringify(mediaId)))) {
      throw new ScarletApiError(409, "media_in_use", `${media.name} is in the video or its history, so it can’t be removed.`);
    }
    if (this.db.tasks.some(t => t.projectId === projectId && t.kind !== "transcribe" && ["claimed", "running", "waiting_for_user"].includes(t.state))) {
      throw new ScarletApiError(409, "media_busy", `Scarlet is working on a request, so ${media.name} can’t be removed until it’s done.`);
    }
    this.db.media[projectId] = list.filter(m => m.id !== mediaId);
    this.projectById(projectId).media = this.db.media[projectId]!;
    this.refreshCounts(projectId);
    this.log(projectId, "media.removed", `${this.currentUser().name} removed “${media.name}”, which couldn't be read`, { mediaId });
    this.emit({ type: "media.removed", projectId, mediaId });
    return this.latency({});
  }
  private async simulateIngest(projectId: string, media: MediaAsset, bytes: number) {
    await sleep(1800);
    const probed: MediaAsset = {
      ...media,
      status: "ready",
      hash: newId(undefined, 8),
      duration: media.kind === "image" ? undefined : 20,
      fps: media.kind === "video" ? 30 : undefined,
      width: media.kind === "audio" ? undefined : 640,
      height: media.kind === "audio" ? undefined : 360,
      hasAudio: media.kind !== "image",
    };
    this.replaceMedia(projectId, probed);
    this.emit({ type: "media.updated", projectId, media: probed });
    const project = this.projectById(projectId);
    if (!project.head && (probed.kind === "video" || probed.kind === "audio")) {
      const tl = emptyTimeline(projectId);
      tl.version = newId("ver");
      tl.createdAt = now();
      this.db.timelines[tl.version] = tl;
      project.head = tl.version;
      this.summary(projectId).head = tl.version;
      (this.db.versions[projectId] ??= []).push({ version: tl.version, parent: null, name: "Main", author: { type: "scarlet", name: "Scarlet" }, changeId: null, description: `Imported ${probed.name}`, duration: timelineDuration(tl), isHead: true, createdAt: tl.createdAt });
      this.emitProject(projectId);
    }
    if (this.db.settings.transcription.provider !== "none" && probed.hasAudio && bytes > 0) {
      await sleep(2200);
      this.saveSampleTranscript(projectId, probed, `tr_${probed.id}`, now());
    }
  }

  private saveSampleTranscript(projectId: string, media: MediaAsset, id: string, completedAt: string) {
    const sample = this.db.transcripts[media.id] ?? this.db.transcripts.med_main!;
    this.db.transcripts[media.id] = { ...sample, id, mediaId: media.id, createdAt: completedAt };
    const updated = { ...media, transcriptId: id, lastTranscription: { completedAt, model: SAMPLE_TRANSCRIPTION_MODEL } };
    this.replaceMedia(projectId, updated);
    this.emit({ type: "media.updated", projectId, media: updated });
  }

  private replaceMedia(projectId: string, media: MediaAsset) {
    const list = this.db.media[projectId] ?? [];
    const i = list.findIndex((m) => m.id === media.id);
    if (i >= 0) list[i] = media;
    else list.push(media);
    this.projectById(projectId).media = list;
  }
  /** The demo groups no retakes. */
  async retakes(_projectId: string, mediaId: string, _from: number, _to: number): Promise<{ mediaId: string; groups: [] }> {
    this.requireAuth();
    return this.latency({ mediaId, groups: [] });
  }
  async transcript(mediaId: string, opts: { from?: number; to?: number; granularity?: "word" | "segment" } = {}): Promise<Transcript> {
    this.requireAuth();
    const t = this.db.transcripts[mediaId];
    if (!t) throw notFound("Transcript");
    const segments = t.segments.filter((s) => (opts.from === undefined || s.end > opts.from) && (opts.to === undefined || s.start < opts.to));
    return this.latency({ ...t, segments: opts.granularity === "segment" ? segments.map((s) => ({ ...s, words: [] })) : segments }, 220);
  }
  async transcribe(mediaId: string, provider?: string): Promise<{ task: Task }> {
    this.requireAuth();
    const projectId = Object.entries(this.db.media).find(([, list]) => list.some((m) => m.id === mediaId))?.[0];
    if (!projectId) throw notFound("Media");
    if (this.db.settings.transcription.provider === "none") throw new ScarletApiError(400, "transcription_off", "Transcription isn't available in this build of Scarlet.");
    const task: Task = { id: newId("task"), projectId, kind: "transcribe", agent: "api", model: provider, instruction: `Transcribe ${mediaId}`, context: { mediaId }, state: "running", createdBy: this.human(), hostId: null, changeIds: [], question: null, summary: null, createdAt: now(), startedAt: now() };
    this.db.tasks.unshift(task);
    void (async () => {
      await sleep(3000);
      const media = this.db.media[projectId]?.find((m) => m.id === mediaId);
      const completedAt = now();
      if (media) this.saveSampleTranscript(projectId, media, newId("trs"), completedAt);
      task.state = "done";
      task.finishedAt = completedAt;
      task.summary = `Transcribed 20 s of speech (${SAMPLE_TRANSCRIPTION_MODEL}).`;
      this.emit({ type: "task.updated", projectId, task: { ...task } });
    })();
    return this.latency({ task });
  }
  async waveform(mediaId: string, from: number, to: number, points = 1000) {
    // Measured from the demo MP4 in 20 ms windows, after AAC encoding.
    const peaks: number[] = [];
    const rms: number[] = [];
    for (let i = 0; i < points; i++) {
      const lo = Math.max(0, Math.floor((from + (to - from) * i / points) * sampleWaveform.pointsPerSecond));
      const hi = Math.min(sampleWaveform.peaks.length, Math.ceil((from + (to - from) * (i + 1) / points) * sampleWaveform.pointsPerSecond));
      let peak = 0;
      let energy = 0;
      for (let n = lo; n < hi; n++) {
        peak = Math.max(peak, sampleWaveform.peaks[n]!);
        energy += sampleWaveform.rms[n]! ** 2;
      }
      peaks.push(peak);
      rms.push(hi > lo ? Math.sqrt(energy / (hi - lo)) : 0);
    }
    return { mediaId, from, to, peaks, rms };
  }

  frameUrl(mediaId: string, t: number, w = 640): string {
    // Small stills from the 20-second sample, served only in the native demo.
    if (w === 160) return `/scrub/${Math.max(0, Math.min(19, Math.floor(t)))}.webp`;
    return `/sample-frame.jpg?m=${encodeURIComponent(mediaId)}&t=${t}&w=${w}`;
  }

  // --- timeline / versions -----------------------------------------------------------
  async timeline(projectId: string, version = "head"): Promise<{ timeline: Timeline }> {
    this.requireAuth();
    const id = version === "head" ? this.projectById(projectId).head : version;
    const tl = id ? this.db.timelines[id] : undefined;
    if (!tl) throw notFound("Timeline");
    return this.latency({ timeline: tl });
  }
  async versions(projectId: string): Promise<{ versions: VersionSummary[] }> {
    this.requireAuth();
    const head = this.projectById(projectId).head;
    const list = (this.db.versions[projectId] ?? []).map((v) => ({ ...v, isHead: v.version === head }));
    return this.latency({ versions: list });
  }
  async diff(projectId: string, a: string, b: string): Promise<{ diff: TimelineDiff; description: string[] }> {
    this.requireAuth();
    const ta = this.db.timelines[a];
    const tb = this.db.timelines[b];
    if (!ta || !tb) throw notFound("Version");
    const fps = this.projectById(projectId).settings.fps;
    const diff = diffTimelines(ta, tb, fps);
    return this.latency({ diff, description: describeDiff(diff, (s) => formatTimecode(s, fps)) });
  }
  private branchRefs = new Map<string, Map<string, string | null>>();
  async branches(projectId: string) {
    this.requireAuth();
    const project = this.projectById(projectId);
    const refs = this.branchRefs.get(projectId) ?? new Map<string, string | null>();
    refs.set(project.branch ?? "main", project.head);
    this.branchRefs.set(projectId, refs);
    return { branches: [...refs].map(([name, head]) => ({ name, head })) };
  }
  async switchBranch(projectId: string, name: string, expectedHead: string, expectedBranch: string, from?: string) {
    await this.branches(projectId);
    const project = this.projectById(projectId);
    if (project.head !== expectedHead || (project.branch ?? "main") !== expectedBranch) throw new Error("The edit changed.");
    const refs = this.branchRefs.get(projectId)!;
    if (from) {
      if (refs.has(name) || !this.db.timelines[from]) throw new Error("Choose a new name and an existing version.");
      refs.set(name, from);
    }
    if (!refs.has(name)) throw notFound("Branch");
    project.head = refs.get(name)!;
    project.branch = name;
    this.summary(projectId).head = project.head;
    this.emitProject(projectId);
    return { project };
  }
  async historyEdit(projectId: string, target: string, action: "revert" | "restore", expectedHead: string, branch: string) {
    this.requireAuth();
    const project = this.projectById(projectId);
    const head = project.head;
    if (!head || head !== expectedHead || branch !== (project.branch ?? "main")) throw new Error("The video changed. Try again.");
    const versions = this.db.versions[projectId] ?? [];
    const selected = versions.find(v => v.version === target);
    if (!selected) throw notFound("Version");
    const lookup = (id: string) => this.db.changes.find(c => c.id === id) ?? null;
    const links = versions.map(v => ({ ...v, revertsVersion: v.changeId ? lookup(v.changeId)?.revertsVersion : undefined }));
    const result = action === "restore" ? this.db.timelines[target]! : planRevert(links, head, target, project.settings.fps,
      id => this.db.timelines[id]!, lookup);
    const version = newId("ver");
    const timeline = { ...result, version, parent: head, createdAt: now() };
    const description = `${action === "restore" ? "Restore" : "Undo"} · ${selected.description ?? target}`;
    const change: Change = { id: newId("chg"), projectId, fromVersion: head, toVersion: version, appliedOnto: head,
      appliedVersion: version, revertsVersion: action === "revert" ? target : undefined, description, author: this.human(),
      state: "approved", noteIds: [], renders: [], ranges: [], createdAt: now(), updatedAt: now() };
    this.db.timelines[version] = timeline;
    versions.unshift({ version, parent: head, revertsVersion: change.revertsVersion, name: timeline.name, author: change.author, changeId: change.id,
      description, duration: timelineDuration(timeline), isHead: true, createdAt: now() });
    this.db.changes.unshift(change);
    project.head = version;
    this.summary(projectId).head = version;
    this.emit({ type: "change.updated", projectId, change });
    this.emitProject(projectId);
    this.log(projectId, action === "restore" ? "version.restored" : "change.undone", description, { changeId: change.id, target });
    return { project, change };
  }
  async checkout(projectId: string, version: string): Promise<{ project: Project }> {
    this.requireAuth();
    const project = this.projectById(projectId);
    if (!this.db.timelines[version]) throw notFound("Version");
    const from = project.head ?? version;
    project.head = version;
    project.updatedAt = now();
    this.summary(projectId).head = version;
    const change: Change = { id: newId("chg"), projectId, fromVersion: from, toVersion: version, description: `Checked out ${this.db.versions[projectId]?.find((v) => v.version === version)?.description ?? version}`, author: this.human(), noteIds: [], ranges: [], state: "approved", renders: [], createdAt: now(), updatedAt: now() };
    this.db.changes.unshift(change);
    this.emit({ type: "change.updated", projectId, change });
    this.emitProject(projectId);
    return this.latency({ project }, 250);
  }
  otioUrl(projectId: string, version: string): string {
    const project = this.projectById(projectId);
    const tl = this.db.timelines[version === "head" ? (project.head ?? "") : version];
    const otio = tl ? toOtio({ ...project, media: this.db.media[projectId] ?? project.media }, tl, { mediaRoot: "C:/scarlet/media" }) : {};
    return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(otio, null, 2))}`;
  }

  // --- changes -------------------------------------------------------------------------
  async changes(projectId: string, state?: string): Promise<{ changes: Change[] }> {
    this.requireAuth();
    return this.latency({ changes: this.db.changes.filter((c) => c.projectId === projectId && (!state || c.state === state)) }, 150);
  }
  async change(changeId: string): Promise<{ change: Change; diff: TimelineDiff }> {
    this.requireAuth();
    const change = this.db.changes.find((c) => c.id === changeId);
    if (!change) throw notFound("Change");
    const viewed = appliedReviewChange(change);
    const a = this.db.timelines[viewed.fromVersion];
    const b = this.db.timelines[viewed.toVersion];
    const diff = a && b ? diffTimelines(a, b, this.projectById(change.projectId).settings.fps) : { clips: [], tracks: [], markersChanged: false, timelineFieldsChanged: [], ranges: [], beforeRanges: [], spots: [], durationBefore: 0, durationAfter: 0 };
    return this.latency({ change, diff }, 200);
  }
  async saveCutChoices(changeId: string, body: { choices: Array<{ index: number; choice: "cut" | "keep" }>; applyWhenDone?: boolean }) {
    this.requireAuth();
    const change = this.db.changes.find(c => c.id === changeId);
    if (!change) throw notFound("Change");
    const { review } = await this.cutReview(changeId);
    change.cutChoices = body.choices.flatMap(({ index, choice }) => {
      const removed = review?.cuts[index]?.removed;
      return removed ? [{ index, start: removed.start, end: removed.end, choice }] : [];
    });
    if (body.applyWhenDone !== undefined) change.applyWhenDone = body.applyWhenDone ? { userId: "usr_mock", at: new Date().toISOString() } : undefined;
    this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
    return { change: { ...change } };
  }

  async cutReviewDraft(changeId: string, restoredCuts: number[], ontoVersion?: string) {
    const { review: _, ...result } = await this.cutReview(changeId, restoredCuts, ontoVersion);
    return result;
  }

  async cutReview(changeId: string, restoredCuts?: number[], ontoVersion?: string) {
    this.requireAuth();
    const change = this.db.changes.find(c => c.id === changeId);
    if (!change) throw notFound("Change");
    const project = this.projectById(change.projectId);
    const stale = (reason: string) => new ScarletApiError(409, "cut_review_stale", reason, { currentVersion: project.head });
    if (ontoVersion !== undefined && ontoVersion !== project.head) throw stale("The working edit changed during review.");
    const base = this.db.timelines[change.fromVersion], proposed = this.db.timelines[change.toVersion];
    const review = base && proposed ? planCutReview(base, proposed, this.db.media[change.projectId] ?? [], change.ops, change.firstCut) : null;
    if (!review) return { review: null };
    const save = (tl: Timeline, parent = change.fromVersion) => {
      if (tl === base || tl === proposed) return tl;
      const version = contentHash(tl, ["version", "parent", "createdAt"]).slice(0, 16);
      return this.db.timelines[version] ??= { ...tl, version, parent };
    };
    if (review.firstCut) review.original = save(review.original);
    if (ontoVersion === undefined) return { review, draft: restoredCuts && save(reviewedTimeline(review, restoredCuts)) };
    const restored = new Set(restoredCuts);
    if (!restoredCuts || restored.size !== restoredCuts.length || restoredCuts.some(i => !Number.isInteger(i) || i < 0 || i >= review.cuts.length))
      throw new ScarletApiError(400, "invalid_cut_selection", "Unknown or duplicate cut in review.");
    if (ontoVersion === change.fromVersion && !change.cutEdits?.length) {
      const removed = review.cuts.flatMap((cut, i) => restored.has(i) ? [] : [cut.removed]);
      return { review, draft: save(reviewedTimeline(review, restoredCuts)), ontoVersion, removed };
    }
    if (review.firstCut) throw stale("The opening assembly changed during review.");
    const head = this.db.timelines[ontoVersion];
    if (!head) throw notFound("Version");
    const selected: { index: number; range: TimeRange }[] = [];
    const mappers = new Map<string, ReturnType<typeof makeStagedCutMapper>>();
    for (const [i, cut] of review.cuts.entries()) {
      if (restored.has(i)) continue;
      const edit = change.cutEdits?.find(e => e.index === i);
      const from = edit ? this.db.timelines[edit.version] : base;
      if (!from) throw notFound("Version");
      const range = edit?.range ?? cut.removed;
      if (range.start === range.end) continue;
      let map = mappers.get(from.version);
      if (!map) {
        map = makeStagedCutMapper(from, head, project.settings.fps);
        mappers.set(from.version, map);
      }
      const location = map(range);
      if (location.kind === "conflict") throw stale(location.reason);
      if (location.kind !== "gone") selected.push({ index: i, range: location.range });
    }
    selected.sort((a, b) => a.range.start - b.range.start);
    const removed = selected.map(c => c.range);
    if (removed.some((r, i) => i > 0 && r.start < removed[i - 1]!.end - 1e-6)) throw stale("Two proposed cuts now cover the same footage.");
    const draft = selected.length ? save(applyReviewRemovals(head, removed, review.proposed.version), ontoVersion) : head;
    return { review, draft, ontoVersion, removed };
  }
  async approveChange(changeId: string, spots?: number[], restoredCuts?: number[]): Promise<ApproveResponse> {
    this.requireAuth();
    await sleep(350);
    const change = this.db.changes.find((c) => c.id === changeId);
    if (!change) throw notFound("Change");
    const project = this.projectById(change.projectId);
    if (change.state === "approved") {
      if (restoredCuts && [...restoredCuts].sort().join(",") !== change.restoredCuts?.slice().sort().join(",")) {
        throw new Error("This proposal was already approved with different choices.");
      }
      return { change, project, outcome: "applied" };
    }
    const head = project.head ?? change.fromVersion;
    if (head === change.toVersion && spots && !change.ranges.every((_, i) => spots.includes(i))) {
      throw new ScarletApiError(400, "spots_unsupported", "All spots are already present in the current edit");
    }
    const from = this.db.timelines[change.fromVersion];
    const to = this.db.timelines[change.toVersion];
    const headTl = this.db.timelines[head];
    let target = change.toVersion;
    let outcome: ApproveResponse["outcome"] = "applied";
    if (restoredCuts) {
      if (head !== change.fromVersion || change.state !== "ready") throw new Error("This pass wasn’t applied because the video changed since Scarlet made it: ask Scarlet to redo the pass on the video as it is now.");
      const { review, draft } = await this.cutReview(changeId, restoredCuts);
      if (!draft || !review) throw new Error("No individually restorable cuts.");
      change.appliedReview = appliedCutReview(review, restoredCuts);
      target = draft.version;
    } else if (from && to && headTl && head !== change.toVersion) {
      const plan = planApply({ from, to, head: headTl, ops: change.ops as TimelineOp[] | undefined, spots, changeRanges: change.ranges, fps: project.settings.fps });
      if (plan.kind === "conflict") {
        if (plan.spotsUnsupported) throw new ScarletApiError(400, "spots_unsupported", `Can't approve spots one by one: ${plan.reason}.`);
        const agent = (change.author.id as AgentId | undefined) ?? "claude";
        const task = this.makeTask(project.id, { kind: "revise", agent, model: change.author.model, instruction: `Redo on the current edit: ${change.description}`, context: { changeId, version: head, threadId: change.threadId ?? change.id, message: "Redo on the current edit" } });
        // As in the engine, the redo is Scarlet's own: the chat carries it on under the request that made the suggestion.
        task.createdBy = { type: "scarlet", name: "Scarlet" };
        Object.assign(change, beginRevision(change, task), { error: `Sent back: ${plan.reason}`, updatedAt: now() });
        void this.runTask(task, { fromVersion: head, description: change.description, supersedes: change });
        this.emit({ type: "change.updated", projectId: project.id, change: { ...change } });
        this.log(project.id, "change.sent_back", `“${change.description}” couldn’t be merged (${plan.reason}); it went back to ${change.author.name}`, { changeId: change.id });
        return { change, project, outcome: "sent_back", reason: plan.reason, task };
      }
      if (plan.kind !== "fast-forward") {
        target = newId("ver");
        this.db.timelines[target] = { ...plan.timeline, version: target, parent: head, createdAt: now() };
        outcome = plan.kind;
      }
    }
    change.state = "approved";
    change.appliedVersion = target;
    change.appliedOnto = head;
    change.approvedSpots = outcome === "partial" ? spots : undefined;
    change.restoredCuts = restoredCuts;
    change.decidedBy = this.human();
    change.updatedAt = now();
    project.head = target;
    project.updatedAt = now();
    this.summary(project.id).head = target;
    const versions = (this.db.versions[project.id] ??= []);
    const tl = this.db.timelines[target];
    for (const v of versions) v.isHead = false;
    versions.push({ version: target, parent: head, name: tl?.name ?? "Main", author: change.author, changeId: change.id, description: outcome === "partial" ? `${change.description} (${spots!.length} of ${change.ranges.length})` : change.description, duration: tl ? timelineDuration(tl) : 0, isHead: true, createdAt: now() });
    for (const n of this.db.notes) {
      if (change.noteIds.includes(n.id) && n.state !== "resolved") {
        n.state = "resolved";
        n.updatedAt = now();
        this.emit({ type: "note.updated", projectId: project.id, note: { ...n } });
      }
    }
    this.refreshCounts(project.id);
    this.emit({ type: "change.updated", projectId: project.id, change: { ...change } });
    this.emitProject(project.id);
    this.log(project.id, "change.approved", outcome === "partial" ? `${this.currentUser().name} approved ${spots!.length} of ${change.ranges.length} spots of “${change.description}”` : `${this.currentUser().name} approved “${change.description}”${outcome === "rebased" ? " (merged into the latest edit)" : ""}`, { changeId: change.id, outcome });
    return { change, project, outcome };
  }
  async unapproveChange(changeId: string): Promise<{ change: Change; project: Project }> {
    this.requireAuth();
    await sleep(250);
    const change = this.db.changes.find((c) => c.id === changeId);
    if (!change) throw notFound("Change");
    const project = this.projectById(change.projectId);
    const applied = change.appliedVersion ?? change.toVersion;
    if (change.state !== "approved") throw new ScarletApiError(409, "invalid_state", "Only approved changes can be undone");
    if (project.head !== applied) throw new ScarletApiError(409, "not_latest", "Other changes were approved after this one. Restore an earlier version from the Changelog instead.");
    project.head = change.appliedOnto ?? change.fromVersion;
    this.summary(project.id).head = project.head;
    const versions = this.db.versions[project.id] ?? [];
    this.db.versions[project.id] = versions.filter((v) => v.version !== applied || v.changeId !== change.id);
    for (const v of this.db.versions[project.id]!) v.isHead = v.version === project.head;
    change.state = "ready";
    change.appliedVersion = undefined;
    change.appliedOnto = undefined;
    change.approvedSpots = undefined;
    change.restoredCuts = undefined;
    change.appliedReview = undefined;
    change.updatedAt = now();
    this.refreshCounts(project.id);
    this.emit({ type: "change.updated", projectId: project.id, change: { ...change } });
    this.emitProject(project.id);
    this.log(project.id, "change.undone", `${this.currentUser().name} undid the approval of “${change.description}”`, { changeId: change.id });
    return { change, project };
  }
  async rejectChange(changeId: string, reason?: string): Promise<{ change: Change }> {
    this.requireAuth();
    await sleep(300);
    const change = this.db.changes.find((c) => c.id === changeId);
    if (!change) throw notFound("Change");
    if (change.state === "approved") throw new ScarletApiError(409, "invalid_state", "Cannot reject an approved change");
    if (change.state === "rejected") return { change };
    change.rejectedFrom = change.state;
    change.state = "rejected";
    change.decidedBy = this.human();
    change.rejectReason = reason;
    change.updatedAt = now();
    this.refreshCounts(change.projectId);
    this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
    this.log(change.projectId, "change.rejected", `${this.currentUser().name} rejected “${change.description}”${reason ? `: “${reason}”` : ""}`, { changeId: change.id });
    return { change };
  }
  async reopenChange(changeId: string): Promise<{ change: Change }> {
    this.requireAuth();
    const change = this.db.changes.find(c => c.id === changeId);
    if (!change) throw notFound("Change");
    if (change.state !== "rejected") throw new ScarletApiError(409, "invalid_state", "Only a rejected edit can be reopened.");
    change.state = restoredReviewState(change, change.rejectedFrom, id => this.db.renders.find(r => r.id === id)?.state);
    this.restoreUnreplacedProposal(change);
    change.rejectedFrom = undefined;
    change.decidedBy = undefined;
    change.rejectReason = undefined;
    change.updatedAt = now();
    this.refreshCounts(change.projectId);
    this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
    this.log(change.projectId, "change.reopened", "Reopened for review", { changeId });
    return { change };
  }
  async reviseChange(changeId: string, body: ReviseRequest): Promise<{ change: Change; note: Note; task?: Task }> {
    this.requireAuth();
    const change = this.db.changes.find((c) => c.id === changeId);
    if (!change) throw notFound("Change");
    if (change.state === "approved") throw new ScarletApiError(409, "invalid_state", "Cannot revise an approved change");
    const { agent, model } = body.assignTo ? splitAgentTarget(body.assignTo)
      : { agent: change.author.type === "agent" ? change.author.id : "claude", model: change.author.model };
    const note: Note = { id: newId("note"), projectId: change.projectId, version: body.position?.version ?? change.toVersion, time: body.position?.time ?? change.ranges[0]?.start ?? 0, end: body.position ? body.position.end : change.ranges[0]?.end, clipIds: body.position?.clipIds ?? [], text: body.text, voiceTranscript: body.voiceTranscript, author: this.human(), assignedTo: body.assignTo ?? agent, changeId, state: "in_progress", createdAt: now(), updatedAt: now() };
    this.db.notes.unshift(note);
    const task = this.makeTask(change.projectId, { kind: "revise", agent: agent as AgentId, model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.text, context: { skillIds: body.skillIds, version: change.fromVersion, ...body.position, changeId, noteIds: [note.id], threadId: change.threadId ?? change.id, message: body.text } });
    Object.assign(change, beginRevision(change, task), { noteIds: [...change.noteIds, note.id], updatedAt: now() });
    void this.runTask(task, { fromVersion: change.fromVersion, description: `Revised: ${body.text}`, noteIds: [note.id], supersedes: change });
    this.refreshCounts(change.projectId);
    this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
    this.log(change.projectId, "change.revise_requested", `${this.currentUser().name} asked for a new version of “${change.description}”: “${body.text}”`, { changeId: change.id, threadId: change.threadId });
    return this.latency({ change, note, task }, 250);
  }

  // --- notes ---------------------------------------------------------------------------
  async createNote(projectId: string, body: CreateNoteRequest): Promise<{ note: Note; task?: Task }> {
    this.requireAuth();
    const project = this.projectById(projectId);
    const note: Note = { id: newId("note"), projectId, version: body.version ?? project.head ?? "draft", time: body.time, end: body.end, clipIds: body.clipIds ?? [], text: body.text, voiceTranscript: body.voiceTranscript, author: this.human(), assignedTo: body.assignTo, changeId: body.changeId, state: body.assignTo ? "in_progress" : "open", createdAt: now(), updatedAt: now() };
    this.db.notes.unshift(note);
    let task: Task | undefined;
    if (body.assignTo) {
      const { agent, model } = splitAgentTarget(body.assignTo);
      task = this.makeTask(projectId, { kind: "note", agent: agent as AgentId, model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.text, context: { skillIds: body.skillIds, version: note.version, noteIds: [note.id], time: body.time, end: body.end, clipIds: body.clipIds } });
      void this.runTask(task, { fromVersion: project.head ?? "", description: body.text, noteIds: [note.id] });
    }
    this.refreshCounts(projectId);
    return this.latency({ note, task }, 200);
  }
  async speechToText(_audio: Blob): Promise<{ text: string }> {
    this.requireAuth();
    if (this.db.settings.transcription.provider === "none") throw new ScarletApiError(400, "transcription_off", "Transcription isn't available in this build of Scarlet.");
    await sleep(500);
    return { text: "Keep the pause a little longer, maybe a third of a second, so it still breathes." };
  }
  async createVoiceNote(projectId: string, audio: Blob, fields: { time: number; end?: number; version?: string; clipIds?: string[]; assignTo?: string; changeId?: string }): Promise<{ note: Note; task?: Task }> {
    this.requireAuth();
    if (this.db.settings.transcription.provider === "none") return this.createNote(projectId, { ...fields, text: "[voice note — transcription not configured]" });
    await sleep(900); // "transcribing…"
    const seconds = Math.max(1, Math.round(audio.size / 6000));
    const voiceTranscript = `uh so right here, ${seconds > 3 ? "the pacing drags a bit, can we tighten this section" : "tighten this up"}`;
    const text = seconds > 3 ? "The pacing drags here; tighten this section." : "Tighten this up.";
    return this.createNote(projectId, { ...fields, text, voiceTranscript });
  }
  async notes(projectId: string, state?: string): Promise<{ notes: Note[] }> {
    this.requireAuth();
    return this.latency({ notes: this.db.notes.filter((n) => n.projectId === projectId && (!state || n.state === state)) }, 150);
  }
  async updateNote(noteId: string, body: UpdateNoteRequest): Promise<{ note: Note }> {
    this.requireAuth();
    const note = this.db.notes.find((n) => n.id === noteId);
    if (!note) throw notFound("Note");
    Object.assign(note, body, { updatedAt: now() });
    this.refreshCounts(note.projectId);
    this.emit({ type: "note.updated", projectId: note.projectId, note: { ...note } });
    return this.latency({ note });
  }
  async replyNote(noteId: string, text: string): Promise<{ note: Note }> {
    this.requireAuth();
    const note = this.db.notes.find((n) => n.id === noteId);
    if (!note) throw notFound("Note");
    const user = this.currentUser();
    note.replies = [...(note.replies ?? []), { text, author: { type: "human", id: user.id, name: user.name }, createdAt: now() }];
    note.updatedAt = now();
    this.emit({ type: "note.updated", projectId: note.projectId, note: { ...note } });
    return this.latency({ note });
  }

  // --- renders -------------------------------------------------------------------------
  private readonly renderOwners = new Map<string, Set<string>>();
  private renderHeight(project: Project, quality: "preview" | "delivery"): number {
    return quality === "delivery" ? project.settings.height : Math.min(project.settings.height, this.db.settings.render.previewHeight);
  }
  private fullKey(project: Project, version: string, quality: "preview" | "delivery"): string {
    return JSON.stringify(["full", quality, project.id, version, project.settings, this.renderHeight(project, quality), this.db.settings.render.hwaccel]);
  }
  // The demo plays a bundled sample with no fragments to prepare.
  async preparePlayback(): Promise<void> {}
  async cutPlaybackFile(projectId: string, version: string, _range: TimeRange, signal: AbortSignal) {
    const { timeline } = await this.timeline(projectId, version);
    signal.throwIfAborted();
    return { url: this.renderFileUrl(version), start: 0, end: timelineDuration(timeline), full: true as const };
  }

  async requestRender(projectId: string, body: Partial<RenderRequest>): Promise<{ render: Render }> {
    this.requireAuth();
    const project = this.projectById(projectId);
    const version = body.version ?? project.head ?? "draft";
    const delivery = body.quality === "delivery";
    const quality = body.quality ?? "preview";
    const kind = body.range && (body.kind ?? "full") === "full" ? "segment" : body.kind ?? "full";
    if (kind === "export") throw new Error("The demo saves its included sample video. Use a library project for a custom video export.");
    let key: string;
    if (kind === "full") key = this.fullKey(project, version, quality);
    else if (kind === "segment") key = JSON.stringify([kind, this.fullKey(project, version, quality), body.range]);
    else key = newId("k");
    const cached = this.db.renders.find(r => r.key === key && r.state !== "failed" && r.state !== "cancelled");
    if (cached) {
      if (body.owner) this.renderOwners.get(cached.id)?.add(body.owner);
      else this.renderOwners.delete(cached.id);
      return this.latency({ render: cached });
    }
    const height = this.renderHeight(project, quality);
    const width = Math.round(project.settings.width * height / project.settings.height / 2) * 2;
    const render: Render = { id: newId("rnd"), projectId, version, kind, quality, range: body.range ?? null, key, path: null, state: "queued", progress: 0, width, height, createdAt: now() };
    this.db.renders.push(render);
    if (body.owner) this.renderOwners.set(render.id, new Set([body.owner]));
    void this.simulateRender(render, delivery ? 6000 : 3000);
    return this.latency({ render });
  }
  private async simulateRender(render: Render, totalMs: number) {
    const cancelled = () => render.state === "cancelled";
    await sleep(300);
    if (cancelled()) return;
    render.state = "running";
    this.emit({ type: "render.updated", projectId: render.projectId, render: { ...render } });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await sleep(totalMs / steps);
      if (cancelled()) return;
      render.progress = Math.min(0.99, i / steps);
      this.emit({ type: "render.updated", projectId: render.projectId, render: { ...render } });
    }
    render.state = "done";
    render.progress = 1;
    render.path = `renders/${render.id}.mp4`;
    render.finishedAt = now();
    this.renderOwners.delete(render.id);
    const tl = this.db.timelines[render.version];
    render.durationSeconds = render.range ? render.range.end - render.range.start : tl ? timelineDuration(tl) : 20;
    this.emit({ type: "render.updated", projectId: render.projectId, render: { ...render } });
  }
  async exports(): Promise<{ renders: Render[] }> {
    return { renders: [] };
  }
  async releaseRender(id: string, owner: string): Promise<void> {
    this.requireAuth();
    const owners = this.renderOwners.get(id);
    if (!owners?.delete(owner) || owners.size) return;
    this.renderOwners.delete(id);
    const render = this.db.renders.find(r => r.id === id);
    if (render && (render.state === "queued" || render.state === "running")) {
      render.state = "cancelled";
      render.finishedAt = now();
      this.emit({ type: "render.updated", projectId: render.projectId, render: { ...render } });
    }
  }
  async render(renderId: string): Promise<{ render: Render }> {
    this.requireAuth();
    const render = this.db.renders.find((r) => r.id === renderId);
    if (!render) throw notFound("Render");
    return this.latency({ render });
  }
  async renders(projectId: string, q: { kind?: string; version?: string; currentDelivery?: boolean } = {}): Promise<{ renders: Render[]; currentDeliveryKey?: string | null; fullRenderKeys?: FullRenderKeys }> {
    this.requireAuth();
    const project = this.projectById(projectId);
    const target = !q.currentDelivery && q.version && q.version !== "head" ? q.version : project.head;
    const fullRenderKeys = target ? { context: fullRenderContext({ ...project, head: target }),
      delivery: this.fullKey(project, target, "delivery"), preview: this.fullKey(project, target, "preview") } : undefined;
    if (q.currentDelivery) {
      const key = fullRenderKeys?.delivery ?? null;
      return this.latency({ currentDeliveryKey: key, renders: this.db.renders.filter((r) => r.projectId === projectId && r.key === key) }, 150);
    }
    const version = q.version === "head" ? project.head : q.version;
    return this.latency({ fullRenderKeys, renders: this.db.renders.filter((r) => r.projectId === projectId && (!q.kind || r.kind === q.kind) && (!q.version || r.version === version)) }, 150);
  }
  renderFileUrl(renderId: string): string {
    return `/sample.mp4#render=${renderId}`;
  }
  mediaFileUrl(mediaId: string, proxy = false): string {
    return `/sample.mp4#media=${mediaId}${proxy ? "&proxy" : ""}`;
  }
  async sourceCache(_mediaId: string, _prepare = false): Promise<PlaybackCacheStatus> { return { state: "ready" }; }
  async sourceCaches(projectId: string): Promise<{ caches: SourceCacheStatus[] }> {
    return { caches: (this.db.media[projectId] ?? []).filter(m => m.kind === "video").map(m => ({ mediaId: m.id, state: "ready" })) };
  }
  sourceCacheUrl(mediaId: string) { return this.mediaFileUrl(mediaId, true); }
  sourcePreviewUrl(mediaId: string, index: number): string {
    return `/sample.mp4#media=${mediaId}&chunk=${index}`;
  }

  // --- tasks ---------------------------------------------------------------------------
  private makeTask(projectId: string, body: { kind: Task["kind"]; agent: AgentId; model?: string; effort?: string; serviceTier?: string; instruction: string; context?: Task["context"] }): Task {
    const host = this.db.hosts.find((h) => h.online && h.agents.some((a) => a.id === body.agent && a.installed && a.loggedIn !== false));
    const model = body.model ?? host?.agents.find((a) => a.id === body.agent)?.model;
    const id = newId("task");
    const task: Task = { id, projectId, kind: body.kind, agent: body.agent, model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.instruction, context: { ...(body.kind === "edit" || body.kind === "revise" || body.kind === "note" ? { dialogueOperation: dialogueCommand(body.context?.message ?? body.instruction, this.db.skills) ?? "none" } : {}), ...body.context, threadId: body.context?.threadId ?? id }, state: "queued", createdBy: this.human(), hostId: host?.id ?? null, changeIds: [], question: null, summary: null, createdAt: now() };
    this.db.tasks.unshift(task);
    this.db.taskEvents[task.id] = [];
    return task;
  }
  private pushEvent(task: Task, type: TaskEvent["type"], text: string, data?: Record<string, unknown>) {
    const event: TaskEvent = { id: newId("ev"), taskId: task.id, at: now(), type, text, data };
    (this.db.taskEvents[task.id] ??= []).push(event);
    this.emit({ type: "task.event", projectId: task.projectId, taskId: task.id, event });
  }
  private restoreUnreplacedProposal(change: Change) {
    const prior = change.revisionFrom;
    if (change.state !== "revising" || !prior) return false;
    // The demo inserts new tasks at the front. Ignore revisions from earlier attempts.
    const first = this.db.tasks.findIndex(t => t.id === prior.taskId);
    if (first < 0) return false;
    const revisions = this.db.tasks.slice(0, first + 1).filter(t => t.projectId === change.projectId && t.kind === "revise" && t.context.changeId === change.id);
    if (revisions.some(t => !["done", "failed", "cancelled"].includes(t.state))) return false;
    const ids = new Set(revisions.map(t => t.id));
    if (this.db.changes.some(c => c.projectId === change.projectId && c.taskId && ids.has(c.taskId))) return false;
    change.error = prior.error;
    change.state = restoredReviewState(change, prior.state, id => this.db.renders.find(r => r.id === id)?.state);
    change.revisionFrom = undefined;
    change.updatedAt = now();
    return true;
  }
  private updateTask(task: Task, patch: Partial<Task>) {
    Object.assign(task, patch);
    if (task.kind === "revise" && patch.state && ["done", "failed", "cancelled"].includes(patch.state)) {
      const change = this.db.changes.find(c => c.id === task.context.changeId && c.projectId === task.projectId);
      if (change && this.restoreUnreplacedProposal(change)) {
        this.refreshCounts(change.projectId);
        this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
      }
    }
    this.emit({ type: "task.updated", projectId: task.projectId, task: { ...task } });
  }
  /** Simulated agent run: claim → log lines → propose change → renders → ready → done. */
  private async runTask(task: Task, opts: { fromVersion: string; description: string; noteIds?: string[]; supersedes?: Change; previewOnly?: boolean }) {
    const isCancelled = () => task.state === "cancelled";
    await sleep(600);
    // A request whose words the editor is changing waits until they're saved.
    while (task.state === "queued" && task.rewordingUntil && Date.parse(task.rewordingUntil) > Date.now()) await sleep(300);
    if (isCancelled()) return;
    if (!task.hostId) {
      await sleep(400);
      if (isCancelled()) return;
      this.updateTask(task, { state: "failed", error: `No online agent host has ${AGENT_NAMES[task.agent]} signed in.`, finishedAt: now() });
      return;
    }
    this.updateTask(task, { state: "claimed" });
    await sleep(700);
    if (isCancelled()) return;
    this.updateTask(task, { state: "running", startedAt: now() });
    this.pushEvent(task, "log", `Starting ${AGENT_NAMES[task.agent]}${task.model ? ` (${task.model})` : ""} with project context and ${this.db.skills.filter((s) => s.enabled).length} skills`);
    await sleep(1400);
    if (isCancelled()) return;
    this.pushEvent(task, "tool", `transcript.get granularity=word${task.context.time !== undefined ? ` around=${task.context.time.toFixed(2)}` : ""}`);
    await sleep(1400);
    if (isCancelled()) return;
    this.pushEvent(task, "log", "I’m checking the timeline before preparing your edit.", { kind: "editor_progress" });
    await sleep(1200);
    if (isCancelled()) return;

    const base = this.db.timelines[opts.fromVersion] ?? (this.projectById(task.projectId).head ? this.db.timelines[this.projectById(task.projectId).head!] : undefined);
    if (!base) {
      this.updateTask(task, { state: "failed", error: "Project has no timeline yet. Upload media first.", finishedAt: now() });
      return;
    }
    // A plausible edit: trim 0.3 s off the end of the last clip on the first video track (or the clip under the playhead).
    const vTrack = base.tracks.find((t) => t.kind === "video" && t.clips.length);
    const target = vTrack?.clips.find((c) => task.context.time !== undefined && c.timelineIn <= task.context.time && task.context.time < clipEnd(c)) ?? vTrack?.clips[vTrack.clips.length - 1];
    let after: Timeline;
    let ops: TimelineOp[] | undefined;
    try {
      ops = target && target.kind === "media" ? [{ op: "updateClip", clipId: target.id, patch: { sourceOut: Math.max(target.sourceIn + 0.5, target.sourceOut - 0.3) } }] : undefined;
      if (timelineDuration(base) === 0) {
        const footage = this.db.media[task.projectId]?.find(m => (m.kind === "video" || m.kind === "audio") && m.duration);
        const track = base.tracks.find(t => t.kind === footage?.kind);
        if (footage?.duration && track) {
          ops = [{ op: "addClip", trackId: track.id, clip: mc(newId("clip"), footage.id, 0, footage.duration, 0, { label: footage.name }) }];
        }
      }
      after = ops ? applyOps(base, ops) : structuredClone(base);
    } catch {
      ops = undefined;
      after = structuredClone(base);
    }
    after.version = newId("ver");
    after.parent = base.version;
    after.createdAt = now();
    this.db.timelines[after.version] = after;
    const fps = this.projectById(task.projectId).settings.fps;
    const diff = diffTimelines(base, after, fps);
    const ranges = diff.ranges.length ? diff.ranges : [{ start: target?.timelineIn ?? 0, end: target ? clipEnd(target) : Math.min(3, timelineDuration(after)) }];
    // One before/after pair per spot, with the same 1.5 s handles the engine uses.
    const spots = diff.spots.length ? diff.spots : ranges.map((r) => ({ after: r, before: r }));
    const change: Change = { id: newId("chg"), projectId: task.projectId, fromVersion: base.version, toVersion: after.version, description: opts.description, author: { type: "agent", id: task.agent, name: AGENT_NAMES[task.agent], model: task.model }, noteIds: opts.noteIds ?? [], ranges, state: "ready", renders: spots.map((sp) => ({ range: withHandles(sp.after, 1.5, diff.durationAfter), beforeRange: withHandles(sp.before, 1.5, diff.durationBefore), before: null, after: null })), taskId: task.id, threadId: task.context.threadId ?? task.id, ops: ops as unknown as Array<Record<string, unknown>> | undefined, createdAt: now(), updatedAt: now() };
    change.canApproveSpots = canApproveSpots(base, ops, ranges, fps);
    this.db.changes.unshift(change);
    this.refreshCounts(task.projectId);
    this.pushEvent(task, "tool", `timeline.propose description="${opts.description.slice(0, 60)}" → ${change.id}`);
    this.pushEvent(task, "change", `Proposed change: ${describeDiff(diff, (s) => formatTimecode(s, fps)).join("; ") || opts.description}`, { changeId: change.id });
    task.changeIds = [...task.changeIds, change.id];
    this.emit({ type: "change.updated", projectId: task.projectId, change: { ...change } });
    if (opts.supersedes?.state === "revising") {
      opts.supersedes.state = "rejected";
      opts.supersedes.updatedAt = now();
      this.emit({ type: "change.updated", projectId: task.projectId, change: { ...opts.supersedes } });
    }
    const result = opts.previewOnly ? change : (await this.approveChange(change.id)).change;
    if (isCancelled()) return;
    this.updateTask(task, { state: "done", summary: result.description, finishedAt: now() });

  }
  async createTask(projectId: string, body: CreateTaskRequest): Promise<{ task: Task }> {
    this.requireAuth();
    const project = this.projectById(projectId);
    if (body.kind === "skill_from_change") throw new ScarletApiError(400, "use_skill_from_change", "Create skill tasks from an approved change");
    if (body.kind === "skill_edit") throw new ScarletApiError(400, "use_skill_edit", "Ask for a change to a skill from its page");
    if (body.kind === "learning_check") throw new ScarletApiError(400, "not_a_request", "Scarlet starts this check itself, with each request.");
    const followUp = body.context?.threadId;
    const ahead = followUp ? this.db.tasks.filter(t => t.projectId === projectId && (t.context.threadId ?? t.id) === followUp) : [];
    this.log(projectId, "request.created", `${this.currentUser().name} asked ${AGENT_NAMES[body.agent]}: “${body.context?.message ?? body.instruction}”${followUp ? " (follow-up)" : ""}`);
    // As the engine does: what the person said is the request itself, unless the app sent their words apart from what
    // it asks of the agent. Undo edit reads "Undo" in the chat and the queue.
    const said = body.context?.message ?? body.instruction;
    const task = this.makeTask(projectId, { kind: body.kind ?? "edit", agent: body.agent, model: body.model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.instruction,
      context: { ...(body.context ?? {}), ...(followUp ? { message: said, asked: said === body.instruction ? undefined : body.instruction } : {}) } });
    void (async () => {
      // A follow-up waits until nothing else is running in its thread.
      while (task.state === "queued" && task.context.threadId === followUp && ahead.some(t =>
        (t.context.threadId ?? t.id) === followUp && ["queued", "claimed", "running", "waiting_for_user"].includes(t.state))) await sleep(500);
      if (task.state !== "queued") return;
      await this.runTask(task, { fromVersion: project.head ?? "", description: body.instruction.length > 90 ? `${body.instruction.slice(0, 87)}…` : body.instruction });
    })();
    return this.latency({ task }, 200);
  }
  async tasks(projectId: string, state?: string, events?: "conversation") {
    this.requireAuth();
    const tasks = this.db.tasks.filter((t) => t.projectId === projectId && !isAsideTask(t) && (!state || t.state === state));
    const conversation = events && Object.fromEntries(tasks.filter(t => t.kind !== "transcribe").map(t => [t.id, this.conversation(t.id)]));
    return this.latency({ tasks, conversation }, 150);
  }
  /** The demo runs no real agent, so it has no tokens to report. */
  async projectUsage(_projectId: string, by: Exclude<UsageGroupBy, "project"> = "thread"): Promise<UsageResponse> {
    this.requireAuth();
    return this.latency({ by, total: emptyUsageTotals(), groups: [] }, 100);
  }
  async usage(by: UsageGroupBy = "project"): Promise<UsageResponse> {
    this.requireAuth();
    return this.latency({ by, total: emptyUsageTotals(), groups: [] }, 100);
  }
  private conversation(taskId: string) {
    return (this.db.taskEvents[taskId] ?? []).filter(e => e.type === "question" || e.type === "answer" || (e.type === "log" && e.data?.kind === "editor_progress"));
  }
  async task(taskId: string, scope: "all" | "conversation" = "all"): Promise<{ task: Task; events: TaskEvent[] }> {
    this.requireAuth();
    const task = this.db.tasks.find((t) => t.id === taskId);
    if (!task) throw notFound("Task");
    const events = scope === "all" ? this.db.taskEvents[taskId] ?? [] : this.conversation(taskId);
    return this.latency({ task, events });
  }
  async cancelTask(taskId: string): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.db.tasks.find((t) => t.id === taskId);
    if (!task) throw notFound("Task");
    if (["done", "failed", "cancelled"].includes(task.state)) return { task };
    this.updateTask(task, { state: "cancelled", finishedAt: now() });
    this.pushEvent(task, "log", "Cancelled by user");
    return this.latency({ task });
  }
  /** The engine's rule: only a request that hasn't begun has words left to change. */
  private waitingToReword(taskId: string): Task {
    const task = this.db.tasks.find(t => t.id === taskId);
    if (!task) throw notFound("Task");
    if (task.state !== "queued" || task.startedAt || task.resumeRootId) throw new ScarletApiError(409, "already_started", "Scarlet has already started on this request.");
    if (task.createdBy.type !== "human") throw new ScarletApiError(409, "not_yours", "This request is Scarlet’s own, so its words can’t be changed.");
    return task;
  }
  async startBeforeCalls(taskId: string): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.db.tasks.find(t => t.id === taskId);
    if (!task) throw notFound("Task");
    if (task.state !== "queued") throw new ScarletApiError(409, "already_started", "Scarlet has already started on this request.");
    if (!task.startsBeforeCalls) this.updateTask(task, { startsBeforeCalls: true });
    return this.latency({ task });
  }
  async holdForRewording(taskId: string, on: boolean): Promise<{ task: Task }> {
    this.requireAuth();
    if (!on) {
      const task = this.db.tasks.find(t => t.id === taskId);
      if (!task) throw notFound("Task");
      if (task.rewordingUntil) this.updateTask(task, { rewordingUntil: undefined });
      return this.latency({ task });
    }
    const task = this.waitingToReword(taskId);
    this.updateTask(task, { rewordingUntil: new Date(Date.now() + 90_000).toISOString() });
    return this.latency({ task });
  }
  async rewordTask(taskId: string, text: string, skillIds?: string[]): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.waitingToReword(taskId);
    const said = task.context.message ?? task.instruction;
    const words = text.trim();
    const skills = skillIds?.length ? [...new Set(skillIds)] : undefined;
    const dialogueOperation = dialogueCommand(words, this.db.skills) ?? "none";
    // Reworded, a request the app had worded for the editor, such as an undo, is their own words and nothing else.
    if (task.context.message !== undefined) this.updateTask(task, { instruction: task.context.asked ? words : task.instruction.replace(said, words),
      context: { ...task.context, dialogueOperation, dialogueRange: undefined, message: words, skillIds: skills, asked: undefined }, rewordingUntil: undefined });
    else this.updateTask(task, { instruction: words, context: { ...task.context, dialogueOperation, dialogueRange: undefined, skillIds: skills }, rewordingUntil: undefined });
    for (const note of this.db.notes.filter(n => (task.kind === "revise" || task.kind === "note") && task.context.noteIds?.includes(n.id) && n.text === said)) {
      Object.assign(note, { text: words, voiceTranscript: undefined, updatedAt: now() });
      this.emit({ type: "note.updated", projectId: note.projectId, note: { ...note } });
    }
    this.log(task.projectId, "request.reworded", `${this.currentUser().name} changed a waiting request to: “${words}”`);
    return this.latency({ task });
  }
  async continueWhenReady(taskId: string, on: boolean): Promise<{ task: Task; resumed?: Task }> {
    this.requireAuth();
    const task = this.db.tasks.find(t => t.id === taskId);
    if (!task) throw notFound("Task");
    if (task.retryTaskId) return this.latency({ task, resumed: this.db.tasks.find(t => t.id === task.retryTaskId) });
    if (!taskNeedsTranscripts(task)) throw new ScarletApiError(409, "not_waiting", "This edit isn’t waiting for a transcript.");
    // The sample project's transcripts are always ready, so asking to wait resumes the run at once.
    if (on) return this.latency({ task, resumed: (await this.retryTask(taskId)).task });
    this.updateTask(task, { continueWhenReady: undefined });
    return this.latency({ task });
  }
  async retryTask(taskId: string, body: RunChoice = {}): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.db.tasks.find(t => t.id === taskId);
    if (!task) throw notFound("Task");
    if (task.retryTaskId) return this.task(task.retryTaskId);
    const action = taskRecoveryAction(task, this.db.changes.some(c => c.taskId === taskId));
    if (!action) throw new ScarletApiError(409, "not_retryable", "This request cannot be retried.");
    const run = body.agent ? { agent: body.agent, model: body.model, effort: body.effort, fast: body.fast, serviceTier: body.serviceTier } : {};
    const retry = this.makeTask(task.projectId, { ...task, ...run, context: { ...task.context, threadId: task.context.threadId ?? task.id } });
    if (action === "resume") retry.resumeRootId = task.resumeRootId ?? task.id;
    const proposal = task.kind === "revise" ? this.db.changes.find(c => c.id === task.context.changeId && c.projectId === task.projectId) : undefined;
    if (proposal && proposal.state !== "approved" && proposal.state !== "revising") {
      Object.assign(proposal, beginRevision(proposal, retry), { updatedAt: now() });
      this.emit({ type: "change.updated", projectId: task.projectId, change: { ...proposal } });
    }
    this.updateTask(task, { retryTaskId: retry.id });
    void this.runTask(retry, { fromVersion: this.projectById(task.projectId).head ?? "", description: task.context.message ?? task.instruction, supersedes: proposal });
    return { task: retry };
  }
  async answerTask(taskId: string, text: string, skillIds?: string[]): Promise<{ task: Task }> {
    this.requireAuth();
    const task = this.db.tasks.find((t) => t.id === taskId);
    if (!task) throw notFound("Task");
    if (skillIds?.length) task.context.skillIds = [...new Set([...(task.context.skillIds ?? []), ...skillIds])];
    const operation = dialogueCommand(text, this.db.skills);
    if (operation && operation !== task.context.dialogueOperation) {
      task.context = { ...task.context, dialogueOperation: operation, dialogueRange: undefined };
      task.repeatAudit = undefined;
    }
    this.pushEvent(task, "answer", text);
    this.updateTask(task, { state: "running", question: null });
    void (async () => {
      await sleep(1500);
      this.pushEvent(task, "log", `Applying your answer: “${text}”`);
      await sleep(1500);
      const change = this.db.changes.find((c) => task.changeIds.includes(c.id));
      if (change && change.state === "rendering") {
        const pending = this.db.renders.filter((r) => r.changeId === change.id && r.state !== "done");
        for (const r of pending) {
          r.state = "done";
          r.progress = 1;
          r.path = `renders/${r.id}.mp4`;
          r.finishedAt = now();
          this.emit({ type: "render.updated", projectId: task.projectId, render: { ...r } });
        }
        change.state = "ready";
        change.updatedAt = now();
        this.emit({ type: "change.updated", projectId: task.projectId, change: { ...change } });
      }
      this.updateTask(task, { state: "done", summary: "Lower-third updated per your answer.", finishedAt: now() });
    })();
    return this.latency({ task });
  }

  // --- hosts / skills / settings ---------------------------------------------------------
  async hosts(): Promise<{ hosts: AgentHost[] }> {
    this.requireAuth();
    return this.latency({ hosts: this.db.hosts }, 150);
  }
  async skills(): Promise<{ skills: Skill[] }> {
    this.requireAuth();
    return this.latency({ skills: this.db.skills }, 150);
  }
  async createSkill(body: UpsertSkillRequest): Promise<{ skill: Skill }> {
    this.requireAuth();
    if (this.db.skills.some(s => s.name === body.name)) throw new ScarletApiError(409, "skill_exists", "A skill with that name already exists");
    const skill: Skill = { id: newId("skl"), name: body.name, description: body.description ?? "", content: body.content, scope: "team", ownerId: null, projectId: null, agents: [], enabled: body.enabled ?? true, version: 1, createdAt: now(), updatedAt: now() };
    this.db.skills.push(skill);
    this.db.skillVersions[skill.id] = [{ version: 1, content: skill.content, author: this.human(), createdAt: now() }];
    this.emit({ type: "skill.updated", skill });
    return this.latency({ skill }, 200);
  }
  async skill(skillId: string): Promise<{ skill: Skill; versions: SkillVersion[]; edits: Task[] }> {
    this.requireAuth();
    const skill = this.db.skills.find((s) => s.id === skillId);
    if (!skill) throw notFound("Skill");
    // The demo adds new tasks at the front. The page reads them in the order asked.
    const edits = this.db.tasks.filter(t => isSkillEdit(t) && t.context.skillId === skillId).map(t => ({ ...t })).reverse();
    return this.latency({ skill, versions: this.db.skillVersions[skillId] ?? [], edits });
  }
  /** The demo has no model: it adds the request to the end of the instructions, as a new version by the agent. */
  async editSkill(skillId: string, body: EditSkillRequest): Promise<{ task: Task }> {
    this.requireAuth();
    const skill = this.db.skills.find((s) => s.id === skillId);
    if (!skill) throw notFound("Skill");
    if (this.db.tasks.some(t => isSkillEdit(t) && t.context.skillId === skillId && !["done", "failed", "cancelled"].includes(t.state))) {
      throw new ScarletApiError(409, "skill_edit_running", "Scarlet is already revising this skill");
    }
    const home = this.db.projects[0];
    if (!home) throw new ScarletApiError(409, "no_project", "Create a project first. Scarlet runs its requests from one.");
    const task = this.makeTask(home.id, { kind: "skill_edit", agent: body.agent ?? this.db.settings.defaultAgent, model: body.model, effort: body.effort,
      serviceTier: body.serviceTier, instruction: body.prompt, context: { skillId } });
    const isCancelled = () => task.state === "cancelled";
    void (async () => {
      await sleep(600);
      if (isCancelled()) return;
      if (!task.hostId) {
        this.updateTask(task, { state: "failed", error: `No online agent host has ${AGENT_NAMES[task.agent]} signed in.`, finishedAt: now() });
        return;
      }
      this.updateTask(task, { state: "running", startedAt: now() });
      await sleep(2400);
      if (isCancelled()) return;
      const current = this.db.skills.find((s) => s.id === skillId);
      if (!current) {
        this.updateTask(task, { state: "failed", error: "The skill was deleted.", finishedAt: now() });
        return;
      }
      current.content = `${current.content.trimEnd()}\n\n## From the editor\n\n${body.prompt.trim()}\n`;
      current.version += 1;
      current.updatedAt = now();
      (this.db.skillVersions[skillId] ??= []).push({ version: current.version, content: current.content,
        author: { type: "agent", id: task.agent, name: AGENT_NAMES[task.agent], model: task.model }, createdAt: current.updatedAt });
      this.emit({ type: "skill.updated", skill: { ...current } });
      this.updateTask(task, { state: "done", resultSkillId: skillId, summary: "Added it as a section at the end of the instructions.", finishedAt: now() });
    })();
    return this.latency({ task: { ...task } }, 200);
  }
  // --- learnings ---------------------------------------------------------------------------
  async learnings(projectId: string): Promise<{ learnings: Learning[] }> {
    this.requireAuth();
    return this.latency({ learnings: this.db.learnings.filter(l => l.projectId === projectId && (l.state === "suggested" || l.state === "saving")).map(l => ({ ...l })) }, 120);
  }
  private learning(projectId: string, learningId: string): Learning {
    const learning = this.db.learnings.find(l => l.id === learningId && l.projectId === projectId);
    if (!learning) throw notFound("Learning");
    if (learning.state !== "suggested") throw new ScarletApiError(409, "learning_settled", `this learning is already ${learning.state}`);
    return learning;
  }
  /**
   * The demo has no model: the rule takes the place of the first passage it replaces, and the others go, or it goes in
   * at the end of the skill's instructions when it replaces nothing. The skill gets a new version by the agent.
   */
  async approveLearning(projectId: string, learningId: string, body: ApproveLearningRequest = {}): Promise<{ learning: Learning }> {
    this.requireAuth();
    const learning = this.learning(projectId, learningId);
    const skill = this.db.skills.find(s => s.id === (body.skillId ?? learning.skillId));
    if (!skill) throw notFound("Skill");
    const replaces = skill.id === learning.skillId ? learning.replaces : undefined;
    Object.assign(learning, { skillId: skill.id, replaces, state: "saving", error: undefined });
    this.emit({ type: "learning.updated", projectId, learning: { ...learning } });
    void (async () => {
      await sleep(1800);
      const [first, ...rest] = (replaces ?? []).filter(q => skill.content.includes(q));
      skill.content = first ? rest.reduce((text, q) => text.replace(q, "").replace(/ {2,}/g, " "), skill.content.replace(first, learning.rule))
        : `${skill.content.trimEnd()}\n\n${learning.rule}\n`;
      skill.version += 1;
      skill.updatedAt = now();
      (this.db.skillVersions[skill.id] ??= []).push({ version: skill.version, content: skill.content,
        author: { type: "agent", id: "claude", name: AGENT_NAMES.claude }, createdAt: skill.updatedAt });
      this.emit({ type: "skill.updated", skill: { ...skill } });
      learning.state = "saved";
      this.emit({ type: "learning.updated", projectId, learning: { ...learning } });
    })();
    return this.latency({ learning: { ...learning } }, 150);
  }
  async reviseLearning(projectId: string, learningId: string, body: ReviseLearningRequest): Promise<{ learning: Learning }> {
    this.requireAuth();
    const learning = this.learning(projectId, learningId);
    const revised = ReviseLearningRequest.safeParse(body);
    if (!revised.success) throw new ScarletApiError(400, "invalid_request", "A rule is one line of up to 280 characters.");
    Object.assign(learning, { rule: revised.data.rule, error: undefined });
    this.emit({ type: "learning.updated", projectId, learning: { ...learning } });
    return this.latency({ learning: { ...learning } }, 120);
  }
  async declineLearning(projectId: string, learningId: string): Promise<{ learning: Learning }> {
    this.requireAuth();
    const learning = this.learning(projectId, learningId);
    learning.state = "declined";
    this.emit({ type: "learning.updated", projectId, learning: { ...learning } });
    return this.latency({ learning: { ...learning } }, 120);
  }

  async updateSkill(skillId: string, body: Partial<UpsertSkillRequest>): Promise<{ skill: Skill }> {
    this.requireAuth();
    const skill = this.db.skills.find((s) => s.id === skillId);
    if (!skill) throw notFound("Skill");
    if (this.db.skills.some(s => s.name === body.name && s.id !== skillId)) throw new ScarletApiError(409, "skill_exists", "A skill with that name already exists");
    const contentChanged = body.content !== undefined && body.content !== skill.content;
    Object.assign(skill, body, { scope: "team", projectId: null, ownerId: null, agents: [], updatedAt: now() });
    if (contentChanged) {
      skill.version += 1;
      (this.db.skillVersions[skillId] ??= []).push({ version: skill.version, content: skill.content, author: this.human(), createdAt: now() });
    }
    this.emit({ type: "skill.updated", skill: { ...skill } });
    return this.latency({ skill }, 200);
  }
  async deleteSkill(skillId: string): Promise<Record<string, never>> {
    this.requireAuth();
    this.db.skills = this.db.skills.filter((s) => s.id !== skillId);
    return this.latency({});
  }
  async skillFromChange(changeId: string, name: string, agent?: string): Promise<{ task: Task }> {
    this.requireAuth();
    const change = this.db.changes.find((c) => c.id === changeId);
    if (!change) throw notFound("Change");
    this.projectById(change.projectId);
    if (!SkillSlug.safeParse(name).success) throw new ScarletApiError(400, "invalid_skill_name", "Invalid skill name");
    if (change.state !== "approved") throw new ScarletApiError(409, "change_not_approved", "Only approved changes can be saved as skills");
    const teamSkillExists = () => this.db.skills.some((s) => s.scope === "team" && s.name === name);
    if (teamSkillExists()) throw new ScarletApiError(409, "skill_exists", `A team skill named "${name}" already exists`);
    const version = change.appliedVersion ?? change.toVersion;
    const task = this.makeTask(change.projectId, {
      kind: "skill_from_change",
      agent: (agent as AgentId | undefined) ?? this.db.settings.defaultAgent,
      instruction: `Write a SKILL.md named "${name}" capturing change ${changeId}: ${change.description}`,
      context: { changeId, version, skillName: name },
    });
    const isCancelled = () => task.state === "cancelled";
    void (async () => {
      await sleep(800);
      if (isCancelled()) return;
      if (!task.hostId) {
        this.updateTask(task, { state: "failed", error: `No online agent host has ${AGENT_NAMES[task.agent]} signed in.`, finishedAt: now() });
        return;
      }
      this.updateTask(task, { state: "running", startedAt: now() });
      this.pushEvent(task, "tool", `change.get ${changeId}`);
      await sleep(1600);
      if (isCancelled()) return;
      this.pushEvent(task, "log", "Drafting SKILL.md from the approved change");
      await sleep(1800);
      if (isCancelled()) return;
      if (!this.db.projects.some((p) => p.id === task.projectId) || change.state !== "approved" || (change.appliedVersion ?? change.toVersion) !== version) {
        this.updateTask(task, { state: "failed", error: "The source change is no longer approved at the requested version.", finishedAt: now() });
        return;
      }
      if (teamSkillExists()) {
        this.updateTask(task, { state: "failed", error: `A team skill named "${name}" already exists.`, finishedAt: now() });
        return;
      }
      const approvedRanges = change.ranges.filter((_, index) => !change.approvedSpots || change.approvedSpots.includes(index));
      const content = `---\nname: ${name}\ndescription: ${JSON.stringify(change.description)}\n---\n\n# ${name}\n\nLearned from change ${changeId}.\n\n1. ${change.description}\n2. Keep the affected range tight (${approvedRanges.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)} s`).join(", ") || "whole timeline"}).\n`;
      const skill: Skill = { id: newId("skl"), name, description: change.description, content, scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1, createdAt: now(), updatedAt: now(), source: `change:${changeId}` };
      this.db.skills.push(skill);
      this.db.skillVersions[skill.id] = [{ version: 1, content, author: { type: "agent", id: task.agent, name: AGENT_NAMES[task.agent], model: task.model }, createdAt: now() }];
      this.emit({ type: "skill.updated", skill });
      this.updateTask(task, { state: "done", resultSkillId: skill.id, summary: `Saved skill “${name}” (team scope).`, finishedAt: now() });
    })();
    return this.latency({ task }, 200);
  }
  async localModelStatus() { return { state: "ready" as const }; }
  async settings(): Promise<{ settings: ServerSettings; transcriptionAvailable: boolean }> {
    this.requireAuth();
    return this.latency({ settings: this.db.settings, transcriptionAvailable: this.db.settings.transcription.provider !== "none" });
  }
  async updateSettings(body: Partial<ServerSettings>): Promise<{ settings: ServerSettings }> {
    this.requireAuth();
    const previous = this.db.settings;
    this.db.settings = { ...this.db.settings, ...body, editingTools: { ...this.db.settings.editingTools, ...body.editingTools }, transcription: { ...this.db.settings.transcription, ...body.transcription }, noteCleanup: { ...this.db.settings.noteCleanup, ...body.noteCleanup }, render: { ...this.db.settings.render, ...body.render },
      dialogue: DialoguePreferences.parse({ ...this.db.settings.dialogue, ...body.dialogue, aiCuts: { ...this.db.settings.dialogue?.aiCuts, ...body.dialogue?.aiCuts } }) };
    if (previous.render.hwaccel !== this.db.settings.render.hwaccel || previous.render.previewHeight !== this.db.settings.render.previewHeight ||
        previous.dialogue.crossfadeFrames !== this.db.settings.dialogue.crossfadeFrames) this.emit({ type: "render.settings.updated" });
    return this.latency({ settings: this.db.settings }, 250);
  }

  // --- background activity so the UI moves on its own ---------------------------------------
  private bootBackgroundActivity() {
    void (async () => {
      // The "rendering" change finishes its after-render and becomes ready.
      const rendering = this.db.renders.find((r) => r.id === "rnd_a2");
      const change = this.db.changes.find((c) => c.id === "chg_rendering");
      if (rendering && change) {
        await sleep(4000);
        for (let p = 0.42; p < 1; p += 0.145) {
          rendering.progress = Math.min(0.99, p);
          this.emit({ type: "render.updated", projectId: rendering.projectId, render: { ...rendering } });
          await sleep(900);
        }
        rendering.state = "done";
        rendering.progress = 1;
        rendering.path = `renders/${rendering.id}.mp4`;
        rendering.durationSeconds = 5;
        rendering.finishedAt = now();
        this.emit({ type: "render.updated", projectId: rendering.projectId, render: { ...rendering } });
        if (change.state !== "rendering" && change.state !== "proposed") return;
        change.state = "ready";
        change.updatedAt = now();
        this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
      }
    })();
    void (async () => {
      // The running filler-word task streams a few more lines, then completes with a change.
      const task = this.db.tasks.find((t) => t.id === "task_running");
      if (!task) return;
      await sleep(2500);
      const steps = [
        { type: "tool", text: "waveform.get range=15.5–19.5 points=400" },
        { type: "log", text: "All three cuts fall in gaps between spoken phrases.", data: { kind: "editor_progress" } },
      ] as const;
      for (const step of steps) {
        if (task.state !== "running") return;
        this.pushEvent(task, step.type, step.text, "data" in step ? step.data : undefined);
        await sleep(2600);
      }
      if (task.state !== "running") return;
      await this.runTask(task, { fromVersion: "ver_3", description: "Remove three filler words from the wrap (um 15.9, like 17.2, you know 18.4)", previewOnly: this.chatLayouts });
    })();
  }
}
