/**
 * Minimal typed HTTP client for the Scarlet API. Works in Node 22+ and
 * browsers (uses global fetch). Used by the web UI, MCP server and agent host.
 */
import type { EditReviewRequest } from "./telemetry.js";
import type { z } from "zod/v3";
import { requireSecureEngineUrl } from "./engineTransport.js";
import type { TranscriptSearchResult } from "./transcriptSearch.js";
import type { ThreadEdit } from "./threadTimeline.js";
import type { StorageCleanup, StorageProject } from "./storage.js";
import type { AcousticWordsRequest, DialogueRangeRequest, DialogueScanRequest, DialogueWindowRequest, DialogueDetections, SourceAudioRequest, SoundPictureRequest, SoundPictureLayout, SheetRequest, TimelinePicturesRequest, InspectionReviewRequest, InspectionResult, PictureActivityRequest, PictureActivityWindow, RepeatAuditRequest, RepeatAuditResult } from "./inspection.js";
import type { Author, Change, CutAssessment, CutReview, MediaAsset, Note, Project, Timeline, TimelineDiff, TimeRange, Transcript, TranscriptWord } from "@scarlet/timeline";
import type {
  ActivityEntry,
  KeepEditsRequest,
  UnkeepEditsRequest,
  KeptEdit,
  AgentHost,
  ApproveResponse,
  TrashedProject,
  CompleteTaskRequest,
  CreateNoteRequest,
  CreateTaskRequest,
  RewordTaskRequest,
  FullRenderKeys,
  PlaybackCacheStatus,
  SourceCacheStatus,
  ProjectDetail,
  ProjectSummary,
  ProposeChangeRequest,
  Render,
  RenderFileInfo,
  RenderRequest,
  ReviseRequest,
  ServerSettings,
  Skill,
  SkillVersion,
  GraphicRenderResponse,
  SaveStyleGuideRequest,
  TaskAttachment,
  RecordTaskUsageRequest,
  Task,
  TaskEvent,
  TaskPrompt,
  TaskSkillDraft,
  EditSkillRequest,
  ApproveLearningRequest,
  ReviseLearningRequest,
  RunChoice,
  Learning,
  SuggestLearningRequest,
  UpdateNoteRequest,
  UsageGroupBy,
  UsageResponse,
  UpsertSkillRequest,
  User,
  VersionSummary,
  WaveformResponse,
  RetakeGroup,
  DialogueCutsRequest,
  JoinCrossfades,
  FlagEditRequest,
  CutChoicesRequest,
  StagedCutRevision,
  LocalModelStatus,
  TelemetryUnavailable,
  HandoffResponse,
} from "./api.js";

/**
 * File extension for a recorded clip. Chromium (Windows) records webm/opus;
 * Safari's WebKit (macOS) records mp4/aac. Transcription providers go by the
 * extension, so it has to match what was actually recorded.
 */
function audioExt(audio: Blob): string {
  const type = audio.type.toLowerCase();
  if (type.includes("mp4") || type.includes("aac") || type.includes("m4a")) return ".m4a";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg")) return ".mp3";
  return ".webm";
}

/** A query string from the fields that are set. */
const query = (q: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

/** Route IDs are single opaque segments. URL parsers normalize even encoded dot segments. */
export function apiPathId(id: string): string {
  if (!id || id === "." || id === ".." || /[/\\?#%\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Invalid resource ID");
  }
  return encodeURIComponent(id);
}

export class ScarletApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScarletApiError";
  }
}

export interface ClientOptions {
  baseUrl: string; // e.g. http://localhost:4000
  token?: string | (() => string | undefined);
  fetch?: typeof fetch;
  /** Let a client trace failures after the response headers arrive. */
  readResponse?: (response: Response) => Promise<string>;
  /** Allow editor thumbnails to sample a source's prepared preview. */
  previewFrames?: boolean;
}

/** A host snapshots this identity when it claims the task. Reconnecting must retain the original start. */
export interface TaskAttempt { taskId: string; startedAt?: string }
export const REQUEST_ID_HEADER = "X-Scarlet-Request-Id";

/** The native webview can use an origin where randomUUID is unavailable. */
export function newRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
export const TASK_HEADER = "X-Scarlet-Task";
export const ATTEMPT_HEADER = "X-Scarlet-Task-Started-At";

type ThreadEdits = { version: string | null; edits: ThreadEdit[] };
type ThreadEditLists = { version: string | null; lists: Record<string, ThreadEdit[]>; failed?: Record<string, string> };
type ThreadEditBatch = { ids: Set<string>; read: Promise<ThreadEditLists> };

export class ScarletClient {
  private readonly baseUrl: string;
  private readonly tokenSource?: string | (() => string | undefined);
  private readonly fetchImpl: typeof fetch;
  private readonly readResponse: (response: Response) => Promise<string>;
  private readonly previewFrames: boolean;

  private readonly editBatches = new Map<string, ThreadEditBatch>();

  private readonly projectScope?: string;

  constructor(opts: ClientOptions, projectId?: string, private readonly attempt?: TaskAttempt) {
    this.projectScope = projectId === undefined ? undefined : apiPathId(projectId);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.token) requireSecureEngineUrl(this.baseUrl);
    this.tokenSource = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.readResponse = opts.readResponse ?? (response => response.text());
    this.previewFrames = opts.previewFrames ?? false;
  }

  /** Bind individual MCP resource lookups and mutations to their owning project. */
  forProject(projectId: string, attempt = this.attempt): ScarletClient {
    return new ScarletClient({ baseUrl: this.baseUrl, token: this.tokenSource, fetch: this.fetchImpl, readResponse: this.readResponse, previewFrames: this.previewFrames }, projectId, attempt);
  }

  async withResource<T>(collection: "notes" | "media" | "changes" | "renders" | "tasks", id: string, request: (path: string) => Promise<T>): Promise<T> {
    const path = `/${collection}/${apiPathId(id)}`;
    if (!this.projectScope) return request(path);
    const project = `/projects/${this.projectScope}`;
    try {
      return await request(project + path);
    } catch (err) {
      // Standalone MCP can connect to an older engine. Only its explicit missing-route
      // response permits the legacy route, after checking the project's own listing.
      if (!(err instanceof ScarletApiError && err.status === 404 && err.code === "not_found" &&
          ["GET", "POST", "PATCH"].some(method => err.message.startsWith(`no route for ${method} /api${project}${path}`)))) throw err;
    }
    const listed = await this.get<Record<string, { id: string }[]>>(`${project}/${collection}`);
    if (!listed[collection]?.some(row => row.id === id)) {
      throw new ScarletApiError(404, "project_resource_missing", "Resource not found in this project");
    }
    return request(path);
  }

  get token(): string | undefined {
    return typeof this.tokenSource === "function" ? this.tokenSource() : this.tokenSource;
  }

  url(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  /** Absolute URL for a media/render file, with the token as a query param for <video src>. */
  fileUrl(path: string): string {
    const t = this.token;
    return `${this.url(path)}${t ? `?token=${encodeURIComponent(t)}` : ""}`;
  }

  wsUrl(): string {
    const http = new URL(this.baseUrl);
    http.protocol = http.protocol === "https:" ? "wss:" : "ws:";
    const t = this.token;
    return `${http.origin}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`;
  }

  async request<T>(method: string, path: string, body?: unknown, init: RequestInit = {},
    readBinary?: (data: ArrayBuffer) => T): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.headers) new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const callerAuthorization = headers.authorization !== undefined;
    if (callerAuthorization) requireSecureEngineUrl(this.baseUrl);
    if (this.attempt) {
      headers[TASK_HEADER] = this.attempt.taskId;
      if (this.attempt.startedAt) headers[ATTEMPT_HEADER] = this.attempt.startedAt;
    }
    const t = this.token;
    if (t) {
      delete headers.authorization;
      headers.Authorization = `Bearer ${t}`;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      delete headers["content-type"];
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.fetchImpl(this.url(path), { ...init, method, headers, body: payload,
      ...((t || callerAuthorization) && { redirect: "error" }) });
    if (res.status === 204) return undefined as T;
    if (readBinary && res.ok && res.headers.get("Content-Type") === "application/octet-stream") {
      return readBinary(await res.arrayBuffer());
    }
    const text = await this.readResponse(res);
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // A reply that claims success without JSON (a proxy's page, another program on the port) reaches the caller as nothing.
      // Say so here, by route alone: the query and the reply can hold what the editor typed.
      if (res.ok) console.warn(`[scarlet] [api] ${method} ${path.split("?")[0]}: ${res.status} reply was not JSON`);
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new ScarletApiError(res.status, err?.code ?? "http_error", err?.message ?? (text || res.statusText), err?.details);
    }
    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }

  // Auth
  me() {
    return this.get<{ user: User }>("/auth/me");
  }

  // Projects
  projects() {
    return this.get<{ projects: ProjectSummary[] }>("/projects");
  }
  createProject(body: { name: string; settings?: Partial<Project["settings"]> }) {
    return this.post<{ project: Project }>("/projects", body);
  }
  project(id: string) {
    return this.get<ProjectDetail>(`/projects/${id}`);
  }
  projectInfo(id: string) {
    return this.get<Pick<ProjectDetail, "project">>(`/projects/${apiPathId(id)}?view=project`);
  }
  projectHeader(id: string) {
    return this.get<{ project: Pick<Project, "id" | "head" | "settings"> }>(`/projects/${apiPathId(id)}?view=header`);
  }
  workspace(id: string) {
    return this.get<Pick<ProjectDetail, "project" | "timeline">>(`/projects/${id}?view=workspace`);
  }
  /** Opening the workspace asks for many threads in the same turn. Share the engine's project history
   * read across them. A thread whose list fails to project fails alone. */
  async threadEdits(projectId: string, threadId: string): Promise<ThreadEdits> {
    const path = `/projects/${apiPathId(projectId)}`;
    const single = () => this.get<ThreadEdits>(`${path}/threads/${encodeURIComponent(threadId)}/edits`);
    let batch = this.editBatches.get(projectId);
    if (!batch || (batch.ids.size >= 64 && !batch.ids.has(threadId))) {
      const ids = new Set<string>();
      const read = Promise.resolve().then(async () => {
        if (this.editBatches.get(projectId)?.ids === ids) this.editBatches.delete(projectId);
        if (ids.size === 1) {
          const { version, edits } = await single();
          return { version, lists: { [threadId]: edits } };
        }
        return this.post<ThreadEditLists>(`${path}/thread-edits`, { threads: [...ids] });
      });
      batch = { ids, read };
      this.editBatches.set(projectId, batch);
    }
    batch.ids.add(threadId);
    try {
      const { version, lists, failed } = await batch.read;
      if (failed && Object.hasOwn(failed, threadId)) throw new ScarletApiError(500, "internal_error", failed[threadId]!);
      if (!Object.hasOwn(lists, threadId)) throw new ScarletApiError(404, "not_found", "thread not found");
      return { version, edits: lists[threadId]! };
    } catch (error) {
      // Clients connected to an older engine can still read each list through its original route. The engine
      // may name the path decoded or behind a prefix, so only the method and the route's last segment are matched.
      if (error instanceof ScarletApiError && error.status === 404 && error.code === "not_found" &&
          error.message.startsWith("no route for POST ") && error.message.endsWith("/thread-edits")) return single();
      throw error;
    }
  }
  recordEditReview(projectId: string, body: EditReviewRequest) {
    return this.post<void>(`/projects/${projectId}/edit-reviews`, body);
  }
  setThreadDone(projectId: string, threadId: string, done: boolean, revision: string) {
    return this.post<{ completedThreads: Record<string, string>; project?: Project }>(`/projects/${projectId}/threads/${encodeURIComponent(threadId)}/disposition`, { done, revision });
  }
  updateProject(id: string, body: Record<string, unknown>) {
    return this.patch<{ project: Project }>(`/projects/${id}`, body);
  }
  stopEditing(id: string) {
    return this.post<{ project: Project; tasks: Task[] }>(`/projects/${apiPathId(id)}/stop-editing`);
  }
  resumeEditing(id: string) {
    return this.post<{ project: Project; tasks: Task[] }>(`/projects/${apiPathId(id)}/resume-editing`);
  }
  deleteProject(id: string) {
    return this.delete<Record<string, never>>(`/projects/${id}`);
  }

  contactSheet(projectId: string, request: z.input<typeof SheetRequest>, signal?: AbortSignal) {
    return this.request<InspectionResult>("POST", `/projects/${encodeURIComponent(projectId)}/contact-sheet`, request, { signal });
  }
  /** Frames of an edit at the given timeline seconds, with unsaved `ops` applied to the version first. */
  timelinePictures(projectId: string, request: z.input<typeof TimelinePicturesRequest>, signal?: AbortSignal) {
    return this.request<{ pictures: Array<{ time: number; jpeg: string }> }>("POST", `/projects/${encodeURIComponent(projectId)}/timeline-pictures`, request, { signal });
  }
  /** How much of each source window's picture changes, and when. Older engines have no such route. */
  pictureActivity(projectId: string, request: z.input<typeof PictureActivityRequest>, signal?: AbortSignal) {
    return this.request<{ windows: PictureActivityWindow[] }>("POST", `/projects/${encodeURIComponent(projectId)}/picture-activity`, request, { signal });
  }
  checkDialogueRepeats(projectId: string, taskId: string, body: z.input<typeof RepeatAuditRequest>) {
    return this.post<RepeatAuditResult>(`/projects/${apiPathId(projectId)}/tasks/${apiPathId(taskId)}/repeat-audit`, body);
  }
  dialogueDetections(projectId: string, request: z.input<typeof DialogueWindowRequest>) {
    return this.post<DialogueDetections>(`/projects/${encodeURIComponent(projectId)}/dialogue-detections`, request);
  }
  /** Complete words heard in each contiguous run of cached speech frames for this input, in source seconds. */
  dialogueAcousticWords(projectId: string, request: z.input<typeof AcousticWordsRequest>) {
    return this.post<TranscriptWord[][]>(`/projects/${encodeURIComponent(projectId)}/dialogue-acoustic-words`, request);
  }
  startDialogueScan(projectId: string, request: z.input<typeof DialogueScanRequest>) {
    return this.post<Array<{ start: number; end: number }>>(`/projects/${encodeURIComponent(projectId)}/dialogue-scan`, request);
  }
  dialogueCheckpoints(projectId: string, request: z.input<typeof DialogueRangeRequest>) {
    return this.post<Array<{ start: number; end: number }>>(`/projects/${encodeURIComponent(projectId)}/dialogue-checkpoints`, request);
  }
  /** The verbatim words the saved scan pages read between from and to, in source seconds, and the stretches they cover. */
  dialogueVerbatimWords(projectId: string, request: z.input<typeof DialogueRangeRequest>) {
    return this.post<{ words: TranscriptWord[]; covered: Array<{ start: number; end: number }> }>(`/projects/${encodeURIComponent(projectId)}/dialogue-verbatim`, request);
  }
  soundPicture(projectId: string, request: z.input<typeof SoundPictureRequest>) {
    return this.post<{ jpeg: string; layout: SoundPictureLayout }>(`/projects/${encodeURIComponent(projectId)}/sound-picture`, request);
  }
  sourceAudio(projectId: string, request: z.input<typeof SourceAudioRequest>) {
    return this.post<{ wav: string }>(`/projects/${encodeURIComponent(projectId)}/source-audio`, request);
  }
  reviewCut(projectId: string, request: z.input<typeof InspectionReviewRequest>) {
    return this.post<InspectionResult>(`/projects/${encodeURIComponent(projectId)}/review-cut`, request);
  }

  // Media
  media(projectId: string) {
    return this.get<{ media: MediaAsset[] }>(`/projects/${projectId}/media`);
  }
  uploadMedia(projectId: string, file: Blob, name: string, kind?: string, provenance?: Record<string, unknown>) {
    const fd = new FormData();
    fd.append("file", file, name);
    if (kind) fd.append("kind", kind);
    if (provenance) fd.append("provenance", JSON.stringify(provenance));
    return this.post<{ media: MediaAsset }>(`/projects/${projectId}/media`, fd);
  }
  importMedia(projectId: string, body: { path?: string; url?: string; kind?: string; importId?: string; deferFormat?: boolean }, signal?: AbortSignal) {
    return this.request<{ media: MediaAsset }>("POST", `/projects/${projectId}/media/import`, body, { signal });
  }
  /** Take a file Scarlet couldn't read out of the project. The engine refuses one the video or its history uses. */
  removeMedia(projectId: string, mediaId: string) {
    return this.delete<Record<string, never>>(`/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}`);
  }
  waveform(mediaId: string, from: number, to: number, points = 1000, cachedOnly = false, speechActivity = false) {
    return this.withResource("media", mediaId, path => this.get<WaveformResponse>(`${path}/waveform?from=${from}&to=${to}&points=${points}${cachedOnly ? "&cachedOnly=1" : ""}${speechActivity ? "&speechActivity=1" : ""}`));
  }
  /** Prepared peaks for full-recording matching. An older engine returns its usual JSON waveform. */
  waveformPeaks(mediaId: string, from: number, to: number, points: number) {
    return this.withResource("media", mediaId, path => this.request<Pick<WaveformResponse, "peaks">>("GET",
      `${path}/waveform?from=${from}&to=${to}&points=${points}&cachedOnly=1&format=peaks-f64le`, undefined, {}, data => {
        const view = new DataView(data);
        if (view.byteLength % 8) throw new Error("Truncated waveform peaks");
        const peaks = new Array<number>(view.byteLength / 8);
        for (let i = 0; i < peaks.length; i++) peaks[i] = view.getFloat64(i * 8, true);
        return { peaks };
      }));
  }
  /** Words heard only on the input a recording's dialogue isn't on, and what sounded there alone in each gap. Source seconds. */
  otherInput(projectId: string, mediaId: string, body: { words: Array<[number, number]>; gaps: Array<[number, number]> }) {
    return this.post<{ available: boolean; words: boolean[]; gaps: Array<Array<{ start: number; end: number }>> }>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/other-input`, body);
  }

  transcript(mediaId: string, opts: { from?: number; to?: number; granularity?: "word" | "segment"; audioSources?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.from !== undefined) q.set("from", String(opts.from));
    if (opts.to !== undefined) q.set("to", String(opts.to));
    if (opts.granularity) q.set("granularity", opts.granularity);
    if (opts.audioSources) q.set("audioSources", "1");
    const qs = q.toString();
    return this.withResource("media", mediaId, path => this.get<Transcript>(`${path}/transcript${qs ? `?${qs}` : ""}`));
  }
  searchTranscript(mediaId: string, phrase: string, contextWords: number, knownWordSnapshot?: string) {
    const query = new URLSearchParams({ search: phrase, contextWords: String(contextWords) });
    if (knownWordSnapshot !== undefined) query.set("wordSnapshot", knownWordSnapshot);
    // Engines predating search ignore the query and return the original transcript.
    // A very long phrase can also be searched locally without exceeding a URL limit.
    if (query.toString().length > 4096) return this.transcript(mediaId);
    return this.withResource("media", mediaId, path => this.get<TranscriptSearchResult | Transcript>(`${path}/transcript?${query}`));
  }
  /** Repeated lines in one recording with a take inside from–to (source seconds). */
  retakes(projectId: string, mediaId: string, from: number, to: number) {
    return this.get<{ mediaId: string; groups: RetakeGroup[] }>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/retakes?from=${from}&to=${to}`);
  }
  transcribe(mediaId: string, provider?: string) {
    return this.post<{ task: Task }>(`/media/${mediaId}/transcribe`, { provider });
  }
  prepareMedia(projectId: string, mediaId: string, kind: "transcript" | "waveform") {
    return this.post<{ state: "ready" } | { state: "processing"; taskId: string }>(
      `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/prepare`, { kind },
    );
  }
  frameUrl(mediaId: string, t: number, w = 640) {
    const frame = this.fileUrl(`/media/${encodeURIComponent(mediaId)}/frame`);
    return `${frame}${frame.includes("?") ? "&" : "?"}t=${t}&w=${w}${this.previewFrames ? "&preview=1" : ""}`;
  }

  // Timeline / versions
  timeline(projectId: string, version = "head", signal?: AbortSignal) {
    return this.request<{ timeline: Timeline }>("GET", `/projects/${projectId}/timeline?version=${encodeURIComponent(version)}`, undefined, { signal });
  }
  preparePlayback(projectId: string, version: string, times: number[], signal: AbortSignal) {
    return this.request<void>("POST", `/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(version)}/prepare-playback`, { times }, { signal });
  }
  async cutPlaybackFile(projectId: string, version: string, range: TimeRange, signal: AbortSignal) {
    const { renderId, ...file } = await this.request<{ renderId: string; start: number; end: number; full?: true }>("POST",
      `/projects/${apiPathId(projectId)}/versions/${apiPathId(version)}/cut-playback-file`, range, { signal });
    return { url: this.renderFileUrl(renderId), ...file };
  }
  versions(projectId: string) {
    return this.get<{ versions: VersionSummary[] }>(`/projects/${projectId}/versions`);
  }
  diff(projectId: string, a: string, b: string, clipNames?: "id") {
    return this.get<{ diff: TimelineDiff; description: string[] }>(`/projects/${projectId}/versions/${apiPathId(a)}/diff/${apiPathId(b)}${clipNames === "id" ? "?clipNames=id" : ""}`);
  }
  branches(projectId: string) {
    return this.get<{ branches: { name: string; head: string | null }[] }>(`/projects/${projectId}/branches`);
  }
  switchBranch(projectId: string, name: string, expectedHead: string, expectedBranch: string, from?: string) {
    return this.post<{ project: Project }>(`/projects/${projectId}/branches`, { name, from, expectedHead, expectedBranch });
  }
  historyEdit(projectId: string, version: string, action: "revert" | "restore", expectedHead: string, branch: string) {
    return this.post<{ project: Project; change: Change }>(`/projects/${projectId}/versions/${version}/${action}`, { expectedHead, branch });
  }
  /** Put back what applied edits the editor rejected changed, with no model. Refused (409) where the engine can't. */
  rejectEdits(projectId: string, body: { expectedHead: string; branch: string; threadId: string;
    edits: { changeId: string; spot: number; label: string; range: TimeRange; revised?: boolean; at?: number; before?: { version: string; removed: TimeRange } }[] }) {
    return this.post<{ project: Project; change: Change }>(`/projects/${projectId}/rejected-edits`, body);
  }
  checkout(projectId: string, version: string) {
    return this.post<{ project: Project }>(`/projects/${projectId}/versions/${version}/checkout`);
  }
  otioUrl(projectId: string, version: string) {
    return this.fileUrl(`/projects/${projectId}/versions/${version}/export.otio`);
  }
  srtUrl(projectId: string, version: string, opts?: { trackId?: string; start?: number; end?: number }) {
    return this.captionUrl(projectId, version, "srt", opts);
  }
  vttUrl(projectId: string, version: string, opts?: { trackId?: string; start?: number; end?: number }) {
    return this.captionUrl(projectId, version, "vtt", opts);
  }
  private captionUrl(projectId: string, version: string, format: "srt" | "vtt", opts?: { trackId?: string; start?: number; end?: number }) {
    const url = this.fileUrl(`/projects/${projectId}/versions/${version}/export.${format}`);
    const params = query({ trackId: opts?.trackId, start: opts?.start, end: opts?.end });
    return params ? `${url}${url.includes("?") ? "&" : "?"}${params}` : url;
  }

  // Changes
  submitDialogueCuts(projectId: string, body: DialogueCutsRequest) {
    return this.post<{ changes: Array<Pick<Change, "id" | "state" | "fromVersion" | "toVersion" | "description" | "intent" | "timelineEdits">>;
      /** Staged cuts from the run's previous part that joined this part's review. */
      carriedForward?: number;
      /** Proposed ranges covered by an editor decision on an earlier part. */
      editorDecided?: TimeRange[];
      /** Proposed ranges held in their existing review for an editor call or a revision. */
      heldForReview?: TimeRange[];
      /** Earlier review slots whose footage is already out. Each join is on its named version. */
      alreadyRemoved?: { changeId: string; index: number; version: string; at: number }[];
      /** The requested crossfade on the joins these cuts made. Older engines omit it. */
      joinCrossfades?: JoinCrossfades;
      /** Confident cuts that wait for the editor instead of applying, and why. */
      stagedForEditor?: { cuts: number; why: string };
      /** Cuts whose edges moved onto whole frames: how many, the largest move in seconds, and why. */
      onFrames?: { cuts: number; largestShift: number; why: string };
      /** Staged cuts of an earlier part that left the review because their footage changed. */
      droppedFromReview?: Array<{ changeId: string; version: string; start: number; end: number; why: string }>;
      /** Cuts left out because they would have swapped a held staged cut for other edges Scarlet couldn't place either. */
      heldCutsStay?: Array<{ asked: TimeRange; staged: TimeRange; why: string }>;
      /** The project head after this submission. Older engines omit it. */
      head?: string }>(
      `/projects/${encodeURIComponent(projectId)}/dialogue-cuts`, body);
  }
  /** Flag an applied edit for the editor, as the run that found a doubt about it. */
  flagEdit(projectId: string, body: FlagEditRequest) {
    type Flagged = { changeId: string; spot: number; label: string; request: string; range: TimeRange; at?: number };
    return this.post<{ flagged: Flagged; version: string; alsoThere?: Flagged[] }>(`/projects/${encodeURIComponent(projectId)}/edit-flags`, body);
  }
  /** Record that the editor kept these edits, so the runs of their request hear of it. */
  keepEdits(projectId: string, body: KeepEditsRequest) {
    return this.post<void>(`/projects/${encodeURIComponent(projectId)}/kept-edits`, body);
  }
  /** Take back the editor's Keep of these edits, so they wait on the editor again. */
  unkeepEdits(projectId: string, body: UnkeepEditsRequest) {
    return this.post<void>(`/projects/${encodeURIComponent(projectId)}/kept-edits/undo`, body);
  }
  /** The edits the editor kept in a request (`threadId`), oldest first. */
  keptEdits(projectId: string, threadId: string) {
    return this.get<{ kept: KeptEdit[] }>(`/projects/${encodeURIComponent(projectId)}/kept-edits?thread=${encodeURIComponent(threadId)}`);
  }
  proposeChange(projectId: string, body: ProposeChangeRequest) {
    return this.post<{ change: Change; timeline: Timeline; diffDescription?: string[] }>(`/projects/${projectId}/changes`, body);
  }
  proposeChangeSummary(projectId: string, body: ProposeChangeRequest) {
    // Older engines return the full response when they receive the summary query.
    return this.post<{
      change: Pick<Change, "id" | "state" | "description" | "reason" | "fromVersion" | "toVersion" | "ranges" | "timelineEdits">;
      duration?: number; diffDescription?: string[]; timeline?: Timeline;
      /** Removals inside a selected passage the engine put on whole frames. Older engines omit it. */
      onWholeFrames?: Array<{ asked: [number, number]; removed: [number, number] }>;
      /** The edit met footage another request changed since `fromVersion`, so it wasn't applied. Older engines omit it. */
      notApplied?: { reason: string; currentVersion: string };
    }>(`/projects/${projectId}/changes?summary=true`, body);
  }
  changes(projectId: string, state?: string) {
    return this.get<{ changes: Change[] }>(`/projects/${projectId}/changes${state ? `?state=${encodeURIComponent(state)}` : ""}`);
  }
  changeRecord(changeId: string) {
    return this.withResource("changes", changeId, path => this.get<{ change: Change }>(`${path}?view=record`));
  }
  change(changeId: string) {
    return this.withResource("changes", changeId, path => this.get<{ change: Change; diff: TimelineDiff }>(path));
  }
  cutReview(changeId: string, restoredCuts?: number[]) {
    return this.withResource("changes", changeId, path => this.post<{ review: CutReview | null; draft?: Timeline }>(`${path}/cut-review`, { restoredCuts }));
  }
  cutReviewDraft(changeId: string, restoredCuts: number[], ontoVersion?: string, signal?: AbortSignal) {
    return this.withResource("changes", changeId, path => this.request<{ draft?: Timeline; ontoVersion?: string; removed?: TimeRange[] }>(
      "POST", `${path}/cut-review?view=draft`, { restoredCuts, ontoVersion }, { signal }));
  }
  assessCuts(changeId: string, fromVersion: string, toVersion: string, assessments: Array<Omit<CutAssessment, "provisional" | "askOrder" | "revised"> & { amend?: boolean }>) {
    // A published or revised call keeps its note and decision with the editor, unless Scarlet amends the note of one still waiting.
    return this.withResource("changes", changeId, path => this.post<{ total: number; assessed: number; needsDecision: number;
      heldForEditor?: number[]; editorPreference?: string; heldRevised?: number[]; editorRequest?: string; heldCalls?: number[]; existingCalls?: string;
      amended?: number[]; amendedCalls?: string }>(
      `${path}/cut-assessments`, { fromVersion, toVersion, assessments }));
  }
  saveCutChoices(changeId: string, body: CutChoicesRequest) {
    return this.withResource("changes", changeId, path => this.put<{ change: Change }>(`${path}/cut-choices`, body));
  }
  reviseStagedCut(changeId: string, index: number, body: StagedCutRevision) {
    return this.withResource("changes", changeId, path => this.post<{ change: Change; replaced?: string; index?: number; carried?: true }>(`${path}/staged-cuts/${index}`, body));
  }
  approveChange(changeId: string, spots?: number[], restoredCuts?: number[]) {
    return this.post<ApproveResponse>(`/changes/${changeId}/approve`, { spots, restoredCuts });
  }
  unapproveChange(changeId: string) {
    return this.post<{ change: Change; project: Project }>(`/changes/${changeId}/unapprove`);
  }
  rejectChange(changeId: string, reason?: string) {
    return this.post<{ change: Change }>(`/changes/${changeId}/reject`, { reason });
  }
  reopenChange(changeId: string) {
    return this.post<{ change: Change }>(`/changes/${changeId}/reopen`);
  }
  reviseChange(changeId: string, body: ReviseRequest) {
    return this.post<{ change: Change; note: Note; task?: Task }>(`/changes/${changeId}/revise`, body);
  }

  // Notes
  createNote(projectId: string, body: CreateNoteRequest) {
    return this.post<{ note: Note; task?: Task }>(`/projects/${projectId}/notes`, body);
  }
  createVoiceNote(
    projectId: string,
    audio: Blob,
    fields: Omit<CreateNoteRequest, "text" | "voiceTranscript">,
  ) {
    const fd = new FormData();
    fd.append("audio", audio, `note${audioExt(audio)}`);
    fd.append("time", String(fields.time));
    if (fields.end !== undefined) fd.append("end", String(fields.end));
    if (fields.version) fd.append("version", fields.version);
    if (fields.clipIds) fd.append("clipIds", JSON.stringify(fields.clipIds));
    if (fields.assignTo) fd.append("assignTo", fields.assignTo);
    if (fields.effort) fd.append("effort", fields.effort);
    if (fields.serviceTier) fd.append("serviceTier", fields.serviceTier);
    if (fields.changeId) fd.append("changeId", fields.changeId);
    return this.post<{ note: Note; task?: Task }>(`/projects/${projectId}/notes/voice`, fd);
  }
  /** Transcribe a short voice clip (push-to-talk) to text. */
  speechToText(audio: Blob) {
    const fd = new FormData();
    fd.append("audio", audio, `speech${audioExt(audio)}`);
    return this.post<{ text: string }>("/speech", fd);
  }
  notes(projectId: string, state?: string) {
    return this.get<{ notes: Note[] }>(`/projects/${projectId}/notes${state ? `?state=${encodeURIComponent(state)}` : ""}`);
  }
  updateNote(noteId: string, body: UpdateNoteRequest) {
    return this.withResource("notes", noteId, path => this.patch<{ note: Note }>(path, body));
  }
  /** `author` is the agent replying. Left out, the reply is the signed-in person's. */
  replyNote(noteId: string, text: string, author?: Author) {
    return this.withResource("notes", noteId, path => this.post<{ note: Note }>(`${path}/reply`, { text, author }));
  }

  // Renders
  requestRender(projectId: string, body: Partial<RenderRequest>) {
    return this.post<{ render: Render }>(`/projects/${projectId}/renders`, body);
  }
  /** Desktop exports in every project that haven't been saved or released yet. */
  exports() {
    return this.get<{ renders: Render[] }>("/exports");
  }
  releaseRender(renderId: string, owner: string) {
    return this.delete<void>(`/renders/${encodeURIComponent(renderId)}/owners/${encodeURIComponent(owner)}`);
  }
  render(renderId: string, inspectFile = false) {
    return this.withResource("renders", renderId, path => this.get<{ render: Render; fileInfo?: RenderFileInfo }>(`${path}${inspectFile ? "?inspectFile=true" : ""}`));
  }
  renders(projectId: string, q: { kind?: string; version?: string; currentDelivery?: boolean } = {}) {
    const qs = query(q);
    return this.get<{ renders: Render[]; currentDeliveryKey?: string | null; fullRenderKeys?: FullRenderKeys }>(`/projects/${projectId}/renders${qs ? `?${qs}` : ""}`);
  }
  renderFileUrl(renderId: string, waitForPlayback = false) {
    const file = this.fileUrl(`/renders/${renderId}/file`);
    if (!waitForPlayback) return file;
    const url = new URL(file);
    url.searchParams.set("wait", "1");
    return url.toString();
  }
  mediaFileUrl(mediaId: string, proxy = false) {
    return this.fileUrl(`/media/${mediaId}/${proxy ? "proxy" : "file"}`);
  }
  sourceCache(mediaId: string, prepare = false) {
    const url = `/media/${encodeURIComponent(mediaId)}/playback-cache`;
    return prepare ? this.post<PlaybackCacheStatus>(url, {}) : this.get<PlaybackCacheStatus>(url);
  }
  /** Every video's playback cache in a project. Reading never starts caching. */
  sourceCaches(projectId: string) {
    return this.get<{ caches: SourceCacheStatus[] }>(`/projects/${encodeURIComponent(projectId)}/playback-caches`);
  }
  sourceCacheUrl(mediaId: string, fileKey?: string) {
    const file = this.fileUrl(`/media/${encodeURIComponent(mediaId)}/playback-cache/file`);
    if (!fileKey) return file;
    const url = new URL(file);
    url.searchParams.set("fileKey", fileKey);
    return url.toString();
  }
  sourcePreviewUrl(mediaId: string, index: number) {
    return this.fileUrl(`/media/${mediaId}/preview/${index}`);
  }

  // Tasks
  createTask(projectId: string, body: CreateTaskRequest) {
    return this.post<{ task: Task }>(`/projects/${projectId}/tasks`, body);
  }
  tasks(projectId: string, state?: string, events?: "conversation") {
    // Not URLSearchParams.size: a WebView older than Safari 17 has none, and the whole query was dropped there.
    const qs = query({ state: state || undefined, events });
    return this.get<{ tasks: Task[]; conversation?: Record<string, TaskEvent[]> }>(`/projects/${projectId}/tasks${qs ? "?" + qs : ""}`);
  }
  task(taskId: string, events: "all" | "conversation" | "none" = "all") {
    return this.withResource("tasks", taskId, path => this.get<{ task: Task; events: TaskEvent[]; checksTaskAttempts?: true }>(path + (events === "all" ? "" : "?events=" + events)));
  }
  waitForTranscription(taskId: string) {
    return this.withResource("tasks", taskId, path => this.get<{ task: Task; waited?: boolean }>(path + "?wait=transcript"));
  }
  /**
   * Stop a request, or take it out of the queue with `queuedOnly`. `withdrawn`: the editor took the words back (⌘Z), so
   * the check reading them for a rule stops too, even once the request is under way. Stop this edit keeps it.
   */
  cancelTask(taskId: string, queuedOnly = false, withdrawn = false) {
    const qs = query({ queuedOnly: queuedOnly ? "1" : undefined, withdrawn: withdrawn ? "1" : undefined });
    return this.post<{ task: Task }>(`/tasks/${apiPathId(taskId)}/cancel${qs ? "?" + qs : ""}`);
  }
  /** Retry or resume a run, on the model the editor has picked now when one is given. */
  retryTask(taskId: string, body: RunChoice = {}) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/retry`, body);
  }
  /** Resume a run that ended without its transcripts once they're ready, or stop waiting to. Returns the resumed run when it starts now. */
  continueWhenReady(taskId: string, on: boolean) {
    return this.post<{ task: Task; resumed?: Task }>(`/tasks/${taskId}/continue-when-ready`, { on });
  }
  answerTask(taskId: string, text: string, skillIds?: string[]) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/answer`, { text, skillIds });
  }
  /** Keep a queued request from starting while the editor changes its words, or let it go. Renew it to keep holding. */
  holdForRewording(taskId: string, on: boolean) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/hold`, { on });
  }
  /** Start a queued request without waiting for the editor's calls on a dialogue pass. */
  startBeforeCalls(taskId: string) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/start-now`, {});
  }
  /** Change the words of a request that is still waiting its turn. It keeps its place in the queue. */
  rewordTask(taskId: string, text: string, skillIds?: string[]) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/reword`, { text, skillIds } satisfies RewordTaskRequest);
  }

  // Agent hosts
  registerHost(body: { name: string; platform: string; agents: AgentHost["agents"] }) {
    return this.post<{ host: AgentHost }>("/hosts/register", body);
  }
  heartbeat(hostId: string, agents: AgentHost["agents"], running?: string[]) {
    return this.post<{ cancelled?: string[] }>(`/hosts/${hostId}/heartbeat`, { agents, running });
  }
  postTaskEvent(taskId: string, event: TaskEvent, startedAt?: string) {
    return this.withResource("tasks", taskId, path => this.post<Record<string, never>>(path + "/events", { ...event, startedAt }));
  }
  /** Hosts add the CLI session that asked (null: none), so the answer can continue it. */
  async postTaskQuestion(taskId: string, startedAt: string | undefined, text: string, signal?: AbortSignal, host?: { sessionId: string | null }) {
    const ack = await this.withResource("tasks", taskId, path => this.request<{ waiting?: unknown } | null>("POST", path + "/question", { startedAt, text, ...host }, { signal }));
    if (typeof ack?.waiting !== "boolean") throw new Error("The engine did not acknowledge the question.");
    return { waiting: ack.waiting };
  }
  /**
   * The prompt a host gives its CLI. `fresh` skips resuming the CLI session that asked a question.
   * `timeLimitMinutes` is the cap the host puts on this run, so the prompt can say so. The engine takes a whole number from 1 to 1440.
   */
  taskPrompt(taskId: string, opts: { workDir?: string; fresh?: boolean; timeLimitMinutes?: number } = {}) {
    const q = new URLSearchParams({ ...(opts.workDir && { workDir: opts.workDir }), ...(opts.fresh && { fresh: "1" }), ...(opts.timeLimitMinutes && { timeLimit: String(opts.timeLimitMinutes) }) }).toString();
    return this.withResource("tasks", taskId, path => this.get<TaskPrompt>(`${path}/prompt${q ? `?${q}` : ""}`));
  }
  completeTask(taskId: string, body: CompleteTaskRequest) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/complete`, body);
  }
  recordTaskUsage(taskId: string, body: RecordTaskUsageRequest) {
    return this.withResource("tasks", taskId, path => this.post<Record<string, never>>(path + "/usage", body));
  }
  projectUsage(projectId: string, by: Exclude<UsageGroupBy, "project"> = "thread") {
    return this.get<UsageResponse>(`/projects/${apiPathId(projectId)}/usage?by=${by}`);
  }
  usage(by: UsageGroupBy = "project") {
    return this.get<UsageResponse>(`/usage?by=${by}`);
  }
  hosts() {
    return this.get<{ hosts: AgentHost[] }>("/hosts");
  }

  // Graphics
  /** Draw a graphic from a page: `options` (GraphicRenderRequest), the page as `html`, and the files it links to as `asset`s. */
  renderGraphic(projectId: string, form: FormData) {
    return this.post<GraphicRenderResponse & { media?: MediaAsset }>(`/projects/${apiPathId(projectId)}/graphics`, form);
  }
  /** A graphic Scarlet drew: its page, where it is, its files, size and timing. */
  graphic(projectId: string, mediaId: string) {
    return this.get<Record<string, unknown>>(`/projects/${apiPathId(projectId)}/graphics/${apiPathId(mediaId)}`);
  }
  saveStyleGuide(projectId: string, body: SaveStyleGuideRequest) {
    return this.put<{ styleGuide: unknown }>(`/projects/${apiPathId(projectId)}/style-guide`, body);
  }
  /** Read an attachment or the style guide: text as text, a picture as itself, a PDF as pictures of its `pages`. */
  readDocument(projectId: string, body: { attachmentId?: string; styleGuide?: boolean; pages?: number[] }) {
    return this.post<{ name: string; path: string; size: number; mime?: string; text?: string; pageCount?: number;
      pages?: Array<{ page: number; jpeg: string }>; image?: { mime: string; data: string } }>(`/projects/${apiPathId(projectId)}/documents/read`, body);
  }

  // Attachments: files the editor drops on the message box, which ride on the next request
  /** A file's bytes, as pasted or dropped in a browser, or a path on this machine, as the desktop app's drops give. */
  uploadAttachment(projectId: string, file: Blob | { path: string }, name?: string) {
    const path = `/projects/${apiPathId(projectId)}/attachments`;
    if (!(file instanceof Blob)) return this.post<{ attachment: TaskAttachment }>(path, { path: file.path });
    const fd = new FormData();
    fd.append("file", file, name ?? (typeof File !== "undefined" && file instanceof File ? file.name : "attachment"));
    return this.post<{ attachment: TaskAttachment }>(path, fd);
  }

  // Skills
  skills(q: { projectId?: string; taskId?: string; view?: "prompt" | "assistant" } = {}) {
    const qs = query(q);
    return this.get<{ skills: Skill[] }>(`/skills${qs ? `?${qs}` : ""}`);
  }
  createSkill(body: UpsertSkillRequest) {
    return this.post<{ skill: Skill }>("/skills", body);
  }
  skill(skillId: string) {
    return this.get<{ skill: Skill; versions: SkillVersion[]; edits?: Task[] }>(`/skills/${skillId}`);
  }
  updateSkill(skillId: string, body: Partial<UpsertSkillRequest>) {
    return this.put<{ skill: Skill }>(`/skills/${skillId}`, body);
  }
  deleteSkill(skillId: string) {
    return this.delete<Record<string, never>>(`/skills/${skillId}`);
  }
  skillFromChange(changeId: string, name: string, agent?: string) {
    return this.post<{ task: Task }>("/skills/from-change", { changeId, name, agent });
  }

  saveTaskSkill(projectId: string, taskId: string, body: TaskSkillDraft & { changeId: string; hostId: string }) {
    return this.post<{ skill: Skill }>(`/projects/${projectId}/tasks/${taskId}/skill`, body);
  }
  /** Ask an agent to revise the skill as the editor describes. The skill changes when the task saves it. */
  editSkill(skillId: string, body: EditSkillRequest) {
    return this.post<{ task: Task }>(`/skills/${skillId}/edit`, body);
  }
  saveSkillEdit(projectId: string, taskId: string, body: TaskSkillDraft & { skillId: string; hostId: string }) {
    return this.post<{ skill: Skill }>(`/projects/${projectId}/tasks/${taskId}/skill-edit`, body);
  }

  // Learnings: rules picked up from requests, waiting for the editor
  learnings(projectId: string) {
    return this.get<{ learnings: Learning[] }>(`/projects/${projectId}/learnings`);
  }
  suggestLearning(projectId: string, taskId: string, body: SuggestLearningRequest) {
    return this.post<{ learning: Learning; skill: Pick<Skill, "id" | "name"> }>(`/projects/${projectId}/tasks/${taskId}/learnings`, body);
  }
  approveLearning(projectId: string, learningId: string, body: ApproveLearningRequest = {}) {
    return this.post<{ learning: Learning }>(`/projects/${projectId}/learnings/${learningId}/approve`, body);
  }
  reviseLearning(projectId: string, learningId: string, body: ReviseLearningRequest) {
    return this.patch<{ learning: Learning }>(`/projects/${projectId}/learnings/${learningId}`, body);
  }
  declineLearning(projectId: string, learningId: string) {
    return this.post<{ learning: Learning }>(`/projects/${projectId}/learnings/${learningId}/decline`, {});
  }

  // Activity, trash, DaVinci
  activity(projectId: string, q: { before?: string; beforeId?: string; limit?: number; type?: string } = {}) {
    const qs = query(q);
    return this.get<{ activity: ActivityEntry[] }>(`/projects/${projectId}/activity${qs ? `?${qs}` : ""}`);
  }
  serverActivity(q: { before?: string; limit?: number } = {}) {
    const qs = query(q);
    return this.get<{ activity: ActivityEntry[] }>(`/activity${qs ? `?${qs}` : ""}`);
  }
  trash() {
    return this.get<{ projects: TrashedProject[] }>("/trash");
  }
  restoreProject(projectId: string) {
    return this.post<{ project: Project }>(`/projects/${projectId}/restore`);
  }
  /** What the folder for finishing the edit in another app holds, linked as it will sit at `folder`. */
  handoff(projectId: string, version: string, folder: string) {
    return this.post<HandoffResponse>(`/projects/${projectId}/versions/${version}/handoff`, { folder });
  }

  importOtio(projectId: string, otio: unknown, opts: { autoApprove?: boolean } = {}) {
    return this.post<{ change: Change; timeline: Timeline }>(`/projects/${projectId}/import/otio`, { otio, autoApprove: opts.autoApprove });
  }

  storage() {
    return this.get<{ projects: StorageProject[] }>("/storage");
  }
  cleanStorage(selection: StorageCleanup) {
    return this.post<{ projects: number }>("/storage/cleanup", selection);
  }

  // Settings
  localModelStatus() {
    return this.get<LocalModelStatus>("/settings/local-model");
  }
  settings() {
    return this.get<{ settings: ServerSettings; transcriptionAvailable?: boolean; transcriptionIssue?: string; telemetryUnavailable?: TelemetryUnavailable }>("/settings");
  }
  updateSettings(body: Partial<ServerSettings>) {
    return this.patch<{ settings: ServerSettings }>("/settings", body);
  }
}
