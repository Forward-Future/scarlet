import { create } from "zustand";
import { fullRenderContext, isAsideTask, ScarletApiError } from "@scarlet/shared";
import type {
  ActivityEntry,
  ApproveResponse,
  CreateNoteRequest,
  CreateTaskRequest,
  FullRenderKeys,
  Learning,
  ProjectSummary,
  Render,
  RenderRequest,
  RunChoice,
  SpeakerProgress,
  Task,
  TaskEvent,
  TrashedProject,
  UpdateNoteRequest,
  UsageTotals,
  VersionSummary,
  WsEvent,
} from "@scarlet/shared";
import type { Change, MediaAsset, Note, Project, Timeline } from "@scarlet/timeline";
import { api, errorMessage } from "../lib/client";
import { subscribeProject } from "../lib/realtime";
import { mergeTaskEvents } from "../lib/taskActivity";

export type Status = "idle" | "loading" | "ready" | "error";

export interface ProjectData {
  id: string;
  project: Project;
  timeline: Timeline | null;
  media: MediaAsset[];
  changes: Change[];
  notes: Note[];
  /** Rules Scarlet picked up from requests here, each until the editor has approved or declined it and it is saved. */
  learnings?: Learning[];
  renders: Render[];
  fullRenderKeys?: FullRenderKeys;
  renderSettingsRevision?: number;
  sourcePreviewRevisions?: Record<string, number>;
  tasks: Task[];
  taskEvents: Record<string, TaskEvent[]>;
  /** Token totals per task, across its runs. Tasks without a report are absent. */
  taskUsage?: Record<string, UsageTotals>;
  speakerProgress?: Record<string, SpeakerProgress & { updatedAt?: number }>;
  taskEventScopes?: Record<string, "all" | "conversation">;
  versions?: VersionSummary[];
  historyRevision?: number;
  /** Identity of the last full project read, including the one following an engine reconnect. */
  loadRevision?: number;
  reviewStatus?: "loading" | "error";
  reviewError?: string;
  /**
   * The edit moved on and its timeline still couldn't be read after the store tried again by itself. The last timeline
   * that was read stays on screen meanwhile, and so does the conversation.
   */
  headError?: string;
  /** The permanent activity log, newest first (loaded on demand). */
  activity?: ActivityEntry[];
  activityComplete?: boolean;
}

interface ProjectState {
  list: ProjectSummary[];
  listStatus: Status;
  listError: string | null;
  /** `retry` is the editor asking again after a failure, which shows as loading. A refresh never does. */
  loadList(retry?: boolean): Promise<void>;
  createProject(body: { name: string; settings?: Partial<Project["settings"]> }): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  current: ProjectData | null;
  trashedProject: TrashedProject | null;
  status: Status;
  error: string | null;
  /** `tries` is the store's own: which try this is at reading the open project again, after a read of it failed. */
  load(id: string, tries?: number): Promise<void>;
  refreshHead(projectId?: string): Promise<void>;
  loadVersions(): Promise<void>;
  applyEvent(ev: WsEvent): void;

  setThreadDone(threadId: string, done: boolean, revision: string): Promise<void>;
  updateProject(body: { mediaPaused?: boolean; name?: string; archived?: boolean; settings?: Partial<Project["settings"]>; expectedFormat?: Pick<Project, "head" | "settings"> }, projectId?: string): Promise<void>;

  approve(changeId: string, spots?: number[], restoredCuts?: number[]): Promise<ApproveResponse | undefined>;
  historyEdit(version: string, action: "revert" | "restore"): Promise<void>;
  switchBranch(name: string, from?: string): Promise<void>;
  unapprove(changeId: string): Promise<void>;
  reopen(changeId: string): Promise<void>;
  reject(changeId: string, reason?: string): Promise<void>;
  revise(changeId: string, body: Parameters<typeof api.reviseChange>[1]): Promise<Task | undefined>;
  loadChangeDiff(changeId: string): Promise<Awaited<ReturnType<typeof api.change>>["diff"]>;

  requestRender(body: Partial<RenderRequest>): Promise<Render>;
  ensureRender(renderId: string): Promise<void>;
  refreshFullRenders(): Promise<void>;

  createNote(projectId: string, body: CreateNoteRequest): Promise<{ note: Note; task?: Task }>;
  createVoiceNote(projectId: string, blob: Blob, fields: Parameters<typeof api.createVoiceNote>[2]): Promise<{ note: Note; task?: Task }>;
  updateNote(noteId: string, body: UpdateNoteRequest): Promise<void>;
  replyNote(noteId: string, text: string): Promise<void>;

  /** Approve a rule for the skill it names, or another the editor chose. An agent then works it into that skill. */
  /** Approve a rule for a skill. The save runs on the model chosen now. */
  approveLearning(learningId: string, skillId?: string, runWith?: RunChoice): Promise<void>;
  reviseLearning(learningId: string, rule: string): Promise<void>;
  declineLearning(learningId: string): Promise<void>;

  createTask(projectId: string, body: CreateTaskRequest): Promise<Task>;
  cancelTask(taskId: string): Promise<void>;
  /** Retry or resume a run. It runs on the model picked now. */
  retryTask(taskId: string, runWith?: RunChoice): Promise<void>;
  /** Finish a run that ended without its transcripts once they are ready, or stop waiting to. */
  continueWhenReady(taskId: string, on: boolean): Promise<void>;
  answerTask(taskId: string, text: string, skillIds?: string[]): Promise<void>;
  /** Keep a queued request from starting while its words are changed, or let it go. */
  holdForRewording(taskId: string, on: boolean): Promise<void>;
  /** Change the words of a request still waiting its turn. */
  rewordTask(taskId: string, text: string, skillIds?: string[]): Promise<void>;
  /** Start a queued request without waiting for the editor's calls on a dialogue pass. */
  startBeforeCalls(taskId: string): Promise<void>;
  loadTaskEvents(taskId: string, scope?: "all" | "conversation"): Promise<void>;

  transcribe(mediaId: string): Promise<Task>;
  upsertMedia(projectId: string, media: MediaAsset): void;
  /** Take a file Scarlet couldn't read out of the project. The engine refuses one the video or its history uses. */
  removeMedia(mediaId: string): Promise<void>;
  checkout(version: string): Promise<void>;
  loadActivity(more?: boolean): Promise<void>;
  importFromDavinci(otio: unknown): Promise<Change>;
}

/**
 * A task as a request answered it, unless the socket already has it further on. The engine tells the socket first, so
 * an answer that says "queued" can arrive after the task was claimed, and would put a running request back in line.
 */
function upsertAnswered(tasks: Task[], task: Task): Task[] {
  const held = tasks.find(t => t.id === task.id);
  return held && task.state === "queued" && held.state !== "queued" && held.state !== "waiting_for_user" ? tasks : upsert(tasks, task);
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function mergeSinceLoad<T extends { id: string }>(snapshot: T[], base: T[], live: T[]): T[] {
  if (base === live) return snapshot;
  const before = new Map(base.map(item => [item.id, item]));
  const newer = new Map(live.filter(item => item !== before.get(item.id)).map(item => [item.id, item]));
  const result = snapshot.map(item => {
    const update = newer.get(item.id);
    newer.delete(item.id);
    return update ?? item;
  });
  return [...result, ...newer.values()];
}

/** The waits before the store tries again to read the open project. After the last it stops trying. */
const READ_AGAIN_AFTER_MS = [1000, 2000, 4000, 8000];

export const useProjectStore = create<ProjectState>((set, get, store) => {
  let renderLookup = 0;
  let projectLoad = 0;
  let listRevision = 0;
  let listRequest: { client: typeof api; job: Promise<void> } | undefined;
  let opening: { id: string; events: WsEvent[]; imports: MediaAsset[] } | undefined;
  const eventLookups = new Map<string, Promise<void>>();
  /** The runs whose steps the open project's pages have asked for, each with the fullest read asked. */
  let askedEvents: { project: string; scopes: Record<string, "all" | "conversation"> } | undefined;
  let headLookup = 0;
  const renderLookups = new Set<string>();
  let versionLookup: Promise<void> | undefined;
  /** The store's one wait to read the open project again, and the project it is for. */
  let readAgain: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const dropReadAgain = () => {
    clearTimeout(readAgain?.timer);
    readAgain = undefined;
  };
  /** The store's one wait to read the open project's new timeline again, after a read of it failed. */
  let headAgain: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const dropHeadAgain = () => {
    clearTimeout(headAgain?.timer);
    headAgain = undefined;
  };
  // Each wait is the open project's own: it goes when the project is closed or another takes its place.
  store.subscribe(({ current }) => {
    if (readAgain && current?.id !== readAgain.id) dropReadAgain();
    if (headAgain && current?.id !== headAgain.id) dropHeadAgain();
    if (askedEvents && current?.id !== askedEvents.project) askedEvents = undefined;
  });
  const patch = (projectId: string, fn: (d: ProjectData) => Partial<ProjectData>) => {
    const cur = get().current;
    if (cur?.id === projectId) set({ current: { ...cur, ...fn(cur) } });
  };
  const replaceChange = (change: Change) => patch(change.projectId, d => {
    const changes = upsert(d.changes, change);
    const addedVersion = (d.versions || versionLookup) && d.changes.find(c => c.id === change.id)?.toVersion !== change.toVersion;
    if (!addedVersion) return { changes };
    versionLookup = undefined;
    return { changes, versions: undefined, historyRevision: (d.historyRevision ?? 0) + 1 };
  });
  /**
   * The edit moved to `head` and its timeline couldn't be read. One failed read mustn't take the conversation and the
   * video off screen: the last timeline that was read stays, as it does while any new one is on its way, and the store
   * reads the new one again by itself, a few times. Only a read that keeps failing is said, beside the conversation.
   */
  const headUnread = (projectId: string, head: string | null | undefined, tries = 0) => (err: unknown) => {
    const cur = get().current;
    if (cur?.id !== projectId || cur.project.head !== head || cur.timeline?.version === head) return;
    const wait = READ_AGAIN_AFTER_MS[tries];
    if (wait === undefined) {
      patch(projectId, () => ({ headError: `Couldn’t load the updated timeline: ${errorMessage(err)}` }));
      return;
    }
    dropHeadAgain();
    headAgain = { id: projectId, timer: setTimeout(() => {
      headAgain = undefined;
      const now = get().current;
      if (now?.id === projectId && now.project.head === head) void get().refreshHead(projectId).catch(headUnread(projectId, head, tries + 1));
    }, wait) };
  };
  /**
   * Reading the open project anew failed, and nothing on screen says so or offers Retry. Until it is read, what Scarlet
   * did while the socket was down is missing and a run that finished reads as working, so the store tries again by
   * itself, a few times and no more.
   */
  const readAgainLater = (id: string, request: number, tries: number) => {
    const cur = get().current;
    const wait = READ_AGAIN_AFTER_MS[tries];
    if (request !== projectLoad || cur?.id !== id || cur.reviewStatus || wait === undefined) return;
    dropReadAgain();
    readAgain = { id, timer: setTimeout(() => {
      readAgain = undefined;
      if (request === projectLoad && get().current?.id === id) void get().load(id, tries + 1);
    }, wait) };
  };

  return {
    list: [],
    listStatus: "idle",
    listError: null,
    loadList(retry = false) {
      // Only the first load, or one the editor asked for, shows as loading. A refresh of an empty library leaves
      // its first-project guide in place instead of swapping it for a spinner every ten seconds.
      if (!get().list.length && (get().listStatus === "idle" || retry)) set({ listStatus: "loading" });
      if (listRequest?.client === api) return listRequest.job;
      const revision = listRevision;
      const client = api;
      const job = client.projects().then(({ projects }) => {
        if (client !== api || revision !== listRevision) return;
        // A visibility or ten-second refresh usually returns the same library.
        const state = get();
        if (state.listStatus === "ready" && !state.listError &&
            state.list.length === projects.length && JSON.stringify(state.list) === JSON.stringify(projects)) return;
        set({ list: projects, listStatus: "ready", listError: null });
      }).catch(err => {
        if (client === api && revision === listRevision) set({ listStatus: "error", listError: errorMessage(err) });
      }).finally(() => {
        if (listRequest?.job !== job) return;
        listRequest = undefined;
        if (client === api && revision !== listRevision) return get().loadList();
      });
      listRequest = { client, job };
      return job;
    },
    async createProject(body) {
      const { project } = await api.createProject(body);
      listRevision++;
      const summary: ProjectSummary = { id: project.id, name: project.name, settings: project.settings, head: project.head,
        createdAt: project.createdAt, updatedAt: project.updatedAt, mediaCount: 0, poster: null, pendingChanges: 0, openNotes: 0 };
      set({ list: [summary, ...get().list.filter(p => p.id !== project.id)], listStatus: "ready" });
      return project;
    },
    async deleteProject(id) {
      await api.deleteProject(id);
      listRevision++;
      set({ list: get().list.filter((p) => p.id !== id) });
      if (get().current?.id === id) set({ current: null, status: "idle" });
    },

    current: null,
    trashedProject: null,
    status: "idle",
    error: null,
    async load(id, tries = 0) {
      // Whatever reads a project takes over from a wait to read one again, or to read its timeline again.
      dropReadAgain();
      dropHeadAgain();
      const request = ++projectLoad;
      const same = get().current?.id === id;
      if (!same) {
        set({ status: "loading", error: null, current: null, trashedProject: null });
      }
      const pending = { id, events: [] as WsEvent[], imports: [] as MediaAsset[] };
      opening = pending;
      try {
        // Another try at a failed read follows nothing: the project is followed already, and one the editor has
        // left meanwhile stays left.
        const subscribed = tries ? undefined : subscribeProject(id);
        if (subscribed) await subscribed;
        if (request !== projectLoad) return;
        const detail = await api.workspace(id);
        if (request !== projectLoad) return;
        versionLookup = undefined;
        const prev = same ? get().current : null;
        const needsHistory = !prev || !!prev.reviewStatus;
        set({
          status: "ready", error: null,
          current: {
            id, project: detail.project, timeline: detail.timeline, media: detail.project.media,
            changes: prev?.changes ?? [], notes: prev?.notes ?? [], learnings: prev?.learnings, tasks: prev?.tasks ?? [], renders: [],
            taskEvents: prev?.taskEvents ?? {}, loadRevision: request, historyRevision: (prev?.historyRevision ?? 0) + 1, reviewStatus: needsHistory ? "loading" : undefined,
          },
        });
        opening = undefined;
        for (const event of pending.events) get().applyEvent(event);
        for (const asset of pending.imports) get().upsertMedia(id, asset);

        // Token counts are secondary: a failed read leaves them out without blocking the edit history.
        void api.projectUsage(id, "task").then(usage => {
          if (request !== projectLoad) return;
          const loaded = Object.fromEntries(usage.groups.flatMap(({ key, ...totals }) => key ? [[key, totals]] : []));
          // Totals pushed by the socket while this was loading are newer.
          patch(id, d => ({ taskUsage: { ...loaded, ...d.taskUsage } }));
        }, () => undefined);

        // What waits in Learnings is secondary too. The engine's list is what waits now: after a reconnect, a rule it
        // no longer lists was saved while the socket was down, and one it sent back says why. Kept from before, either
        // would say Saving… for good. Only one that changed while this was read keeps its newer state.
        const held = get().current?.learnings ?? [];
        void api.learnings(id).then(({ learnings }) => {
          if (request !== projectLoad) return;
          patch(id, d => ({ learnings: mergeSinceLoad(learnings, held, d.learnings ?? []) }));
        }, () => undefined);

        // Make the monitor usable before reading older requests and decisions.
        // Snapshot-time edits arriving from the socket or the editor take precedence.
        const base = get().current!;
        try {
          const [changes, notes, tasks] = await Promise.all([api.changes(id), api.notes(id), api.tasks(id, undefined, "conversation")]);
          if (request !== projectLoad) return;
          patch(id, d => {
            const taskEvents = { ...d.taskEvents };
            const taskEventScopes = { ...d.taskEventScopes };
            for (const [taskId, events] of Object.entries(tasks.conversation ?? {})) {
              if (taskEventScopes[taskId] === "all") continue;
              taskEvents[taskId] = mergeTaskEvents(events, taskEvents[taskId] ?? []);
              taskEventScopes[taskId] = "conversation";
            }
            return {
              changes: mergeSinceLoad(changes.changes, base.changes, d.changes),
              notes: mergeSinceLoad(notes.notes, base.notes, d.notes),
              tasks: mergeSinceLoad(tasks.tasks, base.tasks, d.tasks),
              taskEvents, taskEventScopes,
              reviewStatus: undefined, reviewError: undefined,
            };
          });
        } catch (error) {
          if (request === projectLoad) patch(id, () => ({ reviewStatus: needsHistory ? "error" : undefined, reviewError: errorMessage(error) }));
          readAgainLater(id, request, tries);
        }
        // A reload follows a reconnect. Whatever Scarlet did while the socket was down is in no event the window got,
        // and a read of a run's steps that was out when the reload began is dropped, so each run's steps the pages
        // asked for are read again.
        if (request !== projectLoad || !same || askedEvents?.project !== id) return;
        for (const [taskId, scope] of Object.entries(askedEvents.scopes)) void get().loadTaskEvents(taskId, scope).catch(() => undefined);
      } catch (err) {
        if (request !== projectLoad) return;
        opening = undefined;
        let trashedProject: TrashedProject | null = null;
        if (err instanceof ScarletApiError && err.status === 404) {
          const trash = await api.trash().catch(() => null);
          if (request !== projectLoad) return;
          trashedProject = trash?.projects.find((project) => project.id === id) ?? null;
        }
        const message = errorMessage(err);
        set({ status: "error", error: message, trashedProject, current: trashedProject ? null : get().current });
        if (!trashedProject && get().current?.id === id) {
          for (const event of pending.events) get().applyEvent(event);
          for (const asset of pending.imports) get().upsertMedia(id, asset);
          patch(id, d => ({ reviewStatus: d.reviewStatus ? "error" : undefined, reviewError: message }));
          readAgainLater(id, request, tries);
        }
      }
    },
    async refreshHead(projectId = get().current?.id) {
      if (!projectId || get().current?.id !== projectId) return;
      const request = ++headLookup;
      const epoch = projectLoad;
      const detail = await api.workspace(projectId);
      if (request !== headLookup || epoch !== projectLoad || get().current?.id !== projectId) return;
      versionLookup = undefined;
      dropHeadAgain();
      patch(projectId, d => ({
        timeline: detail.timeline, versions: undefined, historyRevision: (d.historyRevision ?? 0) + 1, project: detail.project,
        headError: undefined,
      }));
    },
    async loadVersions() {
      const cur = get().current;
      if (!cur || cur.versions) return;
      if (versionLookup) return versionLookup;
      const request = api.versions(cur.id).then(({ versions }) => {
        if (versionLookup === request && get().current?.project.head === cur.project.head) patch(cur.id, () => ({ versions }));
      }).finally(() => { if (versionLookup === request) versionLookup = undefined; });
      versionLookup = request;
      return request;
    },
    applyEvent(ev) {
      if (opening && "projectId" in ev && opening.id === ev.projectId) {
        opening.events.push(ev);
        return;
      }
      const cur = get().current;
      if (ev.type === "render.settings.updated") {
        if (cur) patch(cur.id, d => ({ renderSettingsRevision: (d.renderSettingsRevision ?? 0) + 1 }));
        void get().refreshFullRenders();
        return;
      }
      if (!("projectId" in ev) || !cur || ev.projectId !== cur.id) return;
      switch (ev.type) {
        case "project.updated": {
          const headChanged = ev.project.head !== cur.project.head;
          patch(cur.id, () => ({ project: ev.project }));
          if (headChanged) void get().refreshHead(cur.id).catch(headUnread(cur.id, ev.project.head));
          break;
        }
        case "media.updated":
          patch(cur.id, (d) => ({ media: upsert(d.media, ev.media) }));
          break;
        case "media.removed":
          patch(cur.id, d => ({ media: d.media.filter(m => m.id !== ev.mediaId) }));
          break;
        case "media.previewReady":
          patch(cur.id, d => ({ sourcePreviewRevisions: { ...d.sourcePreviewRevisions,
            [ev.mediaId]: (d.sourcePreviewRevisions?.[ev.mediaId] ?? 0) + 1 } }));
          break;
        case "media.speakerProgress":
          patch(cur.id, d => ({ speakerProgress: Object.fromEntries(Object.entries(ev.active).map(([id, progress]) => {
            const last = d.speakerProgress?.[id];
            return [id, last?.phase === progress.phase && last.percent === progress.percent ? last : { ...progress, updatedAt: Date.now() }];
          })) }));
          break;
        case "change.updated":
          replaceChange(ev.change);
          break;
        case "note.updated":
          patch(cur.id, (d) => ({ notes: upsert(d.notes, ev.note) }));
          break;
        case "learning.updated":
          patch(cur.id, (d) => ({ learnings: upsert(d.learnings ?? [], ev.learning) }));
          break;
        case "render.updated":
          // The stream loads its own fragments. Their encoder progress has no project UI.
          if (ev.render.kind === "playback") break;
          patch(cur.id, (d) => ({ renders: upsert(d.renders, ev.render) }));
          break;
        case "task.updated":
          // A skill edit or a learning check runs from a project without being part of its conversation.
          if (isAsideTask(ev.task)) break;
          patch(cur.id, (d) => ({ tasks: upsert(d.tasks, ev.task) }));
          break;
        case "task.usage":
          patch(cur.id, (d) => ({ taskUsage: { ...d.taskUsage, [ev.taskId]: ev.usage } }));
          break;
        case "activity.added":
          if (cur.activity && !cur.activity.some((a) => a.id === ev.entry.id)) patch(cur.id, (d) => ({ activity: [ev.entry, ...(d.activity ?? [])] }));
          break;
        case "task.event": {
          const previous = cur.taskEvents[ev.taskId] ?? [];
          if (ev.event.id && previous.some((event) => event.id === ev.event.id)) break;
          const last = previous.at(-1);
          const events = ev.event.at && last?.at && Date.parse(ev.event.at) < Date.parse(last.at)
            ? mergeTaskEvents(previous, [ev.event])
            : [...previous, ev.event];
          patch(cur.id, (d) => ({ taskEvents: { ...d.taskEvents, [ev.taskId]: events } }));
          break;
        }
        default:
          break;
      }
    },

    async setThreadDone(threadId, done, revision) {
      const id = get().current?.id;
      if (!id) return;
      const { completedThreads } = await api.setThreadDone(id, threadId, done, revision);
      patch(id, d => {
        const updated = { ...d.project.completedThreads };
        if (completedThreads[threadId]) updated[threadId] = completedThreads[threadId]!;
        else delete updated[threadId];
        return { project: { ...d.project, completedThreads: updated } };
      });
    },
    async updateProject(body, projectId = get().current?.id) {
      if (!projectId) return;
      const cur = get().current;
      const before = cur?.id === projectId ? cur.project : undefined;
      const name = body.name;
      const renaming = before && name && name !== before.name;
      if (renaming) patch(projectId, () => ({ project: { ...before, name } }));
      try {
        const { project } = await api.updateProject(projectId, body);
        listRevision++;
        patch(projectId, () => ({ project }));
        // The library lists the latest edit first. A project whose video changed moves there now, not when the list is
        // next read. One that was renamed, archived or paused wasn't edited: its time and its place stay.
        const list = get().list, was = list.find(p => p.id === projectId);
        if (was) {
          const saved = { ...was, name: project.name, archived: project.archived, updatedAt: project.updatedAt, settings: project.settings };
          set({ list: saved.updatedAt === was.updatedAt ? list.map(p => p === was ? saved : p) : [saved, ...list.filter(p => p !== was)] });
        }
      } catch (err) {
        // A timeline or settings update can arrive during the request. Roll back only our pending name.
        if (renaming) patch(projectId, d => d.project.name === name && d.project.updatedAt === before.updatedAt
          ? { project: { ...d.project, name: before.name } } : {});
        throw err;
      }
    },

    async approve(changeId, spots, restoredCuts) {
      const cur = get().current;
      const prev = cur?.changes.find((c) => c.id === changeId);
      if (!cur || !prev) return undefined;
      const optimistic = restoredCuts ? undefined : { ...prev, state: "approved" as const };
      if (optimistic) replaceChange(optimistic);
      const res = await api.approveChange(changeId, spots, restoredCuts).catch(err => {
        if (optimistic && get().current?.changes.includes(optimistic)) replaceChange(prev);
        throw err;
      });
      if (get().current?.id !== cur.id) return res;
      replaceChange(res.change);
      if (res.task) patch(cur.id, (d) => ({ tasks: upsertAnswered(d.tasks, res.task!) }));
      patch(cur.id, () => ({ project: res.project }));
      await get().refreshHead(cur.id).catch(headUnread(cur.id, res.project.head));
      return res;
    },
    async historyEdit(version, action) {
      const cur = get().current;
      if (!cur?.project.head) return;
      const { project, change } = await api.historyEdit(cur.id, version, action, cur.project.head, cur.project.branch ?? "main");
      replaceChange(change);
      patch(cur.id, () => ({ project, versions: undefined }));
      await get().refreshHead(cur.id);
    },
    async switchBranch(name, from) {
      const cur = get().current;
      if (!cur?.project.head) return;
      const { project } = await api.switchBranch(cur.id, name, cur.project.head, cur.project.branch ?? "main", from);
      patch(cur.id, () => ({ project, versions: undefined }));
      await get().refreshHead(cur.id);
    },
    async unapprove(changeId) {
      const res = await api.unapproveChange(changeId);
      replaceChange(res.change);
      patch(res.project.id, () => ({ project: res.project }));
      await get().refreshHead(res.project.id);
    },
    async reject(changeId, reason) {
      const prev = get().current?.changes.find((c) => c.id === changeId);
      if (!prev) return;
      replaceChange({ ...prev, state: "rejected" });
      try {
        const { change } = await api.rejectChange(changeId, reason);
        replaceChange(change);
      } catch (err) {
        replaceChange(prev);
        throw err;
      }
    },
    async reopen(changeId) {
      const { change } = await api.reopenChange(changeId);
      replaceChange(change);
    },
    async revise(changeId, body) {
      const res = await api.reviseChange(changeId, body);
      replaceChange(res.change);
      patch(res.change.projectId, (d) => ({ notes: upsert(d.notes, res.note), tasks: res.task ? upsertAnswered(d.tasks, res.task) : d.tasks }));
      return res.task;
    },
    async loadChangeDiff(changeId) {
      const res = await api.change(changeId);
      replaceChange(res.change);
      return res.diff;
    },

    async requestRender(body) {
      const cur = get().current;
      if (!cur) throw new Error("No project loaded");
      const { render } = await api.requestRender(cur.id, body);
      patch(cur.id, (d) => ({
        // Keep a newer socket update if it arrived before the HTTP response.
        renders: selectRender(cur, render.id) === selectRender(d, render.id) ? upsert(d.renders, render) : d.renders,
      }));
      return render;
    },
    async refreshFullRenders() {
      const request = ++renderLookup;
      const cur = get().current;
      if (!cur?.project.head) return;
      patch(cur.id, () => ({ fullRenderKeys: undefined }));
      const context = fullRenderContext(cur.project);
      try {
        const { renders, fullRenderKeys } = await api.renders(cur.id, { kind: "full", version: "head" });
        const active = get().current;
        if (request !== renderLookup || !active || fullRenderContext(active.project) !== context || fullRenderKeys?.context !== context) return;
        patch(cur.id, (d) => {
          const returned = new Set(renders.map(render => render.id));
          let merged = d.renders.filter(r => !(r.state === "done" && r.version === cur.project.head && r.kind === "full" &&
            (r.key === fullRenderKeys.preview || r.key === fullRenderKeys.delivery) && !returned.has(r.id) && selectRender(cur, r.id) === r));
          for (const render of renders) {
            // Keep any update received over the socket during this lookup.
            if (selectRender(cur, render.id) === selectRender(d, render.id)) merged = upsert(merged, render);
          }
          return { fullRenderKeys, renders: merged };
        });
      } catch {
        // Playback uses segments until the engine confirms a compatible full render.
      }
    },
    async ensureRender(renderId) {
      const cur = get().current;
      const epoch = projectLoad;
      const key = JSON.stringify([epoch, renderId]);
      if (!cur || selectRender(cur, renderId) || renderLookups.has(key)) return;
      renderLookups.add(key);
      try {
        const { render } = await api.render(renderId);
        if (epoch !== projectLoad) return;
        patch(cur.id, (d) => selectRender(d, render.id) ? {} : { renders: upsert(d.renders, render) });
      } catch {
        /* missing render; the card shows "not rendered" */
      } finally {
        renderLookups.delete(key);
      }
    },

    async createNote(projectId, body) {
      const res = await api.createNote(projectId, body);
      patch(projectId, (d) => ({ notes: upsert(d.notes, res.note), tasks: res.task ? upsertAnswered(d.tasks, res.task) : d.tasks }));
      return res;
    },
    async createVoiceNote(projectId, blob, fields) {
      const res = await api.createVoiceNote(projectId, blob, fields);
      patch(projectId, (d) => ({ notes: upsert(d.notes, res.note), tasks: res.task ? upsertAnswered(d.tasks, res.task) : d.tasks }));
      return res;
    },
    async updateNote(noteId, body) {
      const prev = get().current?.notes.find((n) => n.id === noteId);
      if (!prev) return;
      patch(prev.projectId, (d) => ({ notes: upsert(d.notes, { ...prev, ...body, assignedTo: body.assignedTo ?? prev.assignedTo }) }));
      try {
        const { note } = await api.updateNote(noteId, body);
        patch(prev.projectId, (d) => ({ notes: upsert(d.notes, note) }));
      } catch (err) {
        patch(prev.projectId, (d) => ({ notes: upsert(d.notes, prev) }));
        throw err;
      }
    },
    async replyNote(noteId, text) {
      const { note } = await api.replyNote(noteId, text);
      patch(note.projectId, (d) => ({ notes: upsert(d.notes, note) }));
    },

    async approveLearning(learningId, skillId, runWith) {
      const projectId = get().current?.id;
      if (!projectId) return;
      const { learning } = await api.approveLearning(projectId, learningId, { ...runWith, ...(skillId && { skillId }) });
      // The socket may already have said it is saved.
      patch(projectId, (d) => ({ learnings: d.learnings?.some(l => l.id === learning.id && l.state === "saved") ? d.learnings : upsert(d.learnings ?? [], learning) }));
    },
    async reviseLearning(learningId, rule) {
      const projectId = get().current?.id;
      if (!projectId) return;
      const { learning } = await api.reviseLearning(projectId, learningId, { rule });
      patch(projectId, (d) => ({ learnings: upsert(d.learnings ?? [], learning) }));
    },
    async declineLearning(learningId) {
      const projectId = get().current?.id;
      if (!projectId) return;
      const { learning } = await api.declineLearning(projectId, learningId);
      patch(projectId, (d) => ({ learnings: upsert(d.learnings ?? [], learning) }));
    },

    async createTask(projectId, body) {
      const { task } = await api.createTask(projectId, body);
      // A project switch or a newer worker event can precede the creation response.
      patch(projectId, d => ({ tasks: d.tasks.some(t => t.id === task.id) ? d.tasks : [...d.tasks, task] }));
      return task;
    },
    async cancelTask(taskId) {
      const { task } = await api.cancelTask(taskId);
      patch(task.projectId, (d) => ({ tasks: upsert(d.tasks, task) }));
    },
    async retryTask(taskId, runWith) {
      const { task } = await api.retryTask(taskId, runWith);
      const current = get().current;
      if (current?.id !== task.projectId) return;
      // The new attempt can already have been claimed by the time the HTTP request returns.
      const tasks = current.tasks.map(t => t.id === taskId ? { ...t, retryTaskId: task.id } : t);
      patch(task.projectId, () => ({ tasks: tasks.some(t => t.id === task.id) ? tasks : [...tasks, task] }));
    },
    async continueWhenReady(taskId, on) {
      const { task, resumed } = await api.continueWhenReady(taskId, on);
      patch(task.projectId, (d) => ({ tasks: resumed ? upsertAnswered(upsert(d.tasks, task), resumed) : upsert(d.tasks, task) }));
    },
    async answerTask(taskId, text, skillIds) {
      const { task } = await api.answerTask(taskId, text, skillIds);
      patch(task.projectId, (d) => ({ tasks: upsertAnswered(d.tasks, task) }));
    },
    async holdForRewording(taskId, on) {
      const { task } = await api.holdForRewording(taskId, on);
      // Letting go of a hold lets Scarlet start the request, and so does saving its new words. The socket may have it
      // claimed before this answer says "queued": that answer must not put a running request back in the tray.
      patch(task.projectId, (d) => ({ tasks: upsertAnswered(d.tasks, task) }));
    },
    async startBeforeCalls(taskId) {
      const { task } = await api.startBeforeCalls(taskId);
      patch(task.projectId, (d) => ({ tasks: upsertAnswered(d.tasks, task) }));
    },
    async rewordTask(taskId, text, skillIds) {
      const { task } = await api.rewordTask(taskId, text, skillIds);
      patch(task.projectId, (d) => ({ tasks: upsertAnswered(d.tasks, task) }));
    },
    async loadTaskEvents(taskId, scope = "all") {
      const cur = get().current;
      const loaded = cur?.taskEventScopes?.[taskId];
      if (!cur || loaded === "all" || loaded === scope) return;
      const epoch = projectLoad;
      const key = JSON.stringify([epoch, taskId, scope]);
      const pending = eventLookups.get(key) ?? (scope === "conversation" ? eventLookups.get(JSON.stringify([epoch, taskId, "all"])) : undefined);
      if (pending) return pending;
      if (askedEvents?.project !== cur.id) askedEvents = { project: cur.id, scopes: {} };
      if (askedEvents.scopes[taskId] !== "all") askedEvents.scopes[taskId] = scope;
      const initialTask = cur.tasks.find(t => t.id === taskId);
      const request = api.task(taskId, scope).then(({ task, events }) => {
        if (epoch !== projectLoad) return;
        patch(cur.id, d => {
          if (d.taskEventScopes?.[taskId] === "all" && scope === "conversation") return {};
          return {
            tasks: d.tasks.find(t => t.id === taskId) === initialTask && JSON.stringify(initialTask) !== JSON.stringify(task)
              ? upsert(d.tasks, task) : d.tasks,
            taskEvents: { ...d.taskEvents, [taskId]: mergeTaskEvents(events, d.taskEvents[taskId] ?? []) },
            taskEventScopes: { ...d.taskEventScopes, [taskId]: scope },
          };
        });
      }).finally(() => eventLookups.delete(key));
      eventLookups.set(key, request);
      return request;
    },

    async transcribe(mediaId) {
      const { task } = await api.transcribe(mediaId);
      const current = get().current;
      if (current?.id !== task.projectId) return task;
      // The socket can be ahead of the HTTP response: by then the task may be waiting its turn, under way or finished.
      // The response's copy has no progress, and would turn "Waiting to transcribe" into a bar that runs for nothing.
      const newer = current.tasks.find((t) => t.id === task.id && (t.finishedAt || t.progress));
      if (newer) return newer;
      patch(task.projectId, (d) => ({ tasks: upsert(d.tasks, task) }));
      return task;
    },
    upsertMedia(projectId, media) {
      if (opening?.id === projectId) {
        opening.imports.push(media);
        return;
      }
      // Import responses describe the initial state. A socket event can already
      // have delivered progress or the finished asset before the response arrives.
      if (media.status === "ingesting" && get().current?.media.some((item) => item.id === media.id)) return;
      patch(projectId, (d) => ({ media: upsert(d.media, media) }));
    },
    async removeMedia(mediaId) {
      const projectId = get().current?.id;
      if (!projectId) return;
      await api.removeMedia(projectId, mediaId);
      // The socket says so as well. The row goes without waiting for it.
      patch(projectId, d => ({ media: d.media.filter(m => m.id !== mediaId) }));
    },
    async loadActivity(more) {
      const cur = get().current;
      if (!cur) return;
      const cursor = more ? cur.activity?.at(-1) : undefined;
      const { activity } = await api.activity(cur.id, { before: cursor?.createdAt, beforeId: cursor?.id, limit: 200 });
      patch(cur.id, (d) => ({ activity: more ? [...(d.activity ?? []), ...activity] : activity, activityComplete: activity.length < 200 }));
    },
    async importFromDavinci(otio) {
      const cur = get().current;
      if (!cur) throw new Error("No project loaded");
      const { change } = await api.importOtio(cur.id, otio);
      replaceChange(change);
      return change;
    },
    async checkout(version) {
      const cur = get().current;
      if (!cur) return;
      const { project } = await api.checkout(cur.id, version);
      patch(cur.id, () => ({ project }));
      await get().refreshHead(cur.id);
      const changes = await api.changes(cur.id);
      patch(cur.id, () => ({ changes: changes.changes }));
    },
  };
});

/** Convenience selectors. */
export function selectRender(d: ProjectData | null, id: string | null | undefined): Render | undefined {
  if (!d || !id) return undefined;
  return d.renders.find((r) => r.id === id);
}

export function selectHeadRender(d: Pick<ProjectData, "id" | "project" | "fullRenderKeys" | "renders"> | null, quality?: Render["quality"]): Render | undefined {
  if (!d || !d.project.head) return undefined;
  const keys = d.fullRenderKeys;
  if (!keys || keys.context !== fullRenderContext(d.project)) return undefined;
  const matchingKeys = quality ? [keys[quality]] : [keys.preview, keys.delivery];
  const full = d.renders.filter(r => r.projectId === d.id && r.version === d.project.head && r.kind === "full" &&
    !r.range && r.state !== "cancelled" && matchingKeys.includes(r.key));
  // Prefer done renders, then running, newest first.
  full.sort((a, b) => {
    const rank = (r: Render) => (r.state === "done" ? 0 : r.state === "running" || r.state === "queued" ? 1 : 2);
    const d1 = rank(a) - rank(b);
    if (d1 !== 0) return d1;
    return (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0);
  });
  return full[0];
}
