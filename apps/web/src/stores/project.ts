import { create } from "zustand";
import { fullRenderContext, isAsideTask, ScarletApiError } from "@scarlet/shared";
import type {
  ActivityEntry,
  ApproveResponse,
  CreateNoteRequest,
  CreateTaskRequest,
  FullRenderKeys,
  Learning,
  PictureMarks,
  ProjectSummary,
  Render,
  RenderRequest,
  RunChoice,
  SpeakerProgress,
  Task,
  TaskAttachment,
  TaskEvent,
  TrashedProject,
  UsageTotals,
  VersionSummary,
  WsEvent,
} from "@scarlet/shared";
import type { AudioTrackSelection, Change, MediaAsset, Note, Project, Timeline } from "@scarlet/timeline";
import { api, errorMessage } from "../lib/client";
import { parseTimestamp } from "../lib/format";
import { subscribeProject } from "../lib/realtime";
import { mergeTaskEvents } from "../lib/taskActivity";
import { failure, requestLog } from "../lib/requestLog";
import { createHeldProjectController, mergeSinceLoad, READ_AGAIN_AFTER_MS, sameVersion, upsert, upsertAnswered, upsertEditingTasks } from "./projectHelpers";

type Status = "idle" | "loading" | "ready" | "error";

export interface ProjectData {
  id: string;
  project: Project;
  timeline: Timeline | null;
  media: MediaAsset[];
  changes: Change[];
  notes: Note[];
  /** Rules Scarlet picked up from requests here, each until the editor has approved or declined it and it is saved. */
  learnings?: Learning[];
  /** AI-generated short titles for collapsed edit batches in the beta edits column, keyed by batch hash. */
  batchSummaries?: Record<string, string>;
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
  /** Oldest entry from the engine's last page. Live events are outside that page's pagination. */
  activityCursor?: ActivityEntry;
  activityComplete?: boolean;
}

interface ProjectState {
  list: ProjectSummary[];
  listStatus: Status;
  listError: string | null;
  /** `retry` is the editor asking again after a failure, which shows as loading. A refresh never does. */
  loadList(retry?: boolean): Promise<void>;
  createProject(body: { name: string; settings?: Partial<Project["settings"]> }): Promise<Project>;
  createSampleProject(): Promise<Project>;
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
  mergeBatchSummaries(projectId: string, summaries: Record<string, string>): void;

  setThreadDone(threadId: string, done: boolean, revision: string): Promise<void>;
  updateProject(body: { mediaPaused?: boolean; name?: string; archived?: boolean; settings?: Partial<Project["settings"]>; expectedFormat?: Pick<Project, "head" | "settings"> }, projectId?: string): Promise<void>;

  approve(changeId: string, spots?: number[], restoredCuts?: number[]): Promise<ApproveResponse | undefined>;
  historyEdit(version: string, action: "revert" | "restore"): Promise<void>;
  /** Put back what applied edits the editor rejected changed, on the engine. Answers with the version it made. */
  rejectEdits(threadId: string, head: string, edits: Parameters<typeof api.rejectEdits>[1]["edits"]): Promise<string>;
  /** Adjust an applied cut's edges directly on the engine. Answers with the version it made and whether the cut was removed whole. */
  adjustCut(threadId: string, head: string, cut: Parameters<typeof api.adjustCut>[1]["cut"], removed: Parameters<typeof api.adjustCut>[1]["removed"]): Promise<{ version: string; rejected: boolean }>;
  /** Adjust a non-cut applied edit's start/end edges directly on the engine (captions, overlays, zooms, dips, split edits). */
  adjustEdit(threadId: string, head: string, edit: Parameters<typeof api.adjustEdit>[1]["edit"], nextRange: Parameters<typeof api.adjustEdit>[1]["nextRange"]): Promise<{ version: string; rejected: boolean }>;
  /** Move one staged cut of a waiting dialogue pass directly, carrying over all other cuts and editor choices. */
  reviseStagedCut(changeId: string, index: number, body: Parameters<typeof api.reviseStagedCut>[2]): Promise<{ change: Change; index: number }>;
  revise(changeId: string, body: Parameters<typeof api.reviseChange>[1]): Promise<Task | undefined>;

  requestRender(body: Partial<RenderRequest>): Promise<Render>;
  ensureRender(renderId: string): Promise<void>;
  refreshFullRenders(): Promise<void>;

  createNote(projectId: string, body: CreateNoteRequest): Promise<{ note: Note; task?: Task }>;
  createVoiceNote(projectId: string, blob: Blob, fields: Parameters<typeof api.createVoiceNote>[2]): Promise<{ note: Note; task?: Task }>;

  /** Approve a rule for a skill. The save runs on the model chosen now. */
  approveLearning(learningId: string, skillId?: string, runWith?: RunChoice): Promise<void>;
  reviseLearning(learningId: string, rule: string): Promise<void>;
  declineLearning(learningId: string): Promise<void>;

  createTask(projectId: string, body: CreateTaskRequest): Promise<Task>;
  cancelTask(taskId: string, queuedOnly?: boolean): Promise<void>;
  stopEditing(projectId: string): Promise<void>;
  resumeEditing(projectId: string, runWith?: RunChoice): Promise<void>;
  /** Retry or resume a run. It runs on the model picked now. */
  retryTask(taskId: string, runWith?: RunChoice): Promise<void>;
  /** Finish a run that ended without its transcripts once they are ready, or stop waiting to. */
  continueWhenReady(taskId: string, on: boolean): Promise<void>;
  answerTask(taskId: string, text: string, skillIds?: string[], runWith?: RunChoice, files?: { attachments: TaskAttachment[]; pictureMarks?: PictureMarks }): Promise<void>;
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
  /** Choose which audio track (or all tracks mixed) Scarlet reads from a multi-track recording. */
  setMediaAudioTrack(mediaId: string, audioTrack: AudioTrackSelection): Promise<void>;
  /** Save what the editor says a file is and how to use it. An empty note takes it off. */
  setMediaNote(mediaId: string, note: string): Promise<void>;
  loadActivity(more?: boolean): Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get, store) => {
  let renderLookup = 0;
  let projectLoad = 0;
  let listRevision = 0;
  let listRequest: { client: typeof api; job: Promise<void> } | undefined;
  const editingRequests = new Map<string, Promise<void>>();
  let opening: { id: string; events: WsEvent[]; imports: MediaAsset[] } | undefined;
  const eventLookups = new Map<string, Promise<void>>();
  /** The runs whose steps the open project's pages have asked for, each with the fullest read asked. */
  let askedEvents: { project: string; scopes: Record<string, "all" | "conversation"> } | undefined;
  let headLookup = 0;
  /** The read of the open project's new working cut that is out, and the one more a burst of new ones asked for. */
  let headRead: { projectId: string; job: Promise<void>; again?: Promise<void> } | undefined;
  const heldProject = createHeldProjectController();
  const { heldFor, showHeld, takeProject } = heldProject;
  const renderLookups = new Set<string>();
  let versionLookup: Promise<void> | undefined;
  let activityRead: { projectId: string; entries: Map<string, ActivityEntry> } | undefined;
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
    if (headRead && current?.id !== headRead.projectId) headRead = undefined;
    if (askedEvents && current?.id !== askedEvents.project) askedEvents = undefined;
    if (activityRead && current?.id !== activityRead.projectId) activityRead = undefined;
  });
  const patch = (projectId: string, fn: (d: ProjectData) => Partial<ProjectData>) => {
    const cur = get().current;
    if (cur?.id === projectId) set({ current: { ...cur, ...fn(cur) } });
  };
  const refreshListActivity = (projectId: string) => {
    // A Projects read may have counted activity from before the request changed it.
    if (listRequest || get().list.some(p => p.id === projectId)) {
      listRevision++;
      void get().loadList();
    }
  };
  const changeEditing = (projectId: string, send: () => Promise<{ project: Project; tasks: Task[] }>) => {
    // The socket can show Continue before the Stop response arrives. Keep the two actions in order.
    const previous = editingRequests.get(projectId);
    const update = async () => {
      const before = get().current?.id === projectId ? get().current!.tasks : [];
      const { project, tasks } = await send();
      patch(projectId, d => ({
        project: takeProject(d, project) ?? d.project,
        tasks: tasks.length ? upsertEditingTasks(before, d.tasks, tasks) : d.tasks,
      }));
      refreshListActivity(projectId);
    };
    const request = (previous ? previous.then(update, update) : update()).finally(() => {
      if (editingRequests.get(projectId) === request) editingRequests.delete(projectId);
    });
    editingRequests.set(projectId, request);
    return request;
  };
  const replaceChange = (change: Change) => patch(change.projectId, d => {
    const changes = upsert(d.changes, change);
    const addedVersion = (d.versions || versionLookup) && d.changes.find(c => c.id === change.id)?.toVersion !== change.toVersion;
    if (!addedVersion) return { changes };
    versionLookup = undefined;
    return { changes, versions: undefined, historyRevision: (d.historyRevision ?? 0) + 1 };
  });
  /** Keep the task a request about it answers with, unless the socket already has it further on. */
  const taskAnswered = async (request: Promise<{ task: Task }>, event = "answered", fields?: Record<string, unknown>) => {
    const { task } = await logged(event, request, fields ?? {});
    patch(task.projectId, (d) => ({ tasks: upsertAnswered(d.tasks, task) }));
  };
  /** Keep a new note and the request it started. */
  const noteCreated = (projectId: string, res: { note: Note; task?: Task }) => {
    patch(projectId, (d) => ({ notes: upsert(d.notes, res.note), tasks: res.task ? upsertAnswered(d.tasks, res.task) : d.tasks }));
    return res;
  };
  /**
   * A call to the engine about a request, in the app log as what it made (`created task=…`) or why it failed. The
   * `[api]` line names the route; this one names the request, so the two read together.
   */
  const logged = async <T extends { task?: { id: string } }>(event: string, call: Promise<T>, fields: Record<string, unknown>) => {
    try {
      const result = await call;
      requestLog(event, { ...fields, task: result.task?.id ?? fields.task });
      return result;
    } catch (error) {
      requestLog(`${event}-failed`, { ...fields, ...failure(error) }, "warn");
      throw error;
    }
  };
  /** Show the working cut an edit of the history made. The list of versions it changed is read again when next asked for. */
  const showRewritten = (projectId: string, project: Project) => patch(projectId, d => {
    const shown = takeProject(d, project);
    return shown ? { project: shown, versions: undefined } : {};
  });
  /** Send a change to one of the open project's learnings, and keep the learning as the engine answers. */
  const learningChanged = async (send: (projectId: string) => Promise<{ learning: Learning }>) => {
    const projectId = get().current?.id;
    if (!projectId) return;
    const { learning } = await send(projectId);
    patch(projectId, (d) => ({ learnings: upsert(d.learnings ?? [], learning) }));
  };
  /** Read the open project's working cut and its timeline anew, after the head moved. */
  const readHead = async (projectId: string) => {
    const before = get().current;
    if (before?.id !== projectId) return;
    heldFor(before);
    const readAt = heldProject.tick();
    const request = ++headLookup;
    const epoch = projectLoad;
    const detail = await api.workspace(projectId);
    if (request !== headLookup || epoch !== projectLoad || get().current?.id !== projectId) return;
    versionLookup = undefined;
    dropHeadAgain();
    patch(projectId, d => {
      const h = heldFor(d);
      const project = takeProject(d, detail.project, readAt);
      return { ...(project && { project }),
        ...(detail.project.head === h.saved.head && {
          timeline: sameVersion(d.timeline, detail.timeline), versions: undefined,
          historyRevision: (d.historyRevision ?? 0) + 1, headError: undefined,
        }) };
    });
  };
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
      const summary: ProjectSummary = { id: project.id, name: project.name, settings: project.settings, head: project.head, mediaPaused: project.mediaPaused,
        createdAt: project.createdAt, updatedAt: project.updatedAt, mediaCount: 0, poster: null, pendingChanges: 0, openNotes: 0 };
      set({ list: [summary, ...get().list.filter(p => p.id !== project.id)], listStatus: "ready" });
      return project;
    },
    async createSampleProject() {
      const { project } = await api.createSampleProject();
      listRevision++;
      const summary: ProjectSummary = { id: project.id, name: project.name, settings: project.settings, head: project.head, mediaPaused: project.mediaPaused,
        createdAt: project.createdAt, updatedAt: project.updatedAt, mediaCount: project.media.length, poster: null, pendingChanges: 0, openNotes: 0 };
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
      // A read of the working cut that is out was asked before this one: its answer is dropped, so none waits on it.
      headRead = undefined;
      const request = ++projectLoad;
      const same = get().current?.id === id;
      if (!same) {
        set({ status: "loading", error: null, current: null, trashedProject: null });
      }
      const pending = { id, events: [] as WsEvent[], imports: [] as MediaAsset[] };
      opening = pending;
      // What arrived while the project was being read is applied on top of the read.
      const replayPending = () => {
        for (const event of pending.events) get().applyEvent(event);
        for (const asset of pending.imports) get().upsertMedia(id, asset);
      };
      try {
        // Another try at a failed read follows nothing: the project is followed already, and one the editor has
        // left meanwhile stays left.
        const subscribed = tries ? undefined : subscribeProject(id);
        if (subscribed) await subscribed;
        if (request !== projectLoad) return;
        const readAt = heldProject.tick();
        const detail = await api.workspace(id);
        if (request !== projectLoad) return;
        versionLookup = undefined;
        const prev = same ? get().current : null;
        const needsHistory = !prev || !!prev.reviewStatus;
        // A fresh read replaces the snapshot held. A rename or a filing still on its way stays on top of it.
        const project = heldProject.resetOnLoad(id, detail.project, readAt, !!prev);
        set({
          status: "ready", error: null,
          current: {
            id, project, timeline: sameVersion(prev?.timeline, detail.timeline), media: detail.project.media,
            changes: prev?.changes ?? [], notes: prev?.notes ?? [], learnings: prev?.learnings, tasks: prev?.tasks ?? [], renders: [],
            // A reconnect keeps the token counts shown until the fresh read arrives: a total only climbs.
            taskUsage: prev?.taskUsage,
            taskEvents: prev?.taskEvents ?? {}, loadRevision: request, historyRevision: (prev?.historyRevision ?? 0) + 1, reviewStatus: needsHistory ? "loading" : undefined,
          },
        });
        opening = undefined;
        replayPending();

        // Token counts are secondary: a failed read leaves them out without blocking the edit history.
        void api.projectUsage(id, "task").then(usage => {
          if (request !== projectLoad) return;
          const loaded = Object.fromEntries(usage.groups.flatMap(({ key, ...totals }) => key ? [[key, totals]] : []));
          // A total only climbs: whichever of the read and the one held (kept from before, or pushed by the socket since) is larger is newer.
          patch(id, d => {
            const taskUsage = { ...loaded };
            for (const [key, held] of Object.entries(d.taskUsage ?? {})) {
              if (!taskUsage[key] || held.totalTokens >= taskUsage[key].totalTokens) taskUsage[key] = held;
            }
            return { taskUsage };
          });
        }, () => undefined);

        // What waits in Learnings is secondary too. The engine's list is what waits now: after a reconnect, a rule it
        // no longer lists was saved while the socket was down, and one it sent back says why. Kept from before, either
        // would say Saving… for good. Only one that changed while this was read keeps its newer state.
        const heldLearnings = get().current?.learnings ?? [];
        void api.learnings(id).then(({ learnings }) => {
          if (request !== projectLoad) return;
          patch(id, d => ({ learnings: mergeSinceLoad(learnings, heldLearnings, d.learnings ?? []) }));
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
          replayPending();
          patch(id, d => ({ reviewStatus: d.reviewStatus ? "error" : undefined, reviewError: message }));
          readAgainLater(id, request, tries);
        }
      }
    },
    async refreshHead(projectId = get().current?.id) {
      if (!projectId || get().current?.id !== projectId) return;
      // One read at a time. A burst of new working cuts while one is out reads once more after it, and every caller
      // in the burst waits for that read: it began after what each of them saw.
      const out = headRead?.projectId === projectId ? headRead : undefined;
      if (out) return out.again ??= out.job.catch(() => undefined).then(() => {
        if (headRead === out) headRead = undefined;
        return get().refreshHead(projectId);
      });
      const read = { projectId, job: readHead(projectId) } as NonNullable<typeof headRead>;
      headRead = read;
      try {
        await read.job;
      } finally {
        if (headRead === read && !read.again) headRead = undefined;
      }
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
          const project = takeProject(cur, ev.project);
          if (!project) break;
          const headChanged = project.head !== cur.project.head;
          patch(cur.id, () => ({ project }));
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
        case "batch_summary.updated":
          patch(cur.id, (d) => (d.batchSummaries?.[ev.key] === ev.title
            ? {}
            : { batchSummaries: { ...d.batchSummaries, [ev.key]: ev.title } }));
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
          if (activityRead?.projectId === cur.id) activityRead.entries.set(ev.entry.id, ev.entry);
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

    mergeBatchSummaries(projectId, summaries) {
      const entries = Object.entries(summaries);
      if (!entries.length) return;
      patch(projectId, (d) => {
        const prev = d.batchSummaries;
        if (prev && entries.every(([k, v]) => prev[k] === v)) return {};
        return { batchSummaries: { ...prev, ...summaries } };
      });
    },

    async setThreadDone(threadId, done, revision) {
      const before = get().current;
      if (!before) return;
      const { id } = before;
      const { completedThreads, project } = await api.setThreadDone(id, threadId, done, revision);
      let headChanged = false;
      patch(id, d => {
        const h = heldFor(d);
        if (project) {
          const head = h.saved.head;
          // Media has its own live state and can change without advancing the project row revision.
          const shown = takeProject(d, d.media === before.media ? project : { ...project, media: d.media });
          headChanged = !!shown && project.head !== head;
          return shown ? { project: shown } : {};
        }
        // An older engine confirms only the filing. It stays on top of any snapshot read before it.
        h.filings.set(threadId, { value: completedThreads[threadId] || undefined, at: heldProject.tick() });
        return { project: showHeld(h) };
      });
      if (headChanged && project) void get().refreshHead(id).catch(headUnread(id, project.head));
    },
    async updateProject(body, projectId = get().current?.id) {
      if (!projectId) return;
      const cur = get().current;
      const before = cur?.id === projectId ? cur.project : undefined;
      const name = body.name;
      const rename = before && name && name !== before.name ? { name } : undefined;
      if (rename) patch(projectId, d => {
        const h = heldFor(d);
        h.rename = rename;
        return { project: showHeld(h) };
      });
      try {
        const { project } = await api.updateProject(projectId, body);
        listRevision++;
        let savedProject = project, stale = false, heldHead: string | null | undefined;
        patch(projectId, d => {
          const h = heldFor(d);
          heldHead = h.saved.head;
          if (h.rename === rename) h.rename = undefined;
          const shown = takeProject(d, project);
          stale = !shown;
          savedProject = h.saved;
          return { project: shown ?? showHeld(h) };
        });
        // The answer can be older than a head the socket brought meanwhile: when the two disagree, the engine says which is
        // current. A read that fails is tried again, as after an undo.
        if (!stale && heldHead !== undefined && heldHead !== project.head) {
          void get().refreshHead(projectId).catch(headUnread(projectId, get().current?.project.head));
        }
        // The library lists the latest edit first. A project whose video changed moves there now, not when the list is
        // next read. One that was renamed, archived or paused wasn't edited: its time and its place stay.
        const list = get().list, was = list.find(p => p.id === projectId);
        if (was) {
          const saved = { ...was, name: savedProject.name, archived: savedProject.archived, mediaPaused: savedProject.mediaPaused,
            updatedAt: savedProject.updatedAt, settings: savedProject.settings };
          set({ list: saved.updatedAt === was.updatedAt ? list.map(p => p === was ? saved : p) : [saved, ...list.filter(p => p !== was)] });
        }
      } catch (err) {
        // A timeline or settings update can arrive during the request. Roll back only our pending name.
        if (rename) patch(projectId, d => {
          const h = heldFor(d);
          if (h.rename !== rename) return {};
          h.rename = undefined;
          return { project: showHeld(h) };
        });
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
      patch(cur.id, d => {
        const project = takeProject(d, res.project);
        return project ? { project } : {};
      });
      const head = get().current?.project.head;
      await get().refreshHead(cur.id).catch(headUnread(cur.id, head));
      return res;
    },
    async historyEdit(version, action) {
      const cur = get().current;
      if (!cur?.project.head) return;
      const { project, change } = await api.historyEdit(cur.id, version, action, cur.project.head, cur.project.branch ?? "main");
      replaceChange(change);
      showRewritten(cur.id, project);
      // The undo went through. A timeline that can't be read at once is read again, as after an approval.
      await get().refreshHead(cur.id).catch(headUnread(cur.id, get().current?.project.head));
    },
    async rejectEdits(threadId, head, edits) {
      const cur = get().current;
      if (!cur) throw new Error("No project is open.");
      const { project, change } = await api.rejectEdits(cur.id, { expectedHead: head, branch: cur.project.branch ?? "main", threadId, edits });
      replaceChange(change);
      showRewritten(cur.id, project);
      void get().refreshHead(cur.id).catch(headUnread(cur.id, get().current?.project.head));
      return change.appliedVersion ?? change.toVersion;
    },
    async adjustCut(threadId, head, cut, removed) {
      const cur = get().current;
      if (!cur) throw new Error("No project is open.");
      const { project, change } = await api.adjustCut(cur.id, { expectedHead: head, branch: cur.project.branch ?? "main", threadId, cut, removed });
      replaceChange(change);
      showRewritten(cur.id, project);
      void get().refreshHead(cur.id).catch(headUnread(cur.id, get().current?.project.head));
      return { version: change.appliedVersion ?? change.toVersion, rejected: !!change.rejects };
    },
    async adjustEdit(threadId, head, edit, nextRange) {
      const cur = get().current;
      if (!cur) throw new Error("No project is open.");
      const { project, change } = await api.adjustEdit(cur.id, { expectedHead: head, branch: cur.project.branch ?? "main", threadId, edit, nextRange });
      replaceChange(change);
      showRewritten(cur.id, project);
      void get().refreshHead(cur.id).catch(headUnread(cur.id, get().current?.project.head));
      return { version: change.appliedVersion ?? change.toVersion, rejected: !!change.rejects };
    },
    async reviseStagedCut(changeId, index, body) {
      const res = await api.reviseStagedCut(changeId, index, body);
      const cur = get().current;
      if (cur && cur.id === res.change.projectId) {
        patch(cur.id, d => ({
          changes: upsert(d.changes.map(c => c.id === changeId && c.state === "ready" ? { ...c, state: "rejected" as const, replacedBy: res.change.id } : c), res.change),
        }));
      } else {
        replaceChange(res.change);
      }
      return { change: res.change, index: res.index ?? index };
    },
    async revise(changeId, body) {
      const res = await logged("revision-created", api.reviseChange(changeId, body),
        { change: changeId, chars: body.text?.length, voice: body.voiceTranscript ? true : undefined });
      replaceChange(res.change);
      noteCreated(res.change.projectId, res);
      return res.task;
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
      return noteCreated(projectId, await logged("note-created", api.createNote(projectId, body), { project: projectId, chars: body.text?.length }));
    },
    async createVoiceNote(projectId, blob, fields) {
      return noteCreated(projectId, await logged("voice-note-created", api.createVoiceNote(projectId, blob, fields), { project: projectId, bytes: blob.size }));
    },

    async approveLearning(learningId, skillId, runWith) {
      const projectId = get().current?.id;
      if (!projectId) return;
      const { learning } = await api.approveLearning(projectId, learningId, { ...runWith, ...(skillId && { skillId }) });
      // The socket may already have said it is saved.
      patch(projectId, (d) => ({ learnings: d.learnings?.some(l => l.id === learning.id && l.state === "saved") ? d.learnings : upsert(d.learnings ?? [], learning) }));
    },
    async reviseLearning(learningId, rule) {
      return learningChanged(projectId => api.reviseLearning(projectId, learningId, { rule }));
    },
    async declineLearning(learningId) {
      return learningChanged(projectId => api.declineLearning(projectId, learningId));
    },

    async createTask(projectId, body) {
      const context = body.context as { threadId?: string; changeId?: string; attachments?: unknown[]; time?: number } | undefined;
      const { task } = await logged("created", api.createTask(projectId, body), {
        project: projectId, kind: body.kind ?? "edit", agent: body.agent, model: body.model, chars: body.instruction.length,
        thread: context?.threadId, change: context?.changeId, files: context?.attachments?.length || undefined,
        at: context?.time, voice: body.voiceTranscript ? true : undefined,
      });
      // A project switch or a newer worker event can precede the creation response.
      patch(projectId, d => ({ tasks: d.tasks.some(t => t.id === task.id) ? d.tasks : [...d.tasks, task] }));
      return task;
    },
    async cancelTask(taskId, queuedOnly) {
      const { task } = await logged("cancelled", api.cancelTask(taskId, queuedOnly), { task: taskId, queuedOnly: queuedOnly || undefined });
      patch(task.projectId, (d) => ({ tasks: upsert(d.tasks, task) }));
      refreshListActivity(task.projectId);
    },
    stopEditing(projectId) {
      return changeEditing(projectId, () => api.stopEditing(projectId));
    },
    resumeEditing(projectId, runWith) {
      return changeEditing(projectId, () => runWith ? api.resumeEditing(projectId, runWith) : api.resumeEditing(projectId));
    },
    async retryTask(taskId, runWith) {
      const { task } = await logged("retried", api.retryTask(taskId, runWith), { retryOf: taskId, agent: runWith?.agent, model: runWith?.model });
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
    async answerTask(taskId, text, skillIds, runWith, files) {
      // Files attached to the answer go with it. Without any, the call is as it always was.
      const fields = { task: taskId, chars: text.length, files: files?.attachments.length || undefined, agent: runWith?.agent, model: runWith?.model };
      if (files) return taskAnswered(api.answerTask(taskId, text, skillIds, runWith, files), "answered", fields);
      return taskAnswered(runWith ? api.answerTask(taskId, text, skillIds, runWith) : api.answerTask(taskId, text, skillIds), "answered", fields);
    },
    async holdForRewording(taskId, on) {
      // Letting go of a hold lets Scarlet start the request, and so does saving its new words. The socket may have it
      // claimed before this answer says "queued": that answer must not put a running request back in the tray.
      return taskAnswered(api.holdForRewording(taskId, on), on ? "held-for-rewording" : "released-from-rewording", { task: taskId });
    },
    async startBeforeCalls(taskId) {
      return taskAnswered(api.startBeforeCalls(taskId), "started-before-calls", { task: taskId });
    },
    async rewordTask(taskId, text, skillIds) {
      return taskAnswered(api.rewordTask(taskId, text, skillIds), "reworded", { task: taskId, chars: text.length });
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
    async setMediaNote(mediaId, note) {
      const projectId = get().current?.id;
      if (!projectId) return;
      const { media } = await api.setMediaNote(mediaId, note);
      patch(projectId, d => ({ media: upsert(d.media, media) }));
    },
    async setMediaAudioTrack(mediaId, audioTrack) {
      const projectId = get().current?.id;
      if (!projectId) return;
      const { media } = await api.setMediaAudioTrack(mediaId, audioTrack);
      patch(projectId, d => ({ media: upsert(d.media, media) }));
    },
    async loadActivity(more) {
      const cur = get().current;
      if (!cur) return;
      const cursor = more ? cur.activityCursor : undefined;
      const pending = cursor ? undefined : { projectId: cur.id, entries: activityRead?.entries ?? new Map<string, ActivityEntry>() };
      if (pending) activityRead = pending;
      try {
        const { activity } = await api.activity(cur.id, { before: cursor?.createdAt, beforeId: cursor?.id, limit: 200 });
        if (pending && activityRead !== pending) return;
        // Events that arrive before the first page can also be in the snapshot. Merge by ID and use the engine's order.
        patch(cur.id, d => {
          if (cursor && d.activityCursor !== cursor) return {};
          const held = pending ? [...pending.entries.values()] : d.activity ?? [];
          const entries = held.length
            ? [...new Map([...held, ...activity].map(entry => [entry.id, entry])).values()]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
            : activity;
          return { activity: entries, activityCursor: activity.at(-1) ?? cursor, activityComplete: activity.length < 200 };
        });
      } finally {
        if (pending && activityRead === pending) activityRead = undefined;
      }
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
    return parseTimestamp(b.createdAt) - parseTimestamp(a.createdAt);
  });
  return full[0];
}
