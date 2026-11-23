import { dialogueCommand, AGENT_LABEL, ScarletApiError, isProjectEditTask, countReviewDecisions, type Learning, type AgentId, type ProjectSummary, type Render, type Skill, type Task, type TaskEvent, type User, type WsEvent, type ActivityEntry } from "@scarlet/shared";
import { canApproveSpots, newId, timelineDuration, TimelineOp, type Author, type Change, type Project, type Timeline } from "@scarlet/timeline";
import { seedActivity } from "./activitySeed";
import { Emitter } from "./emitter";
import { buildDb, type MockDb } from "./fixtures";
import { fullRenderKey } from "./renders";
import { restoreUnreplacedProposal } from "./tasks";
import { isFinished, notFound, now } from "./util";

/** The demo's state, and the helpers the client and its domain modules share. */
export class MockStore {
  readonly events = new Emitter();
  readonly db: MockDb;
  readonly activityLog: ActivityEntry[];
  readonly renderOwners = new Map<string, Set<string>>();

  constructor(private readonly tokenSource: () => string | undefined, readonly chatLayouts = false) {
    this.db = buildDb(chatLayouts);
    for (const render of this.db.renders) {
      if (render.kind === "full" && !render.range) render.key = fullRenderKey(this.projectById(render.projectId), render.version, render.quality ?? "preview", this.db.settings.render);
    }
    for (const change of this.db.changes) {
      const base = this.db.timelines[change.fromVersion];
      change.canApproveSpots = !!base && canApproveSpots(base, change.ops as TimelineOp[] | undefined, change.ranges, this.projectById(change.projectId).settings.fps);
    }
    this.activityLog = seedActivity(this.db);
  }

  get token(): string | undefined {
    return this.tokenSource();
  }
  log(projectId: string | null, type: string, summary: string, data: Record<string, unknown> = {}, actor?: Author) {
    const entry: ActivityEntry = { id: newId("act"), projectId, actor: actor ?? this.human(), type, summary, data, createdAt: now() };
    this.activityLog.unshift(entry);
    this.emit({ type: "activity.added", projectId, entry });
  }
  requireAuth() {
    if (!this.token) throw new ScarletApiError(401, "unauthorized", "Missing access token");
  }
  emit(ev: WsEvent) {
    this.events.emit(ev);
  }
  summary(projectId: string): ProjectSummary {
    const s = this.db.summaries[projectId];
    if (!s) throw notFound("Project");
    const project = this.projectById(projectId);
    const tasks = this.db.tasks.filter(t => t.projectId === projectId);
    s.pendingChanges = countReviewDecisions({
      changes: this.db.changes.filter(c => c.projectId === projectId),
      tasks,
      notes: this.db.notes.filter(n => n.projectId === projectId),
    }, project.completedThreads);
    s.mediaPaused = project.mediaPaused;
    const editing = tasks.filter(task => isProjectEditTask(task) && (task.state === "claimed" || task.state === "running")).length;
    s.activity = editing ? [{ kind: "editing", count: editing }] : undefined;
    const head = this.db.timelines[project.head ?? ""];
    s.duration = head && timelineDuration(head);
    return s;
  }
  projectById(id: string): Project {
    const p = this.db.projects.find((x) => x.id === id);
    if (!p) throw notFound("Project");
    return p;
  }
  refreshCounts(projectId: string) {
    const s = this.db.summaries[projectId];
    if (!s) return;
    s.openNotes = this.db.notes.filter((n) => n.projectId === projectId && (n.state === "open" || n.state === "in_progress")).length;
    s.mediaCount = (this.db.media[projectId] ?? []).length;
    s.updatedAt = now();
  }
  currentUser(): User {
    return this.db.me;
  }
  human(): Author {
    const u = this.currentUser();
    return { type: "human", id: u.id, name: u.name };
  }
  emitProject(projectId: string) {
    this.emit({ type: "project.updated", projectId, project: this.projectById(projectId) });
  }
  emitChange(change: Change) {
    this.emit({ type: "change.updated", projectId: change.projectId, change: { ...change } });
  }
  emitRender(render: Render) {
    this.emit({ type: "render.updated", projectId: render.projectId, render: { ...render } });
  }
  emitLearning(projectId: string, learning: Learning) {
    this.emit({ type: "learning.updated", projectId, learning: { ...learning } });
  }
  changeById(id: string): Change {
    const change = this.db.changes.find((c) => c.id === id);
    if (!change) throw notFound("Change");
    return change;
  }
  taskById(id: string): Task {
    const task = this.db.tasks.find((t) => t.id === id);
    if (!task) throw notFound("Task");
    return task;
  }
  skillById(id: string): Skill {
    const skill = this.db.skills.find((s) => s.id === id);
    if (!skill) throw notFound("Skill");
    return skill;
  }
  /** A version's timeline, or the project's head for "head". */
  versionTimeline(project: Project, version: string): Timeline | undefined {
    return this.db.timelines[version === "head" ? (project.head ?? "") : version];
  }
  requireTranscription() {
    if (this.db.settings.transcription.provider === "none") throw new ScarletApiError(400, "transcription_off", "Transcription isn't available in this build of Scarlet.");
  }
  makeTask(projectId: string, body: { kind: Task["kind"]; agent: AgentId; model?: string; effort?: string; serviceTier?: string; instruction: string; context?: Task["context"] }): Task {
    const host = this.db.hosts.find((h) => h.online && h.agents.some((a) => a.id === body.agent && a.installed && a.loggedIn !== false));
    const model = body.model ?? host?.agents.find((a) => a.id === body.agent)?.model;
    const id = newId("task");
    const task: Task = { id, projectId, kind: body.kind, agent: body.agent, model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.instruction, context: { ...(body.kind === "edit" || body.kind === "revise" || body.kind === "note" ? { dialogueOperation: dialogueCommand(body.context?.message ?? body.instruction, this.db.skills) ?? "none" } : {}), ...body.context, threadId: body.context?.threadId ?? id }, state: "queued", createdBy: this.human(), hostId: host?.id ?? null, changeIds: [], question: null, summary: null, createdAt: now() };
    this.db.tasks.unshift(task);
    this.db.taskEvents[task.id] = [];
    return task;
  }
  pushEvent(task: Task, type: TaskEvent["type"], text: string, data?: Record<string, unknown>) {
    const event: TaskEvent = { id: newId("ev"), taskId: task.id, at: now(), type, text, data };
    (this.db.taskEvents[task.id] ??= []).push(event);
    this.emit({ type: "task.event", projectId: task.projectId, taskId: task.id, event });
  }
  updateTask(task: Task, patch: Partial<Task>) {
    Object.assign(task, patch);
    if (task.kind === "revise" && patch.state && isFinished(patch.state)) {
      const change = this.db.changes.find(c => c.id === task.context.changeId && c.projectId === task.projectId);
      if (change && restoreUnreplacedProposal(this.db, change)) {
        this.refreshCounts(change.projectId);
        this.emitChange(change);
      }
    }
    this.emit({ type: "task.updated", projectId: task.projectId, task: { ...task } });
  }
  failTask(task: Task, error: string) {
    this.updateTask(task, { state: "failed", error, finishedAt: now() });
  }
  /** Fails a run no online host can take. Returns whether it did. */
  failWithoutHost(task: Task): boolean {
    if (task.hostId) return false;
    this.failTask(task, `No online agent host has ${AGENT_LABEL[task.agent]} signed in.`);
    return true;
  }
  conversation(taskId: string) {
    return (this.db.taskEvents[taskId] ?? []).filter(e => e.type === "question" || e.type === "answer" || (e.type === "log" && e.data?.kind === "editor_progress"));
  }
}
