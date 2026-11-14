/**
 * Scarlet HTTP + WebSocket API contract.
 *
 * Base URL: http://<server>/api
 * Auth: `Authorization: Bearer <token>`. Scarlet is single-user: the server
 * creates one local user and an access token on first start. The desktop shell
 * receives the token through the engine startup handshake.
 * All bodies are JSON. Errors are `{ error: { code, message } }` with 4xx/5xx.
 *
 * Routes (method path → request body → response):
 *
 *  Auth
 *   GET    /auth/me                                      → { user: User }     (checks the token; the local user)
 *
 *  Projects
 *   GET    /projects                                     → { projects: ProjectSummary[] }
 *   POST   /projects                CreateProjectRequest → { project: Project }
 *   GET    /projects/:id                                 → ProjectDetail
 *   PATCH  /projects/:id            UpdateProjectRequest → { project: Project }
 *   DELETE /projects/:id                                 → {}
 *
 *  Media
 *   POST   /projects/:id/media      multipart (file, kind?, provenance?) → { media: MediaAsset }   (ingest: probe, hash, proxy, waveform, transcript; MediaAsset.status tracks progress)
 *   POST   /projects/:id/media/import { path | url }     → { media: MediaAsset }      (server-side path or Drive/HTTP URL)
 *   GET    /projects/:id/media                           → { media: MediaAsset[] }
 *   DELETE /projects/:id/media/:mediaId                  → {}                 (a file Scarlet couldn't read; 409 when a version of the video uses it, a request is at work in the project, or the file was read)
 *   GET    /media/:mediaId/file                          → bytes (range requests)
 *   GET    /media/:mediaId/proxy                         → bytes (low-res mp4)
 *   GET    /media/:mediaId/waveform?from&to&points       → WaveformResponse
 *   GET    /media/:mediaId/transcript?from&to&granularity → Transcript (segments filtered to range)
 *   GET    /projects/:id/media/:mediaId/retakes?from&to  → { mediaId, groups: RetakeGroup[] } (repeated lines with a take in from–to, source seconds)
 *   POST   /media/:mediaId/transcribe { provider? }      → { task: Task }   (re-run transcription)
 *   GET    /media/:mediaId/frame?t=<seconds>&w=<px>      → image/jpeg
 *
 *  Timeline versions
 *   GET    /projects/:id/timeline?version=<id|head>      → { timeline: Timeline }
 *   GET    /projects/:id/versions                        → { versions: VersionSummary[] }
 *   GET    /projects/:id/versions/:a/diff/:b             → { diff: TimelineDiff, description: string[] }
 *   POST   /projects/:id/versions/:v/checkout            → { project }        (set head to a past version; records a change)
 *   GET    /projects/:id/versions/:v/export.otio         → application/json (OTIO)
 *
 *  Changes (the review loop)
 *   POST   /projects/:id/changes    ProposeChangeRequest → { change: Change, timeline: Timeline }
 *   GET    /projects/:id/changes?state=                  → { changes: Change[] }
 *   GET    /changes/:changeId                            → { change: Change, diff: TimelineDiff }
 *   POST   /changes/:changeId/approve  { spots? }         → ApproveResponse   (merges into the cut: as-is, re-applied onto a moved cut, or only the chosen spots; overlapping edits are sent back to the agent)
 *   POST   /changes/:changeId/unapprove                  → { change: Change, project: Project } (undo, while nothing was approved on top)
 *   POST   /changes/:changeId/reject   { reason? }       → { change: Change }
 *   POST   /changes/:changeId/revise   ReviseRequest     → { change: Change, note: Note, task?: Task }
 *   POST   /projects/:id/dialogue-cuts DialogueCutsRequest → { changes, joinCrossfades?: JoinCrossfades }
 *
 *  Notes
 *   POST   /projects/:id/notes      CreateNoteRequest    → { note: Note, task?: Task }
 *   POST   /projects/:id/notes/voice multipart (audio, time, end?, version, clipIds?, assignTo?) → { note, task? }
 *   GET    /projects/:id/notes?state=                    → { notes: Note[] }
 *   POST   /speech                  multipart (audio)    → { text }           (speech to text for voice actions; audio is not stored)
 *   PATCH  /notes/:noteId           UpdateNoteRequest    → { note: Note }
 *   POST   /notes/:noteId/reply     { text }             → { note: Note }     (agent → human reply thread)
 *
 *  Renders
 *   POST   /projects/:id/renders    RenderRequest        → { render: Render }
 *   GET    /exports                                      → { renders: Render[] }  exports not yet saved or released
 *   GET    /renders/:renderId                            → { render: Render }
 *   GET    /renders/:renderId/file                       → bytes (mp4, range requests)
 *   GET    /projects/:id/renders?kind=&version=          → { renders: Render[], fullRenderKeys?: FullRenderKeys }
 *
 *  Agent tasks
 *   POST   /projects/:id/tasks      CreateTaskRequest    → { task: Task }     (queue work for an agent host)
 *   GET    /projects/:id/tasks?state=                    → { tasks: Task[] }
 *   GET    /tasks/:taskId                                → { task: Task, events: TaskEvent[] }
 *   GET    /tasks/:taskId/prompt?workDir=&fresh=         → TaskPrompt (what the agent is told; hosts call this before each run)
 *   POST   /tasks/:taskId/cancel                         → { task: Task }
 *   POST   /tasks/:taskId/retry  RunChoice?              → { task: Task } (resume an interrupted request or retry a failure, on the model given)
 *   POST   /tasks/:taskId/answer    { text }             → { task: Task }     (human answers an agent question)
 *   GET    /projects/:id/usage?by=thread|task|agent|model|day → UsageResponse  (agent token usage, newest group first)
 *   GET    /usage?by=project|thread|task|agent|model|day    → UsageResponse  (all projects, including trashed ones not yet removed)
 *   GET    /under-way                                    → { edits, queued, exports }  (what quitting would stop, in every project)
 *
 *  Agent hosts (called by apps/agent with an agent token)
 *   POST   /hosts/register          RegisterHostRequest  → { host: AgentHost }
 *   POST   /hosts/:hostId/heartbeat { agents, running? } → { cancelled: string[] }
 *   POST   /hosts/:hostId/claim?wait=<s> { taskId?, agents? } → { task: Task | null } (claim next queued task for this host's user; long-polls up to wait seconds; agents = idle runtimes)
 *   POST   /tasks/:taskId/events    TaskEvent            → {}
 *   POST   /tasks/:taskId/question  { startedAt?, text, sessionId? } → { waiting: boolean } (once per claim; hosts add the CLI session that asked)
 *   POST   /tasks/:taskId/complete  CompleteTaskRequest  → { task: Task }
 *   POST   /tasks/:taskId/usage     RecordTaskUsageRequest → {}           (tokens one run reported; once per run)
 *   GET    /hosts                                       → { hosts: AgentHost[] }
 *
 *  Skills
 *   GET    /skills?projectId=&taskId=&view=              → { skills: Skill[] }
 *   POST   /skills                  UpsertSkillRequest   → { skill: Skill }
 *   GET    /skills/:skillId                              → { skill: Skill, versions: SkillVersion[], edits: Task[] }   (edits: the requests to revise it, in the order asked)
 *   PUT    /skills/:skillId         UpsertSkillRequest   → { skill: Skill }
 *   DELETE /skills/:skillId                              → {}
 *   POST   /projects/:id/tasks/:taskId/skill { changeId, hostId, description, instructions } → { skill: Skill } (active skill-from-change task only)
 *   POST   /skills/from-change      { changeId, name }   → { task: Task }     (ask an agent to draft a skill from an approved change)
 *   POST   /skills/:skillId/edit    EditSkillRequest     → { task: Task }     (ask an agent to revise a skill as the editor describes)
 *   POST   /projects/:id/tasks/:taskId/skill-edit { skillId, hostId, description, instructions } → { skill: Skill } (active skill-edit task only)
 *
 *  Activity, trash, DaVinci round-trip
 *   GET    /projects/:id/activity?before=&limit=&type=   → { activity: ActivityEntry[] }   (newest first, permanent)
 *   GET    /activity?before=&limit=                      → { activity: ActivityEntry[] }   (server-wide: quick actions, skills, deletions)
 *   GET    /trash                                        → { projects: TrashedProject[] }   (deleted projects, kept 30 days)
 *   POST   /projects/:id/restore                         → { project }
 *   POST   /projects/:id/import/otio  { otio, autoApprove? } → { change, timeline }   (a timeline edited in DaVinci Resolve, as a change by you)
 *
 *  Quick actions
 *
 *  Settings
 *   GET    /settings                                     → { settings: ServerSettings, transcriptionAvailable: boolean }
 *   GET    /settings/local-model                         → LocalModelStatus (selection, active local engine and readiness)
 *   PATCH  /settings                Partial<ServerSettings> → { settings }
 *
 *  Realtime
 *   WS     /ws?token=<token>        server pushes WsEvent; client may send { type: "subscribe", projectId }
 */
import { z } from "zod/v3";
import { EditingTools } from "./editingTools.js";
import {
  Author,
  Change,
  EditIntent,
  ChangeState,
  DEFAULT_PREVIEW_HEIGHT,
  Id,
  LocalTranscriptionModel,
  MediaAsset,
  Note,
  Project,
  ProjectSettings,
  stableStringify,
  Seconds,
  Timeline,
  WritableTimeline,
  TimelineOp,
  TimeRange,
} from "@scarlet/timeline";

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/** The local user (Scarlet is single-user; the name labels the activity log). */
export const User = z.object({
  id: Id,
  name: z.string(),
  createdAt: z.string().datetime().optional(),
});
export type User = z.infer<typeof User>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * One thing Scarlet is doing in a project. `fraction` is how far a job under way has got, from what the engine counted,
 * and is left out until there is a figure. `count` is how many files or requests it covers. `paused` is media work held
 * by the project's pause.
 */
export const ProjectActivity = z.object({
  kind: z.enum(["editing", "importing", "transcribing", "caching"]),
  fraction: z.number().min(0).max(1).optional(),
  count: z.number().int().positive().optional(),
  paused: z.boolean().optional(),
});
export type ProjectActivity = z.infer<typeof ProjectActivity>;

export const ProjectSummary = z.object({
  id: Id,
  archived: z.boolean().optional(),
  name: z.string(),
  settings: ProjectSettings,
  head: Id.nullable(),
  mediaCount: z.number().int(),
  /** First video used for the library thumbnail. Old engines omit this field. */
  poster: z.object({ mediaId: Id, time: Seconds }).nullable().optional(),
  /** How long the project's video runs: the length of its head. Left out before it has one, and by old engines. */
  duration: Seconds.optional(),
  /** What waits on the editor, counted as the project's chat counts it: see countReviewDecisions. */
  pendingChanges: z.number().int(),
  openNotes: z.number().int(),
  /**
   * What Scarlet is doing in the project now, for the project list, in the order it reads: a request it is working on,
   * then files it is importing, transcribing or caching. A question waits on the editor, so `pendingChanges` counts it.
   * Nothing while Scarlet is idle. Old engines omit it.
   */
  activity: z.array(ProjectActivity).optional(),
  updatedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectDetail = z.object({
  project: Project,
  summary: ProjectSummary,
  timeline: Timeline.nullable(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const CreateProjectRequest = z.object({
  name: z.string().min(1),
  settings: ProjectSettings.partial().optional(),
});
export const ThreadDisposition = z.object({ done: z.boolean(), revision: z.string().max(2048) });
export const UpdateProjectRequest = z.object({
  mediaPaused: z.boolean().optional(),
  /** Only initialize a new project’s format while it still matches the creation snapshot. */
  expectedFormat: z.object({ settings: ProjectSettings, head: Id.nullable() }).optional(),
  archived: z.boolean().optional(),
  name: z.string().min(1).optional(),
  settings: ProjectSettings.partial().optional(),
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const WaveformResponse = z.object({
  mediaId: Id,
  from: Seconds,
  to: Seconds,
  /** Peak amplitude per bucket, 0..1. */
  peaks: z.array(z.number()),
  /** RMS per bucket, 0..1. */
  rms: z.array(z.number()).optional(),
  speechActivity: z.array(TimeRange).optional(),
});
export type WaveformResponse = z.infer<typeof WaveformResponse>;

// ---------------------------------------------------------------------------
// Versions & changes
// ---------------------------------------------------------------------------

export const VersionSummary = z.object({
  revertsVersion: Id.optional(),
  version: Id,
  parent: Id.nullable(),
  name: z.string(),
  author: Author.optional(),
  changeId: Id.nullable().default(null),
  description: z.string().optional(),
  duration: Seconds,
  isHead: z.boolean(),
  createdAt: z.string().datetime().optional(),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

/**
 * Propose a change. Provide either `ops` (applied to `fromVersion`, default head)
 * or a full `timeline`. The server validates, stores the new version, computes
 * the diff and affected ranges, creates the Change in `proposed` state and
 * queues before/after segment renders. Humans with `autoApprove` (e.g. the
 * editor fixing something by hand) can skip review.
 */
export const ProposeChangeRequest = z.object({
  intent: EditIntent.optional(),
  firstCut: z.boolean().optional(),
  /** Synchronized ripple removals in the coordinates of the base version. */
  range: TimeRange.optional(),
  fromVersion: Id.optional(),
  ops: z.array(TimelineOp).optional(),
  timeline: WritableTimeline.optional(),
  description: z.string().min(1),
  noteIds: z.array(Id).optional(),
  taskId: Id.optional(),
  /** Override author (agent hosts set this to the agent/model that did the work). */
  author: Author.partial().optional(),
  autoApprove: z.boolean().optional(),
  timelineEdits: Change.shape.timelineEdits,
  /** Skip before/after segment renders (e.g. metadata-only changes). */
  skipRender: z.boolean().optional(),
});
export type ProposeChangeRequest = z.infer<typeof ProposeChangeRequest>;

export const DialogueCutKind = z.enum(["pause", "filler", "retake", "coaching"]);
export type DialogueCutKind = z.infer<typeof DialogueCutKind>;

export const CrossfadeFrames = z.number().int().min(0).max(12);

/** Outcome of the requested audio crossfade, including cuts carried into the submission's review. */
export interface JoinCrossfades {
  /** Total overlap requested for the new cuts in this submission, in project frames. */
  frames: number;
  faded: number;
  plain: Array<{ version: string; at: number; reason: string }>;
}

export const DialogueCutsRequest = ProposeChangeRequest.pick({ description: true, taskId: true, author: true, noteIds: true }).extend({
  fromVersion: Id,
  /** Centered audio overlap in project frames at new joins. Omitted or zero gives a straight cut. */
  crossfadeFrames: CrossfadeFrames.optional(),
  /** Scope and explicitly preserved passages on fromVersion. */
  range: TimeRange.optional(),
  kept: z.array(TimeRange).optional(),
  cuts: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
    originalRange: TimeRange.optional(), review: z.boolean(), reason: z.string().min(1),
    /** Editorial classification, also used to enforce the scope of a local pause edit. */
    kind: DialogueCutKind.optional(),
    /** A doubt the editor must settle by listening or looking. Marks an applied cut as needing them until they keep it. */
    check: z.string().trim().min(1).max(120).optional() })
    .refine(c => !c.originalRange || (c.review && c.originalRange.start <= c.start && c.end <= c.originalRange.end),
      "A repaired range must be staged inside its originally proposed removal.")).min(1),
});
export type DialogueCutsRequest = z.infer<typeof DialogueCutsRequest>;

/** Move one staged cut. Without an explicit inspected version, times are on the original pass. */
export const StagedCutRevision = ProposeChangeRequest.pick({ taskId: true, author: true, noteIds: true }).extend({
  version: Id.optional(),
  /** Omitted keeps this cut’s recorded overlap. */
  crossfadeFrames: CrossfadeFrames.optional(),
  /** Relative moves are measured from the named cut's two edges. Return the successor before applying one there. */
  requireCurrentCut: z.literal(true).optional(),
  keep: z.boolean().optional(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  reason: z.string().trim().min(1).max(800),
});
export type StagedCutRevision = z.infer<typeof StagedCutRevision>;

/** The editor's calls on a dialogue pass's staged cuts, sent whole each time. applyWhenDone: apply them once the pass finishes. */
export const CutChoicesRequest = z.object({
  fromVersion: z.string(), toVersion: z.string(),
  choices: z.array(z.object({ index: z.number().int().nonnegative(), choice: z.enum(["cut", "keep"]) })).max(2000),
  applyWhenDone: z.boolean().optional(),
});
export type CutChoicesRequest = z.infer<typeof CutChoicesRequest>;

export const ApproveRequest = z.object({
  /** Indices into change.ranges to approve; omit to approve every spot. */
  spots: z.array(z.number().int().min(0)).optional(),
  restoredCuts: z.array(z.number().int().min(0)).optional(),
}).refine(v => !(v.spots && v.restoredCuts), "Choose spots or restored cuts");
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const ApproveResponse = z.object({
  change: Change,
  project: Project,
  /**
   * applied: taken as-is · rebased: re-applied onto a cut that moved since ·
   * partial: only the chosen spots · sent_back: overlapped with something
   * approved since, so the agent is redoing it on the current cut.
   */
  outcome: z.enum(["applied", "rebased", "partial", "sent_back", "conflict"]),
  reason: z.string().optional(),
  task: z.lazy(() => Task).optional(),
});
export type ApproveResponse = z.infer<typeof ApproveResponse>;

/** Provider option IDs are also passed as CLI arguments on Windows. */
export const AgentOptionId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const AgentEffort = AgentOptionId;
export const ModelTuning = z.object({
  effort: AgentEffort.optional(),
  serviceTier: AgentOptionId.optional(),
});

export const ReviseRequest = ModelTuning.extend({
  skillIds: z.array(Id).optional(),
  position: Note.pick({ time: true, end: true, clipIds: true }).extend({ version: Id.optional(), mediaId: Id.optional(), cutIndex: z.number().int().nonnegative().optional() }).optional(),
  text: z.string().min(1),
  voiceTranscript: z.string().optional(),
  /** Agent to send the revision to. Defaults to the change's author. */
  assignTo: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const CreateNoteRequest = ModelTuning.extend({
  skillIds: z.array(Id).optional(),
  version: Id.optional(),
  time: Seconds,
  end: Seconds.optional(),
  clipIds: z.array(Id).optional(),
  text: z.string().min(1),
  voiceTranscript: z.string().optional(),
  /** Agent id (e.g. "claude", "codex", "gemini") to dispatch to; omit to leave the note unassigned. */
  assignTo: z.string().optional(),
  changeId: Id.optional(),
});
export const UpdateNoteRequest = Note.pick({ text: true, state: true, assignedTo: true }).partial();

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

/** Canonical browser destination for a change or task notification. */
export function reviewItemPath(projectId: string, itemId: string): string {
  return `/p/${encodeURIComponent(projectId)}?thread=${encodeURIComponent(itemId)}`;
}

/** The project inputs for a full render. Workspace encoder settings are reflected in the engine's keys. */
export function fullRenderContext(project: Pick<Project, "id" | "head" | "settings">): string {
  return stableStringify([project.id, project.head, project.settings]);
}

export interface PlaybackCacheStatus {
  state: "uncached" | "caching" | "ready" | "failed";
  progress?: number;
  /** While caching: about how many seconds are left, once this run's pace is known. */
  remainingSeconds?: number;
  /** Pins subsequent source byte-range requests to the same completed preview. */
  fileKey?: string;
}

/** One video's full-length playback cache, as listed for a whole project. */
export interface SourceCacheStatus extends PlaybackCacheStatus {
  mediaId: string;
  /** Waiting its turn, or held while the project's media processing is paused. */
  queued?: boolean;
}

/**
 * How much of the footage a project is caching is cached, from 0 to 1, by length: a cached video counts whole, one under
 * way by its own figure, one waiting its turn as nothing. A video that failed, or that isn't to be cached, isn't in it,
 * so the figure can reach the end. Videos count alike when one has no length to weigh it by. The project list and the
 * project's own menu both read it, so they give the same figure. Undefined while no video counts.
 */
export function cachedShare(videos: Array<{ cache: SourceCacheStatus; seconds: number }>): number | undefined {
  const counted = videos.filter(v => v.cache.state === "ready" || v.cache.state === "caching" || v.cache.queued);
  if (!counted.length) return undefined;
  const weigh = counted.every(v => v.seconds > 0) ? (v: typeof counted[number]) => v.seconds : () => 1;
  let whole = 0;
  let done = 0;
  for (const v of counted) {
    whole += weigh(v);
    done += weigh(v) * (v.cache.state === "ready" ? 1 : v.cache.state === "caching" ? v.cache.progress ?? 0 : 0);
  }
  return Math.min(1, done / whole);
}

export interface FullRenderKeys {
  context: string;
  preview: string;
  delivery: string;
}

/** Stream and container measurements read from a completed output on demand. */
export interface RenderFileInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  sampleRate?: number;
  channels?: number;
  /** EBU R128 loudness of the file's sound, as heard with every gain and effect. Silence reads null. */
  loudness?: { integratedLufs: number | null; loudnessRangeLu: number | null; truePeakDbtp: number | null };
}

export const RenderKind = z.enum(["segment", "full", "proxy", "preview", "playback", "export"]);
export type RenderKind = z.infer<typeof RenderKind>;

export const RenderState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
const HardwareEncoder = z.enum(["none", "auto", "nvenc", "qsv", "videotoolbox"]);

const ExportOptions = z.object({
  height: z.number().int().min(2).max(16384).multipleOf(2).optional(),
  omitCaptions: z.boolean().optional(),
});

/** Where a desktop export saves its file. The ticket names a destination only the desktop app can resolve. */
const ExportSave = z.object({
  name: z.string().min(1).max(255),
  ticket: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  path: z.string().max(4096).optional(),
});

export const Render = z.object({
  exportOptions: ExportOptions.optional(),
  /** A desktop export still owed to the editor. It outlives the engine, unlike other owned renders. */
  export: ExportSave.extend({ owner: z.string().uuid() }).optional(),
  /** Finished, seekable segments of an in-progress full preview. */
  cachedRanges: z.array(TimeRange).optional(),
  id: Id,
  projectId: Id,
  version: Id,
  kind: RenderKind,
  quality: z.enum(["preview", "delivery"]).optional(),
  /** Settings captured when queued. Older render rows lack these fields. */
  projectSettings: ProjectSettings.optional(),
  hwaccel: HardwareEncoder.optional(),
  range: TimeRange.nullable().default(null),
  /** Content key: hash of (version content, range, settings). Equal keys share a file. */
  key: z.string(),
  /** Immutable inputs to a shareable render. The request key above remains version-specific. */
  previewContentKey: z.string().optional(),
  /** Pending work owned by live desktop requests in this engine process. */
  demandPid: z.number().int().positive().optional(),
  /** Engine that owns the encoder or its queued slot, including after a viewer requests durable work. */
  queuePid: z.number().int().positive().optional(),
  path: z.string().nullable().default(null),
  state: RenderState,
  progress: z.number().min(0).max(1).default(0),
  durationSeconds: Seconds.optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  /** Why it failed, for the editor. */
  error: z.string().optional(),
  /** Why it failed in the renderer's own words, such as ffmpeg's output: the evidence an agent reads. */
  errorDetail: z.string().optional(),
  changeId: Id.optional(),
  createdAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type Render = z.infer<typeof Render>;

export const RenderRequest = z.object({
  exportOptions: ExportOptions.optional(),
  version: Id.optional(),
  /** A desktop export or automatic cut cache can release its demand when the editor leaves. */
  owner: z.string().uuid().optional(),
  /** Keep this owner's export across a restart, until the owner releases it. */
  export: ExportSave.optional(),
  kind: RenderKind.default("full"),
  range: TimeRange.optional(),
  /** Output quality preset. */
  quality: z.enum(["preview", "delivery"]).default("preview"),
});

// ---------------------------------------------------------------------------
// Agent tasks
// ---------------------------------------------------------------------------

/** Known agent runtimes. Hosts report which are installed and logged in. */
export const AgentId = z.enum(["claude", "codex", "gemini", "api"]);
export type AgentId = z.infer<typeof AgentId>;

/** What each agent is called, in the interface and in the sentences the engine keeps in a project's history. */
export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  api: "API",
};

/** Note assignments accept an agent alone or an agent and an exact CLI model ID. */
export function agentTarget(agent: AgentId, model?: string): string {
  return model ? `${agent}:${model}` : agent;
}

export function splitAgentTarget(value: string) {
  const sep = value.search(/[:/]/);
  return sep < 0 ? { agent: value, model: undefined } : { agent: value.slice(0, sep), model: value.slice(sep + 1) || undefined };
}

const ModelOption = z.object({ id: AgentOptionId, label: z.string().optional(), description: z.string().optional() });
export const ModelOptions = z.object({
  efforts: z.array(ModelOption),
  speeds: z.array(ModelOption),
  defaultEffort: AgentOptionId.optional(),
  defaultSpeed: AgentOptionId.optional(),
});
export type ModelOptions = z.infer<typeof ModelOptions>;
export type AgentEffort = z.infer<typeof AgentEffort>;

export const AgentAvailability = z.object({
  id: AgentId,
  installed: z.boolean(),
  loggedIn: z.boolean().optional(),
  /** How the CLI is signed in: its own subscription (Claude Pro/Max, ChatGPT plan) or an API key. */
  auth: z.enum(["subscription", "api_key"]).optional(),
  /** Subscription tier when the CLI reports it (e.g. "max", "pro"). */
  plan: z.string().optional(),
  version: z.string().optional(),
  /** Model override the host will pass to the CLI (e.g. "opus", "gpt-5-codex"). */
  model: z.string().optional(),
  models: z.array(z.string()).optional(),
  /** Provider display names keyed by the model ID passed to the CLI. */
  modelLabels: z.record(z.string()).optional(),
  modelOptions: z.record(ModelOptions).optional(),
});
export type AgentAvailability = z.infer<typeof AgentAvailability>;

export const AgentHost = z.object({
  id: Id,
  userId: Id,
  name: z.string(),
  platform: z.string(),
  agents: z.array(AgentAvailability),
  online: z.boolean(),
  lastSeenAt: z.string().datetime().optional(),
});
export type AgentHost = z.infer<typeof AgentHost>;

export const RegisterHostRequest = z.object({
  name: z.string(),
  platform: z.string(),
  agents: z.array(AgentAvailability),
});

export const SkillSlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const TaskKind = z.enum([
  "edit", // free-form instruction against the project ("make the first cut as a 9:16 short")
  "note", // respond to a specific review note
  "revise", // revise a rejected/sent-back change
  "skill_from_change", // write a SKILL.md capturing an approved change
  "skill_edit", // revise one skill as the editor described; not part of a project's conversation
  "learning_check", // read one request for a standing rule to offer; started with the request, beside it
  "transcribe", // server-side job, not dispatched to hosts
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskState = z.enum([
  "queued",
  "claimed",
  "running",
  "waiting_for_user", // agent asked a question
  "done",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

export const Task = z.object({
  id: Id,
  projectId: Id,
  kind: TaskKind,
  /** Which agent runtime should run it. */
  agent: AgentId,
  model: z.string().optional(),
  effort: AgentEffort.optional(),
  /** Fast mode: quicker output, uses more of the plan (Claude fast mode, Codex fast tier). */
  fast: z.boolean().optional(),
  serviceTier: AgentOptionId.optional(),
  /** Plain-language instruction, already cleaned up from voice. */
  instruction: z.string(),
  /** Extra structured context the host passes to the agent. */
  context: z
    .object({
      branch: z.string().optional(),
      version: Id.optional(),
      mediaId: Id.optional(),
      /** The provider the editor chose for this one transcription, when it isn't the one in Settings. */
      transcriptionProvider: z.string().max(40).optional(),
      /** The service a transcription ran with, so a run cut off by a quit starts again by itself only with that service. */
      transcribedWith: z.string().max(40).optional(),
      /** The local engine that ran, when this was a configured local transcription. */
      localModel: LocalTranscriptionModel.optional(),
      noteIds: z.array(Id).optional(),
      changeId: Id.optional(),
      cutIndex: z.number().int().nonnegative().optional(),
      editIndex: z.number().int().nonnegative().optional(),
      /** The selected edit's number in the editor's list, which is how they and Scarlet's replies refer to it. */
      editNumber: z.number().int().positive().optional(),
      /** Slug authorized by the editor when requesting a skill from an approved change. */
      skillName: SkillSlug.optional(),
      /** The skill the editor asked Scarlet to revise. */
      skillId: Id.optional(),
      /** The learning this skill edit saves, when the editor approved one. */
      learningId: Id.optional(),
      /** The request a learning_check task reads. A rule it offers is that request's. */
      checksTaskId: Id.optional(),
      time: Seconds.optional(),
      end: Seconds.optional(),
      clipIds: z.array(Id).optional(),
      reviewAllCuts: z.boolean().optional(),
      /** Product shortcut chosen by the editor, independent of the guides pinned to this task. */
      dialogueOperation: z.enum(["none", "first-cut", "local-pauses"]).optional(),
      /** The local passage established on the first save, in this immutable version's timeline seconds. */
      dialogueRange: z.object({ version: Id, start: Seconds, end: Seconds }).optional(),
      skillIds: z.array(Id).optional(),
      /** The thread this task belongs to. Defaults to the task's own id (a new thread). */
      threadId: Id.optional(),
      /**
       * What the person actually said, when `instruction` was expanded with thread history. For a request the app
       * worded for them, such as Undo edit, it is the request's name in the chat ("Undo").
       */
      message: z.string().optional(),
      /** What such a request asked of the agent, without the thread's history. Its name alone doesn't say which edit, so the thread's later requests are told this. */
      asked: z.string().optional(),
    })
    .default({}),
  state: TaskState,
  createdBy: Author,
  hostId: Id.nullable().default(null),
  /** The skill a skill_from_change task produced, or a skill_edit task revised. */
  resultSkillId: Id.optional(),
  /** The most recent measured playback and any outstanding request to finish checking it. */
  repeatAudit: z.object({
    version: z.string(), remaining: z.number().int().nonnegative().optional(),
    /** Every audible passage in scope was checked and there were no repeats or joins to review. */
    noFindings: z.boolean().optional(),
    unavailable: z.array(z.string()).optional(), returns: z.number().int().nonnegative().default(0),
  }).optional(),
  /** Change(s) produced. */
  changeIds: z.array(Id).default([]),
  /** Median running time of recent comparable completed requests, when available. */
  expectedSeconds: z.number().positive().optional(),
  /** A running transcription: waiting its turn behind other audio work, or how much is done. */
  progress: z.object({
    stage: z.enum(["queued", "transcribing", "aligning"]),
    fraction: z.number().min(0).max(1),
    remainingSeconds: z.number().nonnegative().optional(),
    /**
     * The same for the words alone. The transcript is saved once it has them, before word alignment, and a dialogue
     * pass reads it from then on, so this is the part of the job a pass waits for.
     */
    words: z.object({ fraction: z.number().min(0).max(1), remainingSeconds: z.number().nonnegative().optional() }).optional(),
  }).optional(),
  /** The worker stopped before finishing, possibly after saving changes. */
  interrupted: z.boolean().optional(),
  /**
   * A finished run waited for these recordings' transcripts or dialogue analysis and ended before they were ready,
   * so it saved only what it could do without them. Scarlet measures this from the run's waits; it can be resumed.
   */
  needsTranscripts: z.array(Id).optional(),
  /** The editor asked Scarlet to resume this run as soon as `needsTranscripts` are ready. */
  continueWhenReady: z.boolean().optional(),
  retryTaskId: Id.optional(),
  /** Server-assigned original attempt whose workspace and progress this run continues. */
  resumeRootId: Id.optional(),
  /** Whether the selected cut was still staged when the request was made. Editing an applied cut uses the timeline. */
  stagedCutRevision: z.boolean().optional(),
  /**
   * The editor is changing this queued request's words. No host claims it until then, and the requests behind it keep
   * waiting, so it can't start with the words being replaced. The app renews it while the words are open.
   */
  rewordingUntil: z.string().datetime().optional(),
  /**
   * The editor told this queued request to start without waiting for their calls on a dialogue pass. It still takes
   * its turn behind what Scarlet is on and what is ahead of it in line.
   */
  startsBeforeCalls: z.boolean().optional(),
  /** The CLI session that asked the pending question; the host resumes it with the answer. */
  session: z.object({ agent: AgentId, id: z.string().min(1) }).optional(),
  /** Pending question from the agent, if waiting_for_user. */
  question: z.string().nullable().default(null),
  /** Where the editor can hear the updated passage while answering a question about a staged cut. */
  cutConflict: z.object({ version: Id, range: TimeRange.optional(), changeId: Id.optional(), index: z.number().int().nonnegative().optional(),
    answered: z.literal(true).optional(), retried: z.literal(true).optional(),
    /** The editor already approved this call before the agent was asked to recheck it. */
    approved: z.literal(true).optional() }).optional(),
  summary: z.string().nullable().default(null),
  /**
   * What Scarlet said to the editor as a dialogue pass finished. The pass's `summary` is Scarlet's receipt of what it
   * saved, so its own words are kept here: those of the pass itself, not of the repeat check that follows it.
   */
  reply: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type Task = z.infer<typeof Task>;

/** Retrying is safe only if an editing worker failed before saving an output. */
export function canRetryTask(task: Task): boolean {
  return task.state === "failed" && task.kind !== "transcribe" && !task.changeIds.length && !task.resultSkillId;
}

/**
 * The host stopped the run before it finished, keeping what it saved. Hosts mark this as `interrupted`;
 * older ones stopped every run at 45 minutes and recorded only "timed out".
 */
export function taskWasStopped(task: Task): boolean {
  return task.state === "failed" && (!!task.interrupted || /^timed out\b/.test(task.error ?? ""));
}

/** The run ended without the transcripts it waited for, keeping what it saved. */
export function taskNeedsTranscripts(task: Task): boolean {
  return task.state === "done" && !!task.needsTranscripts?.length && !task.retryTaskId;
}

export function taskRecoveryAction(task: Task, hasLinkedChange: boolean): "resume" | "retry" | undefined {
  if (task.kind === "transcribe" || task.resultSkillId) return;
  if (task.state === "cancelled" || taskWasStopped(task) || taskNeedsTranscripts(task)) return "resume";
  if (canRetryTask(task) && !hasLinkedChange) return task.resumeRootId ? "resume" : "retry";
}

/** The editor-selected destination available to a live skill authoring task. */
export function skillTaskTarget(task: Task, projectId: string) {
  if (task.kind !== "skill_from_change" || task.projectId !== projectId || !task.hostId ||
      (task.state !== "claimed" && task.state !== "running") || !task.context.changeId || !task.context.skillName) return undefined;
  return { name: task.context.skillName, changeId: task.context.changeId, hostId: task.hostId };
}

/** The one skill a live skill-edit task may revise: the one the editor asked about. */
export function skillEditTarget(task: Task, projectId: string) {
  if (task.kind !== "skill_edit" || task.projectId !== projectId || !task.hostId ||
      (task.state !== "claimed" && task.state !== "running") || !task.context.skillId) return undefined;
  return { skillId: task.context.skillId, hostId: task.hostId };
}

/** A request to revise a skill. It isn't about the project it runs in. */
export function isSkillEdit(task: Pick<Task, "kind">): boolean {
  return task.kind === "skill_edit";
}

/** The check that reads a request for a standing rule. It runs beside the request and edits nothing. */
export function isLearningCheck(task: Pick<Task, "kind">): boolean {
  return task.kind === "learning_check";
}

/** A run that edits no video, so it stays out of the project's conversation and queue: a skill edit or a learning check. */
export function isAsideTask(task: Pick<Task, "kind">): boolean {
  return isSkillEdit(task) || isLearningCheck(task);
}

export const TaskSkillDraft = z.object({
  description: z.string().trim().min(1).max(1024).regex(/^[^\r\n]+$/),
  instructions: z.string().trim().min(1).max(128 * 1024),
});
export type TaskSkillDraft = z.infer<typeof TaskSkillDraft>;

export const CreateTaskRequest = z.object({
  kind: TaskKind.default("edit"),
  agent: AgentId,
  model: z.string().optional(),
  effort: AgentEffort.optional(),
  fast: z.boolean().optional(),
  serviceTier: AgentOptionId.optional(),
  instruction: z.string().min(1),
  voiceTranscript: z.string().optional(),
  context: Task.shape.context.removeDefault().omit({ dialogueOperation: true, dialogueRange: true }).optional(),
});

/**
 * New words for a request still waiting its turn, and the skills their /commands name, resolved as a send resolves
 * them. The skills replace the request's: words that no longer name a skill don't run it.
 */
export const RewordTaskRequest = z.object({
  text: z.string().trim().min(1),
  skillIds: z.array(Id).optional(),
});

/** The agent and model the editor chose for a run, as the message box sends it. */
export const RunChoice = z.object({
  agent: AgentId.optional(),
  model: z.string().optional(),
  effort: AgentEffort.optional(),
  fast: z.boolean().optional(),
  serviceTier: AgentOptionId.optional(),
});
export type RunChoice = z.infer<typeof RunChoice>;

/** What the editor wants changed in a skill, in their words, and the model they chose to do it. */
export const EditSkillRequest = RunChoice.extend({
  prompt: z.string().trim().min(1).max(8000),
});

/** Source seconds in a dialogue scan. A page has no "to" until the scanner finishes it. */
/**
 * A standing rule Scarlet picked up from a request, for one of the editor's skills. It changes nothing until the
 * editor approves it; approving it has an agent work it into the skill.
 */
export const LearningState = z.enum(["suggested", "saving", "saved", "declined"]);
export type LearningState = z.infer<typeof LearningState>;
export const LearningRule = z.string().trim().min(1).max(280).regex(/^[^\r\n]+$/);
/** What a skill already says that a rule would change, quoted from it. */
export const LearningReplaces = z.array(z.string().trim().min(1).max(600)).max(6);
export const Learning = z.object({
  id: Id,
  projectId: Id,
  /** The rule in one sentence, as it would read in the skill. */
  rule: LearningRule,
  /** What the editor said in the request it came from. */
  said: z.string(),
  /** The request it came from. */
  taskId: Id,
  /** The skill it would go into: the agent's pick, or the editor's once they chose another. */
  skillId: Id,
  /**
   * What that skill already says that the rule contradicts or overrides, quoted from it word for word. The editor
   * sees it beside the rule before deciding, and approving the rule chooses it over these. Only for the skill the
   * rule was offered for: approved for another, it is dropped.
   */
  // A later approval can cover additional passages quoted to the editor after the original offer.
  replaces: z.array(z.string().min(1)).optional(),
  state: LearningState,
  /** Who approved it. The skill edit that saves it runs in their name. */
  approvedBy: Author.optional(),
  /** The model chosen when it was approved. The skill edit that saves it runs on it. */
  runWith: RunChoice.optional(),
  /** The skill edit saving it, once one has started. */
  editTaskId: Id.optional(),
  /** Why the last attempt to save it changed nothing. */
  error: z.string().optional(),
  /** Why the save before this approval changed nothing, which the editor read before approving again. */
  approvedAfter: z.string().optional(),
  createdAt: z.string().datetime().optional(),
});
export type Learning = z.infer<typeof Learning>;

/**
 * A rule an agent offers from the request it is working on, the skill it belongs in, by id or exact name, and what
 * that skill already says that the rule would change.
 */
export const SuggestLearningRequest = z.object({ rule: LearningRule, skill: z.string().trim().min(1).max(200), replaces: LearningReplaces.optional() });
export type SuggestLearningRequest = z.infer<typeof SuggestLearningRequest>;
/** The editor's approval, with the skill they chose when it isn't the suggested one, and the model chosen now. */
export const ApproveLearningRequest = RunChoice.extend({ skillId: Id.optional() });
export type ApproveLearningRequest = z.infer<typeof ApproveLearningRequest>;
/** The editor's own wording for a rule that waits on them. It is saved to the skill as they wrote it. */
export const ReviseLearningRequest = z.object({ rule: LearningRule });
export type ReviseLearningRequest = z.infer<typeof ReviseLearningRequest>;

export const DialogueScanPage = z.object({
  mediaId: Id,
  from: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  to: z.number().finite().optional(),
}).refine(p => p.from < p.end && (p.to === undefined || (p.to > p.from && p.to <= p.end)));
export type DialogueScanPage = z.infer<typeof DialogueScanPage>;

export const TaskEvent = z.object({
  id: Id.optional(),
  taskId: Id.optional(),
  at: z.string().datetime().optional(),
  type: z.enum([
    "log", // agent stdout line / progress message
    "tool", // agent called a Scarlet tool
    "question", // agent needs input → task enters waiting_for_user
    "answer", // human answered
    "change", // a change was proposed
    "plan", // the agent's own to-do list, as its harness reported it: data is a TaskPlan
    "error",
  ]),
  text: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/**
 * One step of the plan an agent keeps for itself, in its own words. `state` is what the harness said and nothing
 * more: Codex's headless stream marks a step finished or not, so its steps are never "in_progress".
 */
export const PlanStep = z.object({ text: z.string().trim().min(1), state: z.enum(["pending", "in_progress", "done"]) });
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * A `plan` event's data: every step of the agent's plan as it stood when the harness reported it (Claude Code's task
 * tools, Codex's `update_plan`). Scarlet asks for one where the harness has the tool and the chat will show it, sets none of its steps and never edits it. No steps means the agent cleared it.
 */
export const TaskPlan = z.object({ steps: z.array(PlanStep).max(100) });
export type TaskPlan = z.infer<typeof TaskPlan>;

/** How a plan reads as an event's text, in logs and exports: one step a line, "[x]" done, "[>]" under way, "[ ]" to come. */
export function planText(steps: readonly PlanStep[]): string {
  return steps.map(step => `${step.state === "done" ? "[x]" : step.state === "in_progress" ? "[>]" : "[ ]"} ${step.text}`).join("\n") || "Plan cleared";
}

/**
 * The plan a run is working to: the last one its harness reported. A run picked up again after the editor's answer
 * starts without one, because nothing says the harness still keeps the plan it had before the question.
 */
export function taskPlan(events: readonly Pick<TaskEvent, "type" | "data">[]): PlanStep[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "answer") return undefined;
    if (event.type !== "plan") continue;
    const plan = TaskPlan.safeParse(event.data);
    return plan.success && plan.data.steps.length ? plan.data.steps : undefined;
  }
  return undefined;
}

export const CompleteTaskRequest = z.object({
  state: z.enum(["done", "failed", "cancelled"]),
  /** Only finish this still-active claim. A newer claim or an editor answer wins. */
  ifStartedAt: z.string().datetime().optional(),
  interrupted: z.boolean().optional(),
  /** The run stopped because its engine went away, and a host started for the next engine reports it. It counts as a
   * lost worker: a run whose own work keeps crashing the engine stops resuming by itself. */
  engineLost: z.boolean().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  changeIds: z.array(Id).optional(),
});

/** The one prompt every host gives its CLI, built by the engine. */
export const TaskPrompt = z.object({
  systemPrompt: z.string(),
  instruction: z.string(),
  /** Continue this CLI session with `instruction` (the editor's answer). Absent: start a fresh run. */
  resumeSession: z.string().optional(),
  /** Launch the CLI with its own to-do tool on, so the plan it keeps reaches Scarlet (`plan` in capabilities.ts). */
  plan: z.boolean().optional(),
});
export type TaskPrompt = z.infer<typeof TaskPrompt>;

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

const TokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Tokens one agent run reported, normalized across CLIs. `inputTokens` excludes
 * cache reads and writes. `reasoningTokens` is the part of `outputTokens` spent on
 * reasoning, where the CLI reports it. Scarlet tracks tokens, not cost: runs use
 * the editor's subscription.
 */
export const AgentUsage = z.object({
  model: z.string().min(1).max(200).optional(),
  inputTokens: TokenCount.default(0),
  outputTokens: TokenCount.default(0),
  cacheReadTokens: TokenCount.default(0),
  cacheWriteTokens: TokenCount.default(0),
  reasoningTokens: TokenCount.default(0),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

/** One run of a task. `startedAt` is the claim's start, so a repeated report replaces the first. */
export const RecordTaskUsageRequest = AgentUsage.extend({ startedAt: z.string().datetime().optional() });
export type RecordTaskUsageRequest = z.input<typeof RecordTaskUsageRequest>;

export const UsageGroupBy = z.enum(["project", "thread", "task", "agent", "model", "day"]);
export type UsageGroupBy = z.infer<typeof UsageGroupBy>;

export const UsageTotals = z.object({
  runs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  /** Input, output and cache tokens together. */
  totalTokens: z.number().int().nonnegative(),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageGroup = UsageTotals.extend({ key: z.string().nullable() });
export type UsageGroup = z.infer<typeof UsageGroup>;

export const UsageResponse = z.object({ by: UsageGroupBy, total: UsageTotals, groups: z.array(UsageGroup) });
export type UsageResponse = z.infer<typeof UsageResponse>;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const Skill = z.object({
  id: Id,
  /** Folder name, e.g. "dialogue-pass". */
  name: SkillSlug,
  description: z.string(),
  /** Full SKILL.md contents including frontmatter. */
  content: z.string(),
  // Keep the original global scope on the wire for older desktop hosts.
  scope: z.literal("team"),
  ownerId: z.null().default(null),
  projectId: z.null().default(null),
  /** Older clients expect an empty list for a skill available to every agent. */
  agents: z.array(AgentId).default([]).transform((): AgentId[] => []),
  enabled: z.boolean().default(true),
  version: z.number().int().default(1),
  /** Original shipped name, retained when the editor customizes the guide. */
  bundledName: SkillSlug.optional(),
  /** "bundled" or "seed" while a skill Scarlet came with is unedited, then unset. Otherwise where an added skill came from. */
  source: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Skill = z.infer<typeof Skill>;

export const SkillVersion = z.object({
  version: z.number().int(),
  content: z.string(),
  author: Author.optional(),
  createdAt: z.string().datetime().optional(),
});
export type SkillVersion = z.infer<typeof SkillVersion>;

export const UpsertSkillRequest = Skill.pick({
  name: true,
  description: true,
  content: true,
  scope: true,
  projectId: true,
  agents: true,
  enabled: true,
}).partial({ scope: true, projectId: true, agents: true, enabled: true, description: true });

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

/**
 * One thing that happened, recorded permanently: changes proposed, approved,
 * rejected, undone; versions restored; imports from DaVinci; notes; requests;
 * uploads; settings changes; deletions and restores.
 */
export const ActivityEntry = z.object({
  id: Id,
  /** Null for server-wide events (quick actions, skills). */
  projectId: Id.nullable(),
  actor: Author,
  type: z.string(),
  summary: z.string(),
  /** Ids and values for linking (changeId, version, threadId, …). */
  data: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const TrashedProject = z.object({ id: Id, name: z.string(), deletedAt: z.string().datetime(), purgeAt: z.string().datetime() });
export type TrashedProject = z.infer<typeof TrashedProject>;

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

/** A saved instruction an editor runs in one move ("Remove dead air and repeated lines"). */
export const QuickAction = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  instruction: z.string().min(1),
  /** "video": the whole cut · "playhead": the moment you're on (Watch) or the change in focus. */
  target: z.enum(["video", "playhead"]).default("video"),
  /** Legacy (from multi-user days); every action is available everywhere. */
  scope: z.enum(["personal", "team"]).default("personal"),
  ownerId: Id.nullable().default(null),
  /** Optional agent/model; otherwise the one picked in the composer. */
  agent: AgentId.optional(),
  model: z.string().optional(),
  /** 1–9: run with that number key. */
  hotkey: z.number().int().min(1).max(9).optional(),
  createdBy: Id.nullable().default(null),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type QuickAction = z.infer<typeof QuickAction>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export { LocalTranscriptionModel };

export type TelemetryUnavailable = "environment" | "unconfigured";

export const ServerSettings = z.object({
  telemetryEnabled: z.boolean().default(true),
  editingTools: EditingTools.default({}),
  /** Transcription provider: "openai" (API key), "whispercpp" (local binary), "none" (no engine in this build: not a choice the editor can make). */
  transcription: z.object({
    provider: z.enum(["openai", "whispercpp", "none"]).default("none"),
    /** Omitted by older releases, which selected a custom model by saving its paths. */
    localModel: LocalTranscriptionModel.optional(),
    openaiModel: z.string().default("whisper-1"),
    whisperCppPath: z.string().optional(),
    whisperModelPath: z.string().optional(),
    language: z.string().optional(),
  }),
  /** Small-model "note cleanup" (voice transcript → precise instruction). */
  noteCleanup: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(["anthropic", "openai", "none"]).default("none"),
    model: z.string().optional(),
  }),
  render: z.object({
    /** Seconds of context on each side of a change clip. */
    handleSeconds: z.number().min(0).default(1.5),
    previewHeight: z.number().int().default(DEFAULT_PREVIEW_HEIGHT),
    concurrency: z.number().int().min(1).default(2),
    hwaccel: HardwareEncoder.default("auto"),
  }),
  /** Default agent for new tasks when the UI doesn't pick one. */
  defaultAgent: AgentId.default("claude"),
});
export type ServerSettings = z.infer<typeof ServerSettings>;

export function selectedLocalModel(settings: Pick<ServerSettings["transcription"], "localModel" | "whisperCppPath" | "whisperModelPath">): LocalTranscriptionModel {
  return settings.localModel ?? (settings.whisperCppPath || settings.whisperModelPath ? "custom" : "crisperwhisper");
}

// ---------------------------------------------------------------------------
// WebSocket events
// ---------------------------------------------------------------------------

export const SpeakerProgress = z.object({
  phase: z.enum(["audio", "models", "segmenting", "identifying", "grouping", "matching"]),
  percent: z.number().int().min(0).max(100).optional(),
});
export type SpeakerProgress = z.infer<typeof SpeakerProgress>;

export const WsEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.subscribed"), projectId: Id, found: z.boolean() }),
  z.object({ type: z.literal("project.updated"), projectId: Id, project: Project }),
  z.object({ type: z.literal("media.updated"), projectId: Id, media: MediaAsset }),
  /** A file was taken out of the project. */
  z.object({ type: z.literal("media.removed"), projectId: Id, mediaId: Id }),
  z.object({ type: z.literal("media.previewReady"), projectId: Id, mediaId: Id }),
  z.object({ type: z.literal("media.speakerProgress"), projectId: Id, active: z.record(Id, SpeakerProgress) }),
  z.object({ type: z.literal("media.import.checking"), projectId: Id, importId: z.string().uuid(), fraction: z.number().min(0).max(1) }),
  z.object({ type: z.literal("change.updated"), projectId: Id, change: Change }),
  z.object({ type: z.literal("note.updated"), projectId: Id, note: Note }),
  z.object({ type: z.literal("render.updated"), projectId: Id, render: Render }),
  z.object({ type: z.literal("render.settings.updated") }),
  z.object({ type: z.literal("task.updated"), projectId: Id, task: Task }),
  z.object({ type: z.literal("task.event"), projectId: Id, taskId: Id, event: TaskEvent }),
  /** The task's token totals across its runs, after a run reported usage. */
  z.object({ type: z.literal("task.usage"), projectId: Id, taskId: Id, usage: UsageTotals }),
  z.object({ type: z.literal("host.updated"), host: AgentHost }),
  z.object({ type: z.literal("skill.updated"), skill: Skill }),
  z.object({ type: z.literal("learning.updated"), projectId: Id, learning: Learning }),
  z.object({ type: z.literal("activity.added"), projectId: Id.nullable(), entry: ActivityEntry }),
  z.object({
    type: z.literal("notification"),
    title: z.string(),
    body: z.string().optional(),
    projectId: Id.optional(),
    link: z.string().optional(),
  }),
]);
export type WsEvent = z.infer<typeof WsEvent>;

export const WsClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), projectId: Id }),
  z.object({ type: z.literal("unsubscribe"), projectId: Id }),
  z.object({ type: z.literal("ping") }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export { ChangeState };

export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;
export type RenderRequest = z.infer<typeof RenderRequest>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;
export type RewordTaskRequest = z.infer<typeof RewordTaskRequest>;
export type EditSkillRequest = z.infer<typeof EditSkillRequest>;
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequest>;
export type UpsertSkillRequest = z.infer<typeof UpsertSkillRequest>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
export type ReviseRequest = z.infer<typeof ReviseRequest>;
export type RegisterHostRequest = z.infer<typeof RegisterHostRequest>;

/** Nearby clauses of one recording whose words closely repeat: attempts at the same line. Source seconds. */
export interface RetakeGroup {
  score: number;
  takes: Array<{ start: number; end: number; text: string }>;
}

export type LocalModelStatus = (
  | { state: "downloading"; received: number; total: number }
  | { state: "missing" | "checking" | "ready" | "failed" | "invalid" }
) & {
  selected?: LocalTranscriptionModel;
  active?: LocalTranscriptionModel;
  fallback?: boolean;
  reason?: string;
};
