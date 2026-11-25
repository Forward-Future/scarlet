/**
 * Minimal typed HTTP client for the Scarlet API. Works in Node 22+ and
 * browsers (uses global fetch). Used by the web UI, MCP server and agent host.
 */
import type { EditReviewRequest } from "./telemetry.js";
import type { Listener, ListenResult } from "./capabilities.js";
import type { HandOffResult } from "./taskModels.js";
import type { z } from "zod/v3";
import { apiPathId, appendFields, ClientTransport, isMissingRouteError, ScarletApiError, withQuery } from "./clientTransport.js";
import type { TranscriptSearchResult } from "./transcriptSearch.js";
import type { ThreadEdit } from "./threadEdits.js";
import type { StorageCleanup, StorageProject } from "./storage.js";
import type { AcousticWordsRequest, DialogueRangeRequest, DialogueScanRequest, DialogueWindowRequest, DialogueDetections, SourceAudioRequest, SoundPictureRequest, SoundPictureLayout, SheetRequest, TimelinePicturesRequest, InspectionReviewRequest, InspectionResult, PictureActivityRequest, PictureActivityWindow, RepeatAuditRequest, RepeatAuditResult } from "./inspection.js";
import type { AudioTrackSelection, Author, Change, CutAssessment, CutReview, MediaAsset, Note, Project, Timeline, TimelineDiff, TimeRange, Transcript, TranscriptWord } from "@scarlet/timeline";
import type { ActivityEntry, ExpandMediaPathsResponse, MusicReading, TrashedProject, FullRenderKeys, PlaybackCacheStatus, SourceCacheStatus, ProjectDetail, ProjectSummary, Render, RenderFileInfo, RenderRequest, ServerSettings, User, WaveformResponse, RetakeGroup, LocalModelStatus, TelemetryUnavailable, HandoffResponse } from "./api.js";
import type { AgentHost, RunChoice } from "./agents.js";
import type { CompleteTaskRequest, CreateTaskRequest, PictureMarks, RewordTaskRequest, TaskAttachment, Task, TaskEvent, TaskPrompt, TaskSkillDraft } from "./tasks.js";
import type { KeepEditsRequest, UnkeepEditsRequest, KeptEdit, ApproveResponse, CreateNoteRequest, ProposeChangeRequest, ReviseRequest, UpdateNoteRequest, VersionSummary, DialogueCutsRequest, JoinCrossfades, FlagEditRequest, CutChoicesRequest, StagedCutRevision } from "./changes.js";
import type { ApproveLearningRequest, ReviseLearningRequest, Learning, SuggestLearningRequest } from "./learnings.js";
import type { RecordTaskUsageRequest, UsageGroupBy, UsageResponse } from "./usage.js";
import type { GraphicRenderResponse, SaveStyleGuideRequest } from "./graphics.js";
import type { Skill, SkillVersion, EditSkillRequest, UpsertSkillRequest } from "./skills.js";
import type {
  CreateStyleGuideRequest,
  EditStyleGuideRequest,
  StyleGuideAsset,
  StyleGuideFromGraphicRequest,
  StyleGuidePreviewRenderRequest,
  StyleGuidePreviewRenderResponse,
  StyleGuideRecord,
  TaskStyleGuideDraft,
  UpdateStyleGuideRequest,
} from "./styleGuides.js";

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

type ThreadEdits = { version: string | null; edits: ThreadEdit[] };
type ThreadEditLists = { version: string | null; lists: Record<string, ThreadEdit[]>; failed?: Record<string, string> };
type ThreadEditBatch = { ids: Set<string>; read: Promise<ThreadEditLists> };

export class ScarletClient extends ClientTransport {
  private readonly editBatches = new Map<string, ThreadEditBatch>();

  /** Bind individual MCP resource lookups and mutations to their owning project. */
  forProject(projectId: string, attempt = this.attempt): ScarletClient {
    return new ScarletClient({ baseUrl: this.baseUrl, token: this.tokenSource, fetch: this.fetchImpl, readResponse: this.readResponse, previewFrames: this.previewFrames }, projectId, attempt);
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
  createSampleProject() {
    return this.post<{ project: Project }>("/projects/sample", {});
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
      if (isMissingRouteError(error, message => message.startsWith("no route for POST ") && message.endsWith("/thread-edits"))) return single();
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
  resumeEditing(id: string, body?: RunChoice) {
    return this.post<{ project: Project; tasks: Task[] }>(`/projects/${apiPathId(id)}/resume-editing`, body);
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
  /** Have a model that hears listen to a passage for this run, and wait up to `wait` seconds for what it heard. */
  listen(projectId: string, request: { taskId: string; mediaId: string; from: number; to: number; voice?: "me" | "other voices"; question: string }, wait: number) {
    return this.post<ListenResult>(`/projects/${encodeURIComponent(projectId)}/listen?wait=${Math.max(0, Math.round(wait))}`, request);
  }
  /** Hand one kind of work to the model the editor chose for it in Task models, and wait up to `wait` seconds for it. */
  handOff(projectId: string, request: { taskId: string; type?: string; brief?: string; handoffId?: string }, wait: number) {
    return this.post<HandOffResult>(`/projects/${encodeURIComponent(projectId)}/hand-off?wait=${Math.max(0, Math.round(wait))}`, request);
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
    appendFields(fd, { kind, provenance: provenance ? JSON.stringify(provenance) : undefined });
    return this.post<{ media: MediaAsset }>(`/projects/${projectId}/media`, fd);
  }
  expandMediaPaths(paths: string[], signal?: AbortSignal) {
    return this.request<ExpandMediaPathsResponse>("POST", "/media/expand-paths", { paths }, { signal });
  }
  importMedia(projectId: string, body: { path?: string; url?: string; kind?: string; importId?: string; deferFormat?: boolean }, signal?: AbortSignal) {
    return this.request<{ media: MediaAsset }>("POST", `/projects/${projectId}/media/import`, body, { signal });
  }
  /** Take a file Scarlet couldn't read out of the project. The engine refuses one the video or its history uses. */
  removeMedia(projectId: string, mediaId: string) {
    return this.delete<Record<string, never>>(`/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}`);
  }
  /** Save what the editor says a file is and how to use it. An empty note takes it off. */
  setMediaNote(mediaId: string, note: string) {
    return this.put<{ media: MediaAsset }>(`/media/${encodeURIComponent(mediaId)}/note`, { note });
  }
  /** Choose which audio track (or all tracks mixed) Scarlet reads from a multi-track recording. */
  setMediaAudioTrack(mediaId: string, audioTrack: AudioTrackSelection) {
    return this.put<{ media: MediaAsset }>(`/media/${encodeURIComponent(mediaId)}/audio-track`, { audioTrack });
  }
  waveform(mediaId: string, from: number, to: number, points = 1000, cachedOnly = false, speechActivity = false) {
    return this.withResource("media", mediaId, path => this.get<WaveformResponse>(withQuery(`${path}/waveform`, {
      from, to, points, cachedOnly: cachedOnly ? "1" : undefined, speechActivity: speechActivity ? "1" : undefined,
    })));
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
    return this.withResource("media", mediaId, path => this.get<Transcript>(withQuery(`${path}/transcript`, {
      from: opts.from, to: opts.to, granularity: opts.granularity, audioSources: opts.audioSources ? "1" : undefined,
    })));
  }
  searchTranscript(mediaId: string, phrase: string, contextWords: number, knownWordSnapshot?: string) {
    const query = new URLSearchParams({ search: phrase, contextWords: String(contextWords) });
    if (knownWordSnapshot !== undefined) query.set("wordSnapshot", knownWordSnapshot);
    // Engines predating search ignore the query and return the original transcript.
    // A very long phrase can also be searched locally without exceeding a URL limit.
    if (query.toString().length > 4096) return this.transcript(mediaId);
    return this.withResource("media", mediaId, path => this.get<TranscriptSearchResult | Transcript>(`${path}/transcript?${query}`));
  }
  /** A music file's beats, bars, tempo and level sections, measured from its sound. Source seconds. */
  musicBeats(projectId: string, mediaId: string, range: { from?: number; to?: number } = {}) {
    return this.get<MusicReading>(withQuery(`/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/music-beats`, range));
  }
  /** Correct a word or phrase in the project's transcripts (all of them, or `mediaIds`), keeping word times. */
  fixTranscriptWords(projectId: string, body: { find: string; replace: string; mediaIds?: string[]; from?: number; to?: number }) {
    return this.post<{ recordings: Array<{ mediaId: string; name: string; count: number; wordsAdded: number;
      places: Array<{ index: number; start: number; end: number; before: string; after: string }> } | { mediaId: string; name: string; skipped: string }> }>(
      `/projects/${encodeURIComponent(projectId)}/transcripts/fix`, body);
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
    return this.fileUrl(`/media/${encodeURIComponent(mediaId)}/frame`, { t, w, preview: this.previewFrames ? "1" : undefined });
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
    edits: { changeId: string; spot: number; label: string; range: TimeRange; revised?: boolean; marker?: boolean; at?: number; before?: { version: string; removed: TimeRange } }[] }) {
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
    return this.fileUrl(`/projects/${projectId}/versions/${version}/export.${format}`, { trackId: opts?.trackId, start: opts?.start, end: opts?.end });
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
      /** Earlier staged cuts Scarlet checked and settled as cuts, never asked about, that went into the video with this save. */
      settledApplied?: { cuts: number; why: string };
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
      notApplied?: { reason: string; currentVersion: string; editorAsked?: string[] };
    }>(`/projects/${projectId}/changes?summary=true`, body);
  }
  changes(projectId: string, state?: string) {
    return this.get<{ changes: Change[] }>(withQuery(`/projects/${projectId}/changes`, { state: state || undefined }));
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
    appendFields(fd, {
      time: String(fields.time),
      end: fields.end !== undefined ? String(fields.end) : undefined,
      version: fields.version || undefined,
      clipIds: fields.clipIds ? JSON.stringify(fields.clipIds) : undefined,
      assignTo: fields.assignTo || undefined,
      effort: fields.effort || undefined,
      serviceTier: fields.serviceTier || undefined,
      changeId: fields.changeId || undefined,
    });
    return this.post<{ note: Note; task?: Task }>(`/projects/${projectId}/notes/voice`, fd);
  }
  /** Transcribe a short voice clip (push-to-talk) to text. */
  speechToText(audio: Blob) {
    const fd = new FormData();
    fd.append("audio", audio, `speech${audioExt(audio)}`);
    return this.post<{ text: string }>("/speech", fd);
  }
  notes(projectId: string, state?: string) {
    return this.get<{ notes: Note[] }>(withQuery(`/projects/${projectId}/notes`, { state: state || undefined }));
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
    return this.get<{ renders: Render[]; currentDeliveryKey?: string | null; fullRenderKeys?: FullRenderKeys }>(withQuery(`/projects/${projectId}/renders`, q));
  }
  renderFileUrl(renderId: string, waitForPlayback = false) {
    return this.fileUrl(`/renders/${renderId}/file`, waitForPlayback ? { wait: "1" } : undefined);
  }
  mediaFileUrl(mediaId: string, proxy = false, audioTrack?: AudioTrackSelection) {
    return this.fileUrl(`/media/${mediaId}/${proxy ? "proxy" : "file"}`,
      proxy && audioTrack !== undefined ? { track: String(audioTrack) } : undefined);
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
    return this.fileUrl(`/media/${encodeURIComponent(mediaId)}/playback-cache/file`, fileKey ? { fileKey } : undefined);
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
    return this.get<{ tasks: Task[]; conversation?: Record<string, TaskEvent[]> }>(withQuery(`/projects/${projectId}/tasks`, { state: state || undefined, events }));
  }
  task(taskId: string, events: "all" | "conversation" | "none" = "all") {
    return this.withResource("tasks", taskId, path => this.get<{ task: Task; events: TaskEvent[]; checksTaskAttempts?: true; listener?: Listener;
      taskModels?: Array<{ id: string; name: string; description?: string; by: { agent: string; model?: string; label?: string } }> }>(path + (events === "all" ? "" : "?events=" + events)));
  }
  waitForTranscription(taskId: string) {
    return this.withResource("tasks", taskId, path => this.get<{ task: Task; waited?: boolean }>(path + "?wait=transcript"));
  }
  /**
   * Stop a request, or take it out of the queue with `queuedOnly`. `withdrawn`: the editor took the words back (⌘Z), so
   * the check reading them for a rule stops too, even once the request is under way. Stop this edit keeps it.
   */
  cancelTask(taskId: string, queuedOnly = false, withdrawn = false) {
    return this.post<{ task: Task }>(withQuery(`/tasks/${apiPathId(taskId)}/cancel`, { queuedOnly: queuedOnly ? "1" : undefined, withdrawn: withdrawn ? "1" : undefined }));
  }
  /** Retry or resume a run, on the model the editor has picked now when one is given. */
  retryTask(taskId: string, body: RunChoice = {}) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/retry`, body);
  }
  /** Resume a run that ended without its transcripts once they're ready, or stop waiting to. Returns the resumed run when it starts now. */
  continueWhenReady(taskId: string, on: boolean) {
    return this.post<{ task: Task; resumed?: Task }>(`/tasks/${taskId}/continue-when-ready`, { on });
  }
  /** Answer Scarlet's question. Files attached to the answer are kept with the request, as its own are. */
  answerTask(taskId: string, text: string, skillIds?: string[], runWith?: RunChoice, files?: { attachments: TaskAttachment[]; pictureMarks?: PictureMarks }) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/answer`, { ...runWith, text, skillIds, ...files });
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
  rewordTask(taskId: string, text: string, skillIds?: string[], styleGuideIds?: string[]) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/reword`, { text, skillIds, styleGuideIds } satisfies RewordTaskRequest);
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
  /** Hosts add the CLI session that asked (null: none), so the answer can continue it. `choices` are the short answers the question offers. */
  async postTaskQuestion(taskId: string, startedAt: string | undefined, text: string, signal?: AbortSignal, host?: { sessionId: string | null }, choices?: readonly string[]) {
    const ack = await this.withResource("tasks", taskId, path => this.request<{ waiting?: unknown } | null>("POST", path + "/question", { startedAt, text, ...host, ...(choices?.length && { choices }) }, { signal }));
    if (typeof ack?.waiting !== "boolean") throw new Error("The engine did not acknowledge the question.");
    return { waiting: ack.waiting };
  }
  /**
   * The prompt a host gives its CLI. `fresh` skips resuming the CLI session that asked a question.
   * `timeLimitMinutes` is the cap the host puts on this run, so the prompt can say so. The engine takes a whole number from 1 to 1440.
   */
  taskPrompt(taskId: string, opts: { workDir?: string; fresh?: boolean; timeLimitMinutes?: number } = {}) {
    return this.withResource("tasks", taskId, path => this.get<TaskPrompt>(withQuery(`${path}/prompt`, {
      workDir: opts.workDir || undefined, fresh: opts.fresh ? "1" : undefined, timeLimit: opts.timeLimitMinutes || undefined,
    })));
  }
  completeTask(taskId: string, body: CompleteTaskRequest) {
    return this.post<{ task: Task }>(`/tasks/${taskId}/complete`, body);
  }
  recordTaskUsage(taskId: string, body: RecordTaskUsageRequest, signal?: AbortSignal) {
    return this.withResource("tasks", taskId, path => this.request<Record<string, never>>("POST", path + "/usage", body, { signal }));
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
  refreshHostQuota(force = false) {
    return this.post<{ ok: boolean }>("/hosts/quota/refresh", { force });
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
    return this.get<{ skills: Skill[] }>(withQuery("/skills", q));
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

  // Style guides
  styleGuides() {
    return this.get<{ styleGuides: StyleGuideRecord[] }>("/style-guides");
  }
  styleGuide(styleGuideId: string) {
    return this.get<{ styleGuide: StyleGuideRecord; edits?: Task[] }>(`/style-guides/${apiPathId(styleGuideId)}`);
  }
  createStyleGuide(body: CreateStyleGuideRequest) {
    return this.post<{ styleGuide: StyleGuideRecord }>("/style-guides", body);
  }
  createStyleGuideFromGraphic(body: StyleGuideFromGraphicRequest) {
    return this.post<{ styleGuide: StyleGuideRecord }>("/style-guides/from-graphic", body);
  }
  updateStyleGuide(styleGuideId: string, body: UpdateStyleGuideRequest) {
    return this.put<{ styleGuide: StyleGuideRecord }>(`/style-guides/${apiPathId(styleGuideId)}`, body);
  }
  deleteStyleGuide(styleGuideId: string) {
    return this.delete<Record<string, never>>(`/style-guides/${apiPathId(styleGuideId)}`);
  }
  editStyleGuide(styleGuideId: string, body: EditStyleGuideRequest) {
    return this.post<{ task: Task }>(`/style-guides/${apiPathId(styleGuideId)}/edit`, body);
  }
  saveTaskStyleGuideEdit(projectId: string, taskId: string, body: TaskStyleGuideDraft & { styleGuideId: string; hostId: string }) {
    return this.post<{ styleGuide: StyleGuideRecord }>(`/projects/${apiPathId(projectId)}/tasks/${apiPathId(taskId)}/style-guide-edit`, body);
  }
  uploadStyleGuideAsset(styleGuideId: string, file: Blob | { path: string }, name?: string) {
    const path = `/style-guides/${apiPathId(styleGuideId)}/assets`;
    if (!(file instanceof Blob)) return this.post<{ asset: StyleGuideAsset; styleGuide: StyleGuideRecord }>(path, { path: file.path });
    const fd = new FormData();
    fd.append("file", file, name ?? (typeof File !== "undefined" && file instanceof File ? file.name : "asset"));
    return this.post<{ asset: StyleGuideAsset; styleGuide: StyleGuideRecord }>(path, fd);
  }
  styleGuideAssetUrl(styleGuideId: string, assetId: string) {
    return this.fileUrl(`/style-guides/${apiPathId(styleGuideId)}/assets/${apiPathId(assetId)}`);
  }
  readStyleGuideAsset(styleGuideId: string, assetId: string, pages?: number[]) {
    return this.post<{ name: string; path: string; size: number; mime?: string; text?: string; pageCount?: number;
      pages?: Array<{ page: number; jpeg: string }>; image?: { mime: string; data: string } }>(
      `/style-guides/${apiPathId(styleGuideId)}/assets/${apiPathId(assetId)}/read`,
      pages ? { pages } : {},
    );
  }
  renderStyleGuidePreview(styleGuideId: string, body: StyleGuidePreviewRenderRequest) {
    return this.post<StyleGuidePreviewRenderResponse>(`/style-guides/${apiPathId(styleGuideId)}/preview`, body);
  }
  styleGuidePreviewSource(styleGuideId: string) {
    return this.get<{ html: string; width: number; height: number; updatedAt: string; jpeg?: string }>(`/style-guides/${apiPathId(styleGuideId)}/preview/source`);
  }
  styleGuidePreviewUrl(styleGuideId: string, updatedAt?: string) {
    return this.fileUrl(`/style-guides/${apiPathId(styleGuideId)}/preview`, updatedAt ? { v: updatedAt } : undefined);
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
    return this.get<{ activity: ActivityEntry[] }>(withQuery(`/projects/${projectId}/activity`, q));
  }
  serverActivity(q: { before?: string; limit?: number } = {}) {
    return this.get<{ activity: ActivityEntry[] }>(withQuery("/activity", q));
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
