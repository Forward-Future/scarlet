/**
 * Scarlet HTTP + WebSocket API contract.
 *
 * Base URL: http://<server>/api
 * Auth: `Authorization: Bearer <token>`. Scarlet is single-user: the server
 * creates one local user and an access token on first start. The desktop shell
 * receives the token through the engine startup handshake.
 * All bodies are JSON. Errors are `{ error: { code, message } }` with 4xx/5xx.
 *
 * This file holds the project, media, render, activity and settings shapes. The others named below have modules of
 * their own: agents and hosts (agents.ts), requests (tasks.ts), versions, changes and notes (changes.ts), learnings,
 * token usage, graphics, skills, and WebSocket events (wsEvents.ts).
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
 *   POST   /projects/:id/stop-editing                    → { project: Project, tasks: Task[] }
 *   POST   /projects/:id/resume-editing                  → { project: Project, tasks: Task[] }
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
 *   GET    /projects/:id/versions/:v/export.srt          → application/x-subrip (SubRip); ?trackId&start&end
 *   GET    /projects/:id/versions/:v/export.vtt          → text/vtt (WebVTT); ?trackId&start&end
 *   POST   /projects/:id/versions/:v/handoff { folder }  → HandoffResponse (the folder for finishing the edit in another app)
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
 *   POST   /tasks/:taskId/cancel?queuedOnly=1&withdrawn=1 → { task: Task } (both optional; withdrawn: the editor took the words back, so no rule is learned from them)
 *   POST   /tasks/:taskId/retry  RunChoice?              → { task: Task } (resume an interrupted request or retry a failure, on the model given)
 *   POST   /tasks/:taskId/answer    { text, attachments?, pictureMarks? } → { task: Task } (human answers an agent question; files sent with it are kept with the request)
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
 *   POST   /tasks/:taskId/usage     RecordTaskUsageRequest → {}           (tokens one claim reported so far; startedAt names the claim)
 *   GET    /hosts                                       → { hosts: AgentHost[] }
 *
 *  Skills
 *   GET    /skills?projectId=&taskId=&view=              → { skills: Skill[] }
 *
 *  Graphics and the style guide
 *   POST   /projects/:id/graphics   multipart (options: GraphicRenderRequest, html?, asset*) → GraphicRenderResponse
 *   GET    /projects/:id/graphics/:mediaId               → { html, source, width, height, fps, duration }
 *   PUT    /projects/:id/style-guide SaveStyleGuideRequest → { styleGuide: StyleGuide }   (replaces the project's guide)
 *   DELETE /projects/:id/style-guide                     → {}
 *   GET    /projects/:id/attachments/:attachmentId       → the file (for reading an attachment or the guide)
 *
 *  Attachments (files the editor drops on the message box; they ride on the next request)
 *   POST   /projects/:id/attachments  multipart (file)   → { attachment: TaskAttachment }
 *
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
 *   GET    /settings                                     → { settings: ServerSettings, transcriptionAvailable: boolean, transcriptionIssue?: string }
 *   GET    /settings/local-model                         → LocalModelStatus (selection, active local engine and readiness)
 *   PATCH  /settings                Partial<ServerSettings> → { settings }
 *
 *  Realtime
 *   WS     /ws?token=<token>        server pushes WsEvent; client may send { type: "subscribe", projectId }
 */
import { z } from "zod/v3";
import { CheckIn } from "./checkIn.js";
import { DEFAULT_TASK_MODELS, TASK_MODELS_MAX, TaskModelType } from "./taskModels.js";

/** The longest "Talking to you" the editor can write: a few short lines of how they like to be spoken to. */
export const TALKING_TO_YOU_MAX = 2000;
import {
  Author,
  ChangeState,
  DEFAULT_PREVIEW_HEIGHT,
  Id,
  LocalTranscriptionModel,
  Project,
  ProjectSettings,
  stableStringify,
  Seconds,
  Timeline,
  TimeRange,
} from "@scarlet/timeline";
import { AgentId } from "./agents.js";

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
  mediaPaused: Project.shape.mediaPaused,
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

/** A stretch of music where the level holds (`GET /projects/:id/media/:mediaId/music-beats`). */
export interface MusicSection {
  start: number;
  end: number;
  /** Mean level over the section, dBFS. */
  levelDb: number;
  /** How the level moves through the section: its fitted change from start to end, dB. */
  changeDb: number;
  /** The level just after the section starts against just before it, dB: a step up or down at its start. */
  jumpDb?: number;
}

/** A music file's beats, bars, tempo and level sections, measured from its sound. Source seconds. */
export interface MusicReading {
  mediaId?: string;
  from: number;
  to: number;
  tempo: { bpm: number; confidence: number; alternatives: number[] } | { unclear: string };
  /** Seconds between beats at that tempo. */
  beatSeconds?: number;
  beats: number[];
  meter?: { beatsPerBar: number; confidence: number } | { unclear: string };
  downbeats?: number[];
  sections: MusicSection[];
  /** The level every `stepSeconds`, dBFS, from `from`. */
  levels: { stepSeconds: number; db: number[] };
}

/** One file of the folder an editor takes to another app: its text, or a copy of a file in Scarlet's library. */
export type HandoffFile = { path: string; text: string } | { path: string; source: string; size: number };

/** The folder for finishing the edit in DaVinci Resolve, Final Cut Pro or Premiere Pro, and the bytes of footage it copies. */
export interface HandoffResponse { files: HandoffFile[]; mediaBytes: number }

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
  /** Why the loudness couldn't be measured, when it couldn't. The other figures still hold. */
  loudnessUnavailable?: string;
}

export const RenderKind = z.enum(["segment", "full", "proxy", "preview", "playback", "export"]);
export type RenderKind = z.infer<typeof RenderKind>;

export const RenderState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
const HardwareEncoder = z.enum(["none", "auto", "nvenc", "qsv", "videotoolbox"]);

const ExportOptions = z.object({
  height: z.number().int().min(2).max(16384).multipleOf(2).optional(),
  omitCaptions: z.boolean().optional(),
  /** Original quality: encode in software at about the source's own rate, with 320 kb/s sound. A larger file than a delivery render. */
  bestQuality: z.boolean().optional(),
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
  /** Of a running full or export render: the seconds already encoded by an earlier render, and the progress they account for. */
  reused: z.object({ seconds: z.number().nonnegative(), progress: z.number().min(0).max(1) }).optional(),
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
    provider: z.enum(["anthropic", "openai", "gemini", "none"]).default("none"),
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
  /** How many of a pass's cuts, the ones Scarlet thinks most likely to be wrong, the editor is asked to check. */
  checkIn: CheckIn.default("balanced"),
  /**
   * How Scarlet writes to the editor, in their own words: in the chat and on its cards, in every project, whichever
   * model runs the request. Their own instructions for Claude Code, Codex or Gemini are for their own chats and never
   * reach Scarlet's runs, so this is where they say it for Scarlet. Empty = nothing added.
   */
  talkingToYou: z.string().max(TALKING_TO_YOU_MAX).default(""),
  /**
   * Which model listens to cuts for a request whose own model can't hear: "auto" (the best one signed in), "off", or
   * one model as "agent:model" (`chooseListener`).
   */
  listening: z.string().regex(/^(auto|off|[a-z]+:[^\s]+)$/).default("auto"),
  /**
   * Kinds of work the editor gives to a model of their choosing, each with what counts as it (Settings → Models → Task
   * models). The model running a request hands such work to that model with `hand_off`. "same" leaves it with the chat's.
   */
  taskModels: z.array(TaskModelType).max(TASK_MODELS_MAX).default(DEFAULT_TASK_MODELS),
  /** Opt-in Style guides (Beta) library, preview editor, and @name mentions in chat/skills. Off by default. */
  styleGuidesBeta: z.boolean().default(false),
});
export type ServerSettings = z.infer<typeof ServerSettings>;

export function selectedLocalModel(settings: Pick<ServerSettings["transcription"], "localModel" | "whisperCppPath" | "whisperModelPath">): LocalTranscriptionModel {
  return settings.localModel ?? (settings.whisperCppPath || settings.whisperModelPath ? "custom" : "whispercpp");
}

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export { ChangeState };

export type RenderRequest = z.infer<typeof RenderRequest>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

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
