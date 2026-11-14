import { PictureBatches, type PictureRequest, type PreparedPictures } from "./picture-batches.js";
import { matchAudio, syncRate } from "./audio-sync.js";
/**
 * The Scarlet MCP server: the tools an AI editor uses to read a project and
 * propose changes. Everything goes through a `ScarletClient`; the server can
 * be run over stdio (see cli.ts) or embedded in-process.
 */
import { cutScope, selectedRange } from "./cut-scope.js";
import { audibleSourcePoints, cutsReach, dialogueGate, dialogueScanPage, planDialogueCuts, resolveCutRange, type DialoguePlanSources } from "./dialogue-plan.js";
import { inspectDialogueSuggestion, MAX_WHOLE_PICTURE_SHEETS, type DialogueInspection } from "./dialogue-review.js";
import { Lanes, ReviewInspections, urgencyRank, type InspectionRequest } from "./review-prep.js";
import { AIR_AFTER_SPEECH, AIR_BEFORE_SPEECH, DIP_DBFS, PAUSE_BEAT, checkKeptWords, checkDialogueJoin, checkResumeQuote, clipEdgeSound, dialogueAudioStream, dialogueClips, dialogueCutPreview, dialogueJoinWords, joinAudio, joinEvidence, type JoinPage } from "./dialogue-join.js";
import { DialogueScanBatch, FIRST_CUT_BATCH_SIZE } from "./dialogue-scan-batch.js";
import { resolveOutgoingPause } from "./outgoing-pause.js";
import { DialogueEvidence, matchFillers } from "./dialogue-decisions.js";
import { acousticRetakeContinuations, acousticRetakeJoin, type AcousticRetakePage } from "./dialogue-retake-join.js";
import { acousticRepeatedTakes, findRepeatedTakes } from "./dialogue-retakes.js";
import { audioCrossfadeOps } from "./audio-crossfade.js";
import { firstCutRanges } from "./first-cut-ranges.js";
import { InsetFraming, insetFraming, syncPictureOps } from "./sync-layout.js";
import { mkdtemp } from "node:fs/promises";
import { readArtifact, writeArtifact } from "./workspace-files.js";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { boundedRippleOps, cutAnchorOn, taskDialogueOperation, agentCapabilities, DEFAULT_RESULT_CHARS, type AgentCapabilities, JOIN_WORD_SECONDS, fuzzySearchTranscript, apiPathId, disabledEditingTools, type EditingTools, type ScarletToolName,
  CrossfadeFrames, SheetOptions, SheetRequest, CutReviewOptions, SourceAudioOptions, SoundPictureOptions, type InspectionResult, type InspectionWindow, type DialogueDetections, type PictureActivityWindow, ScarletApiError, SuggestLearningRequest, TaskSkillDraft, skillTaskTarget, skillEditTarget, type ScarletClient } from "@scarlet/shared";
import type { RepeatEvidence, AgentId, DialogueScanPage, ProjectDetail, ProposeChangeRequest, Skill, Task, TaskEvent, WaveformResponse } from "@scarlet/shared";
import type { Author, Change, MediaAsset, TimeRange } from "@scarlet/timeline";
import {
  applyOps,
  CutAssessment,
  CaptionStyle,
  captionsFromWords,
  clipDuration,
  clipEnd,
  clipsAt,
  clipById, describeDiff,
  diffTimelines,
  emptyTimeline,
  frameAligned,
  newId,
  OpError,
  makeTimeMap,
  mergeRanges,
  rangesOverlap,
  timelineDuration,
  timelineFromKeepRanges,
  timelineToSource,
  type Timeline,
  SUMMARY_MAX,
  WritableTimeline,
  TimelineOp,
  type CaptionClip,
  type MediaClip,
  Transform,
  type Track,
  type TranscriptWord,
} from "@scarlet/timeline";
import {
  audibleMediaClips,
  captionSourceClips,
  dedupeWords,
  detectSilences,
  dialogueCutSuggestions,
  firstCutEvidence,
  firstCutPauses,
  downsample,
  flattenWords,
  round3,
  dbfs,
  captionWordMapper,
  searchTranscript,
  sparkline,
  summarizeTimeline,
} from "./analysis.js";
import { toolAnnotations } from "./annotations.js";
import { registerPerception } from "./perception-tools.js";
import { sourceRangeToTimeline, sourceToTimeline, timelineWords } from "./timeline-perception.js";
import { KEPT_PAUSE_SECONDS, partLeftovers } from "./dialogue-leftovers.js";
import { GAP_SECONDS, QUIET_PHRASE_CONTEXT, describeGapSound, gapSound, quietPhrases, speakingLevel, type GapLevels, type GapSound, type QuietPhrase } from "./gap-sound.js";
import { keptSilences, pictureReading, pictureWindows, silences, type Silence } from "./silences.js";
import { levelProfile } from "./media-profile.js";

const SKILL_FROM_CHANGE_TOOLS: ReadonlySet<string> = new Set(["task_log", "task_question", "change_get", "timeline_get", "skill_save_from_change"]);
const IMAGE_TOOLS: ReadonlySet<string> = new Set(["frame_contact_sheet", "frame_contact_sheet_batch", "media_frame", "sound_picture"]);
const SKILL_EDIT_TOOLS: ReadonlySet<string> = new Set(["task_log", "task_question", "skills_list", "skill_save_edit"]);
/** A learning check reads one request for a standing rule. It can read the editor's skills and offer a rule, and nothing else. */
const LEARNING_CHECK_TOOLS: ReadonlySet<string> = new Set(["skills_list", "learning_suggest"]);
const PASS_WIDE_TOOLS: ReadonlySet<string> = new Set(["timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "captions_generate", "dialogue_apply_cuts", "dialogue_review_save"]);

/** Source seconds read without saving a part before dialogue_scan reminds the agent that the editor is waiting. */
export const SAVE_REMINDER_SECONDS = 300;
/** The latest staged pass of a run, and how many of its cuts still have no recommendation. */
interface StagedReview { changeId: string; total: number; unchecked: number }
/** dialogue_scan's note while staged cuts wait for a recommendation, which the editor needs before they can call them. */
function reviewReminderText({ changeId, total, unchecked }: StagedReview) {
  const cuts = unchecked === 1 ? "1 cut" : `${unchecked} cuts`;
  return `${cuts} you staged on ${changeId} ${unchecked === 1 ? "has" : "have"} no recommendation yet${unchecked < total ? ` (of ${total})` : ""}. The editor sees a staged cut as a call only once it has one, so they have nothing to decide while you read on. Record them with dialogue_review_inspect and dialogue_review_save, then continue.`;
}
export interface ScarletMcpContext {
  projectId: string;
  editingTools?: EditingTools;
  /** How long a cut or an edge check waits for word alignment to reach it. Tests shorten it. */
  alignmentWaitMs?: number;
  /** Agent task this session is running for; enables task_log/task_question and tags changes. */
  taskId?: string;
  /** Claim that launched this MCP session, including when a provider reconnects. */
  taskStartedAt?: string;
  /** Authoritative task fetched at startup, for task-specific tools. */
  task?: Task;
  author: Author;
  /** Which CLI is driving this session; sets the default capabilities. */
  agent?: AgentId | string;
  /** What the harness delivers to the model. Defaults to agentCapabilities(agent). Without audio, no tool offers WAV. */
  capabilities?: AgentCapabilities;
  /** Directory where the server may write files (OTIO exports). Defaults to the OS temp dir. */
  workDir?: string;
  /** fetch used for binary endpoints (frames). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export { SCARLET_TOOL_NAMES, type ScarletToolName } from "@scarlet/shared";

/**
 * The audible clip edges a saved timeline cuts at that the version it replaces did not: each start (`in`) and end
 * (`out`) of a clip, in its own recording's seconds. An edge the old version already had is no new cut and is left
 * out. So are the first and last instants of a recording, and the two halves of a split that plays straight on.
 * Whatever made the edge counts: a ripple, a trimmed or added clip, a whole new timeline. A pass that built its
 * video from added clips skipped every edge check there was, and a revision that trimmed one clip by a frame did too.
 */
export function newClipEdges(before: Timeline | null, next: Timeline, media: ReadonlyArray<{ id: string; duration?: number }>):
  Array<{ clipId: string; mediaId: string; stream?: number; side: "in" | "out"; source: number }> {
  const audible = (tl: Timeline) => tl.tracks.filter(t => t.kind !== "caption" && !t.muted)
    .map(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled && c.volume > 0));
  const old = before ? audible(before).flat() : [];
  const seen = new Set<string>();
  const edges: ReturnType<typeof newClipEdges> = [];
  for (const clips of audible(next)) {
    for (const clip of clips) {
      const length = media.find(m => m.id === clip.mediaId)?.duration, stream = dialogueAudioStream(clip), ends = clip.timelineIn + clipDuration(clip);
      for (const [side, source] of [["in", clip.sourceIn], ["out", clip.sourceOut]] as const) {
        const key = `${clip.mediaId}/${stream ?? ""}/${side}/${source.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (source < .05 || (length !== undefined && source > length - .05)) continue;
        if (old.some(c => c.mediaId === clip.mediaId && Math.abs((side === "in" ? c.sourceIn : c.sourceOut) - source) < 1e-3)) continue;
        if (clips.some(c => c !== clip && c.mediaId === clip.mediaId && (side === "out"
          ? Math.abs(c.sourceIn - source) < 1e-3 && Math.abs(c.timelineIn - ends) < 1e-3
          : Math.abs(c.sourceOut - source) < 1e-3 && Math.abs(c.timelineIn + clipDuration(c) - clip.timelineIn) < 1e-3))) continue;
        edges.push({ clipId: clip.id, mediaId: clip.mediaId, ...(stream !== undefined && { stream }), side, source });
      }
    }
  }
  return edges;
}

const OPS_DOC = `Op types (all times are seconds; timeline times are positions in the edit, source times are positions in the media file):
- addClip: {"op":"addClip","trackId":"v1","clip":{"id":"clip_x","kind":"media","mediaId":"m1","sourceIn":12.5,"sourceOut":20,"timelineIn":0}} — place a media clip (also kind "caption" {timelineOut,text} or "color" {timelineOut,color}). Clip duration on the timeline = (sourceOut-sourceIn)/speed.
- removeClip: {"op":"removeClip","clipId":"clip_x"} — remove a clip, leaving a gap (use rippleDelete to close gaps).
- updateClip: {"op":"updateClip","clipId":"clip_x","patch":{"audioFadeIn":0.066,"audioFadeOut":0.066}} — patch any clip fields (sourceIn/sourceOut to trim, volume, speed, opacity, transform, label, enabled, effects, text/style for captions).
- moveClip: {"op":"moveClip","clipId":"clip_x","timelineIn":42.0,"trackId":"v2"} — move to a timeline position (and optionally another track).
- splitClip: {"op":"splitClip","clipId":"clip_x","at":30.0,"newClipId":"clip_y"} — split at a timeline time into two clips.
- rippleDelete: {"op":"rippleDelete","start":30.0,"end":31.2} — remove a timeline range from every track (or "trackIds") and close the gap; clips spanning the range are trimmed/split. The primitive for cutting a false start or a long pause while keeping all tracks in sync.
- rippleInsertGap: {"op":"rippleInsertGap","at":30.0,"duration":2.0} — push everything after the given time later.
- addTrack: {"op":"addTrack","track":{"id":"v2","kind":"video","name":"B-roll","clips":[]}} — kinds: video | audio | caption.
- removeTrack: {"op":"removeTrack","trackId":"v2"}
- updateTrack: {"op":"updateTrack","trackId":"a1","patch":{"muted":true}}
- addMarker: {"op":"addMarker","marker":{"id":"mk1","time":12.0,"kind":"todo","text":"needs b-roll"}}
- removeMarker: {"op":"removeMarker","markerId":"mk1"}
- updateMarker: {"op":"updateMarker","markerId":"mk1","patch":{"resolved":true}}
- setTimeline: {"op":"setTimeline","patch":{"name":"Short v2","background":"#000000","captionStyle":{"fontSize":0.06}}}

Clip fields:
- volume is linear gain (1 = unchanged, 0 = mute). Fades (audioFadeIn/Out, videoFadeIn/Out) are seconds.
- transform: A patch replaces the whole transform, so include the framing you want to keep. x and y are offsets from the center as fractions of the canvas width and height, scale 1 fits the cropped source to the canvas, rotation is degrees clockwise, cropLeft/Right/Top/Bottom are fractions of the source. cornerRadius rounds the cropped layer's corners (0–0.5 of its shorter side, 0 for square). keyframes: [{time, transform, ease}] animate x, y and scale, with time in seconds from the clip's start and ease linear | easeIn | easeOut | easeInOut | hold.
- effects: [{type, params, enabled}]. A patch replaces the whole array, so include the stages you keep. Audio types: denoise {amount dB, noiseFloor dBFS}, expander {thresholdDb, rangeDb, ratio, attack ms, release ms}, eq {highpass Hz, lowpass Hz, bands [{frequency, gain dB, width Q}]}, compressor {thresholdDb, ratio, attack ms, release ms, makeupDb}, limiter {limitDb, attack ms, release ms}, loudnorm {i LUFS, tp dBTP, lra LU}.
- A later video track composites on top of an earlier one. A caption clip can carry a title or label.`;

type ToolResult = CallToolResult;

class MediaPreparing extends Error {}

/**
 * How long a cut or an edge check waits for word alignment to reach it before asking to be called again. Alignment
 * runs ahead of the pages a pass reads, so this covers the turn or two it can be behind.
 */
const EDGE_WAIT_MS = 40_000;

/**
 * Dialogue analysis takes its turn in the engine's audio lane behind transcription, so on a long recording a page
 * request can time out again and again while the transcript is made. After this many failures in a row, a page waits
 * for the transcript instead of starting another request.
 */
const DIALOGUE_FAILURE_LIMIT = 2;

/**
 * The longest list of checked joins dialogue_check_join returns whole, in characters. Claude Code withholds a tool
 * result over 25,000 tokens, and a run has no tool to read it back with: lists of 24 to 35 cuts, 57,000 characters
 * and more, came back to real passes as "exceeds maximum allowed tokens", and each was checked again a few at a time
 * or saved unchecked.
 */
const JOIN_LIST_CHARS = 40_000;

/** "about 37 min" or "about 3 h 48 min". */
function roughDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 90 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Where a running transcription stands, as evidence: "aligning words, 33% done, about 37 min left". */
export function transcriptionNote(progress: Task["progress"]): string {
  if (!progress) return "still being made";
  if (progress.stage === "queued") return "waiting its turn behind other audio work";
  // A transcript is readable once it has its words, so while those are made the figure is theirs alone.
  const { fraction, remainingSeconds } = progress.stage === "transcribing" && progress.words ? progress.words : progress;
  const left = remainingSeconds !== undefined && fraction < 1 ? `, ${roughDuration(remainingSeconds)} left` : "";
  return `${progress.stage === "aligning" ? "aligning words" : "transcribing"}, ${Math.floor(fraction * 100)}% done${left}`;
}

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

/** Compact JSON. A tool returns either this or a text rendering of the same data, never both. */
function json(value: unknown): ToolResult {
  return text(JSON.stringify(value));
}

function errorResult(err: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(err) }] };
}

export function describeError(err: unknown): string {
  if (err instanceof OpError) return `Invalid op ${JSON.stringify(err.op)}: ${err.message}`;
  if (err instanceof ScarletApiError) {
    // The engine lists what failed validation. Without it the agent can only guess and resubmit.
    const issues = err.code === "validation_error" ? z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
      .safeParse(err.details) : undefined;
    const detail = issues?.success && issues.data.length ? `\n${formatIssues(issues.data)}` : "";
    return `Scarlet server error ${err.status} (${err.code}): ${err.message}${detail}`;
  }
  if (err instanceof z.ZodError) return `Validation failed:\n${formatZodError(err)}`;
  if (err instanceof Error) return `${err.name}: ${err.message}${errorCause(err)}`;
  return String(err);
}

/** Node's fetch reports every network failure as "fetch failed"; the cause says which (refused, reset, headers timeout). */
function errorCause(err: Error): string {
  const cause = err.cause;
  if (!(cause instanceof Error)) return "";
  const code = (cause as { code?: unknown }).code;
  return ` (${typeof code === "string" ? `${code}: ` : ""}${cause.message})`;
}

/**
 * A read that failed and was answered without, so the result says less and can't say why. The reason goes to stderr;
 * stdout is the protocol's. Media still being prepared is expected, and the tool that waits for it says so itself.
 */
function unavailable(what: string, err: unknown) {
  if (!(err instanceof MediaPreparing)) console.error(`[scarlet-mcp] ${what}: ${describeError(err)}`);
}

export function formatZodError(err: z.ZodError): string {
  return formatIssues(err.issues);
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): string {
  return issues
    .slice(0, 20)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/** Validate a list of ops and return readable errors instead of throwing. */
export function validateOps(ops: unknown): { ok: true; ops: TimelineOp[] } | { ok: false; error: string } {
  if (!Array.isArray(ops)) return { ok: false, error: "ops must be an array of op objects" };
  const parsed = z.array(TimelineOp).safeParse(ops);
  if (parsed.success) return { ok: true, ops: parsed.data };
  const lines = parsed.error.issues.slice(0, 20).map((i) => {
    const idx = typeof i.path[0] === "number" ? i.path[0] : undefined;
    const opName = idx !== undefined ? (ops[idx] as { op?: unknown })?.op : undefined;
    const where = idx !== undefined ? `ops[${idx}]${opName ? ` (${String(opName)})` : ""}` : "ops";
    const field = i.path.slice(1).join(".");
    return `- ${where}${field ? `.${field}` : ""}: ${i.message}`;
  });
  return { ok: false, error: `Invalid ops:\n${lines.join("\n")}\n\n${OPS_DOC}` };
}

export function createScarletMcpServer(workspace: ScarletClient, ctx: ScarletMcpContext): McpServer {
  const startedAt = ctx.taskStartedAt ?? ctx.task?.startedAt;
  const client = workspace.forProject(ctx.projectId, ctx.taskId ? { taskId: ctx.taskId, startedAt } : undefined);
  if (ctx.taskId) apiPathId(ctx.taskId);
  if (ctx.task && ctx.task.projectId !== ctx.projectId) throw new Error("Task belongs to a different project");
  const evidence = new DialogueEvidence();
  const caps = ctx.capabilities ?? agentCapabilities(ctx.agent);
  type DialogueOperation = ReturnType<typeof taskDialogueOperation>;
  let legacyOperation: Promise<DialogueOperation> | undefined;
  const dialogueOperation = () => {
    if (!ctx.task || ctx.task.context.dialogueOperation !== undefined) return ctx.task?.context.dialogueOperation ?? "none";
    // Older engines did not persist the chosen operation. Fold their editor answers using the same command grammar.
    return legacyOperation ??= (async () => {
      const events = ctx.taskId ? (await client.task(ctx.taskId, "conversation")).events : [];
      const answers = events.filter(event => event.type === "answer").map(event => event.text);
      if (taskDialogueOperation(ctx.task!, answers) === "none") return "none";
      const { skills } = await client.skills();
      return taskDialogueOperation(ctx.task!, answers, skills);
    })().catch(error => { legacyOperation = undefined; throw error; });
  };
  const localPausesMode = async () => await dialogueOperation() === "local-pauses";
  let localRange = ctx.task?.context.dialogueRange;
  // A revision of one cut in a pending dialogue pass moves that cut and leaves the rest of the pass alone.
  const stagedCut = (ctx.task?.kind === "revise" || ctx.task?.kind === "edit") && ctx.task.context.changeId && ctx.task.context.cutIndex !== undefined
    ? { changeId: ctx.task.context.changeId, index: ctx.task.context.cutIndex } : undefined;
  async function useStagedCut() {
    if (!stagedCut) return;
    if (ctx.task?.stagedCutRevision === false) return;
    if (ctx.task?.kind === "edit" && ctx.task.stagedCutRevision === undefined) {
      // An ordinary edit can also reference an older change. Only a pending call has a proposal to revise.
      const record = await client.changeRecord(stagedCut.changeId).catch(err => {
        if (err instanceof ScarletApiError && err.status === 404) return undefined;
        throw err;
      });
      if (record?.change.intent !== "suggestion" || (!["ready", "revising"].includes(record.change.state) && !record.change.replacedBy)) return;
    }
    return new Error(`This revises staged cut ${stagedCut.index} of ${stagedCut.changeId}. Save its new range with dialogue_revise_cut.`);
  }
  // An explicit retry uses the footage the agent has actually read on this immutable version. A join
  // measures its two edges; a transcript read covers the returned passage between them.
  let namedConflict = stagedCut;
  let cutConflict = stagedCut && ctx.task?.cutConflict && { ...stagedCut, ...ctx.task.cutConflict };
  const conflictAt = (id: string, i: number) => cutConflict &&
    (cutConflict.changeId === id && cutConflict.index === i || namedConflict?.changeId === id && namedConflict.index === i);
  const revisionVersions = new Set<string>();
  const cutInspections: Array<{ version: string; range: TimeRange; edges: boolean }> = [];
  function readPassage(version: string, range: TimeRange, edges = false) {
    if (stagedCut || version === cutConflict?.version || revisionVersions.has(version)) cutInspections.push({ version, range, edges });
  }
  const scanScopes = new Map<string, number>();
  const acousticRetakePages = new Map<string, AcousticRetakePage>();
  const pendingDetections = new Map<string, Promise<DialogueDetections>>();
  /** Dialogue analysis requests that failed in a row, per recording, and the last reason. */
  const dialogueFailures = new Map<string, { count: number; error: string }>();
  const disabled = disabledEditingTools(ctx.editingTools ?? {});
  /** Scarlet only offers WAV to a model whose harness delivers it. */
  const hearing = caps.audio && !disabled.has("source_audio");
  const reviewPictures = caps.images && !disabled.has("frame_contact_sheet");
  const authoring = ctx.task?.kind === "skill_from_change" ? ctx.task.context : undefined;
  const server = new McpServer(
    { name: "scarlet", version: "0.1.4" },
    {
      instructions: authoring
        ? "Scarlet exposes the approved change and timeline version, communication with the editor, and saving the requested skill."
        : ctx.task?.kind === "skill_edit"
        ? "Scarlet exposes the tools for revising one of the editor’s skills; an empty MCP resource list is normal."
        : ctx.task?.kind === "learning_check"
        ? "Scarlet exposes the tools for reading the editor’s skills and offering a rule for one; an empty MCP resource list is normal."
        : "Scarlet exposes project context and editing operations as tools; an empty MCP resource list is normal. project_get returns the current edit and the editor’s selection. Transcript and waveform tools prepare missing data on demand." +
        (disabled.size ? ` The editor turned off these tools in Settings: ${[...disabled].join(", ")}.` : ""),
    },
  );
  const fetchImpl = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  let tempDir: Promise<string> | undefined;
  const artifactDir = () => ctx.workDir ?? (tempDir ??= mkdtemp(join(tmpdir(), "scarlet-mcp-")));

  // -- helpers --------------------------------------------------------------

  const getProject = () => client.project(ctx.projectId);

  /** For a `.catch`: note the failure on stderr and answer with `fallback`. */
  const without = <T>(what: string, fallback: T) => (err: unknown) => { unavailable(what, err); return fallback; };
  /** The same for a read every page or join repeats: a line is written once, so an engine without the route says so once. */
  const noted = new Set<string>();
  const unavailableOnce = (what: string, err: unknown) => {
    if (err instanceof MediaPreparing) return;
    const line = `${what}: ${describeError(err)}`;
    if (noted.has(line)) return;
    noted.add(line);
    unavailable(what, err);
  };
  const withoutOnce = <T>(what: string, fallback: T) => (err: unknown) => { unavailableOnce(what, err); return fallback; };

  /**
   * The version this agent last looked at. Edits are proposed against it, so
   * if someone approves another change while the agent works, Scarlet can
   * still merge these edits correctly instead of misplacing them.
   */
  let lastTimeline: Timeline | undefined;

  async function getTimeline(version?: string): Promise<Timeline> {
    if (lastTimeline && version === lastTimeline.version && version !== "head") return lastTimeline;
    const { timeline } = await client.timeline(ctx.projectId, version ?? "head");
    lastTimeline = timeline.version === "draft" ? undefined : timeline;
    return timeline;
  }

  /**
   * A version read for a measurement rather than by the agent: the earlier side of a diff, a change's two versions,
   * a staged cut's join. It leaves the version edits are proposed against where the agent's own reads put it.
   * A saved version never changes, so the last few are kept.
   */
  const measuredVersions = new Map<string, Timeline>();
  async function peekTimeline(version: string): Promise<Timeline> {
    if (lastTimeline && version === lastTimeline.version && version !== "head") return lastTimeline;
    const kept = measuredVersions.get(version);
    if (kept) return kept;
    const { timeline } = await client.timeline(ctx.projectId, version);
    if (timeline.version === version && version !== "draft") {
      if (measuredVersions.size >= 4) measuredVersions.delete(measuredVersions.keys().next().value!);
      measuredVersions.set(version, timeline);
    }
    return timeline;
  }

  async function cutAnchor(timeline: Timeline) {
    const anchor = { ...ctx.task?.context, dialogueRange: localRange };
    const version = localRange?.version ?? anchor.version;
    return cutAnchorOn(anchor, timeline, version && version !== "head" && version !== timeline.version ? await peekTimeline(version) : undefined);
  }

  async function headTimelineOrNull(): Promise<Timeline | null> {
    try {
      return await getTimeline("head");
    } catch (err) {
      if (err instanceof ScarletApiError && err.status === 404) return null;
      throw err;
    }
  }

  const preparations = new Map<string, Promise<void>>();

  /**
   * Tell the editor once that the run is waiting on media work, and again when it's ready, so a
   * tool the agent keeps calling to collect the result reads as waiting rather than as fresh work.
   */
  const waits = new Set<string>();
  function waitingOn(what: "transcript" | "sound" | "dialogue", mediaId: string, job: Promise<unknown>) {
    const key = JSON.stringify([what, mediaId]);
    if (waits.has(key)) return;
    waits.add(key);
    const label = what === "transcript" ? "the transcript" : what === "sound" ? "the sound analysis" : "dialogue analysis";
    void postEvent({ type: "log", text: `Waiting for ${label}`, data: { kind: "media_wait", wait: what, mediaId } });
    const since = Date.now();
    // Keep the reason with the event: the task's history is often the only record of why a wait failed.
    void job.then(() => undefined, (err: unknown) => describeError(err)).then(error => {
      waits.delete(key);
      return postEvent({ type: "log", text: error !== undefined ? `Couldn’t prepare ${label}` : `Ready: ${label}`,
        data: { kind: "media_wait", wait: what, mediaId, done: true, waitedMs: Date.now() - since, ...(error !== undefined ? { failed: true, error } : {}) } });
    });
  }

  async function prepare(mediaId: string, kind: "transcript" | "waveform") {
    const result = await client.prepareMedia(ctx.projectId, mediaId, kind);
    if (result.state === "ready") return;
    for (;;) {
      const { task, waited } = await client.waitForTranscription(result.taskId);
      // The transcript can be read once it has its words. The task then goes on to align them.
      if (task.state === "done" || (task.progress?.words?.fraction ?? 0) >= 1) return;
      if (task.state !== "running" && task.state !== "queued" && task.state !== "claimed") {
        throw new Error(task.error || `Transcription ${task.state} for ${mediaId}.`);
      }
      // An older engine or another process's transcription has no local event to await.
      if (!waited) await delay(1500, undefined, { ref: false });
    }
  }

  /** A recording's saved transcript: ready, or how far along it is. Undefined when Scarlet can't say. */
  async function transcriptState(mediaId: string): Promise<{ ready: true } | { ready: false; note: string } | undefined> {
    try {
      const prepared = await client.prepareMedia(ctx.projectId, mediaId, "transcript");
      if (prepared.state === "ready") return { ready: true };
      const { task } = await client.task(prepared.taskId);
      return { ready: false, note: transcriptionNote(task.progress) };
    } catch (err) {
      unavailableOnce(`failed to read how far the transcript of ${mediaId} is`, err);
      return undefined;
    }
  }

  async function readPrepared<T>(mediaId: string, kind: "transcript" | "waveform", read: () => Promise<T>): Promise<T> {
    const key = `${kind}/${mediaId}`;
    try {
      const result = await read();
      preparations.delete(key);
      return result;
    } catch (err) {
      if (!(err instanceof ScarletApiError && err.status === 404) || err.code === "project_resource_missing") throw err;
    }
    let job = preparations.get(key);
    if (!job) {
      job = prepare(mediaId, kind);
      preparations.set(key, job);
    }
    // Keep long jobs alive across MCP call deadlines. A subsequent tool call joins the same job.
    const timer = new AbortController();
    try {
      const pending = delay(15_000, "pending", { signal: timer.signal, ref: false });
      if (await Promise.race([job, pending]) === "pending") {
        waitingOn(kind === "transcript" ? "transcript" : "sound", mediaId, job);
        const state = kind === "transcript" ? await transcriptState(mediaId) : undefined;
        throw new MediaPreparing(`Scarlet is preparing the ${kind} for ${mediaId}${state && !state.ready ? ` (${state.note})` : ""}. Continue other work, then call this tool again to collect the result. No editor action is needed.`);
      }
    } catch (err) {
      if (!(err instanceof MediaPreparing)) preparations.delete(key);
      throw err;
    } finally {
      timer.abort();
    }
    preparations.delete(key);
    return read();
  }

  async function getTranscript(mediaId: string, opts: { from?: number; to?: number; granularity?: "word" | "segment" } = {}, prepareMissing = true) {
    const read = () => client.transcript(mediaId, opts);
    try {
      return await (prepareMissing ? readPrepared(mediaId, "transcript", read) : read());
    } catch (err) {
      if (err instanceof ScarletApiError && (err.code === "no_audio" || (!prepareMissing && err.status === 404))) return null;
      throw err;
    }
  }

  /**
   * A media's words in transcript_get order. The position in this list is the word's stable index,
   * shared by every tool that shows or accepts word references. Only a complete transcript is kept.
   *
   * The engine saves a transcript when Whisper ends and goes on placing its words on the audio. Until that is done
   * the words are read again every couple of seconds: their order and indices hold, and their times are final only
   * up to `through`. With `through` the call resolves once the times are final that far, waiting up to `waitMs`,
   * and otherwise says how far alignment has come. Whatever turns a word time into a cut edge or a measurement
   * asks this way; reading and searching the words does not need to.
   */
  const edgeWaitMs = ctx.alignmentWaitMs ?? EDGE_WAIT_MS;
  const wordLists = new Map<string, TranscriptWord[]>();
  const aligningWords = new Map<string, { words: TranscriptWord[]; through: number; at: number }>();
  const readingWords = new Map<string, Promise<TranscriptWord[] | null>>();
  function readWords(mediaId: string, prepareMissing: boolean): Promise<TranscriptWord[] | null> {
    const ready = wordLists.get(mediaId);
    if (ready) return Promise.resolve(ready);
    const partial = aligningWords.get(mediaId);
    if (partial && Date.now() - partial.at < 1500) return Promise.resolve(partial.words);
    // A read that may not prepare can come back empty, so a preparing read never joins it.
    const key = JSON.stringify([mediaId, prepareMissing]);
    let job = readingWords.get(key);
    if (!job) {
      job = getTranscript(mediaId, { granularity: "word" }, prepareMissing).then(t => {
        const words = t?.segments.length ? flattenWords(t) : null;
        if (words && t!.aligning) aligningWords.set(mediaId, { words, through: t!.aligning.through, at: Date.now() });
        else if (words) {
          aligningWords.delete(mediaId);
          wordLists.set(mediaId, words);
        }
        return words;
      });
      readingWords.set(key, job);
      void job.catch(() => {}).finally(() => readingWords.delete(key));
    }
    return job;
  }
  /** The source second up to which a transcript's word times are final. Infinity once alignment is done. */
  const settledThrough = (mediaId: string) => wordLists.has(mediaId) ? Infinity : aligningWords.get(mediaId)?.through ?? Infinity;
  async function transcriptWords(mediaId: string, prepareMissing = true, through?: number, waitMs = 0): Promise<TranscriptWord[] | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const words = await readWords(mediaId, prepareMissing);
      const settled = settledThrough(mediaId);
      if (!words || through === undefined || settled > through) return words;
      if (Date.now() + 2000 > deadline) {
        throw new MediaPreparing(`Scarlet is still placing the words of ${mediaId} on the audio: their times are final up to ${settled.toFixed(0)} s, and this needs them up to ${through.toFixed(0)} s. ` +
          "Alignment moves forward through the recording, so earlier passages can be checked and saved now. Call this tool again for the rest. No editor action is needed.");
      }
      await delay(2000, undefined, { ref: false });
    }
  }

  /** A waveform window with 20 ms buckets and voice activity, for edge evidence. */
  function readLevels(mediaId: string, from: number, to: number): Promise<WaveformResponse> {
    const points = Math.max(10, Math.ceil((to - from) * 50));
    return readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, points, true, true));
  }

  /**
   * Measured edge evidence near each source instant that no dialogue scan page covers, so
   * dialogue_check_join, word references and dialogue_apply_cuts judge an edge from the recording
   * even without a scan. Only the first audio stream is measured; other streams keep needing a scan.
   */
  const measured: JoinPage[] = [];
  const measuring = new Map<string, Promise<void>>();
  /** Prepared levels in five-minute stretches of a recording, read once each, with the level speech sits at in each. */
  const levelChunks = new Map<string, Promise<{ levels: GapLevels; speech: number }>>();
  const CHUNK = 300;
  function levelChunk(mediaId: string, from: number, to: number) {
    const key = `${mediaId}/${from}/${to}`;
    let chunk = levelChunks.get(key);
    if (!chunk) {
      chunk = readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, Math.max(10, Math.ceil((to - from) * 50)), true))
        .then(wf => { const levels = { from: wf.from, to: wf.to, rms: wf.rms ?? [] }; return { levels, speech: speakingLevel(levels) }; });
      levelChunks.set(key, chunk);
      chunk.catch(() => levelChunks.delete(key));
    }
    return chunk;
  }
  /** What sounds in each stretch between two words of a recording. Undefined where its levels cannot be read. */
  async function gapSounds(mediaId: string, gaps: Array<{ start: number; end: number }>, edge?: number): Promise<Array<GapSound | undefined>> {
    const out: Array<GapSound | undefined> = [];
    for (const gap of gaps) {
      const from = Math.floor(gap.start / CHUNK) * CHUNK;
      // A stretch that runs past its five minutes is read on its own, against the level of the stretch it starts in.
      const [home, own] = await Promise.all([levelChunk(mediaId, from, from + CHUNK),
        gap.end > from + CHUNK ? levelChunk(mediaId, Math.floor(gap.start), Math.ceil(gap.end)) : undefined]);
      out.push(gapSound((own ?? home).levels, gap, home.speech, edge));
    }
    return out;
  }

  // Both the scan and the next save can cover the same phrase. Keep its reading with the transcript whose timed
  // words it measured. A refreshed alignment gets new readings and keeps the same transcript_get indices.
  const phraseReadings = new WeakMap<TranscriptWord[], { through: number; chunks: Map<number, Promise<QuietPhrase[]>> }>();
  async function readQuietPhrases(mediaId: string, from: number, to: number): Promise<QuietPhrase[]> {
    const words = await transcriptWords(mediaId, false);
    if (!words?.length || to <= from) return [];
    let readings = phraseReadings.get(words);
    if (!readings) {
      readings = { through: Math.min(settledThrough(mediaId), words.reduce((end, w) => Math.max(end, w.end), 0)), chunks: new Map() };
      phraseReadings.set(words, readings);
    }
    const { through, chunks } = readings;
    const found: QuietPhrase[] = [];
    for (let chunk = Math.floor(from / CHUNK); chunk * CHUNK < Math.min(to, through); chunk++) {
      const start = chunk * CHUNK;
      let read = chunks.get(start);
      if (!read) {
        const lo = Math.max(0, start - QUIET_PHRASE_CONTEXT), hi = start + CHUNK + QUIET_PHRASE_CONTEXT;
        // Each chunk owns the phrases starting in it. Read the neighbors across its edges as well, at the same
        // 20 ms resolution. The waveform stays cached as the transcript advances through this chunk.
        read = levelChunk(mediaId, lo, hi).then(({ levels }) =>
          quietPhrases(words, levels, through).filter(p => p.start >= start && p.start < start + CHUNK));
        chunks.set(start, read);
        read.catch(() => chunks.delete(start));
      }
      found.push(...(await read).filter(p => p.start >= from && p.end <= to));
    }
    return found;
  }

  async function measureAround(points: Array<{ mediaId: string; t: number }>) {
    const { media } = await client.media(ctx.projectId);
    await Promise.all(points.map(({ mediaId, t }) => {
      const asset = media.find(m => m.id === mediaId);
      // A source with no sound has no levels to read: the engine refuses it, and the join check leaves it out anyway.
      if (!asset?.duration || asset.hasAudio === false || asset.kind === "image" || (dialogueAudioStream(asset) ?? 0) !== 0) return;
      // A second either side, as far as the recording goes: a window can't reach before its start or past its end.
      const covered = (p: JoinPage) => p.mediaId === mediaId && (p.audioStream ?? 0) === 0 && p.edges && p.start <= Math.max(0, t - 1) && p.end >= Math.min(asset.duration!, t + 1);
      if (evidence.scans.some(covered) || measured.some(covered)) return;
      const from = Math.max(0, Math.floor(t) - 2), to = Math.min(asset.duration, Math.floor(t) + 3);
      const key = JSON.stringify([mediaId, from, to]);
      let job = measuring.get(key);
      if (!job) {
        job = (async () => {
          // The window's words must be where the recording has them. One still waiting for alignment says so.
          const [wf, words] = await Promise.all([readLevels(mediaId, from, to), transcriptWords(mediaId, false, to + 1, edgeWaitMs).catch(err => {
            if (err instanceof MediaPreparing) throw err;
            unavailableOnce(`failed to read the words of ${mediaId} beside an edge`, err);
            return null;
          })]);
          const edges = joinEvidence((words ?? []).filter(w => w.end > from && w.start < to), wf);
          if (edges) measured.push({ mediaId, start: from, end: to, audioStream: 0, edges });
        })().finally(() => measuring.delete(key));
        measuring.set(key, job);
      }
      return job;
    }));
  }
  const joinPages = (): JoinPage[] => [...evidence.scans, ...measured];
  /** Measure every audible source under the given timeline times before a join check. */
  async function measureTimeline(tl: Timeline, times: number[]) {
    await measureAround(audibleSourcePoints(tl, times));
  }
  /** Read the whole interval after the preceding word, even when a long pause puts it outside an ordinary edge reading. */
  async function outgoingPausePages(tl: Timeline, project: ProjectDetail["project"], at: number) {
    const { clips, streams } = dialogueClips(tl, project);
    const outgoing = clips.filter(clip => clip.timelineIn < at && clip.timelineIn + clipDuration(clip) >= at - 1e-6);
    async function wordsThrough(clip: (typeof clips)[number], edge: number) {
      const stream = dialogueAudioStream(clip) ?? streams.get(clip.mediaId);
      if (stream !== 0) throw new Error("Word and level measurements are unavailable for this audio stream.");
      return await transcriptWords(clip.mediaId, false, edge, edgeWaitMs) ?? [];
    }
    const starts = await Promise.all(outgoing.map(async clip => {
      const edge = timelineToSource(clip, at);
      const words = await wordsThrough(clip, edge);
      const last = words.findLast(w => w.end > w.start && w.start >= clip.sourceIn && w.start < edge && w.text.trim() && !/^\s*\[.*\]\s*$/.test(w.text));
      return last ? clip.timelineIn + (last.start - clip.sourceIn) / clip.speed : -Infinity;
    }));
    const previous = Math.max(...starts);
    if (!Number.isFinite(previous)) return [];
    // Keep each request within the waveform API's 60-second speech window.
    const affected = clips.filter(clip => clip.timelineIn < at && clip.timelineIn + clipDuration(clip) > previous);
    const pages = await Promise.all(affected.map(async clip => {
      const pages: JoinPage[] = [];
      const from = Math.max(clip.sourceIn, timelineToSource(clip, previous) - .3);
      const to = Math.min(clip.sourceOut, timelineToSource(clip, at) + .3);
      const words = await wordsThrough(clip, Math.min(clip.sourceOut, timelineToSource(clip, at)));
      for (let start = from; start < to - 1e-6; start += 59) {
        const end = Math.min(start + 60, to);
        const wf = await readLevels(clip.mediaId, start, end);
        pages.push({ mediaId: clip.mediaId, audioStream: 0, start, end,
          edges: joinEvidence(words.filter(w => w.end > start && w.start < end), wf) });
        if (end === to) break;
      }
      return pages;
    }));
    return pages.flat();
  }
  /**
   * The new clip edges of a save that cut through sound (clipEdgeSound), each measured on its own recording. A
   * recording that can't be measured refuses nothing: the edit goes ahead as asked.
   */
  async function edgesInSound(before: Timeline | null, next: Timeline) {
    const { project } = await getProject();
    const edges = newClipEdges(before, next, project.media);
    if (!edges.length) return [];
    await measureAround(edges.map(e => ({ mediaId: e.mediaId, t: e.source })));
    const pages = joinPages();
    return edges.flatMap(e => {
      const asset = project.media.find(m => m.id === e.mediaId);
      const found = clipEdgeSound(pages, e.mediaId, e.stream ?? (asset && dialogueAudioStream(asset)) ?? 0, e.source, e.side);
      return found ? [{ ...e, ...found }] : [];
    });
  }
  type SoundingEdge = Awaited<ReturnType<typeof edgesInSound>>[number];
  /** What an edge cuts through and where the recording is quiet beside it, for the model to move it by. */
  const edgeInSoundText = (e: SoundingEdge, name = `clip ${e.clipId}`) => `${name} ${e.side === "in" ? "starts" : "ends"} at source ${e.source.toFixed(2)} s ` +
    (e.word ? `inside “${e.word}”, which is sounding there` : "inside a sound the transcript has no word for") +
    (e.fragment ? `: ${Math.round(e.fragment.seconds * 1000)} ms of it would play at ${e.fragment.db} dBFS, and the recording is quiet at ${e.fragment.quietAt.toFixed(2)} s (${e.fragment.quietDb} dBFS)` : "") +
    (e.levels ? ` [dBFS in 20 ms steps: ${e.levels}]` : "");
  const EDGES_IN_SOUND = "Nothing was saved. Move each edge onto quiet (the second given, or one dialogue_check_join measures), or remove dialogue with dialogue_apply_cuts, where a word reference puts each edge in the recording's silence.";
  // Checking a hundred joins can request hundreds of speech windows. Share the available connections across joins.
  const keptSpeechReads = new Lanes(8);
  /** Live reads for the dialogue planner (dialogue-plan.ts), which replay feeds from stored evidence instead. */
  const planSources: DialoguePlanSources = {
    evidence, pages: joinPages, project: async () => (await getProject()).project,
    words: (mediaId, through, prepare = true) => transcriptWords(mediaId, prepare, through, edgeWaitMs), measure: measureAround,
    readKeptWords: (mediaId, audioStream, from, to, cachedOnly) => keptSpeechReads.run(() => 0, async () => {
      const result = await client.dialogueDetections(ctx.projectId, { mediaId, from, to, keptSide: { audioStream, cachedOnly },
        taskId: ctx.taskId, startedAt: ctx.taskStartedAt });
      if (cachedOnly && (result.keptSideUnavailable || result.segments.some(s => s.id !== "kept")))
        throw new Error("Cached speech measurements are unavailable at this edge.");
      return result.segments.flatMap(s => s.words);
    }),
    sound: async (mediaId, range) => (await gapSounds(mediaId, [range], 0))[0],
  };

  /** Posts an event to this session's task. `error` is why one didn't arrive; a session without a task has nowhere to post. */
  async function postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }> {
    if (!ctx.taskId) return { posted: false };
    try {
      await client.postTaskEvent(ctx.taskId, { ...ev, taskId: ctx.taskId });
      return { posted: true };
    } catch (err) {
      const error = describeError(err);
      console.error(`[scarlet-mcp] failed to post task event: ${error}`);
      return { posted: false, error };
    }
  }

  const intent = z.enum(["requested", "suggestion", "alternative"]);
  const intentInput = (ctx.taskId ? intent : intent.optional()).describe(
    "Use requested only for edits the editor asked you to make. Choose suggestion for extra ideas or previews, and alternative for each option offered. Omitting intent leaves the edit in review.",
  );

  type FrameAdjustment = { asked: [number, number]; removed: [number, number] };
  async function propose(body: ProposeChangeRequest, before: Timeline | null, onWholeFrames: FrameAdjustment[] = []): Promise<ToolResult> {
    // Ripple removals go on whole frames, as dialogue cuts do: one that ends between two frames leaves a black frame
    // at its join. Each one that moved is reported with the range that was removed.
    const fps = !body.range && body.ops?.some(op => op.op === "rippleDelete") ? (await getProject()).project.settings.fps : undefined;
    const base = before ? timelineDuration(before) : Infinity;
    // Ops run in order, so each removal across every track brings the end of the edit earlier for the ones after it.
    // Once any other op has run, where the edit ends is not known here, and the base's end stands. It stands for a
    // task's edit throughout: the engine puts a task's removals on whole frames itself, by the base's end, and would
    // make a move left out here without reporting it.
    let ends = base, known = !ctx.taskId;
    if (fps) body = { ...body, ops: body.ops!.map(op => {
      if (op.op !== "rippleDelete" || typeof op.start !== "number" || typeof op.end !== "number") {
        known = false;
        ends = base;
        return op;
      }
      // A removal that runs to the end of the edit keeps its end, which need not be on a frame.
      const aligned = { start: frameAligned(op, fps).start, end: op.end >= ends - 1e-6 ? op.end : frameAligned(op, fps).end };
      if (Math.abs(aligned.start - op.start) > 1e-6 || Math.abs(aligned.end - op.end) > 1e-6) {
        onWholeFrames.push({ asked: [op.start, op.end], removed: [round3(aligned.start), round3(aligned.end)] });
      }
      if (known && !op.trackIds && aligned.start < ends) ends = Math.max(aligned.start, ends - (aligned.end - aligned.start));
      return { ...op, ...aligned };
    }) };
    const req: ProposeChangeRequest = {
      ...body,
      fromVersion: before && before.version !== "draft" ? before.version : undefined,
      author: ctx.author,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    };
    const { change, timeline, diffDescription, duration } = await client.proposeChangeSummary(ctx.projectId, req);
    if (change.state === "approved") lastTimeline = undefined;
    const action = change.state === "approved" ? "Applied" : "Proposed";
    const lines = diffDescription ?? (before && timeline ? describeDiff(diffTimelines(before, timeline), undefined, clipById) : []);
    await postEvent({
      type: "change",
      text: `${action} change ${change.id}: ${change.description}`,
      data: { changeId: change.id, toVersion: change.toVersion, ranges: change.ranges, state: change.state },
    });
    const result = {
      changeId: change.id,
      state: change.state,
      fromVersion: change.fromVersion,
      toVersion: change.toVersion,
      affectedRanges: change.ranges,
      timelineEdits: change.timelineEdits,
      duration: duration ?? (timeline ? timelineDuration(timeline) : undefined),
      diff: lines,
      ...(onWholeFrames.length && { onWholeFrames }),
    };
    return json(result);
  }

  function tool<Shape extends z.ZodRawShape>(
    name: ScarletToolName,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ) {
    if (disabled.has(name) || (name === "source_audio" && !caps.audio)) return;
    // Only a harness with file tools can put anything in the artifact directory for asset_add to import.
    if (name === "asset_add" && !caps.files) return;
    if (authoring && !SKILL_FROM_CHANGE_TOOLS.has(name)) return;
    if (!caps.images && IMAGE_TOOLS.has(name)) return;
    // A request to revise a skill edits no video. It gets the tools for talking to the editor and for the skill.
    if (ctx.task?.kind === "skill_edit" && !SKILL_EDIT_TOOLS.has(name)) return;
    // A rule approved in Learnings is saved with no one to answer a question: what the save can't settle goes back to
    // the editor beside the rule, in its closing words.
    if (name === "task_question" && ctx.task?.kind === "skill_edit" && ctx.task.context.learningId) return;
    // Every request is read for a standing rule by a learning check, which has that tool and the skills. The run that
    // edits doesn't offer rules as well, so the editor never gets the same rule twice in two wordings.
    if (ctx.task?.kind === "learning_check" ? !LEARNING_CHECK_TOOLS.has(name) : name === "learning_suggest") return;
    server.registerTool(name, { description, inputSchema: shape, annotations: toolAnnotations(name) }, (async (args: z.infer<z.ZodObject<Shape>>) => {
      try {
        if (["timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "captions_generate", "asset_add", "dialogue_check_repeats"].includes(name) && await localPausesMode())
          throw new Error("This request only tightens local pauses. Save classified pauses with dialogue_apply_cuts.");
        if (PASS_WIDE_TOOLS.has(name)) {
          const selected = await useStagedCut();
          if (selected) throw selected;
        }
        return await handler(args);
      } catch (err) {
        if (err instanceof MediaPreparing) return text(err.message);
        return errorResult(err);
      }
    }) as never);
  }

  /** The includeAudio flag exists only for a model that can hear; the type always carries it so handlers stay simple. */
  type AudioShape = { includeAudio: z.ZodDefault<z.ZodBoolean> };
  const audioOption = (description: string) => (hearing ? { includeAudio: z.boolean().default(false).describe(description) } : {}) as AudioShape;

  // -- project & media ------------------------------------------------------

  tool(
    "project_get",
    "Get the project: settings (fps, width x height, aspect), every media asset (id, name, kind, duration s, fps, size, hasAudio, hasTranscript, provenance of generated assets), the head version, the edit's duration, and a per-track summary. For an assigned task, editContext contains the editor’s recorded selection, change or cut index, and note IDs when supplied. Media ids are what transcript, waveform and clip tools take as mediaId. For clip-level detail use timeline_get.",
    {},
    async () => {
      const detail: ProjectDetail = await getProject();
      const media = detail.project.media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind, duration: m.duration, fps: m.fps, width: m.width, height: m.height,
        hasAudio: m.hasAudio, hasTranscript: Boolean(m.transcriptId), ...(m.provenance && { provenance: m.provenance }),
      }));
      const tl = detail.timeline;
      lastTimeline = tl && tl.version !== "draft" ? tl : undefined;
      return json({
        id: detail.project.id,
        name: detail.project.name,
        settings: detail.project.settings,
        head: detail.project.head,
        editContext: ctx.task && { ...ctx.task.context, dialogueRange: localRange },
        duration: tl ? timelineDuration(tl) : 0,
        media,
        tracks: tl ? tl.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length, muted: t.muted, hidden: t.hidden })) : [],
      });
    },
  );

  async function inspect(request: () => Promise<InspectionResult>, onReady?: (windows: InspectionWindow[]) => void, batchSignal?: AbortSignal): Promise<ToolResult> {
    let result = await request();
    if (result.state === "preparing") {
      const deadline = Date.now() + (batchSignal ? 120_000 : 10_000);
      const ids = result.renderIds;
      while (Date.now() < deadline) {
        const jobs = await Promise.all(ids.map(id => client.render(id)));
        const failed = jobs.find(({ render }) => render.state === "failed" || render.state === "cancelled");
        if (failed) throw new Error(failed.render.errorDetail || failed.render.error || "Inspection preview was cancelled.");
        if (jobs.every(({ render }) => render.state === "done")) {
          result = await request();
          break;
        }
        await delay(300, undefined, { signal: batchSignal });
      }
    }
    if (result.state === "preparing" && batchSignal) throw new Error("The preview is still preparing. Retry this window.");
    if (result.state === "preparing") return text("Scarlet is preparing the inspection windows. Repeat this call to collect them. Render IDs: " + result.renderIds.join(", "));
    onReady?.(result.windows);
    const content: ToolResult["content"] = [];
    if (result.total !== undefined) content.push({ type: "text", text: JSON.stringify({
      index: result.index, total: result.total, newEvents: result.newEvents,
      comparison: result.newEvents
        ? "Potential new events on the proposed timeline." + (caps.images ? " Check the images before acting." : "")
        : "Only one side has playable footage.",
    }) });
    for (const { jpeg, wav, ...window } of result.windows) {
      content.push({ type: "text", text: JSON.stringify(window) });
      if (caps.images) content.push({ type: "image", mimeType: "image/jpeg", data: jpeg });
      if (hearing && wav) content.push({ type: "audio", mimeType: "audio/wav", data: wav });
    }
    return { content };
  }

  const reviewPassages = new Set<string>();
  async function pinPictures(requests: PictureRequest[]) {
    if (!requests.some(r => !r.mediaId && (!r.version || r.version === "head"))) return requests;
    const { project } = await getProject();
    if (!project.head) throw new Error("The timeline has no footage yet.");
    return requests.map(r => !r.mediaId && (!r.version || r.version === "head") ? { ...r, version: project.head! } : r);
  }
  async function preparePictures(request: PictureRequest, signal?: AbortSignal): Promise<PreparedPictures> {
    let windows: InspectionWindow[] = [];
    const result = await inspect(() => client.contactSheet(ctx.projectId, request, signal), ready => { windows = ready; }, signal);
    return { request, result, windows };
  }
  async function deliverPictures({ request, result, windows }: PreparedPictures) {
    for (const w of windows) {
      if (!w.jpeg || !w.timestamps.length) continue;
      if (w.clock === "timeline" && caps.images) readPassage(w.id, w.range);
      const key = JSON.stringify([w.clock, w.id, w.range]);
      if (ctx.taskId && scanScopes.size && !reviewPassages.has(key)) {
        reviewPassages.add(key);
        const n = reviewPassages.size;
        if (n === 1 || n % 10 === 0) await postEvent({ type: "log", data: { kind: "editor_progress", reviewCounter: "pictures", count: n },
          text: n === 1 ? "The first passage is ready for picture review." : `Prepared frames for ${n} passages in the edit.` });
      }
    }
    return result;
  }
  tool("frame_contact_sheet",
    "See timestamped frames from one source or timeline window of up to 120 s. Use activity mode (up to 12 s) for pause checks, scene mode for shots, or focus for a cut boundary. For two or more windows use frame_contact_sheet_batch, which returns all of them in one result.",
    { ...SheetOptions, mediaId: z.string().optional(), version: z.string().optional() },
    async args => {
      const [request] = await pinPictures([SheetRequest.parse(args)]);
      return deliverPictures(await preparePictures(request!));
    });

  const batches = new PictureBatches(preparePictures);
  server.server.onclose = () => { batches.close(); reviews.close(); };
  tool("frame_contact_sheet_batch",
    "Inspect 1–8 independent picture windows together, each up to 120 s. One call returns every window's sheet, labeled by the index of its original window. If any took longer, nextCursor is set: collect the rest with batchId and that cursor until null. Activity sheets check every frame for pause decisions.",
    { windows: z.array(SheetRequest).min(1).max(8).optional(), batchId: z.string().min(1).optional(), cursor: z.number().int().nonnegative().default(0) },
    async ({ windows, batchId, cursor }) => {
      if (!!windows === !!batchId || (windows && cursor)) throw new Error("Submit windows or collect a batchId with its cursor.");
      const id = batchId ?? batches.start(await pinPictures(windows!));
      const page = await batches.collect(id, cursor);
      const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ batchId: id, total: page.total, nextCursor: page.nextCursor }) }];
      for (const item of page.items) {
        content.push({ type: "text", text: JSON.stringify({ index: item.index, ...("error" in item && { error: item.error }) }) });
        if ("pictures" in item) content.push(...(await deliverPictures(item.pictures)).content);
      }
      return { content };
    });

  // Offered only to a model whose harness delivers audio (see agentCapabilities).
  tool("source_audio",
    "Listen to up to eight seconds of an original microphone or video, in source seconds: compare takes or hear an edge before deciding a cut.",
    SourceAudioOptions, async args => {
      const { wav } = await client.sourceAudio(ctx.projectId, args);
      return { content: [{ type: "audio", mimeType: "audio/wav", data: wav }] };
    });

  tool("sound_picture",
    `Look at up to 15 s of a recording the way an editor does: its waveform over its spectrogram (0 to 8 kHz bottom to top, brighter is louder), with the transcript's words at their times and a tick where each starts. It shows what words and level figures cannot: a word cut short, the hiss of an “s”, a breath, a click, speech the transcript left out. With \`remove\`, those source ranges are shaded and a second row shows the passage as it would play with them out, at the same scale, each join a red line: look at a join before you make it. The text beside the picture gives each row's place in it and the pixels per second.${hearing ? " A passage of up to eight seconds also comes as audio." : ""}`,
    SoundPictureOptions, async ({ mediaId, from, to, remove, voice }) => {
      const words = (await transcriptWords(mediaId).catch(withoutOnce(`failed to read the words of ${mediaId} for a sound picture`, null)))
        ?.filter(w => w.end > from && w.start < to && w.text.trim()).map(w => ({ text: w.text.trim(), start: w.start, end: w.end }));
      const { jpeg, layout } = await client.soundPicture(ctx.projectId, { mediaId, from, to, ...(remove && { remove }), ...(voice && { voice }), ...(words && { words }) });
      const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ mediaId, from, to, ...layout }) }, { type: "image", mimeType: "image/jpeg", data: jpeg }];
      // A model that can hear gets the passage itself with the picture, without asking twice.
      if (hearing && to - from <= 8) {
        const heard = await client.sourceAudio(ctx.projectId, { mediaId, from, to, ...(voice && { voice }) }).catch(withoutOnce(`failed to read the audio of ${mediaId} for a sound picture`, null));
        if (heard) content.push({ type: "audio", mimeType: "audio/wav", data: heard.wav });
      }
      return { content };
    });

  const { includeAudio: _reviewAudio, ...cutReviewShape } = CutReviewOptions;
  tool("change_review_cut",
    "Compare one chronological cut or changed spot on the original and proposed versions. Reports new black frames, freezes and abrupt mix-level changes (dB)." + (caps.images ? " Includes labeled composite frames." : "") + " Read total to review the next index. For how a dialogue join sounds, use timeline_join_audit.",
    { ...cutReviewShape, ...audioOption("Attach a short WAV of each side") },
    args => inspect(() => client.reviewCut(ctx.projectId, { ...args, includeAudio: hearing && args.includeAudio === true })));

  tool(
    "media_frame",
    "Grab a single video frame as a JPEG image so you can look at it. `t` is seconds into the SOURCE media (not the timeline; use timeline_at to map a timeline time to a source time). `width` is the output width in pixels (default 640; keep it small). Use this to check framing, what is on screen, or whether a screen recording shows the relevant content.",
    {
      mediaId: z.string().describe("Media asset id"),
      t: z.number().min(0).describe("Source time in seconds"),
      width: z.number().int().min(64).max(1920).optional().describe("Output width in pixels, default 640"),
    },
    async ({ mediaId, t, width }) => {
      const w = width ?? 640;
      const res = await client.withResource("media", mediaId, async path => {
        const url = client.url(`${path}/frame?t=${t}&w=${w}`);
        const headers: Record<string, string> = {};
        if (client.token) headers.Authorization = `Bearer ${client.token}`;
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
          throw new ScarletApiError(response.status, body?.error?.code ?? "frame_failed", body?.error?.message ?? response.statusText);
        }
        return response;
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      return {
        content: [
          { type: "text", text: `Frame of ${mediaId} at ${t.toFixed(3)} s (${w}px wide).` },
          { type: "image", data: buf.toString("base64"), mimeType: mime },
        ],
      };
    },
  );

  // -- transcript -----------------------------------------------------------

  tool(
    "transcript_get",
    `Word-timed transcript of a media asset in SOURCE seconds. Each word carries a stable index (#123): the same index transcript_search, timeline_transcript and dialogue_scan show, and the word reference dialogue_check_join and dialogue_apply_cuts accept. Word times locate words; cut edges go where the recording is silent, which the dialogue tools measure. In text, a gap of ${GAP_SECONDS} s or more between two words is followed by a line saying what the recording holds there: quiet, or how much of it is sound at speaking level that no word explains, with its source seconds. That sound is whatever the transcript left out: a word it missed, a cut-off start, a breath, a laugh, typing. A missing transcript is started or joined with the configured provider; if the call reports preparation, call again. Narrow with from/to seconds or fromWord/toWord. A long result includes nextFromWord: pass it back with the same range, granularity and format to read the next page. Text format: \`#index start-end word\` lines (word) or \`[start-end] #first-#last speaker: text\` lines (segment); json: [index, start, end, text, speaker] tuples.`,
    {
      mediaId: z.string(),
      from: z.number().min(0).optional().describe("Start of range, source seconds"),
      to: z.number().min(0).optional().describe("End of range, source seconds"),
      fromWord: z.number().int().min(0).optional().describe("First word index"),
      toWord: z.number().int().min(0).optional().describe("Last word index"),
      nextFromWord: z.number().int().min(0).optional().describe("Continuation word index returned by the previous page"),
      granularity: z.enum(["word", "segment"]).default("word"),
      format: z.enum(["json", "text"]).default("text"),
    },
    async ({ mediaId, from, to, fromWord, toWord, nextFromWord, granularity, format }) => {
      const words = await transcriptWords(mediaId);
      if (!words) return text(`Media ${mediaId} has no audio track or no transcribed speech. Use waveform_get to inspect its sound.`);
      const settled = settledThrough(mediaId);
      const estimates = Number.isFinite(settled) ? `Times after ${settled.toFixed(1)} s are estimates until Scarlet has placed those words on the audio; indices are final.` : undefined;
      const budget = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      const inRange = (w: TranscriptWord, index: number) =>
        (from === undefined || w.end >= from) && (to === undefined || w.start <= to) &&
        (fromWord === undefined || index >= fromWord) && (toWord === undefined || index <= toWord);
      const picked: Array<TranscriptWord & { index: number }> = [];
      let nextIndex: number | undefined;
      let minimumSize = 0;
      // Bound the waveform measurements and formatting to what could fit. A word's spelling plus
      // its separator is a lower bound for every format. The exact rendered size decides below.
      for (let index = Math.max(nextFromWord ?? 0, fromWord ?? 0); index < words.length && index <= (toWord ?? Infinity); index++) {
        const word = words[index]!;
        if (!inRange(word, index)) continue;
        minimumSize += word.text.trim().length + 1;
        if (picked.length && minimumSize > budget) { nextIndex = index; break; }
        picked.push({ ...word, index });
      }
      if (!picked.length) return text(`No speech in that range of ${mediaId} (${words.length} words, #0–#${words.length - 1}). Use waveform_get to inspect pauses.`);
      // The continuation is outside the word list in both formats. A giant single imported
      // word still travels intact: stable indices address words, never fragments of a word.
      function page(render: (count: number, next?: number) => string) {
        const complete = render(picked.length, nextIndex);
        if (complete.length <= budget || picked.length === 1) return text(complete);
        let low = 1, high = picked.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (render(mid, picked[mid]!.index).length <= budget) low = mid;
          else high = mid - 1;
        }
        return text(render(low, picked[low]!.index));
      }
      if (format === "json") {
        const tuples = picked.map(w => [w.index, w.start, w.end, w.text.trim(), w.speaker ?? null]);
        return page((count, next) => JSON.stringify({ mediaId, ...(estimates && { timesFinalThrough: round3(settled) }),
          words: tuples.slice(0, count), ...(next !== undefined && { nextFromWord: next }) }));
      }
      // What the recording holds in each gap between two words, by the index of the word after it.
      const gapped = picked.flatMap((w, i) => {
        // A gap belongs to the word after it, even when it falls exactly between two pages.
        // A fresh ranged read retains its original first-word behavior.
        const previous = words[w.index - 1];
        if (!previous || (!i && nextFromWord === undefined) || !inRange(previous, w.index - 1)) return [];
        return w.start - previous.end >= GAP_SECONDS ? [{ index: w.index, start: previous.end, end: w.start }] : [];
      });
      const sounds = await gapSounds(mediaId, gapped).catch(withoutOnce(`failed to read the levels between the words of ${mediaId}`, [] as Array<GapSound | undefined>));
      const gapNote = new Map(gapped.flatMap((g, i) => sounds[i] ? [[g.index, `  · ${(g.end - g.start).toFixed(2)} s gap, ${describeGapSound(sounds[i]!)}`] as const] : []));
      return page((count, next) => {
        const shown = picked.slice(0, count);
        const lines: string[] = [];
        if (granularity === "segment") {
          let group: typeof picked = [];
          const flush = () => {
            if (!group.length) return;
            const a = group[0]!, b = group.at(-1)!;
            lines.push(`[${a.start.toFixed(2)}-${b.end.toFixed(2)}] #${a.index}-#${b.index}${a.speaker ? ` ${a.speaker}:` : ""} ${group.map(w => w.text.trim()).join(" ")}`);
            group = [];
          };
          for (const w of shown) {
            const prev = group.at(-1);
            if (prev && (gapNote.has(w.index) || w.start - prev.end >= .6 || w.speaker !== prev.speaker || /[.?!]["”’)]*$/.test(prev.text.trim()))) flush();
            if (gapNote.has(w.index)) lines.push(gapNote.get(w.index)!);
            group.push(w);
          }
          flush();
        } else {
          let speaker: string | undefined;
          for (const w of shown) {
            if (gapNote.has(w.index)) lines.push(gapNote.get(w.index)!);
            lines.push(`#${w.index} ${w.start.toFixed(2)}-${w.end.toFixed(2)}${w.speaker && w.speaker !== speaker ? ` ${w.speaker}:` : ""} ${w.text.trim()}`);
            speaker = w.speaker;
          }
        }
        const more = next === undefined ? "" : `\nContinue with nextFromWord=${next}.`;
        return `${mediaId}: words #${picked[0]!.index}–#${shown.at(-1)!.index} of ${words.length}, source seconds.${estimates ? ` ${estimates}` : ""}\n${lines.join("\n")}${more}`;
      });
    },
  );

  tool(
    "transcript_search",
    "Search a media asset's transcript. exact: case- and punctuation-insensitive phrase match. fuzzy: token similarity (0..1) that tolerates paraphrase and ASR spelling, for finding every take of a line. Returns each match with source seconds, its first word index and surrounding words.",
    {
      mediaId: z.string(),
      query: z.string().min(1).describe("Phrase to find"),
      match: z.enum(["exact", "fuzzy"]).default("exact"),
      minScore: z.number().min(0).max(1).default(.6).describe("Fuzzy only: lowest similarity to report"),
      contextWords: z.number().int().min(0).max(30).default(6),
    },
    async ({ mediaId, query, match, minScore, contextWords }) => {
      const words = await transcriptWords(mediaId);
      if (!words) return text(`No transcribed speech to search for media ${mediaId}.`);
      const matches = match === "fuzzy" ? fuzzySearchTranscript(words, query, { contextWords, minScore }) : searchTranscript(words, query, contextWords);
      if (!matches.length) return text(`No ${match} matches for "${query}" in ${mediaId} (${words.length} words searched).`);
      const lines = matches.map((m) => `#${m.wordIndex} [${m.start.toFixed(2)}-${m.end.toFixed(2)}]${"score" in m ? ` ${m.score}` : ""}${m.speaker ? ` ${m.speaker}:` : ""} ${m.context}`);
      return text(`${matches.length} ${match} match(es) for "${query}" in ${mediaId}:\n${lines.join("\n")}`);
    },
  );

  // -- waveform -------------------------------------------------------------

  tool(
    "waveform_get",
    "Audio levels for a range of a media asset in source seconds; missing waveforms are prepared automatically. Returns peak level per bucket in dBFS (evenly spaced over from..to), a sparkline, and silences: runs below thresholdDb lasting at least minSilence seconds. With suggestCuts (a window up to 60 s) it also returns the removable interiors of pauses between timed words and the air left either side.",
    {
      mediaId: z.string(),
      from: z.number().min(0).describe("Range start, source seconds"),
      to: z.number().min(0).describe("Range end, source seconds"),
      points: z.number().int().min(10).max(4000).default(400).describe("Number of buckets; 400 over 60 s = 0.15 s resolution"),
      thresholdDb: z.number().max(0).default(-26).describe("Peak level in dBFS below which a bucket counts as silent"),
      suggestCuts: z.boolean().default(false),
      minSilence: z.number().min(0).default(0.25).describe("Minimum silence duration to report, seconds"),
    },
    async ({ mediaId, from, to: asked, points, thresholdDb, minSilence, suggestCuts }) => {
      if (asked <= from) throw new Error("`to` must be greater than `from`.");
      // The range stops where the recording does. Past its end the engine has nothing and answers with empty buckets,
      // which read as silence that isn't in the recording.
      const duration = (await client.media(ctx.projectId)).media.find(m => m.id === mediaId)?.duration;
      const to = duration ? Math.min(asked, duration) : asked;
      if (duration && to <= from) throw new Error(`Choose a range inside 0–${duration.toFixed(2)} s.`);
      if (suggestCuts && to > from + 60) throw new Error("suggestCuts reads at most 60 source seconds per call. Split the range.");
      const threshold = 10 ** (thresholdDb / 20);
      const resolution = suggestCuts ? Math.max(points, Math.ceil((to - from) * 50)) : points;
      const wf = await readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, resolution, true, suggestCuts));
      let dialogue;
      if (suggestCuts) {
        try {
          const transcript = await getTranscript(mediaId, { from: Math.max(0, from - 2), to: to + 2, granularity: "word" });
          const found = dialogueCutSuggestions(transcript, wf, { threshold, minSilence });
          dialogue = { ...found, candidates: found.candidates.map(({ maxPeak, ...c }) => ({ ...c, maxPeakDb: dbfs(maxPeak) })) };
        } catch (err) {
          if (!(err instanceof ScarletApiError && err.code === "transcription_unavailable")) throw err;
          dialogue = { candidates: [], reason: err.message };
        }
      }
      const peaks = wf.peaks.map((p) => Math.round(p * 1000) / 1000);
      const silences = detectSilences(peaks, wf.from, wf.to, { threshold, minDuration: minSilence });
      const shown = downsample(peaks, points);
      return json({ mediaId, from: wf.from, to: wf.to, bucketSeconds: round3((wf.to - wf.from) / Math.max(1, shown.length)),
        peaksDb: shown.map(dbfs), sparkline: sparkline(peaks, 100), silences, speechActivity: wf.speechActivity, dialogue });
    },
  );

  tool("audio_sync", "Measure the sync offset between two recordings of the same event from their shared audio: the seconds the secondary starts after the reference (negative = earlier). Placed from source zero at normal speed, the secondary's timelineIn is the reference's timelineIn plus this offset. No offset means no unambiguous match.",
    { referenceId: z.string(), secondaryId: z.string() },
    async ({ referenceId, secondaryId }) => {
      if (referenceId === secondaryId) throw new Error("referenceId and secondaryId are the same recording. Choose two different recordings.");
      const { project } = await getProject();
      async function envelope(id: string) {
        const media = project.media.find(m => m.id === id);
        if (!media) throw new Error(`Media ${id} is not in this project. Use project_get for media ids.`);
        const count = Math.floor((media.duration ?? 0) * syncRate);
        const values: number[] = [];
        if (media.hasAudio === false || !count) return values;
        for (let start = 0; start < count; start += 10000) {
          const end = Math.min(start + 10000, count);
          const wave = await readPrepared(id, "waveform", () => client.waveform(id, start / syncRate, end / syncRate, end - start, true));
          if (wave.peaks.length !== end - start) {
            throw new Error(`The waveform of ${id} covered ${wave.peaks.length} of ${end - start} samples from ${(start / syncRate).toFixed(1)} s. Retry; a truncated source needs a sync point from the editor.`);
          }
          values.push(...wave.peaks);
        }
        return values;
      }
      const [reference, secondary] = await Promise.all([envelope(referenceId), envelope(secondaryId)]);
      const match = matchAudio(reference, secondary);
      return json(match ?? { matchedWindows: 0, reason: "No unambiguous constant offset from shared audio." });
    });

  function detectWindow(mediaId: string, from: number, to: number) {
    const key = JSON.stringify([mediaId, from, to]);
    let job = pendingDetections.get(key);
    if (!job) {
      job = client.dialogueDetections(ctx.projectId, { mediaId, from, to, taskId: ctx.taskId, startedAt: ctx.taskStartedAt })
        .then(result => { dialogueFailures.delete(mediaId); return result; }, (err: unknown) => {
          dialogueFailures.set(mediaId, { count: (dialogueFailures.get(mediaId)?.count ?? 0) + 1, error: describeError(err) });
          throw err;
        })
        .finally(() => pendingDetections.delete(key));
      pendingDetections.set(key, job);
    }
    return job;
  }

  function scanProgress(asset: MediaAsset, page: Omit<DialogueScanPage, "mediaId">) {
    return postEvent({ type: "log", text: `Dialogue scan · ${asset.name}`,
      data: { kind: "editor_progress", scanPage: { mediaId: asset.id, ...page } } });
  }

  async function scanPages(asset: MediaAsset, from: number, end: number) {
    const key = JSON.stringify([asset.id, end]);
    const previous = scanScopes.get(key);
    const start = Math.min(previous ?? from, from);
    const opening = previous !== start;
    scanScopes.set(key, start);
    if (opening) await scanProgress(asset, { from: start, end });
    const range = { mediaId: asset.id, from: start, to: end };
    let pages;
    let background = false;
    if (ctx.taskId) {
      try {
        pages = await client.startDialogueScan(ctx.projectId, { ...range, taskId: ctx.taskId, startedAt: ctx.taskStartedAt });
        background = true;
      } catch (err) {
        if (err instanceof ScarletApiError && err.code === "edit_inactive") throw err;
        // An older engine or an unavailable local detector can still serve saved evidence.
        unavailableOnce(`failed to start the background dialogue scan of ${asset.id}`, err);
      }
    }
    pages ??= await client.dialogueCheckpoints(ctx.projectId, range).catch(withoutOnce(`failed to read the saved dialogue pages of ${asset.id}`, []));
    const aligned = pages.filter(p => p.end === Math.min(end, p.start + 60)
      && Math.abs((p.start - start) / 58 - Math.round((p.start - start) / 58)) < 1e-8);
    if (opening) for (const page of mergeRanges(aligned)) await scanProgress(asset, { from: page.start, to: page.end, end });
    return { saved: new Map(aligned.map(p => [p.start, p.end])), background };
  }

  // Picture measurements under way or done, by the windows asked, so a page read again collects them.
  const pictureJobs = new Map<string, Promise<PictureActivityWindow[] | null>>();
  let playing: { tl: Timeline | null; media: MediaAsset[]; at: number } | undefined;
  /**
   * What the picture does through each silence, for every video the edit shows there. One request covers the page.
   * A silence whose measurement isn't back within the budget reads "measuring", and the next read of the page has it.
   */
  async function silencePictures(mediaId: string, stretches: Silence[], budgetMs: number) {
    if (!stretches.length) return [];
    // The edit as it stands says which pictures play with this recording. Read it apart from the version the agent
    // last looked at, which its own edits are proposed against.
    if (!playing || Date.now() - playing.at > 30_000) {
      const [tl, media] = await Promise.all([
        client.timeline(ctx.projectId, "head").then(r => r.timeline, (err: unknown) => {
          // A project with no edit yet shows no picture. That is not a failure.
          if (!(err instanceof ScarletApiError && err.status === 404)) unavailableOnce("failed to read the edit for the pictures through silences", err);
          return null;
        }),
        client.media(ctx.projectId).then(r => r.media, withoutOnce("failed to read the media for the pictures through silences", [] as MediaAsset[]))]);
      playing = { tl, media, at: Date.now() };
    }
    const { tl, media } = playing;
    if (!tl) return [];
    const asked = stretches.map(s => pictureWindows(tl, media, mediaId, { start: s.start, end: Math.min(s.end, s.start + 60) }));
    const flat = asked.flatMap((windows, i) => windows.map(w => ({ i, w }))).slice(0, 24);
    if (!flat.length) return [];
    const key = JSON.stringify(flat.map(f => [f.w.mediaId, f.w.from, f.w.to]));
    let job = pictureJobs.get(key);
    if (!job) {
      // An engine without this measurement, or a source it can't decode, leaves the silences without a picture reading.
      job = client.pictureActivity(ctx.projectId, { windows: flat.map(({ w }) => ({ mediaId: w.mediaId, from: w.from, to: w.to })) })
        .then(r => r.windows, err => { pictureJobs.delete(key); unavailableOnce("failed to measure the pictures through silences", err); return null; });
      pictureJobs.set(key, job);
    }
    const timer = new AbortController();
    const done = await Promise.race([job, delay(Math.max(0, budgetMs), "pending" as const, { signal: timer.signal, ref: false })]).finally(() => timer.abort());
    if (!done) return [];
    return stretches.map((_, i) => {
      const mine = flat.flatMap((f, n) => f.i === i ? [n] : []);
      if (!mine.length) return undefined;
      return done === "pending" ? "measuring" as const : mine.map(n => pictureReading(done[n]!, flat[n]!.w.shift));
    });
  }

  async function readDialoguePage(asset: MediaAsset, from: number, end: number, saved: Map<number, number>, background: boolean) {
    const mediaId = asset.id, to = Math.min(end, from + 60);
    const failed = dialogueFailures.get(mediaId);
    if (failed && failed.count >= DIALOGUE_FAILURE_LIMIT && !pendingDetections.has(JSON.stringify([mediaId, from, to]))) {
      const transcript = await transcriptState(mediaId);
      if (transcript && !transcript.ready) {
        // The run now waits on the transcript. If it ends first, Scarlet records that it ended without it.
        const key = `transcript/${mediaId}`;
        let job = preparations.get(key);
        if (!job) {
          job = prepare(mediaId, "transcript");
          preparations.set(key, job);
          const settled = job;
          void settled.then(() => preparations.get(key) === settled && preparations.delete(key), () => preparations.get(key) === settled && preparations.delete(key));
        }
        waitingOn("transcript", mediaId, job);
        throw new MediaPreparing(`Dialogue analysis of ${asset.name} failed ${failed.count} times in a row (last: ${failed.error}) while its transcript is ${transcript.note}. ` +
          "Scarlet won't request it again until the transcript is saved, so waiting here gains nothing. Save the edits you can decide without it and end your run, saying what is left. " +
          "Scarlet records that the run ended without this transcript and offers the editor to finish the request once it is ready.");
      }
    }
    const timer = new AbortController();
    const pageDeadline = Date.now() + 52_000;
    let detections: DialogueDetections | undefined, detectorIssue: string | undefined;
    try {
      // Allow ordinary local inference to finish within one MCP call. Keep a
      // margin below the common 60-second client deadline for unusually slow jobs.
      const job = detectWindow(mediaId, from, to);
      const ready = await Promise.race([job, delay(45_000, "pending" as const, { signal: timer.signal, ref: false })]);
      if (ready === "pending") {
        waitingOn("dialogue", mediaId, job);
        const transcript = await transcriptState(mediaId);
        const behind = transcript && !transcript.ready ? ` It takes turns with this recording's transcript, which is ${transcript.note}.` : "";
        throw new MediaPreparing(`Dialogue analysis is still running.${behind} Collect this same window at ${from} seconds after reviewing the available material.`);
      }
      detections = ready;
    } catch (err) {
      if (err instanceof MediaPreparing) throw err;
      detectorIssue = describeError(err);
    } finally { timer.abort(); }
    const points = Math.max(10, Math.ceil((to - from) * 50));
    const wf = await readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, points, true, !detections?.speechActivity));
    if (detections?.speechActivity) wf.speechActivity = detections.speechActivity;
    const transcript = detections ? { id: "first-pass", mediaId, segments: detections.segments }
      : await getTranscript(mediaId, { from, to, granularity: "word" }, false);
    const observed = firstCutEvidence(transcript, wf);
    // Use measured words only. The saved transcript's synthesized search timings can
    // differ from this scan. Keep the preceding page's non-overlapping tail on resume.
    const timedWords = (segments: DialogueDetections["segments"], start: number, end: number) =>
      segments.flatMap(s => s.words.filter(w => w.start >= start && w.end <= end && w.end > w.start)
        .map(w => w.speaker || !s.speaker ? w : { ...w, speaker: s.speaker })).sort((a, b) => a.start - b.start);
    const scopeStart = scanScopes.get(JSON.stringify([mediaId, end])) ?? from;
    const previous = evidence.scans.find(s => s.mediaId === mediaId && s.start >= scopeStart && Math.abs(s.start + 58 - from) < 1e-6);
    const earlierWords = timedWords(previous?.segments ?? [], Math.max(scopeStart, from - 25), from);
    const repeatedTakes = findRepeatedTakes([...earlierWords, ...timedWords(transcript?.segments ?? [], from, to)])
      .filter(cue => cue.next.end > from)
      // Independent decodes can move a word across the seam. A cross-page match
      // helps find the takes, but cannot establish an uninterrupted restart.
      .map(cue => cue.first.start < from ? { ...cue, immediateRestart: false } : cue);
    const fillers = matchFillers(observed.fillers, detections?.acoustic ?? []);
    // Measured while the saved transcript's words are found for this page.
    const quiet = silences(transcript, wf, { previous: earlierWords.at(-1) });
    const pictures = silencePictures(mediaId, quiet, Math.min(6000, pageDeadline - Date.now() - 12_000))
      .catch(withoutOnce(`failed to read the pictures through silences of ${mediaId}`, []));
    // Stable word indices from the saved transcript, once its words are placed on the audio through this page, so a
    // cut can name its words. They are matched to the page by time, and an estimate could name the neighbouring word.
    const indexed = await transcriptWords(mediaId, false, to, Math.min(10_000, Math.max(0, pageDeadline - Date.now())))
      .catch(withoutOnce(`failed to read the word indices of ${mediaId}`, null));
    // A quiet phrase can start before the next page's overlap. Return it whole when its last word is reached.
    const audioStream = dialogueAudioStream(asset);
    const soft = indexed && (audioStream ?? 0) === 0
      ? (await readQuietPhrases(mediaId, Math.max(scopeStart, from - QUIET_PHRASE_CONTEXT), to)
        .catch(withoutOnce(`failed to measure quiet phrases on ${mediaId}`, []))).filter(p => p.end > from) : [];
    const indexOf = (start: number, end: number) => {
      if (!indexed) return undefined;
      const inside = indexed.flatMap((w, i) => (w.start + w.end) / 2 >= start - .05 && (w.start + w.end) / 2 <= end + .05 ? [i] : []);
      return inside.length ? [inside[0]!, inside.at(-1)!] as [number, number] : undefined;
    };
    const room = levelProfile({ from: wf.from, to: wf.to, rms: wf.rms ?? [] }, transcript ? transcript.segments.flatMap(s => s.words) : null).roomToneDbfs;
    const scan = detections && dialogueScanPage(mediaId, from, to, audioStream ?? 0, detections.segments, wf);
    const pauses = firstCutPauses(transcript, wf, scan?.edges);
    if (scan) {
      const index = evidence.scans.findIndex(s => s.mediaId === mediaId && s.start === from && s.end === to);
      if (index < 0) evidence.scans.push(scan);
      else evidence.scans[index] = scan;
    }
    if (!background && !saved.has(from) && detections && !detections.speakerIssue && !detections.voiceRoleIssue) {
      await scanProgress(asset, { from, to, end });
    }
    // Read after alignment so a late cache fill or a reread of this page can supply new evidence.
    const wordRuns = await client.dialogueAcousticWords(ctx.projectId, { mediaId, audioStream, from: Math.max(scopeStart, from - 25), to })
      .catch((err: unknown) => {
        if (!(err instanceof ScarletApiError && err.status === 404)) unavailableOnce(`failed to read the acoustic words of ${mediaId}`, err);
        return [] as TranscriptWord[][];
      });
    const acousticTakes = acousticRepeatedTakes(wordRuns, from);
    const takes = acousticRetakeContinuations(wordRuns, acousticTakes);
    const pageKey = JSON.stringify([mediaId, from, to, audioStream]);
    if (takes.length) acousticRetakePages.set(pageKey, { mediaId, audioStream, takes });
    else acousticRetakePages.delete(pageKey);
    return { mediaId, from, to, ...(room !== undefined && { roomToneDbfs: room }), ...observed,
      // Each lookup scans the whole recording's transcript.
      passages: observed.passages.map(p => { const words = indexOf(p.start, p.end); return { ...p, ...(words && { words }) }; }),
      repeatedTakes,
      ...(wordRuns.length && { acousticRepeatedTakes: acousticTakes }),
      ...(soft.length && { quietPhrases: soft }),
      fillerCandidates: fillers.map(f => { const words = indexOf(f.start, f.end); return { ...f, ...(words && { words }) }; }),
      detectors: detections ? ["prompted-whisper", "uhm"] : [], detectorIssue, speakerTurns: detections?.speakerTurns, speakerIssue: detections?.speakerIssue, otherVoiceTurns: detections?.otherVoiceTurns, voiceRoleIssue: detections?.voiceRoleIssue,
      pauses: pauses.map(p => "maxPeak" in p ? (({ maxPeak, ...rest }) => ({ ...rest, maxPeakDb: dbfs(maxPeak) }))(p) : p),
      silences: await pictures.then(read => quiet.map((s, i) => ({ ...s, ...(read[i] && { picture: read[i] }) }))) };
  }

  // How far the agent has read in each recording, and where it stood at its last save. The editor reviews saved parts
  // while the run continues, so a long read without saving keeps them waiting.
  const readTo = new Map<string, number>();
  const savedAt = new Map<string, number>();
  // The pass this run staged cuts on last, and how many of them have no recommendation yet. A staged cut reaches the
  // editor as a call only once it has one, and an agent that read on after each part saved every recommendation in one
  // batch at the end, so the editor had nothing to decide for ten minutes and then fifteen calls at once (2026-11-10).
  let stagedReview: Promise<StagedReview | undefined> | undefined;
  let stageWithoutAppliedCuts: string | undefined;

  async function firstRecommendationNeeded() {
    const id = stageWithoutAppliedCuts;
    if (!id) return;
    // The editor can finish or replace this proposal while the model works.
    const record = await client.changeRecord(id).catch((error: unknown) => {
      if (!(error instanceof ScarletApiError && error.status === 404)) throw error;
      return undefined;
    });
    const change = record?.change;
    if (change?.state === "ready" && !change.replacedBy) {
      const prepared = await stagedReview;
      const assessed = change.cutAssessments?.filter(a => !a.provisional).length ?? 0;
      // A replacement review can inherit every recommendation from the preceding section.
      const hasRecommendation = prepared?.changeId === id
        ? prepared.unchecked === 0 || assessed > prepared.total - prepared.unchecked
        : assessed > 0;
      if (!hasRecommendation && stageWithoutAppliedCuts === id)
        return `This batch only staged cuts on ${id}. Use dialogue_review_inspect and dialogue_review_save to give the editor a recommendation on a new cut before reading another section.`;
    }
    if (stageWithoutAppliedCuts === id) stageWithoutAppliedCuts = undefined;
  }
  // How far into each recording the furthest saved cut reaches.
  const cutTo = new Map<string, number>();
  // How far into each recording the joins the agent has checked reach. It checks a part's joins before it saves the
  // part, minutes ahead on a long recording, so the editor's cut figure moves from the first check instead of sitting
  // at nothing until the first save. Reported only when it moves on.
  const checkedTo = new Map<string, number>();
  async function reportChecked(tl: Timeline, ranges: ReadonlyArray<{ start: number; end: number }>) {
    if (!ctx.taskId) return;
    for (const [mediaId, to] of cutsReach(tl, ranges)) {
      if (to <= (checkedTo.get(mediaId) ?? 0)) continue;
      checkedTo.set(mediaId, to);
      await postEvent({ type: "log", text: "", data: { kind: "join_progress", mediaId, through: to } });
    }
  }
  const scanBatches = new Map<string, DialogueScanBatch>();
  tool("dialogue_scan",
    "Read a dialogue recording in pages (60 s pages overlapping by 2 s, source seconds). Start at the beginning of the requested range, also when resuming; read the page and any restoredPages, then call again with nextFrom until it is null. On a first dialogue cut, save decided cuts when a page returns saveCheckpoint before reading the next section. During a task Scarlet scans the whole range in the background, so later pages often return at once; a page still analyzing says so, and you can collect it after reviewing other material. Each page: passages (spoken text, with `words` = [first, last] transcript_get indices once the saved transcript's words are placed on the audio that far), repeatedTakes (attempts at the same line with the source times and continuation of each; evidence, not a decision), acousticRepeatedTakes (adjacent deliveries independently decoded from cached English speech, with approximate source times and continuation), fillers and fillerCandidates (each with the detectors that heard it: whisper = verbatim transcription, uhm = acoustic filler model; both agreeing is the strongest evidence), pauses (quiet interiors that could be removed, with the air either side), silences (every stretch of 1.5 s or more with no transcript word, whatever sounds in it: the words either side, voiceSeconds the voice detector fired inside it with no word, as typing or a breath does, and, where the current edit shows video through it, picture per video source: changedFrames of frames, the typical and the largest changed region in percent of the frame, and when the largest and the last change happen in this recording's seconds; `measuring` is ready on the next read of the page), unmatchedVoice (voice activity no transcript word explains: breaths, overlapping talk or missed words), speakerTurns (recording-local voice numbers; a number marks a distinct voice, and only confirmed input roles say which is the presenter), otherVoiceTurns (speech on a confirmed other input), roomToneDbfs, and quietPhrases (transcribed words much quieter than the speech on both sides, with source seconds, fromWord/toWord, and the phrase and neighboring levels in dBFS). detectorIssue names incomplete evidence.",
    { mediaId: z.string(), from: z.number().finite().nonnegative().default(0),
      until: z.number().finite().positive().optional().describe("Exclusive end of the requested source range. Defaults to the end of this recording."),
      noCutsReadyThrough: z.number().finite().nonnegative().optional().describe("The through value of a saveCheckpoint, only if this section has no settled cuts to save yet.") },
    async ({ mediaId, from, until, noCutsReadyThrough }) => {
      const { media } = await client.media(ctx.projectId);
      const asset = media.find(m => m.id === mediaId);
      if (!asset || (asset.kind !== "audio" && !asset.hasAudio)) throw new Error("Choose a source with audio from this project.");
      if (!asset.duration) throw new Error("Source duration is unavailable. Check import status before scanning.");
      const end = Math.min(until ?? asset.duration, asset.duration);
      if (from >= end) throw new Error("Choose a nonempty range inside the source.");
      if (!ctx.taskId || await dialogueOperation() !== "first-cut") return scanDialogue(asset, from, end);
      let batch = scanBatches.get(mediaId);
      if (!batch) {
        batch = new DialogueScanBatch();
        scanBatches.set(mediaId, batch);
      }
      return batch.reads.run(() => 0, () => scanDialogue(asset, from, end, batch, noCutsReadyThrough));
    });

  async function scanDialogue(asset: MediaAsset, from: number, end: number, batch?: DialogueScanBatch, noCutsReadyThrough?: number) {
    const mediaId = asset.id;
    const firstEnd = Math.min(from + 60, end);
    const reviewFirst = batch && await firstRecommendationNeeded();
    if (reviewFirst && batch?.isNewPage(from, firstEnd)) throw new Error(reviewFirst);
    batch?.startRead(from, firstEnd, noCutsReadyThrough);
    const { saved, background } = await scanPages(asset, from, end);
    const first = await readDialoguePage(asset, from, end, saved, background);
    batch?.delivered(first.from, first.to);
    const restoredPages = [];
    let nextFrom = first.to < end ? first.to - 2 : null;
    let responseSize = JSON.stringify(first).length;
    while (nextFrom !== null && saved.has(nextFrom) && restoredPages.length < 2 && responseSize < 16_000) {
      const pageEnd = saved.get(nextFrom)!;
      if (batch?.needsSave(nextFrom, pageEnd) || (reviewFirst && batch?.isNewPage(nextFrom, pageEnd))) break;
      const page = await readDialoguePage(asset, nextFrom, end, saved, background);
      responseSize += JSON.stringify(page).length;
      if (responseSize > 16_000) break;
      restoredPages.push(page);
      batch?.delivered(page.from, page.to);
      nextFrom = page.to < end ? page.to - 2 : null;
    }
    const reached = Math.max(readTo.get(mediaId) ?? 0, (restoredPages.at(-1) ?? first).to);
    readTo.set(mediaId, reached);
    if (!savedAt.has(mediaId)) savedAt.set(mediaId, from);
    const unsaved = reached - savedAt.get(mediaId)!;
    const saveReminder = !batch && ctx.taskId && unsaved >= SAVE_REMINDER_SECONDS
      ? `You have read ${Math.round(unsaved / 60)} minutes since your last save. Save the passages you have decided with dialogue_apply_cuts so the editor can review them while you continue. Leave the last moments open until you have read what follows.`
      : undefined;
    const pending = ctx.taskId ? await stagedReview : undefined;
    const reviewReminder = pending?.unchecked ? reviewReminderText(pending) : undefined;
    const saveCheckpoint = batch?.checkpoint;
    return text(JSON.stringify({ ...first, nextFrom, ...(restoredPages.length ? { restoredPages } : {}), ...(saveReminder && { saveReminder }),
      ...(saveCheckpoint && { saveCheckpoint }), ...(reviewReminder && { reviewReminder }) }));
  }

  const WordRef = {
    mediaId: z.string().optional().describe("The mediaId shown with the word indices in timeline_transcript or transcript_get"),
    fromWord: z.number().int().nonnegative().optional().describe("Word reference: first removed word index"),
    toWord: z.number().int().nonnegative().optional().describe("Word reference: last removed word index"),
  };
  const PauseRef = {
    afterWord: z.number().int().nonnegative().optional().describe("Pause reference, with mediaId: the transcript_get index of the word the pause follows. Scarlet trims the pause between it and the next word, both edges in the measured quiet."),
    leave: z.number().finite().min(0.05).max(10).optional().describe(`With afterWord: seconds the pause should still play, word to word, default ${PAUSE_BEAT} s.`),
  };
  let checkedVersion: string | undefined;
  const checkedRepeats = new Map<string, RepeatEvidence>();
  async function checkRepeats(version: string, keep?: Array<{ id: string; reason: string }>, offset?: number) {
    if (!ctx.taskId) throw new Error("Check repeated dialogue from an editing task.");
    const result = await client.checkDialogueRepeats(ctx.projectId, ctx.taskId, { version, keep, offset, startedAt: ctx.task?.startedAt });
    if (checkedVersion !== result.version) checkedRepeats.clear();
    checkedVersion = result.version;
    for (const k of keep ?? []) checkedRepeats.delete(k.id);
    return { ...result, repeats: result.repeats.map(r => {
      checkedRepeats.set(r.id, r);
      const { occurrences, ...words } = r;
      return { ...words, removable: Object.keys(occurrences) };
    }) };
  }
  tool("dialogue_check_repeats",
    "Check what the audible dialogue plays across the current timeline, including kept takes and joins. Give its exact version. The independent speech reading returns repeated phrases, both occurrences in timeline seconds, and their surrounding words. Use dialogue_apply_cuts with removeRepeat to remove either measured occurrence listed under removable. The save checks playback again. Keep an intentional repeat by passing its measured id and a short editorial reason. Kept decisions belong to this pass. offset pages through the outstanding pairs, 25 at a time. The same reading hears each played join, letter by letter from the sound rather than the transcript: `joins` lists one whose edge cuts through a kept word (issue clipped: heard is what plays, expected the transcript's word) or plays a leftover of a removed one (issue fragment), with the side (out = before the join, in = after) and where it starts in the recording. Move that edge before you finish: the editor hears it.",
    { version: z.string(), keep: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1).max(300) })).max(100).optional(), offset: z.number().int().nonnegative().optional() },
    async ({ version, keep, offset }) => json(await checkRepeats(version, keep, offset)));

  const cutCoordinates = `To have Scarlet place the edges, give mediaId and the first and last removed word indices (fromWord/toWord), or mediaId and the word before a pause (afterWord, with optional leave in seconds). Measured word edges leave up to ${AIR_AFTER_SPEECH} s after kept speech and ${AIR_BEFORE_SPEECH} s before it resumes. For edges you place yourself, give start/end in TIMELINE seconds. The edge check preserves that padding where those times are already quiet.`;
  const crossfadeFrames = CrossfadeFrames.optional()
    .describe("Total audio-only overlap at the new dialogue joins, in project frames. Zero or omitted makes a straight cut.");
  const repeatedPhrase = z.string().trim().min(1);
  const resumeWith = z.string().trim().min(1).max(240).optional().describe("For a retake, quote the first consecutive words to keep immediately after the removal. Include the continuation that distinguishes this delivery.");
  tool("dialogue_check_join",
    `Check proposed dialogue removals on a timeline version before submitting them. Give one range, or list up to 100 as \`cuts\` to check them in one call; each is given the same way. ${cutCoordinates} Where two words run together with no pause, the edge goes at the lowest level between them if that is down at room tone (${DIP_DBFS} dBFS or lower) and the removal's other edge has a pause, and the result says what was measured. A word reference keeps its exact performance. alternativeWordRanges lists other indices that leave the same transcript text, with measured edge problems and dips. Submit the indices of the performance you choose. This changes nothing. Returns status (unchanged = both edges quiet; snapped = an edge moved a few frames onto silence and applies as given; adjusted/partial = a larger move that narrows the removal and goes to review; review = no safe edge), the resulting range, per edge the source second, sound (quiet | valley | sound), RMS dBFS in 20 ms steps from 0.3 s before to 0.3 s after the edge (\`|\` marks it) and the nearest quiet points either side, and nearbyWords as [timeline start, timeline end, text] from the scan. The kept audio is independently read for up to ${JOIN_WORD_SECONDS} source seconds on each side of the proposed removal. unreadJoinAudio names a reading that was unavailable. repeatAtJoin identifies a word or phrase that the proposed join would play twice, with both occurrences in timeline seconds. partialWordRepeat identifies a fragment of a word beside another complete delivery, including sound inside the audio crossfade. Its side and ranges locate the fragment on the input timeline. pickupRepeats lists a doubled word or phrase opening or ending the kept take, with each occurrence and the side of the removal. When a prior scan measured an immediate restart, acousticRetakeContinuity reports which delivery the original range removes and whether the word following the second delivery stays connected to the retained take. Its source word times are approximate. An optional resumeWith quote is checked at the original end. With \`cuts\`, the result has \`joins\` in the same order, and a range that cannot be checked carries its own \`error\`. A list too long to return whole leaves out nearbyWords, per-edge readings (\`audio\`) and alternativeWordRanges, on unchanged joins first and then on the others from the end of the list. If needed, it then omits acousticRetakeContinuity and partialWordRepeat details. Every join keeps its status and range, and \`evidenceLeftOut\` lists the indices of the joins that came back without some of it: check the ones you need again in a shorter list.`,
    { version: z.string(), crossfadeFrames, ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), resumeWith,
      cuts: z.array(z.object({ ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), resumeWith }))
        .min(1).max(100).optional().describe("Several removals to check in one call, instead of start/end or a word reference"),
      ...audioOption("Attach about two seconds of the original recording around each edge as WAV, for a single range") },
    async ({ version, includeAudio, resumeWith, cuts, crossfadeFrames = 0, ...cut }) => {
      const [tl, { project }] = await Promise.all([getTimeline(version), getProject()]);
      const resolve = async (c: typeof cut, label: string) => {
        const resolved = await resolveCutRange(tl, c, label, planSources, true);
        if (resolved.start >= resolved.end || resolved.end > timelineDuration(tl)) {
          throw new Error(`${label} ${resolved.start}–${resolved.end} s is not a nonempty range inside version ${tl.version} (0–${timelineDuration(tl).toFixed(2)} s).`);
        }
        return resolved;
      };
      const report = async (resolved: Awaited<ReturnType<typeof resolve>>, quote: string | undefined) => {
        const range = { start: resolved.start, end: resolved.end };
        // Edges placed beside the named words stand as placed, here as in dialogue_apply_cuts.
        const pages = joinPages();
        const checked = "dips" in resolved && !resolved.problems.length
          ? { ...range, status: "unchanged" as const, reason: resolved.dips.length ? resolved.dips.join(" ") : "Scarlet placed both edges in the measured silence beside the words." }
          : checkDialogueJoin(tl, project, range, pages, "spoken" in resolved ? resolved.spoken : undefined);
        const played = frameAligned(checked, project.settings.fps);
        const nearbyWords = dialogueJoinWords(tl, project, played, pages);
        const continuity = acousticRetakeJoin(tl, project, range, acousticRetakePages.values());
        const { repeatAtJoin, partialWordRepeat, pickupRepeats, unread } = await checkKeptWords(tl, project, played, nearbyWords, planSources.readKeptWords,
          undefined, undefined, { at: played.start, preview: () => dialogueCutPreview(tl, project.media, [played], crossfadeFrames / project.settings.fps) });
        const audio = joinAudio(tl, project, range, pages);
        if (audio.some(edge => edge.levels || edge.words)) {
          readPassage(tl.version, range, true);
          readPassage(tl.version, checked, true);
        }
        return { originalRange: range,
          ...("wordRef" in resolved && { words: resolved.words, sourceRange: resolved.source, ...(resolved.problems.length && { wordEdgeProblems: resolved.problems }) }),
          ...("notes" in resolved && resolved.notes.length && { notes: resolved.notes }),
          ...("alternativeWordRanges" in resolved && { alternativeWordRanges: resolved.alternativeWordRanges }),
          ...checked, audio, nearbyWords, ...(partialWordRepeat && { partialWordRepeat }), ...(continuity.length && { acousticRetakeContinuity: continuity }), ...(unread.length && { unreadJoinAudio: unread }), ...(repeatAtJoin && { repeatAtJoin }), ...(pickupRepeats.length && { pickupRepeats }),
          ...(quote && { resumeAtOriginalEnd: checkResumeQuote(tl, project, range.end, evidence.scans, quote) }) };
      };
      if (cuts) {
        if (Object.values(cut).some(value => value !== undefined) || resumeWith) {
          throw new Error("Give either one range or a cuts list, not both.");
        }
        const resolved = await Promise.all(cuts.map(({ resumeWith: _quote, ...c }, i) => resolve(c, `cuts[${i}]`).catch((err: Error) => err)));
        // One measurement pass covers every edge in the list.
        await measureTimeline(tl, resolved.flatMap(r => r instanceof Error ? [] : [r.start, r.end]));
        await reportChecked(tl, resolved.flatMap(r => r instanceof Error ? [] : [r]));
        const joins: Array<Record<string, unknown>> = await Promise.all(resolved.map((r, i) => r instanceof Error ? { error: r.message } : report(r, cuts[i]!.resumeWith).catch((err: Error) => ({ error: describeError(err) }))));
        const whole = JSON.stringify({ version: tl.version, joins });
        if (whole.length <= JOIN_LIST_CHARS) return text(whole);
        // A longer list would not reach the model at all, so it gives up its bulk: the words around each join, then
        // the readings at its edges. Joins with both edges on quiet give theirs up first, since nothing about them is
        // left to judge, then the others from the end of the list. Every join keeps its status and its range, and the
        // result names each one that came back without some of it, for the agent to check again in a shorter list.
        const short = new Set<number>();
        // Counted as if every join were named, so what goes back is never longer than this.
        let size = JSON.stringify({ version: tl.version, joins, evidenceLeftOut: joins.map((_, i) => i) }).length;
        for (const [field, quiet] of [["nearbyWords", true], ["audio", true], ["alternativeWordRanges", true], ["nearbyWords", false], ["audio", false], ["alternativeWordRanges", false], ["acousticRetakeContinuity", true], ["acousticRetakeContinuity", false], ["partialWordRepeat", true], ["partialWordRepeat", false]] as const) {
          for (let i = joins.length - 1; i >= 0 && size > JOIN_LIST_CHARS; i--) {
            const join = joins[i]!;
            if (!(field in join) || (join.status === "unchanged") !== quiet) continue;
            // The value, its name in quotes, the colon and the comma.
            size -= JSON.stringify(join[field]).length + field.length + 4;
            delete join[field];
            short.add(i);
          }
        }
        return json({ version: tl.version, joins, evidenceLeftOut: [...short].sort((a, b) => a - b) });
      }
      const resolved = await resolve(cut, "Range");
      await measureTimeline(tl, [resolved.start, resolved.end]);
      await reportChecked(tl, [resolved]);
      const checked = await report(resolved, resumeWith);
      const result = json({ version: tl.version, ...checked });
      if (!includeAudio || !hearing) return result;
      for (const edge of checked.audio) {
        const from = Math.max(0, edge.at - 1);
        try {
          const { wav } = await client.sourceAudio(ctx.projectId, { mediaId: edge.mediaId, from, to: edge.at + 1 });
          result.content.push({ type: "text", text: `Original ${edge.edge} edge of ${edge.mediaId}: the boundary is ${(edge.at - from).toFixed(2)} s into this clip (source ${edge.at} s).` },
            { type: "audio", mimeType: "audio/wav", data: wav });
        } catch (err) {
          result.content.push({ type: "text", text: `Audio for the ${edge.edge} edge is unavailable: ${describeError(err)}. Judge it from the levels.` });
        }
      }
      return result;
    });

  /** Silences of two seconds or more inside this part that none of its decisions covers, on the version it was planned on. */
  async function passedSilences(tl: Timeline, kept: Array<{ start: number; end: number }>,
    decisions: Array<{ start: number; end: number }>, range?: { start: number; end: number }) {
    const decided = [...decisions.map(d => ({ start: d.start, end: d.end })), ...kept];
    if (!decided.length) return [];
    // Without a range, the part reaches from its first decision to its last.
    const scope = range ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(audibleMediaClips(tl).map(c => c.mediaId))) {
      const words = await transcriptWords(id, false).catch(without(`failed to read the words of ${id} for the silences a part keeps`, null));
      if (words) transcripts.set(id, words);
    }
    return keptSilences(tl, timelineWords(tl, transcripts, scope), decided);
  }
  /**
   * What earlier saves of this pass already listed as still playing. A later part reaches back over the earlier ones,
   * and on one pass its last save listed 58 things of which a handful were new: a chime and a 1.7 s wait among them
   * went unread. Each save lists a thing once; a pause comes back only if it now plays a different length.
   */
  const listed = new Set<string>();
  const listing = (kind: string, mediaId: string, source: number, seconds?: number) =>
    `${kind}/${mediaId}/${source.toFixed(1)}${seconds === undefined ? "" : `/${seconds.toFixed(1)}`}`;
  const fresh = (...thing: Parameters<typeof listing>) => !listed.has(listing(...thing));
  /** Only what a save shows counts as listed: the rest of a long list comes with the next save. */
  const shown = <T>(thing: T, ...key: Parameters<typeof listing>) => { listed.add(listing(...key)); return thing; };
  /** Pauses and doubled words this part still plays once its cuts are out, on the version it was planned on. */
  async function passedLeftovers(tl: Timeline, kept: Array<{ start: number; end: number }>,
    decisions: Array<{ start: number; end: number; review: boolean }>, range?: { start: number; end: number }) {
    const decided = [...decisions, ...kept];
    if (!decided.length) return { pauses: [], repeats: [], gaps: [] };
    const scope = range ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(audibleMediaClips(tl).map(c => c.mediaId))) {
      const words = await transcriptWords(id, false).catch(without(`failed to read the words of ${id} for what a part still plays`, null));
      if (words) transcripts.set(id, words);
    }
    // A range staged for review still plays until the editor approves it.
    return partLeftovers(timelineWords(tl, transcripts, scope), decisions.filter(d => !d.review), kept, transcripts);
  }
  /** The version a part continues on, read once however many lists are placed on it. */
  const continued = new Map<string, Promise<Timeline>>();
  const timelineAt = (version: string, planned: Timeline) => {
    if (version === planned.version) return Promise.resolve(planned);
    let read = continued.get(version);
    if (!read) { continued.clear(); continued.set(version, read = client.timeline(ctx.projectId, version).then(r => r.timeline)); read.catch(() => continued.delete(version)); }
    return read;
  };
  /** Where those silences sit on the version the pass continues on, longest thirty at most, in playback order. */
  async function placeSilences(found: Awaited<ReturnType<typeof passedSilences>>, version: string, planned: Timeline) {
    if (!found.length) return [];
    const after = await timelineAt(version, planned);
    return found.flatMap(k => {
      const at = sourceToTimeline(after, k.mediaId, k.source.start).find(p => p.audible)?.time;
      return at === undefined ? [] : [{ at, seconds: k.seconds, after: k.after, before: k.before }];
    }).sort((a, b) => b.seconds - a.seconds).slice(0, 30).sort((a, b) => a.at - b.at);
  }

  /** Quiet words still playing in the submitted part. Compare levels on the recording the editor actually hears. */
  async function keptQuietPhrases(tl: Timeline, version: string, decided: TimeRange[], span: TimeRange) {
    const { media } = await client.media(ctx.projectId);
    const firstStream = (clip: MediaClip) => {
      const asset = media.find(m => m.id === clip.mediaId);
      return asset && asset.kind !== "image" && asset.hasAudio !== false && (dialogueAudioStream(clip) ?? dialogueAudioStream(asset) ?? 0) === 0;
    };
    const clips = audibleMediaClips(tl).filter(c => firstStream(c) && rangesOverlap(span, { start: c.timelineIn, end: clipEnd(c) }));
    const phrases = (await Promise.all(clips.map(async clip => {
      const from = timelineToSource(clip, Math.max(clip.timelineIn, span.start));
      const to = Math.min(clip.sourceOut, timelineToSource(clip, span.end));
      const found = await readQuietPhrases(clip.mediaId, from, to)
        .catch(withoutOnce(`failed to measure the quiet phrases in ${clip.mediaId}`, [] as QuietPhrase[]));
      const time = (source: number) => clip.timelineIn + (source - clip.sourceIn) / clip.speed;
      return found.flatMap(p => {
        const placed = { start: time(p.start), end: time(p.end) };
        if (!fresh("quietPhrase", clip.mediaId, p.start) || decided.some(d => rangesOverlap(d, placed))) return [];
        return [{ mediaId: clip.mediaId, phrase: p, at: placed.start }];
      });
    }))).flat();
    if (!phrases.length) return [];
    const after = await timelineAt(version, tl);
    const map = makeTimeMap(tl, after);
    const audible = audibleMediaClips(after).filter(firstStream);
    const placed = phrases.flatMap(p => {
      const at = map(p.at, "right");
      // A still-visible picture can anchor this time even if a concurrent edit removed its dialogue.
      if (at === null || !audible.some(c => c.mediaId === p.mediaId && p.phrase.start >= c.sourceIn && p.phrase.end <= c.sourceOut &&
        Math.abs(c.timelineIn + (p.phrase.start - c.sourceIn) / c.speed - at) <= .001)) return [];
      return [{ ...p, at: round3(at) }];
    }).sort((a, b) => a.at - b.at);
    const result = [];
    for (const { at, mediaId, phrase } of placed) {
      if (fresh("quietPhrase", mediaId, phrase.start)) result.push(shown({ at, mediaId, ...phrase }, "quietPhrase", mediaId, phrase.start));
      if (result.length === 30) break;
    }
    return result;
  }

  tool("dialogue_apply_cuts",
    `Save your decisions on an assembled version: cut, review or keep ranges, sorted and nonoverlapping. ${cutCoordinates} Cut ranges apply together; review stages a range for the editor; keep or omission retains it. Scarlet measures each retake, filler, pause and quoted production edge. An edge on sound moves a few frames onto silence, or onto the lowest level between two words said in one breath, and applies; a larger move narrows the cut and stages it. A pause's edge moves onto the quiet beside it. A short piece between cuts with a transcript word at room-tone level returns quietKeptWord with nearby measured sound in source seconds. Footage between separate removals stays in the timeline. \`gate\` lists changes to the measured plan with their evidence. Its ranges describe placement before the engine rounds to project frames. The returned timelineEdits describe the saved edits. An optional quote must verify before anything is saved. Save a long pass in parts and continue on \`continueFrom\`. For a first dialogue pass, send at most ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions as soon as they are ready, with any keep or protected ranges they depend on. For a requested crossfade, \`joinCrossfades\` reports how many joins were faded and why any stayed straight. The result also lists what this part still plays, each thing once per pass, at \`at\` on continueFrom: keptSilences (2 s or more without words that no decision covers), keptPauses (${KEPT_PAUSE_SECONDS} s or more, with the afterWord that trims an untouched one), repeatedWords (said twice in a row, atJoin when a cut made it; fromWord/toWord name the first) and unexplainedSound (speaking-level sound the transcript has no word for, often what is left of a take beside a cut). These are evidence, not decisions: a pause can be a beat, a repeat emphasis, a sound a breath. Ranges your previous part staged on that version join this part's review (carriedForward). Cuts already handed to the editor keep their passage and note (heldForReview). \`description\` is your one-sentence summary for the editor.`,
    { version: z.string(), description: z.string().min(1), crossfadeFrames, noteIds: z.array(z.string()).optional(),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).optional().describe("Requested TIMELINE range if only part of the edit is in scope"),
      only: z.enum(["pause", "filler", "retake", "coaching"]).optional().describe("For a request limited to one type of removal. Omit for a full dialogue pass."),
      cuts: z.array(z.object({ ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(),
        removeRepeat: z.object({ id: z.string(), occurrence: z.enum(["first", "second"]) }).optional().describe("For a retake, identify the occurrence heard by dialogue_check_repeats on this version. Scarlet places both edges using its measured words and waveform."),
        kind: z.enum(["pause", "filler", "retake", "coaching"]), decision: z.enum(["cut", "review", "keep"]),
        resumeWith,
        keepRepeat: z.union([repeatedPhrase, z.array(repeatedPhrase).min(1)]).optional().describe("For speech cuts, quote a word or phrase that deliberately repeats across the join or at the beginning or end of the kept take. Pass a list to keep several. An unacknowledged repeat comes back to you before the plan is saved."),
        productionQuote: z.string().trim().min(1).optional().describe("Optional check for a coaching cut: verify all the words in the removed production aside against the scan."),
        picture: z.enum(["safe", "uncertain", "protect"]).optional().describe("Protect preserves this range. For all other picture verdicts, decision controls whether the range is cut or staged for review."),
        reason: z.string().trim().min(1).describe("One short sentence for the editor about what they will hear or see") }))
        .describe("For a faint line that still plays, keptQuietPhrases returns mediaId and fromWord/toWord for use here, its position on continueFrom (at), and the phrase and neighboring speech levels in dBFS.") },
    async ({ version, description, cuts: requested, noteIds, range, only, crossfadeFrames }) => {
      const operation = await dialogueOperation();
      if (ctx.taskId && operation === "first-cut" && requested.filter(c => c.decision !== "keep" && c.picture !== "protect").length > FIRST_CUT_BATCH_SIZE)
        throw new Error(`Save up to ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions in each first-pass batch, with their keep and protected ranges. Send the first settled group now. For the next group use source word references or map its positions on continueFrom with timeline_at.`);
      const localPauses = operation === "local-pauses";
      const tl = await getTimeline(version);
      // Edge checks, snapping, word references, quotes and the gate report: dialogue-plan.ts, shared with offline replay.
      const cuts = requested.map(({ removeRepeat, ...cut }) => {
        if (!removeRepeat) return cut;
        const occurrence = checkedVersion === tl.version && checkedRepeats.get(removeRepeat.id)?.occurrences[removeRepeat.occurrence];
        if (!occurrence || cut.kind !== "retake") throw new Error("Read dialogue_check_repeats on this version and select a removable occurrence for a retake.");
        return { ...cut, occurrence };
      });
      const anchor = await cutAnchor(tl);
      const scope = range || localPauses || selectedRange(anchor) ? cutScope(tl, anchor, range, localPauses) : undefined;
      const plan = await planDialogueCuts({ tl, cuts, range: scope, only, localPauses, anchor }, { ...planSources, crossfadeFrames });
      const recordKept = (ranges: TimeRange[]) => ranges.length && ctx.taskId
        ? postEvent({ type: "log", text: "", data: { kind: "dialogue_preserved", version: tl.version, ranges } }) : undefined;
      if (plan.outcome === "preserved") {
        await recordKept(plan.kept ?? []);
        for (const [mediaId, batch] of scanBatches) batch.saved(tl, mediaId, plan.kept ?? []);
        return text("All listed passages were preserved.");
      }
      if (plan.outcome === "needsRevision") return json({ needsRevision: true, disputedEdges: plan.disputedEdges,
        next: plan.disputedEdges.some(d => d.quietKeptWord)
          ? "Nothing was saved. Inspect the reported source interval, then resubmit adjusted cuts. To retain the short piece deliberately, include its timeline range as a keep."
          : "Nothing was saved. Check the measured words at each disputed edge with dialogue_check_join. If a quote conflicts, compare the deliveries in dialogue_scan and resubmit the verified edge and words." });
      // A ripple affects every track. Check the whole batch, including any edge adjustment, against the sayings it must retain.
      const retainedRepeats = requested.flatMap(c => {
        if (!c.removeRepeat || c.decision === "keep" || c.picture === "protect") return [];
        const pair = checkedRepeats.get(c.removeRepeat.id)!;
        const kept = c.removeRepeat.occurrence === "first" ? pair.second : pair.first;
        return [{ start: kept.start, end: kept.end, reason: `The planned cuts also reach the delivery of “${pair.phrase}” you chose to keep.` }];
      });
      const clipped = retainedRepeats.filter(kept => plan.decisions.some(d => {
        const reach = d.originalRange ?? d;
        return reach.start < kept.end && reach.end > kept.start;
      }));
      if (clipped.length) return json({ needsRevision: true, disputedEdges: clipped, next: "Both deliveries would be affected. Choose boundaries that preserve one complete occurrence." });
      plan.kept.push(...retainedRepeats.map(({ start, end }) => ({ start, end })));
      const all = plan.decisions;
      // Stretches without words this part still plays and leaves undecided, found before the edit moves.
      const undecided = only && only !== "pause" ? [] : await passedSilences(tl, plan.kept, all, range)
        .catch(without("failed to find the silences this part keeps", []));
      const left = await passedLeftovers(tl, plan.kept, all, range)
        .catch(without("failed to read what this part still plays", { pauses: [], repeats: [], gaps: [] }));
      await postEvent({ type: "log", text: "I’m applying the dialogue decisions to the timeline.", data: { kind: "editor_progress" } });
      const result = await client.submitDialogueCuts(ctx.projectId, { fromVersion: tl.version, description, cuts: all, range: scope, kept: plan.kept, crossfadeFrames,
        taskId: ctx.taskId, author: ctx.author, noteIds });
      const suggestion = result.changes.find(c => c.intent === "suggestion");
      if (result.changes.length) {
        stageWithoutAppliedCuts = suggestion && !result.changes.some(c => c.state === "approved") ? suggestion.id : undefined;
        // Prepare the next review while the agent reads its save receipt.
        stagedReview = suggestion && prepareReview(suggestion.id);
      }
      if (localPauses && !localRange && scope) localRange = { ...scope, version: tl.version };
      await recordKept(plan.kept);
      for (const [mediaId, batch] of scanBatches) batch.saved(tl, mediaId, [...all, ...plan.kept]);
      for (const [mediaId, reached] of readTo) savedAt.set(mediaId, reached);
      const reach = cutsReach(tl, all);
      for (const [mediaId, to] of reach) cutTo.set(mediaId, Math.max(cutTo.get(mediaId) ?? 0, to));
      // How far into each recording the saved cuts reach, so the editor's cut figure moves with every part: to the end
      // of the furthest cut, on the recordings the pass cuts. A pass that reads a whole recording before it saves its
      // first part has read to the end by then, and reporting the read finished the cut at that first save. The read
      // counts only where this part's cuts come within a page of it: a pass that saves as it reads has decided what it
      // read, and the last part finishes the cut though its last cut stops a little short of the recording's end.
      for (const [mediaId, to] of cutTo) {
        const read = readTo.get(mediaId) ?? 0, here = reach.get(mediaId);
        await postEvent({ type: "log", text: "", data: { kind: "pass_progress", mediaId, through: here !== undefined && here >= read - 60 ? Math.max(read, to) : to } });
      }
      lastTimeline = undefined;
      for (const c of result.changes) await postEvent({ type: "change", text: c.description,
        data: { changeId: c.id, toVersion: c.toVersion, state: c.state } });
      // Applied cuts move the edit forward. A part that only stages cuts leaves it where it was.
      const { head, ...reported } = result;
      const continueFrom = head ?? result.changes.find(c => c.intent !== "suggestion")?.toVersion ?? tl.version;
      const decided = [...all, ...plan.kept, ...(result.editorDecided ?? [])];
      const quiet = localPauses || only === "pause" || only === "filler" ? [] : await keptQuietPhrases(tl, continueFrom, decided,
        scope ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) })
        .catch(without("failed to place the quiet phrases the part still plays", []));
      // A stretch already listed as a kept silence is not listed again as a pause.
      const pauses = (only && only !== "pause" ? [] : left.pauses.filter(p => !undecided.some(u => u.mediaId === p.mediaId && u.source.start < p.source.end && u.source.end > p.source.start)))
        .filter(p => fresh("pause", p.mediaId, p.source.start, p.seconds));
      const repeats = (only && only !== "retake" && only !== "filler" ? [] : left.repeats).filter(r => fresh("repeat", r.mediaId, r.source));
      // One read of the version the pass continues on places all three lists.
      // Sound the part still plays between two words it keeps, beside its own cuts first: what is left of a take that came out.
      const sounding = only && only !== "retake" && only !== "filler" ? [] : (await Promise.all([...new Set(left.gaps.map(g => g.mediaId))].map(async mediaId => {
        const mine = left.gaps.filter(g => g.mediaId === mediaId);
        const read = await gapSounds(mediaId, mine.map(g => g.source)).catch(withoutOnce(`failed to read the levels between the words ${mediaId} still plays`, [] as Array<GapSound | undefined>));
        return mine.flatMap((g, i) => read[i]?.runs.length ? [{ mediaId, source: read[i]!.runs[0]!, seconds: read[i]!.seconds, after: g.after, before: g.before }] : []);
      }))).flat().filter(s => fresh("sound", s.mediaId, s.source.start));
      const { kept, keptPauses, repeatedWords, unexplainedSound } = await (async () => {
        const kept = await placeSilences(undecided, continueFrom, tl);
        const after = pauses.length || repeats.length || sounding.length ? await timelineAt(continueFrom, tl) : tl;
        const placed = <T extends { mediaId: string }>(items: T[], source: (item: T) => number) => items.flatMap(item => {
          const at = sourceToTimeline(after, item.mediaId, source(item)).find(p => p.audible)?.time;
          return at === undefined ? [] : [{ at, item }];
        });
        return { kept,
          // The longest thirty, in playback order.
          keptPauses: placed(pauses, p => p.source.start).sort((a, b) => b.item.seconds - a.item.seconds).slice(0, 30).sort((a, b) => a.at - b.at)
            .map(({ at, item: { source, ...p } }) => shown({ at, ...p }, "pause", p.mediaId, source.start, p.seconds)),
          repeatedWords: placed(repeats, r => r.source).slice(0, 30).map(({ at, item: { source, atJoin, ...r } }) => shown({ at, ...r, ...(atJoin && { atJoin }) }, "repeat", r.mediaId, source)),
          unexplainedSound: placed(sounding, s => s.source.start).sort((a, b) => b.item.seconds - a.item.seconds).slice(0, 30).sort((a, b) => a.at - b.at)
            .map(({ at, item: { source, ...s } }) => shown({ at, ...s, sourceSeconds: [source.start, source.end] }, "sound", s.mediaId, source.start)),
        };
      })().catch(without(`failed to place the kept silences on ${continueFrom}`, { kept: [], keptPauses: [], repeatedWords: [], unexplainedSound: [] }));
      const audioRecheck = checkedVersion === tl.version || ctx.task?.repeatAudit?.version === tl.version
        ? await checkRepeats(continueFrom).catch((error: Error) => ({ version: continueFrom, error: error.message, next: "The edit was saved. Retry dialogue_check_repeats on this version." }))
        : undefined;
      return json({ ...reported, continueFrom, ...(audioRecheck && { audioRecheck }), gate: dialogueGate(plan),
        ...(plan.unreadJoinAudio && { unreadJoinAudio: plan.unreadJoinAudio }),
        ...(kept.length && { keptSilences: kept }), ...(keptPauses.length && { keptPauses }), ...(repeatedWords.length && { repeatedWords }),
        ...(unexplainedSound.length && { unexplainedSound }),
        ...(quiet.length && { keptQuietPhrases: quiet }),
        next: result.changes.some(c => c.intent === "suggestion")
          ? "Pending ranges are on the kept version. The editor sees a staged cut as a call only once it has your recommendation, so record them on this part before you read on: dialogue_review_inspect gives their context, up to four at once with count while Scarlet prepares the next ones, and dialogue_review_save records a recommendation. Recommendations carry into the review of your next part." : undefined });
    });

  /** Inspections that read every view of a cut, including a measured join (or a cut with no join). */
  const inspections = new Set<string>();
  // Source pictures decode from the original footage, about a second per sheet, and the engine
  // runs roughly one at a time. Two in flight keeps it busy without queueing far ahead of the agent.
  const lanes = new Lanes(2);
  async function readySheet(request: z.input<typeof SheetRequest>, priority: () => number) {
    return lanes.run(priority, async () => {
      const deadline = Date.now() + (priority() === urgencyRank("now") ? 20_000 : 60_000);
      let result = await client.contactSheet(ctx.projectId, request);
      while (result.state === "preparing") {
        if (Date.now() > deadline) throw new Error("Frames are still preparing. Inspect this cut again.");
        const jobs = await Promise.all(result.renderIds.map(id => client.render(id)));
        const failed = jobs.find(({ render }) => render.state === "failed" || render.state === "cancelled");
        if (failed) throw new Error(failed.render.errorDetail || failed.render.error || "Inspection preview was cancelled.");
        if (jobs.every(({ render }) => render.state === "done")) result = await client.contactSheet(ctx.projectId, request);
        else await delay(300);
      }
      return result;
    });
  }
  async function computeInspection(change: Change, { index, audio, wholePicture }: InspectionRequest, priority: () => number): Promise<DialogueInspection> {
    const [{ review }, { media }] = await Promise.all([client.cutReview(change.id), client.media(ctx.projectId)]);
    if (!review) throw new Error("No reviewable cuts.");
    const edit = change.cutEdits?.find(e => e.index === index);
    if (edit && (!edit.previewVersion || change.cutChoices?.some(c => c.index === index && c.choice === "keep"))) return { content: json({ index, version: edit.version, range: edit.range,
      choice: "keep", alreadyRemoved: edit.range.start === edit.range.end }).content, receipt: { complete: false, picture: [] }, wholeSheets: 0 };
    const playback = edit?.previewVersion ? { original: await peekTimeline(edit.version), range: edit.range, previewVersion: edit.previewVersion } : undefined;
    const result = await inspectDialogueSuggestion(client, change, review, media, index,
      { audio, images: reviewPictures, wholePicture, sheet: request => readySheet(request, priority), unavailable: unavailableOnce, playback });
    const cut = review.cuts[index]!;
    const original = playback?.original ?? review.original;
    const range = playback?.range ?? cut.removed;
    // A fresh review session may have no cached scan from the pass that staged this cut.
    await measureTimeline(original, [range.start, range.end]).catch(without("failed to measure words beside the staged cut", undefined));
    const nearby = dialogueJoinWords(original, { media }, range, joinPages());
    const preview = playback ? await peekTimeline(playback.previewVersion) : review.proposed;
    const { repeatAtJoin, partialWordRepeat, pickupRepeats, unread } = await checkKeptWords(original, { media }, range, nearby, planSources.readKeptWords,
      playback ? undefined : review.cuts[index - 1]?.removed.end, playback ? undefined : review.cuts[index + 1]?.removed.start,
      { at: playback?.range.start ?? cut.at, preview: () => preview });
    if (repeatAtJoin || partialWordRepeat || pickupRepeats.length || unread.length) result.content.push({ type: "text", text: JSON.stringify({
      ...(partialWordRepeat && { partialWordRepeat }), ...(repeatAtJoin && { repeatAtJoin }), ...(pickupRepeats.length && { pickupRepeats }), ...(unread.length && { unreadJoinAudio: unread }),
    }) });
    // How the join sounds on the suggestion's version, measured the same way for every model.
    const { audits, noJoin } = await perception.auditAt(playback?.previewVersion ?? change.toVersion, playback?.range.start ?? cut.at).catch(err => {
      result.content.push({ type: "text", text: JSON.stringify({ joinAudit: `unavailable: ${describeError(err)}` }) });
      return { audits: [], noJoin: undefined };
    });
    if (audits.length) result.content.push({ type: "text", text: JSON.stringify({ joinAudit: audits }) });
    if (noJoin) result.content.push({ type: "text", text: JSON.stringify({ joinAudit: noJoin }) });
    result.receipt.joinAudit = audits.length > 0 && audits.every(a => a.levels) ? audits.map(a => a.verdict).join("; ") : undefined;
    result.receipt.noJoin = noJoin;
    const removed = cut.removed;
    const repaired = !playback && change.cutReasons?.some(r => r.originalRange && r.start >= removed.start - .00001 && r.start < removed.end);
    if (repaired) {
      let compared = false;
      if (!disabled.has("change_review_cut") && !disabled.has("frame_contact_sheet") && (audio || caps.images)) {
        const comparison = await inspect(() => client.reviewCut(ctx.projectId, { changeId: change.id, index, edge: "start", handles: 1.5,
          includeAudio: audio }), windows => {
            const after = windows.find(w => w.id === change.toVersion && w.label === "After");
            compared = !!after;
            if (audio) result.receipt.heardJoin = !!after?.wav;
          });
        result.content.push(...comparison.content);
      }
      if (!compared) {
        result.receipt.complete = false;
        result.content.push({ type: "text", text: "A comparison preview for the narrowed join is unavailable (it is still preparing or frame tools are off). Inspecting this index again retries it." });
      }
    }
    return result;
  }
  const reviews = new ReviewInspections(computeInspection);
  /**
   * How many suggested cuts of a review have a recommendation, so the editor can see how far the checking has come.
   * `looked` also counts the cuts the agent has inspected but not saved yet: recommendations are often saved in one
   * batch at the end, and the count would sit at zero until then.
   */
  function cutProgress(changeId: string, checked: number, total: number, looked?: number) {
    return postEvent({ type: "log", text: "", data: { kind: "cut_progress", changeId, checked, total, ...(looked !== undefined && { looked }) } });
  }
  /** The cuts of each pending review the agent has looked at, by change and version. */
  const lookedAt = new Map<string, Set<number>>();

  async function prepareReview(changeId: string): Promise<StagedReview | undefined> {
    try {
      const [{ change }, { review }] = await Promise.all([client.changeRecord(changeId), client.cutReview(changeId)]);
      if (review && change.state === "ready") {
        reviews.ahead(change, 0, review.cuts.length);
        // A later part of a pass carries the earlier part's recommendations into its review.
        const assessed = change.cutAssessments?.filter(a => !a.provisional).length ?? 0;
        if (review.cuts.length) await cutProgress(changeId, assessed, review.cuts.length);
        return { changeId, total: review.cuts.length, unchecked: Math.max(0, review.cuts.length - assessed) };
      }
    } catch (err) {
      // The agent's own inspection prepares it instead.
      unavailable(`failed to prepare the review of ${changeId} ahead`, err);
    }
    return undefined;
  }

  tool("dialogue_review_inspect",
    "Second pass over chronological cuts of a pending dialogue suggestion. For each cut returns the words around it as [start, end, text, speaker or isolated input], original microphone levels (dBFS), voice activity, and timeline_join_audit's reading of the join or why the cut has none. The surviving speech is checked for a doubled word across the join or at the start or end of its kept take. partialWordRepeat identifies a cut-off word beside a whole occurrence in the saved audio, including faded handles. Inspect up to four consecutive cuts in one call with count. Scarlet prepares the next ones while you read." +
    (reviewPictures ? " Includes synchronized screen and camera sheets and before/after frames for narrowed cuts. A longer removal shows an overview and windows for closer inspection. wholePicture returns activity sheets across all of them." : "") +
    " Pass the returned versions and exact range to dialogue_review_save. If later edits conflict with the cut being revised, inspecting it returns its current passage and words for dialogue_revise_cut.",
    { changeId: z.string(), index: z.number().int().nonnegative(),
      count: z.number().int().min(1).max(4).default(1).describe("Inspect this many consecutive suggestions, starting at index."),
      ...(reviewPictures && { wholePicture: z.boolean().default(false).describe("For one longer removal: activity sheets across its whole removed picture in one result.") }),
      ...audioOption("Attach WAV of the original passage and of the join") },
    async ({ changeId, index, count, wholePicture: requestedPicture, includeAudio }) => {
      const wholePicture = reviewPictures && requestedPicture === true;
      if (cutConflict && conflictAt(changeId, index)) {
        const { version, range } = cutConflict;
        const location = json({ index, currentVersion: version, range,
          next: range ? "Use this version for a revision of the current footage." : "The original footage has no unique placement. Inspect current takes with timeline_transcript and timeline_at." });
        if (range) {
          const words = await perception.readTranscript({ version, from: Math.max(0, range.start - 2), to: range.end + 2, detail: "words" });
          location.content.push(...words.content);
        }
        return location;
      }
      const [{ change }, { review }] = await Promise.all([client.changeRecord(changeId), client.cutReview(changeId)]);
      const pending = change.state === "ready" || (change.state === "revising" && change.id === stagedCut?.changeId);
      if (change.projectId !== ctx.projectId) throw new Error(`Change ${changeId} belongs to another project.`);
      if (change.intent !== "suggestion" || !pending) {
        throw new Error(`Change ${changeId} is ${change.state}${change.intent ? ` (${change.intent})` : ""}. dialogue_review_inspect reads a pending dialogue suggestion; use change_list to find one.`);
      }
      if (!review?.cuts.length) throw new Error(`Change ${changeId} has no individual cuts to inspect; it replaces the whole timeline.`);
      if (index >= review.cuts.length) throw new Error(`Change ${changeId} has ${review.cuts.length} cuts (index 0–${review.cuts.length - 1}).`);
      const audio = hearing && includeAudio === true;
      const end = wholePicture ? index + 1 : Math.min(review.cuts.length, index + count);
      reviews.ahead(change, end, review.cuts.length);
      const indexes = Array.from({ length: end - index }, (_, k) => index + k);
      const results = await Promise.all(indexes.map(i => reviews.take(change, { index: i, audio, wholePicture })));
      const content: ToolResult["content"] = [];
      results.forEach((result, k) => {
        const i = indexes[k]!;
        // An honest receipt: every view arrived, the join was measured or there is none, and a hearing model got the join audio.
        const { receipt } = result;
        const inspected = receipt.complete && !!(receipt.joinAudit || receipt.noJoin) && receipt.heardJoin !== false;
        const edit = change.cutEdits?.find(e => e.index === i);
        if (edit && inspected) readPassage(edit.version, edit.range);
        const key = JSON.stringify([changeId, change.fromVersion, change.toVersion, i]);
        if (inspected) inspections.add(key); else inspections.delete(key);
        const windows = result.receipt.picture;
        const whole = result.wholeSheets <= MAX_WHOLE_PICTURE_SHEETS;
        content.push(...result.content, { type: "text", text: JSON.stringify({ complete: inspected, additionalActivityWindows: windows,
          ...(windows.length ? { closerLook: whole ? `dialogue_review_inspect with index ${i} and wholePicture true returns them in one result.`
            : `This removal needs ${result.wholeSheets} activity sheets. Use frame_contact_sheet_batch for a closer look.` } : {}) }) });
        // If the agent looks closer, the whole picture is ready. It waits behind the cuts the agent reads next.
        if (windows.length && whole && !wholePicture) void reviews.prepare(change, { index: i, audio, wholePicture: true }, "later").catch(() => undefined);
      });
      const version = JSON.stringify([changeId, change.fromVersion, change.toVersion]);
      const seen = lookedAt.get(version) ?? new Set<number>();
      lookedAt.set(version, seen);
      for (const i of indexes) seen.add(i);
      // Cuts with a carried recommendation count too, so the figure never drops below what is saved.
      const assessed = change.cutAssessments?.filter(a => !a.provisional).map(a => a.index) ?? [];
      await cutProgress(changeId, assessed.length, review.cuts.length, new Set([...assessed, ...seen]).size);
      return { content };
    });

  tool("dialogue_review_save", "Record your cut, keep or ask recommendation and reason on a pending suggestion. An ask's reason is the one line the editor reads on that call, so it names what this cut takes out and what to check; cuts that would wait under the same reason are refused. Use the exact change versions, chronological cut index and original timeline range. Saving an ask gives the passage and its note to the editor. Later recommendations preserve that call (heldCalls, or heldRevised after a requested revision). The inspected flag reports whether this session completed an inspection of that exact cut, including its measured join (or a cut with no join).",
    { changeId: z.string(), fromVersion: z.string(), toVersion: z.string(), assessments: z.array(CutAssessment.omit({ inspected: true, revised: true, askOrder: true, provisional: true })).min(1).max(500) },
    async ({ changeId, fromVersion, toVersion, assessments }) => {
      const { change } = await client.changeRecord(changeId);
      if (await localPausesMode() && ![ctx.taskId, ctx.task?.resumeRootId].some(id => id && id === change.taskId) &&
          !ctx.task?.changeIds.includes(changeId)) {
        const prior = change.taskId && (await client.task(change.taskId)).task;
        if (!prior || (prior.resumeRootId ?? prior.id) !== (ctx.task?.resumeRootId ?? ctx.taskId))
          throw new Error("Choose a staged pause from this request.");
      }
      if (change.projectId !== ctx.projectId) throw new Error(`Change ${changeId} belongs to another project.`);
      const recorded = assessments.map(a => ({ ...a,
        inspected: inspections.has(JSON.stringify([changeId, fromVersion, toVersion, a.index])) }));
      const result = await client.assessCuts(changeId, fromVersion, toVersion, recorded);
      await postEvent({ type: "log", text: `Saved recommendations for ${result.assessed} of ${result.total} suggested cuts.`,
        data: { kind: "editor_progress", reviewCounter: `cuts/${changeId}/${toVersion}`, count: result.assessed } });
      await cutProgress(changeId, result.assessed, result.total);
      if (stageWithoutAppliedCuts === changeId && result.assessed > (change.cutAssessments?.filter(a => !a.provisional).length ?? 0)) stageWithoutAppliedCuts = undefined;
      if ((await stagedReview)?.changeId === changeId)
        stagedReview = Promise.resolve({ changeId, total: result.total, unchecked: Math.max(0, result.total - result.assessed) });
      return json(result);
    });

  type MeasuredPause = Exclude<ReturnType<typeof resolveOutgoingPause>, { status: "unavailable" }>;
  async function savedPause(pause: MeasuredPause, preview: string, at: number) {
    const outgoingPause = { word: pause.word.text, beforeSeconds: round3(pause.beforeSeconds) };
    try {
      const { audits, noJoin } = await perception.auditAt(preview, at);
      const reading = audits.find(a => a.out.mediaId === pause.word.mediaId && a.out.lastWord === pause.word.text &&
        a.out.lastWordEnd !== undefined && Math.abs(a.out.lastWordEnd - pause.word.sourceEnd) < .002);
      if (reading?.out.wordEndToJoin !== undefined)
        return { outgoingPause: { ...outgoingPause, remainingSeconds: reading.out.wordEndToJoin }, joinAudit: audits };
      return { outgoingPause, joinAudit: audits, verification: noJoin ?? "The preview could not verify the distance from this word to the join." };
    } catch (err) {
      return { outgoingPause, verification: `Preview measurement unavailable: ${describeError(err)}` };
    }
  }

  tool("dialogue_revise_cut", "Move a staged dialogue cut. Once a call is with the editor, its range can change only on their request about that cut. To trim the pause before a cut, give pauseAfterWord in seconds (0 for the end of the last kept word) instead of start and end. Scarlet locates that word, preserves the incoming edge and checks the word-to-join distance on the saved preview. For other moves give the full new range in TIMELINE seconds on the pass's fromVersion. It may extend past the old edges but must stay clear of neighboring staged cuts. If newer edits affect this passage, Scarlet returns the current version and its location when known. Inspect the current words with timeline_transcript or measure the new edges with dialogue_check_join, then pass that exact version and range to save on the current footage. If the requested result is clear, finish the revision. If it depends on which take the editor wants, task_question can ask that choice. To keep the current footage for the selected call, pass keep:true; when the passage has no current location, use its original range without version. The other cuts and decisions carry over. Measured nearby silence can adjust an edge. Write the reason for the editor in one short sentence. To move several cuts of one pass, list them as cuts in one call.",
    { changeId: z.string(), version: z.string().min(1).optional().describe("Exact version of an inspected current passage; omit for times on the pass's fromVersion"),
      index: z.number().int().nonnegative().optional(), start: z.number().finite().nonnegative().optional(), end: z.number().finite().nonnegative().optional(),
      crossfadeFrames: crossfadeFrames.describe("Total audio-only overlap in project frames for these revised cuts. Omit to keep the existing transition."),
      pauseAfterWord: z.number().finite().nonnegative().optional().describe("Timeline seconds to leave between the last complete word and the start of this cut. Use 0 to trim up to the word."),
      keep: z.literal(true).optional().describe("Keep the current footage for the staged cut this request is about"),
      reason: z.string().trim().min(1).max(800).optional(),
      cuts: z.array(z.object({ index: z.number().int().nonnegative(), start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), keep: z.literal(true).optional(),
        reason: z.string().trim().min(1).max(800) })).min(1).max(50).optional().describe("Several cuts of this pass to move in one call, instead of index, start, end and reason"),
      noteIds: z.array(z.string()).optional() },
    async ({ changeId, version, index, start, end, pauseAfterWord, keep, reason, cuts, noteIds, crossfadeFrames }) => {
      const one = index !== undefined || start !== undefined || end !== undefined || reason !== undefined || keep !== undefined || pauseAfterWord !== undefined;
      if (one === !!cuts) throw new Error("Give either index, start, end and reason for one cut, or a cuts list.");
      if (pauseAfterWord !== undefined && (start !== undefined || end !== undefined || keep)) throw new Error("Give pauseAfterWord on its own with index and reason.");
      if (!cuts && (index === undefined || !reason || (pauseAfterWord === undefined && (start === undefined || end === undefined))))
        throw new Error("A move needs index, reason and either start/end or pauseAfterWord.");
      const indices = cuts ? cuts.map(m => m.index) : [index!];
      if (new Set(indices).size !== indices.length) throw new Error("Each cut can be moved once per call.");
      const selected = await useStagedCut();
      if (!selected && await localPausesMode()) throw new Error("Only the staged pause selected by the editor can be revised here.");
      if (selected && (indices.length !== 1 || changeId === stagedCut?.changeId && stagedCut.index !== indices[0]))
        throw new Error("Choose only the staged cut selected for this request.");
      // Carried versions can renumber a slot. The engine follows the selected passage through its replacement history.
      const { change } = await client.changeRecord(changeId);
      if (change.projectId !== ctx.projectId || change.intent !== "suggestion") throw new Error("Choose a pending dialogue pass in this project.");
      const canKeep = (index: number) => selected && stagedCut && (
        stagedCut.index === index && (stagedCut.changeId === changeId || !!ctx.taskId && change.taskId === ctx.taskId) ||
        namedConflict?.changeId === stagedCut.changeId && namedConflict.index === stagedCut.index && conflictAt(changeId, index));
      if (cuts ? cuts.some(m => m.keep && !canKeep(m.index)) : keep && !canKeep(index!)) {
        throw new Error("Keep applies only to the staged cut selected for this request.");
      }
      if (version === "head") throw new Error("Give the exact version you inspected so your decision stays with that footage.");
      const project = (await getProject()).project;
      let pause: MeasuredPause | undefined;
      if (pauseAfterWord !== undefined && index !== undefined) {
        const { review } = await client.cutReview(changeId);
        const cut = review?.cuts[index];
        if (!cut || review?.firstCut) throw new Error("Choose an individual staged cut to tighten.");
        const edit = change.cutEdits?.find(e => e.index === index);
        const conflict = conflictAt(changeId, index) ? cutConflict : undefined;
        const range = conflict ? conflict.range : edit?.range ?? cut.removed;
        const on = conflict?.version ?? edit?.version ?? change.fromVersion;
        if (!range || range.start >= range.end || (edit && !edit.previewVersion)) throw new Error("This cut has no current removal to tighten.");
        if (version && version !== on) throw new Error(`This cut is on ${on}. Measure its pause there.`);
        const source = await getTimeline(on);
        const measured = resolveOutgoingPause(source, project, range, await outgoingPausePages(source, project, range.start), pauseAfterWord);
        if (measured.status === "unavailable") throw new Error(measured.reason);
        if (measured.status === "already-at-target" && !conflict && crossfadeFrames === undefined) {
          const check = await savedPause(measured, edit?.previewVersion ?? change.toVersion, edit?.range.start ?? cut.at);
          return json({ changeId, index, ...range, unchanged: true, ...check });
        }
        pause = measured;
        start = measured.start;
        end = measured.end;
        version = on;
        readPassage(on, { start, end }, true);
      }
      const moves = cuts ?? [{ index: index!, start: start!, end: end!, reason: reason!, keep }];
      const tl = await getTimeline(version ?? change.fromVersion);
      // A request about one staged cut seldom reads the recording in pages, so the sound beside each new edge is measured
      // here, as dialogue_check_join does. Without it no edge could be judged, and none snapped.
      if (!pause) await measureTimeline(tl, moves.flatMap(m => m.keep ? [] : [m.start, m.end]));
      // Revisions keep their slots. When a later part has carried the pass, the engine translates every
      // remaining request from its original pass, where the agent measured its ranges and indices.
      let current = change.id, revised: Awaited<ReturnType<typeof client.reviseStagedCut>>["change"] | undefined;
      // The pass Scarlet made the first move on, when a revision had replaced the one named.
      let replaced: string | undefined;
      let carried = false;
      const results: Array<Record<string, unknown>> = [];
      for (const move of moves) {
        // A rollback can make the original version the current one again after this cut changed.
        const priorEdit = change.cutEdits?.some(e => e.index === move.index);
        if (version && (version !== change.fromVersion || cutConflict || priorEdit || carried || change.replacedBy) &&
          !cutInspections.some(({ version: read, range, edges }) => read === version &&
          (edges ? Math.abs(range.start - move.start) < .001 && Math.abs(range.end - move.end) < .001
            : range.start <= move.start + 1e-6 && range.end >= move.end - 1e-6))) {
          revisionVersions.add(version);
          const error = `Inspect the words, picture or proposed edges on version ${version} with timeline_transcript, frame_contact_sheet or dialogue_check_join before saving these times.`;
          if (!cuts) throw new Error(error);
          results.push({ index: move.index, error });
          continue;
        }
        const join = move.keep || pause ? undefined : checkDialogueJoin(tl, project, move, joinPages());
        // Snapping keeps every word. Otherwise the requested edges stand; the editor auditions the cut before approving it.
        const range = join?.status === "snapped" ? { start: join.start, end: join.end } : { start: move.start, end: move.end };
        let savedIndex = move.index;
        try {
          const saved = await client.reviseStagedCut(current, move.index, { ...range, version, crossfadeFrames, ...(pause && { requireCurrentCut: true }), keep: move.keep, reason: move.reason, taskId: ctx.taskId,
            author: ctx.author, noteIds: noteIds ?? ctx.task?.context.noteIds });
          revised = saved.change;
          savedIndex = saved.index ?? move.index;
          carried ||= !!saved.carried;
          replaced ??= saved.replaced;
        } catch (err) {
          if (pause && err instanceof ScarletApiError && err.code === "cut_review_moved")
            return { ...json({ error: err.message, currentCut: err.details }), isError: true };
          if (err instanceof ScarletApiError && err.code === "cut_review_stale") {
            const location = z.object({ currentVersion: z.string(), changeId: z.string().optional(), index: z.number().int().nonnegative().optional(),
              range: z.object({ start: z.number(), end: z.number() }).optional() }).safeParse(err.details);
            if (location.success) {
              const { currentVersion, range } = location.data;
              namedConflict = { changeId, index: move.index };
              cutConflict = { changeId: location.data.changeId ?? changeId, index: location.data.index ?? move.index, version: currentVersion, range };
              const failure = { index: move.index, error: err.message, currentVersion, range,
                next: range ? "Inspect the current passage with dialogue_review_inspect, frame_contact_sheet or dialogue_check_join, then save the intended range with this version. Ask only if the editor's preference would change the result."
                  : "Scarlet could not identify a unique current location. Inspect the current transcript and the source placements with timeline_at. If a creative choice remains, ask about the takes." };
              if (!cuts) return { ...json(failure), isError: true };
              results.push(failure);
              continue;
            }
          }
          // One cut that can't move doesn't undo the ones before it or stop the ones after.
          if (!cuts) throw err;
          results.push({ index: move.index, error: describeError(err) });
          continue;
        }
        current = carried ? changeId : revised.id;
        if (conflictAt(changeId, move.index)) cutConflict = undefined;
        const settled = !join || join.status === "unchanged" || join.status === "snapped";
        results.push({ index: savedIndex, ...(savedIndex !== move.index && { requestedIndex: move.index }), ...range, ...(move.keep && { choice: "keep" }), audio: join?.status === "unchanged" ? undefined : join?.reason,
          next: settled ? undefined : "An edge isn't on measured silence. Check it with dialogue_check_join and call again with a quiet edge if one exists. The latest call replaces this one." });
      }
      if (!revised) return json({ changeId, moved: results });
      lastTimeline = undefined;
      await postEvent({ type: "change", text: revised.description, data: { changeId: revised.id, toVersion: revised.toVersion, state: revised.state } });
      // The engine puts each cut on whole frames. Report the ranges it saved, which are the ones a recommendation names.
      const edits = new Map(revised.cutEdits?.map(edit => [edit.index, edit]));
      const needsOriginal = results.some(r => typeof r.index === "number" && !r.error && !r.choice && !edits.has(r.index));
      const stored = needsOriginal ? (await client.cutReview(revised.id).catch(without(`failed to read the ranges saved for ${revised.id}`, undefined)))?.review?.cuts : undefined;
      for (const result of results) {
        if (typeof result.index !== "number" || result.error) continue;
        const currentEdit = edits.get(result.index);
        if (currentEdit) {
          Object.assign(result, currentEdit.range, { version: currentEdit.version, previewVersion: currentEdit.previewVersion });
          if (currentEdit.range.start === currentEdit.range.end && !result.choice) {
            Object.assign(result, { alreadyRemoved: true, choice: "keep" });
            delete result.audio;
            delete result.next;
          }
        } else if (result.choice === "keep") {
          delete result.start;
          delete result.end;
        } else if (stored?.[result.index]?.removed) Object.assign(result, stored[result.index]!.removed);
        if (pause && !result.choice) {
          const at = currentEdit?.range.start ?? stored?.[result.index]?.at;
          Object.assign(result, at === undefined ? { verification: "The saved preview's join could not be located." }
            : await savedPause(pause, currentEdit?.previewVersion ?? revised.toVersion, at));
        }
      }
      const pass = { changeId: revised.id, state: revised.state, fromVersion: revised.fromVersion, toVersion: revised.toVersion,
        ...(replaced && { movedOn: replaced, note: `A revision had replaced ${changeId} with ${replaced} since this was asked. Scarlet made this move on ${replaced}, so the pass keeps that revision.` }) };
      return json(cuts ? { ...pass, moved: results } : { ...pass, ...results[0] });
    });

  // -- timeline -------------------------------------------------------------

  const perception = registerPerception({ tool, client, projectId: ctx.projectId, getTimeline, peekTimeline, getProject, readPassage, transcriptWords, settledThrough, readLevels, unavailable: unavailableOnce,
    readWaveform: (mediaId, from, to, points) => readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, points, true)) });

  async function readApprovedExample(changeId: string) {
    if (!authoring?.version || changeId !== authoring.changeId) throw new Error("This skill reads only the change the editor selected.");
    const { change } = await client.changeRecord(changeId);
    if (change.projectId !== ctx.projectId || change.state !== "approved" || (change.appliedVersion ?? change.toVersion) !== authoring.version) {
      throw new Error("The original change is no longer approved at the requested version.");
    }
    return change;
  }

  tool(
    "timeline_get",
    (authoring ? "Read the timeline version approved for the requested skill." : "Read a timeline version (default head).") + " summary: per track, each clip with id, label, timeline in–out (timecode), source range, speed, volume and fades, plus markers. full: the complete Timeline JSON with every clip property (transforms, effects, caption styles). Clip ids are what ops reference. A media clip lasts (sourceOut - sourceIn) / speed on the timeline.",
    { version: z.string().optional().describe(authoring ? "Defaults to the approved version" : "Version id; default head"), format: z.enum(["summary", "full"]).default("summary") },
    async ({ version, format }) => {
      if (authoring) {
        if (!authoring.changeId || (version && version !== authoring.version)) throw new Error("This skill reads only the approved timeline version.");
        await readApprovedExample(authoring.changeId);
      }
      const tl = await getTimeline(authoring?.version ?? version);
      if (format === "full") return json(tl);
      const project = await getProject();
      return text(summarizeTimeline(tl, project.project.settings.fps));
    },
  );

  tool(
    "timeline_at",
    "Map between timeline and source time so you never compute it by hand. With time (TIMELINE seconds): every clip under that instant with its track and, for media clips, the SOURCE second playing there. With mediaId and sourceTime: every timeline position where that source second plays (none if it was cut). With mediaId and sourceRange: the timeline ranges that play it, split by clip, and the source portions no longer in the edit.",
    { time: z.number().min(0).optional().describe("Timeline time, seconds"), mediaId: z.string().optional(),
      sourceTime: z.number().min(0).optional().describe("Source seconds in mediaId"),
      sourceRange: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional().describe("Source seconds in mediaId"),
      version: z.string().optional() },
    async ({ time, mediaId, sourceTime, sourceRange, version }) => {
      const modes = [time !== undefined, sourceTime !== undefined, sourceRange !== undefined].filter(Boolean).length;
      if (modes !== 1) throw new Error("Give exactly one of time, sourceTime or sourceRange.");
      if ((sourceTime !== undefined || sourceRange) && !mediaId) throw new Error("sourceTime and sourceRange need the mediaId they belong to.");
      const tl = await getTimeline(version);
      if (sourceTime !== undefined) return json({ version: tl.version, mediaId, sourceTime, placements: sourceToTimeline(tl, mediaId!, sourceTime) });
      if (sourceRange) {
        if (sourceRange.end <= sourceRange.start) throw new Error("sourceRange.end must be greater than sourceRange.start.");
        return json({ version: tl.version, mediaId, sourceRange, ...sourceRangeToTimeline(tl, mediaId!, sourceRange.start, sourceRange.end) });
      }
      const clips = clipsAt(tl, time!).map(({ track, clip }) => ({
        trackId: track.id, trackKind: track.kind, clipId: clip.id, kind: clip.kind, ...(clip.label && { label: clip.label }), timelineIn: clip.timelineIn,
        ...(clip.kind === "media" ? { mediaId: clip.mediaId, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, sourceTime: round3(timelineToSource(clip, time!)) } : {}),
        ...(clip.kind === "caption" ? { text: clip.text } : {}),
      }));
      return json({ time, version: tl.version, clips, ...(!clips.length && { note: "Nothing plays at that time (a gap)." }) });
    },
  );

  tool(
    "timeline_propose",
    `Propose an edit to the timeline. Provide EITHER \`ops\` (a list of operations on the named base version) OR \`timeline\` (a full replacement timeline). Scarlet validates it, stores a new version, makes short before/after previews available when the editor opens the change. Directly requested edits apply automatically. Suggestions and alternatives wait for review. Write \`description\` for the editor in one short, plain sentence about what changed (e.g. "Cut the false start at 1:17 and the 1.4 s pause after it"). Pass \`noteIds\` when the change answers review notes. Every audible clip edge the edit makes is measured on its recording, whichever op makes it: one inside a sounding word, or through a sound it would leave a piece of, refuses the edit and gives the quiet second beside it. Returns the change id, state, affected timeline ranges, the new version id and a diff.

${OPS_DOC}`,
    {
      ops: z.array(z.record(z.unknown())).optional().describe("Operations to apply to the current head (see op types)"),
      timeline: z.record(z.unknown()).optional().describe("Full replacement Timeline JSON (use for initial assemblies); omit when using ops"),
      description: z.string().min(1).describe("One short sentence about what the editor will see or hear"),
      noteIds: z.array(z.string()).optional().describe("Review note ids this change responds to"),
      fromVersion: z.string().optional().describe("Version the ops apply to. Defaults to the version you last read with timeline_get or timeline_at; leave it out unless you mean another version."),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).optional().describe("Timeline range on the base version for synchronized ripple removals across all tracks, including local pauses."),
      pictureLayout: z.union([z.object({ screenClipId: z.string(), cameraClipId: z.string(),
        framing: InsetFraming.optional(),
      }), z.literal("asPlaced")]).optional()
        .describe("Optional camera inset during the specified clips’ overlap. Supply framing (scale, center-relative x/y, optional crop and cornerRadius), or use the preset quarter-size bottom-right inset. Omit pictureLayout to use the submitted clip transforms."),
      intent: intentInput,
      timelineEdits: z.array(z.object({ label: z.string().min(1).max(180).describe("Short editor-facing title, at most 50 characters"), range: z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() }).describe("Seconds in the resulting timeline. A cut: the point where it joins, start equal to end. Any other edit, such as footage kept or changed: all of that footage as it plays, from its first second to its last"), check: z.string().trim().min(1).max(120).optional().describe("A few words naming a doubt the editor must settle by listening or looking. Marks this edit as needing the editor until they keep it; omit when nothing is in doubt"), summary: z.string().trim().min(1).max(SUMMARY_MAX).optional().describe("One sentence on what this edit did, including anything else it changed and what check points at. The edit's card shows only this sentence"), replaces: z.object({ changeId: z.string(), spot: z.number().int().nonnegative() }).optional() })).optional().describe("List each distinct edit with a short editor-facing phrase from your reply and its range. Keep overlapping edits separate. For a revision set replaces to the original change ID and zero-based edit index; give the full updated range."),
      ...(!ctx.taskId && { autoApprove: z.boolean().optional().describe("Apply a standalone edit authored directly by the editor") }),
      skipRender: z.boolean().optional().describe("Skip before/after renders (metadata-only changes like markers)"),
    },
    async ({ ops, timeline, description, noteIds, fromVersion, intent, autoApprove, timelineEdits, skipRender, range, pictureLayout }) => {
      // Every clip edge the edit makes is measured on its recording, however the edit makes it: a ripple, a clip added
      // or trimmed, a whole new timeline. One pass built its video from added clips, which nothing measured, and began
      // a clip inside the end of an “uh”; the revision the editor then asked for trimmed that join by one frame, into
      // the first sound of the next word, and said the word now played in full (2026-11-12).
      const refuseEdgesInSound = async (base: Timeline | null, next: Timeline) => {
        const inside = await edgesInSound(base, next).catch(without("failed to measure the edit's new clip edges", [] as SoundingEdge[]));
        if (inside.length) throw new Error(inside.slice(0, 12).map(e => edgeInSoundText(e)).join("; ") +
          `${inside.length > 12 ? `; and ${inside.length - 12} more` : ""}. ${EDGES_IN_SOUND}`);
      };
      if (!ops && !timeline) throw new Error("Provide either `ops` or `timeline`.");
      if (ops && timeline) throw new Error("Provide only one of `ops` or `timeline`.");
      const base = fromVersion ?? lastTimeline?.version;
      const before = base ? await getTimeline(base) : await headTimelineOrNull();
      if (range && (typeof pictureLayout === "object" || !before || !ops || ops.some(o => o.op !== "rippleDelete" || o.trackIds)))
        throw new Error("A bounded ripple edit takes only rippleDelete ops across all tracks on the existing timeline.");
      const body: ProposeChangeRequest = { description, noteIds, intent, fromVersion: base, autoApprove: !ctx.taskId && autoApprove === true ? true : undefined, timelineEdits, skipRender };
      const frameChanges: FrameAdjustment[] = [];
      const inset = typeof pictureLayout === "object" ? pictureLayout : undefined;
      if (ops) {
        const v = validateOps(ops);
        if (!v.ok) return { isError: true, content: [{ type: "text", text: v.error }] };
        if (!v.ops.length) throw new Error("ops is empty");
        if (before && (range || (selectedRange(ctx.task?.context) && v.ops.every(o => o.op === "rippleDelete" && !o.trackIds)))) {
          body.range = cutScope(before, await cutAnchor(before), range);
          const aligned = boundedRippleOps(v.ops, body.range, (await getProject()).project.settings.fps, timelineDuration(before));
          for (const [i, op] of aligned.entries()) {
            const asked = v.ops[i]!;
            if (asked.op === "rippleDelete" && (Math.abs(op.start - asked.start) > 1e-6 || Math.abs(op.end - asked.end) > 1e-6))
              frameChanges.push({ asked: [asked.start, asked.end], removed: [op.start, op.end] });
          }
          v.ops = aligned;
        }
        body.ops = v.ops;
        // Dialogue removed here skips the edge placement and checks of dialogue_apply_cuts. Three removals on one pass
        // came this way, and an edge inside a sounding word is the clipped word the editor sends back. Each all-track
        // ripple is measured on the timeline it applies to, in order.
        if (before) {
          const { project } = await getProject();
          let on = before;
          for (const [i, op] of v.ops.entries()) {
            if (op.op === "rippleDelete" && !op.trackIds && op.end > op.start) {
              // Only a measured word split refuses the edit. A recording with nothing to measure goes ahead as asked.
              const inside = await measureTimeline(on, [op.start, op.end])
                .then(() => joinAudio(on, project, op, joinPages()).filter(e => e.sound === "sound" && e.transcriptSplitsWord))
                .catch(without(`failed to measure the edges of ripple ${i}`, []));
              if (inside.length) throw new Error(inside.map(e => `ops[${i}] ${e.edge} at ${(e.edge === "start" ? op.start : op.end).toFixed(2)} s falls inside “${e.transcriptSplitsWord}”, which is sounding there`).join("; ") +
                ". Remove dialogue with dialogue_apply_cuts, where a word reference puts each edge in the recording's silence, or move the edge onto quiet (dialogue_check_join measures it).");
            }
            on = applyOps(on, [op]);
          }
        }
        // Dry-run against the pinned base before deriving the picture from the synchronized clips.
        const placed = applyOps(before ?? emptyTimeline(ctx.projectId), v.ops);
        await refuseEdgesInSound(before, placed);
        if (inset) body.ops = [...v.ops, ...syncPictureOps((await getProject()).project, placed, inset)];
      } else {
        const parsed = WritableTimeline.safeParse({ ...timeline, projectId: ctx.projectId, version: (timeline as { version?: string })?.version ?? "draft" });
        if (!parsed.success) {
          return { isError: true, content: [{ type: "text", text: `Invalid timeline:\n${formatZodError(parsed.error)}` }] };
        }
        body.timeline = parsed.data;
        await refuseEdgesInSound(before, parsed.data);
        if (inset) body.timeline = applyOps(parsed.data, syncPictureOps((await getProject()).project, parsed.data, inset));
      }
      return propose(body, before, frameChanges);
    },
  );

  tool(
    "timeline_crossfade_audio",
    "Propose centered audio-only crossfades between touching dialogue clips on the same audible track. Pass the clip ids on either side of each join. The total overlap defaults to two project frames. Uses real source handles and preserves picture timing and manual fades. All joins form one proposal.",
    {
      intent: intentInput,
      joins: z.array(z.object({ leftClipId: z.string(), rightClipId: z.string() })).min(1),
      duration: z.number().finite().positive().optional().describe("Total overlap in seconds"),
      description: z.string().min(1).default("Smooth the selected dialogue joins"),
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, joins, duration, description, noteIds }) => {
      const base = lastTimeline?.version;
      const { project } = await getProject();
      const before = await getTimeline(base);
      const ops = audioCrossfadeOps(before, project.media, joins, duration ?? 2 / project.settings.fps);
      return propose({ intent, ops, description, noteIds }, before);
    },
  );

  tool(
    "timeline_first_cut",
    "Replace the whole timeline with SOURCE keeps in the supplied playback order. For dialogue, {fromWord,toWord} keeps those inclusive transcript_get word indices and places their edges in measured quiet. Split adjacent words into separate keeps to tighten their pause. For picture, reordered jumps, or a boundary that needs review, supply exact source seconds as start/end on the affected keeps. {start,end} alone keeps an exact passage. The first and last source words keep the recording head and tail unless you give those handles. With synced A1 audio or audible layer sound, word indices belong to the recording that is heard. `layer` adds a second recording of the same event (a camera beside a screen capture) on a video track above V1, in sync at the offset audio_sync measured with mediaId as the reference: each keep range plays the same moment of both, wherever the layer has footage, as an inset (the preset quarter-size bottom-right, or `framing`). One recording is heard: mediaId's, or the layer's with `sound`. `audioMediaId` places a separate audio recording on A1 with the same ranges and mutes the video clips; use it only when it shares mediaId's timebase. `crossfade` adds that many seconds of audio fade in/out on each clip (about 2 frames, 0.066 s at 30 fps). For centered audio joins, leave crossfade unset. After the assembly is applied, timeline_get returns its clip IDs for timeline_crossfade_audio, which uses a two-frame overlap by default and keeps this assembly separately reviewable. Each keep edge is measured on the recording that is heard: one that would leave a piece of a sound playing moves onto the quiet that ends it, 0.12 s away at most, and comes back in `movedEdges`; one inside a sounding word saves nothing and is named with what was measured.",
    {
      intent: intentInput,
      mediaId: z.string().describe("Video (or audio-only) media to cut from"),
      keep: z
        .array(z.object({
          fromWord: z.number().int().nonnegative().optional(), toWord: z.number().int().nonnegative().optional(),
          start: z.number().finite().nonnegative().optional(), end: z.number().finite().nonnegative().optional(), label: z.string().optional(),
        }).refine(r => r.fromWord !== undefined || r.toWord !== undefined ? r.fromWord !== undefined && r.toWord !== undefined
          : r.start !== undefined && r.end !== undefined, "Give both kept word indices, or both source seconds."))
        .min(1)
        .describe("Ordered keeps from the same source. start/end on an indexed keep fix just those source handles."),
      layer: z.object({
        mediaId: z.string().describe("The second video recording"),
        offset: z.number().finite().describe("Seconds it starts after mediaId (negative = earlier): audio_sync's offset with mediaId as referenceId"),
        sound: z.boolean().optional().describe("Hear this recording instead of mediaId's"),
        framing: InsetFraming.optional().describe("Scale and center-relative x/y of its picture, with optional crop and cornerRadius, in place of the preset inset"),
      }).optional().describe("A second simultaneous recording, inset above the first"),
      audioMediaId: z.string().optional().describe("Separate audio recording synced to the video (same source timebase)"),
      crossfade: z.number().min(0).max(2).optional().describe("Audio fade in/out per clip, seconds"),
      description: z.string().min(1).describe("Description for the reviewer"),
      noteIds: z.array(z.string()).optional(),
    },
    async ({ intent, mediaId, keep, layer, audioMediaId, crossfade, description, noteIds }) => {
      const base = lastTimeline?.version;
      const detail = await getProject();
      const before = base ? await getTimeline(base) : detail.timeline ?? await headTimelineOrNull();
      const media = detail.project.media.find((m) => m.id === mediaId);
      if (!media) throw new Error(`Media ${mediaId} is not in this project. Use project_get for media ids.`);
      const audio = audioMediaId ? detail.project.media.find(m => m.id === audioMediaId) : media;
      if (!audio) {
        throw new Error(`Audio media ${audioMediaId} is not in this project. Use project_get for media ids.`);
      }
      const second = layer && detail.project.media.find(m => m.id === layer.mediaId);
      if (layer) {
        if (!second) throw new Error(`Layer media ${layer.mediaId} is not in this project. Use project_get for media ids.`);
        if (second.kind !== "video" || second.id === mediaId) throw new Error("The layer is a second video recording, not mediaId itself or a sound recording. A separate sound recording goes in audioMediaId.");
        if (!second.duration) throw new Error(`The length of ${layer.mediaId} isn't known yet, so it can't be placed in sync. Try again once it has been read.`);
        if (layer.sound && audioMediaId) throw new Error("Choose one sound: the layer's (sound) or the separate recording (audioMediaId).");
      }
      const anchor = ctx.task?.context;
      if (before?.tracks.some(t => t.clips.length) && selectedRange(anchor))
        throw new Error("A whole-timeline replacement exceeds the scoped selection. Submit the local removals on the existing timeline.");
      const staged = keep.some(r => r.fromWord !== undefined) && await useStagedCut();
      if (staged) throw staged;
      const indexedLayer = layer?.sound && second && keep.some(r => r.fromWord !== undefined);
      const offset = indexedLayer ? layer!.offset : 0;
      const handles = offset ? keep.map(r => ({
        ...r, start: r.start === undefined ? undefined : r.start - offset,
        end: r.end === undefined ? undefined : r.end - offset,
      })) : keep;
      const placed = await firstCutRanges(handles, ctx.projectId, indexedLayer ? second! : audio, planSources);
      const ranges = offset ? placed.ranges.map(r => ({ ...r, start: r.start + offset, end: r.end + offset })) : placed.ranges;
      const placement = placed.evidence;
      if (anchor?.mediaId && anchor.time !== undefined && anchor.end !== undefined &&
          (mediaId !== anchor.mediaId || ranges.some(r => r.start < anchor.time! || r.end > anchor.end!)))
        throw new Error("Keep ranges must be inside the selected source passage.");
      const problems: string[] = [];
      ranges.forEach((r, i) => {
        if (r.end <= r.start) problems.push(`keep[${i}]: end (${r.end}) must be greater than start (${r.start})`);
        if (media.duration !== undefined && r.end > media.duration + 0.01) {
          problems.push(`keep[${i}]: end ${r.end} exceeds media duration ${media.duration}`);
        }
      });
      if (problems.length) return { isError: true, content: [{ type: "text", text: `Invalid keep ranges:\n${problems.map((p) => `- ${p}`).join("\n")}` }] };
      const build = () => timelineFromKeepRanges(ctx.projectId, mediaId, ranges, { audioMediaId, crossfade,
        layer: layer && second ? { mediaId: second.id, offset: layer.offset, duration: second.duration!, sound: layer.sound,
          transform: Transform.parse(layer.framing ?? insetFraming(detail.project, second)) } : undefined });
      // Check the audible picture and audio edges of the assembled timeline, including the edges supplied in seconds. One that
      // leaves a piece of a sound playing goes onto the quiet that ends the piece, a fragment's length away at most,
      // and is reported. One inside a sounding word is the model's to move: which side of the word it meant is its call.
      const movedEdges: Array<{ keep: number; edge: "start" | "end"; from: number; to: number; evidence: string }> = [];
      const measure = (timeline: Timeline) => edgesInSound(null, timeline).catch(without("failed to measure the first cut's edges", [] as SoundingEdge[]));
      /** Which keep range a clip of the built timeline plays: they lie end to end in the order given. */
      const rangeOf = (timeline: Timeline, clipId: string) => {
        const clip = timeline.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
        let cursor = 0;
        for (const [i, r] of ranges.entries()) {
          if (clip && clip.timelineIn >= cursor - 1e-6 && clip.timelineIn < cursor + (r.end - r.start) - 1e-6) return i;
          cursor += r.end - r.start;
        }
        return -1;
      };
      let tl = build();
      let sounding = await measure(tl);
      if (sounding.some(e => e.fragment)) {
        for (const e of sounding) {
          const i = e.fragment ? rangeOf(tl, e.clipId) : -1, r = ranges[i];
          if (!r || !e.fragment) continue;
          const edge = e.side === "in" ? "start" : "end", to = round3(r[edge] + e.fragment.quietAt - e.source);
          if (e.side === "in" ? to >= r.end - .05 : to <= r.start + .05) continue;
          movedEdges.push({ keep: i, edge, from: r[edge], to, evidence: `${Math.round(e.fragment.seconds * 1000)} ms of ${e.word ? `“${e.word}”` : "a sound the transcript has no word for"} played at ${e.fragment.db} dBFS; quiet there is ${e.fragment.quietDb} dBFS` });
          r[edge] = to;
        }
        tl = build();
        sounding = await measure(tl);
      }
      if (sounding.length) throw new Error(sounding.slice(0, 12).map(e => {
        const i = rangeOf(tl, e.clipId);
        return edgeInSoundText(e, i < 0 ? `clip ${e.clipId}` : `keep[${i}]`);
      }).join("; ") + `${sounding.length > 12 ? `; and ${sounding.length - 12} more` : ""}. Nothing was saved. Move each edge onto quiet: source seconds here are those of the recording that is heard.`);
      const result = await propose({ intent, timeline: tl, firstCut: true, description, noteIds }, before);
      const total = ranges.reduce((acc, r) => acc + (r.end - r.start), 0);
      // What the layer covers is evidence: a wrong offset or a short recording shows here, before anything is cut.
      const inset = tl.tracks.find(t => t.id === "v2")?.clips ?? [];
      const covered = inset.reduce((acc, c) => acc + (c.kind === "media" ? c.sourceOut - c.sourceIn : 0), 0);
      return {
        ...result,
        content: [
          { type: "text", text: `First edit: ${ranges.length} clip(s), ${total.toFixed(2)} s total${media.duration ? ` from ${media.duration.toFixed(2)} s of source` : ""}.` +
            (layer ? ` Layer ${layer.mediaId}: ${covered.toFixed(2)} s of the ${total.toFixed(2)} s inset on V2 in ${inset.length} clip(s)${total - covered > 0.01 ? `; it has no footage for the other ${(total - covered).toFixed(2)} s, where ${mediaId} plays alone` : ""}.` : "") },
          ...(movedEdges.length ? [{ type: "text" as const, text: JSON.stringify({ movedEdges }) }] : []),
          ...(placement.length ? [{ type: "text" as const, text: placement.join("\n") }] : []),
          ...result.content,
        ],
      };
    },
  );

  tool(
    "captions_generate",
    "Generate a caption track from the transcript, mapped through the CURRENT edit: for audible clips by default (or all enabled placements of an explicitly named mediaId) the words inside its kept source range are placed at the matching timeline time; words that were cut out are dropped. Groups words into caption clips of at most `maxWords` words / `maxChars` characters with per-word timings (karaoke highlighting possible). Choose a destination when caption tracks already exist. Replacing one track preserves the others. `style` is a partial CaptionStyle: fontFamily, fontSize (fraction of canvas height, e.g. 0.05), color, backgroundColor, outlineColor, outlineWidth, y (0..1 from top, 0.85 = lower third), align, maxWidth, uppercase, highlightColor.",
    {
      mediaId: z.string().optional(),
      intent: intentInput,
      maxWords: z.number().int().positive().default(5),
      maxChars: z.number().int().positive().default(32),
      style: CaptionStyle.partial().optional(),
      maxGap: z.number().finite().nonnegative().optional().describe("Longest inter-word gap within a cue, in seconds (default 0.8)."),
      destination: z.union([z.literal("new"), z.object({ replaceTrackId: z.string().min(1) })]).optional().describe("Create a new caption track or replace the cues of one named caption track."),
      trackName: z.string().optional(),
      description: z.string().min(1).default("Generate captions from the transcript"),
    },
    async ({ intent, mediaId, maxWords, maxChars, maxGap, style, destination, trackName, description }) => {
      const detail = await client.workspace(ctx.projectId);
      const head = detail.timeline;
      if (!head) throw new Error("The project has no timeline yet; assemble an edit before generating captions.");
      const tracks = head.tracks.filter(t => t.kind === "caption");
      if (!destination && tracks.length) return json({ version: head.version, needsDestination: true,
        captionTracks: tracks.map(t => ({ id: t.id, name: t.name, cues: t.clips.length })),
        next: "Choose destination new or supply replaceTrackId. No tracks were changed." });
      const target = typeof destination === "object" ? tracks.find(t => t.id === destination.replaceTrackId) : undefined;
      if (typeof destination === "object" && !target) throw new Error("Choose a caption track on the current version.");
      const sources = new Set(detail.project.media.filter(m => m.kind === "audio" || (m.kind === "video" && m.hasAudio !== false)).map(m => m.id));
      const clips = captionSourceClips(head, id => sources.has(id), mediaId);
      const mediaIds = new Set(clips.map(c => c.mediaId));
      const mappers = new Map<string, ReturnType<typeof captionWordMapper>>();
      // A cue keeps the word times it is saved with, and nothing places them again. So the words must be where the
      // recording has them through the last second captioned: a transcript still being aligned says how far it has
      // come, and the captions are made on a later call. One wait covers every recording.
      const waitUntil = Date.now() + edgeWaitMs;
      for (const id of mediaIds) {
        const last = Math.max(...clips.filter(c => c.mediaId === id).map(c => c.sourceOut));
        const words = await transcriptWords(id, true, last + 1, Math.max(0, waitUntil - Date.now()));
        if (words) mappers.set(id, captionWordMapper(words));
      }
      if (!clips.length) {
        throw new Error(
          mediaId
            ? `no clips of media ${mediaId} with a transcript on the timeline`
            : `no clips of transcribed media on the timeline (name a mediaId from project_get to include its muted placements)`,
        );
      }
      const mapped: TranscriptWord[] = [];
      const skipped: string[] = [];
      for (const clip of clips) {
        const map = mappers.get(clip.mediaId);
        if (map) for (const word of map(clip)) mapped.push(word);
      }
      for (const id of mediaIds) if (!mappers.has(id)) skipped.push(id);
      const words = dedupeWords(mapped);
      if (!words.length) throw new Error(`No transcript words land on the current edit${skipped.length ? ` (no transcript for: ${skipped.join(", ")})` : ""}.`);
      const groups = captionsFromWords(words, { maxWords, maxChars, maxGap, minDuration: 0.1 });
      const captionClips: CaptionClip[] = groups.map((g) => ({
        id: newId("cap"),
        kind: "caption",
        timelineIn: g.start,
        timelineOut: g.end,
        text: g.text,
        words: g.words.map((w) => ({ text: w.text, start: w.start, end: Math.min(w.end, g.end) })),
        enabled: true,
      }));
      const ops: TimelineOp[] = [];
      if (target) ops.push({ op: "removeTrack", trackId: target.id });
      const track: Track = {
        id: target?.id ?? newId("cap"), kind: "caption", name: trackName ?? target?.name ?? "Captions",
        muted: target?.muted ?? false, hidden: target?.hidden ?? false,
        captionStyle: style ? { ...target?.captionStyle, ...style } : target?.captionStyle,
        clips: captionClips,
      };
      ops.push({ op: "addTrack", track, ...(target && { index: head.tracks.indexOf(target) }) });
      // The engine validates and applies these generated ops transactionally
      // against this base. Replaying the whole caption track here duplicates it.
      const result = await propose({ intent, ops, description }, head);
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `${captionClips.length} caption clip(s) from ${words.length} words across ${clips.length} media clip(s)${skipped.length ? `; skipped media without transcript: ${skipped.join(", ")}` : ""}.`,
          },
          ...result.content,
        ],
      };
    },
  );

  // -- changes & notes ------------------------------------------------------

  tool(
    "change_get",
    authoring ? "Read the approved change and the diff of the edits the editor kept." : "Get a change by id: description, state (proposed|rendering|ready|approved|rejected|revising|failed), author, from/to versions, affected ranges, review notes on its cuts, and the diff in plain lines. Use when revising a change the editor sent back; timeline_join_audit measures its joins.",
    { changeId: z.string() },
    async ({ changeId }) => {
      if (authoring) {
        const change = await readApprovedExample(changeId);
        const approved = change.appliedVersion ?? change.toVersion;
        const before = change.appliedReview?.originalVersion ?? (change.appliedOnto === approved ? change.fromVersion : change.appliedOnto ?? change.fromVersion);
        // A partial acceptance can leave the proposal's title and its diff describing edits the editor skipped.
        const partial = change.approvedSpots !== undefined || !!change.restoredCuts?.length;
        const { description: diff } = await client.diff(ctx.projectId, before, approved, "id");
        return json({ change: { id: change.id, description: partial ? undefined : change.description, state: change.state,
          appliedVersion: approved, approvedSpots: change.approvedSpots }, diff });
      }
      const { change, diff } = await client.change(changeId);
      return json({ change, diff: describeDiff(diff, undefined, clipById) });
    },
  );

  tool(
    "change_list",
    "List changes of the project, optionally filtered by state (proposed, rendering, ready, approved, rejected, revising, failed).",
    { state: z.string().optional() },
    async ({ state }) => {
      const { changes } = await client.changes(ctx.projectId, state);
      const lines = changes.map((c: Change) => `${c.id} [${c.state}${c.intent ? ` ${c.intent}` : ""}] ${c.fromVersion}→${c.toVersion} ${c.author.name}: ${c.description}`);
      return text(`${changes.length} change(s)${state ? ` in state ${state}` : ""}:\n${lines.join("\n")}`);
    },
  );

  tool(
    "notes_list",
    "List review notes (editor feedback pinned to a timeline time and clip ids). Filter by state: open, in_progress, resolved, dismissed. Each note has time/end (timeline seconds), clipIds, text, author, assignedTo and optionally the changeId it is about.",
    { state: z.string().optional().describe("Default: all states") },
    async ({ state }) => {
      const { notes } = await client.notes(ctx.projectId, state);
      const lines = notes.map(
        (n) => `${n.id} [${n.state}] @${n.time.toFixed(2)}${n.end !== undefined ? `–${n.end.toFixed(2)}` : ""} s on ${n.version}${n.clipIds.length ? ` clips ${n.clipIds.join(",")}` : ""}${n.changeId ? ` about ${n.changeId}` : ""}${n.assignedTo ? ` for ${n.assignedTo}` : ""} by ${n.author.name}: ${n.text}${(n.replies ?? []).map(r => ` | reply from ${r.author.name}: ${r.text}`).join("")}`,
      );
      return text(`${notes.length} note(s):\n${lines.join("\n")}`);
    },
  );

  tool(
    "note_reply",
    "Reply to a review note (the editor sees your reply in the thread). Use it to explain what you did or why you did something different; use timeline_propose with noteIds to actually address the note.",
    { noteId: z.string(), text: z.string().min(1) },
    async ({ noteId, text: body }) => {
      if (await localPausesMode() && !ctx.task?.context.noteIds?.includes(noteId)) throw new Error("Choose a note attached to this request.");
      const { note } = await client.replyNote(noteId, body, ctx.author);
      return text(`Replied to note ${noteId}; it is ${note.state}.`);
    },
  );

  tool(
    "note_resolve",
    "Mark a review note resolved after you have addressed it (usually after proposing a change with that noteId).",
    { noteId: z.string() },
    async ({ noteId }) => {
      if (await localPausesMode() && !ctx.task?.context.noteIds?.includes(noteId)) throw new Error("Choose a note attached to this request.");
      const { note } = await client.updateNote(noteId, { state: "resolved" });
      return text(`Note ${noteId} is ${note.state}.`);
    },
  );

  // -- renders --------------------------------------------------------------

  tool(
    "render_request",
    "Request a short quality check with a timeline range in seconds. Use preview for low resolution or full for delivery quality. Omit the range with full only for an explicitly requested whole-video render. Proposing and approving edits do not require a render. Poll render_status with the returned id.",
    {
      kind: z.enum(["preview", "full"]).default("preview"),
      version: z.string().optional().describe("Default head"),
      range: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional(),
    },
    async ({ kind, version, range }) => {
      if (kind === "preview" && !range) return { isError: true, content: [{ type: "text", text: "Choose a short timeline range for the preview, in seconds." }] };
      const { render } = await client.requestRender(ctx.projectId, {
        kind: range ? "segment" : kind,
        version,
        range,
        quality: kind === "full" ? "delivery" : "preview",
      });
      return json(render);
    },
  );

  tool(
    "render_status",
    "Status of a render: state (queued|running|done|failed|cancelled), progress 0..1, duration, dimensions, error.",
    { renderId: z.string(), inspectFile: z.boolean().optional().describe("Probe the completed file for its actual duration, dimensions, fps, bitrate and audio/video stream details") },
    async ({ renderId, inspectFile }) => {
      const { render, fileInfo } = await client.render(renderId, inspectFile);
      return json(fileInfo ? { ...render, fileInfo } : render);
    },
  );

  // -- assets ---------------------------------------------------------------

  tool(
    "asset_add",
    "Upload an existing file from this task’s artifact directory (for example an animation, graphic or music bed) into the project's media so it can be placed on the timeline with addClip. `kind` is video|audio|image|graphic (guessed from the extension when omitted). `provenance` records how it was made (prompt/tool) so others can revise it. Returns the new mediaId and probed duration. Agents never upload finished videos; Scarlet renders the edit.",
    {
      path: z.string().describe("File inside the task artifact directory (relative or absolute path)"),
      kind: z.enum(["video", "audio", "image", "graphic"]).optional(),
      provenance: z.object({ prompt: z.string().optional(), model: z.string().optional(), name: z.string().optional() }).optional(),
    },
    async ({ path, kind, provenance }) => {
      const data = await readArtifact(await artifactDir(), path);
      const name = basename(path);
      const guessed = kind ?? guessKind(name);
      const fd = new FormData();
      fd.append("file", new Blob([data]), name);
      fd.append("kind", guessed);
      fd.append(
        "provenance",
        JSON.stringify({ by: "agent", name: provenance?.name ?? ctx.author.name, model: provenance?.model ?? ctx.author.model, prompt: provenance?.prompt, createdAt: new Date().toISOString() }),
      );
      const { media } = await client.post<{ media: ProjectDetail["project"]["media"][number] }>(`/projects/${ctx.projectId}/media`, fd);
      return json(media);
    },
  );

  tool(
    "export_otio",
    "Export a version (default head) as an OpenTimelineIO (.otio) file that DaVinci Resolve imports natively (File > Import > Timeline). Saves to the working directory and returns the path.",
    { version: z.string().optional(), path: z.string().optional().describe("Destination file path; default <workDir>/exports/<version>.otio") },
    async ({ version, path }) => {
      let v = version;
      if (!v || v === "head") {
        const detail = await getProject();
        if (!detail.project.head) throw new Error("project has no head version to export");
        v = detail.project.head;
      }
      const otio = await client.get<unknown>(`/projects/${ctx.projectId}/versions/${apiPathId(v)}/export.otio`);
      const dest = await writeArtifact(await artifactDir(), path ?? join("exports", `${sanitize(v)}.otio`), JSON.stringify(otio, null, 2));
      return json({ path: dest, version: v });
    },
  );

  // -- task events ----------------------------------------------------------

  tool(
    "task_log",
    "Report progress to the editor. Optional edit references link exact phrases in the text to saved changes.",
    { text: z.string().min(1), excerpt: z.string().trim().min(1).max(280).optional()
        .describe("A short verbatim transcript quote for a linked dialogue edit, when it helps identify the passage"),
      activity: z.string().trim().max(48).regex(/^[\p{L}][\p{L}’-]*(?: [\p{L}][\p{L}’-]*)?$/u, "Give the activity in one or two words of letters only, such as Checking captions. Put the rest in text.")
        .optional().describe("Current one- or two-word action, e.g. Checking captions"), edits: z.array(z.object({
      phrase: z.string().min(1).describe("Exact consecutive words in text, in reading order"),
      changeId: z.string().min(1), spot: z.number().int().nonnegative().default(0).describe("Zero-based index in timelineEdits, or affectedRanges when the proposal has no named edits"),
    })).max(32).optional() },
    async ({ text: body, activity, excerpt, edits }) => {
      const { posted, error } = await postEvent({ type: "log", text: body, data: { kind: "editor_progress", ...(activity ? { activity } : {}), ...(edits?.length ? { edits, ...(excerpt ? { excerpt } : {}) } : {}) } });
      if (posted) return text("Logged.");
      // A task whose update was lost or refused is still a Scarlet task. It hears what failed, and the request goes on without the update.
      return text(error === undefined ? "Not running as a Scarlet task; message not posted."
        : `This update didn't reach the editor: ${error}. Carry on with the request unless the task itself has ended.`);
    },
  );

  tool(
    "task_question",
    "Ask the editor a question when you cannot proceed without their decision (which take, what aspect ratio, whether to cut a section). Posting the question pauses the task; STOP working immediately after calling this and end your turn. Scarlet resumes the task with the editor's answer as your next message. Ask only when needed, and make the question specific with the options you see.",
    { text: z.string().min(1) },
    async ({ text: body }) => {
      if (!ctx.taskId) {
        return text("Not running as a Scarlet task, so nobody can answer. Make the most reasonable assumption, state it in your summary, and continue.");
      }
      const { waiting } = await client.postTaskQuestion(ctx.taskId, startedAt, body);
      return text(
        waiting
          ? "Question posted to the editor. Stop now: do not call any more tools and end your turn with a one-line summary of what you have done so far. Scarlet resumes the task with the editor's answer."
          : "This task attempt has already ended. Stop now.",
      );
    },
  );

  // -- skills ---------------------------------------------------------------

  tool(
    "skills_list",
    "List the workflows available for this editing request, or read one by passing its id or exact name as skillId (for example, dialogue-pass). Reading a workflow changes no tool behavior.",
    { skillId: z.string().min(1).optional() },
    async ({ skillId }) => {
      const { skills } = await client.skills({ projectId: ctx.projectId, view: "assistant",
        ...(ctx.taskId && { taskId: ctx.taskId }) });
      const applicable = skills.filter((s: Skill) => s.enabled);
      if (skillId) {
        const skill = applicable.find(s => s.id === skillId) ?? applicable.find(s => s.name === skillId);
        if (!skill) throw new Error("This skill is unavailable for this request. Use skills_list to find an available workflow.");
        return text(skill.content);
      }
      return text(applicable.length ? applicable.map((s) => `${s.id} ${s.name} (${s.scope}): ${s.description}`).join("\n") : "No skills enabled.");
    },
  );

  tool(
    "learning_suggest",
    "Offer the editor a standing rule for one of their skills. It goes on a list they review when they choose, with what they said; nothing in the skill changes unless they approve it. Give the rule as one plain sentence that would read well in the skill, and the skill it belongs in, by id or exact name. In replaces, quote each passage of that skill the rule contradicts or overrides, word for word and one stretch of text each; the editor sees them beside the rule before deciding, and approving it replaces them. Leave replaces out when nothing in the skill says otherwise.",
    SuggestLearningRequest.shape,
    async ({ rule, skill, replaces }) => {
      if (!ctx.taskId) return text("Not running as a Scarlet task, so there is no list to add this to.");
      const { learning, skill: saved } = await client.suggestLearning(ctx.projectId, ctx.taskId, { rule, skill, ...(replaces?.length && { replaces }) });
      return json({ learningId: learning.id, skill: saved.name, state: learning.state, ...(learning.replaces && { replaces: learning.replaces.length }) });
    },
  );

  const task = ctx.task;
  const target = task && task.id === ctx.taskId && (!ctx.agent || task.agent === ctx.agent) ? skillTaskTarget(task, ctx.projectId) : undefined;
  if (task && target) {
    tool(
      "skill_save_from_change",
      `Save the team skill "${target.name}" requested by the editor for approved change ${target.changeId}. Provide a one-line description and the reusable Markdown instructions without frontmatter.`,
      TaskSkillDraft.shape,
      async ({ description, instructions }) => {
        const { skill } = await client.saveTaskSkill(ctx.projectId, task.id, { changeId: target.changeId, hostId: target.hostId, description, instructions });
        return json({ skillId: skill.id, name: skill.name, scope: skill.scope });
      },
    );
  }

  const editing = task && task.id === ctx.taskId && (!ctx.agent || task.agent === ctx.agent) ? skillEditTarget(task, ctx.projectId) : undefined;
  if (task && editing) {
    tool(
      "skill_save_edit",
      "Save your revision of the skill the editor asked you to change. Provide its one-line description and the complete Markdown instructions without frontmatter: this replaces both, so include what stays as well as what changed. Scarlet keeps the name and the earlier version.",
      TaskSkillDraft.shape,
      async ({ description, instructions }) => {
        const { skill } = await client.saveSkillEdit(ctx.projectId, task.id, { skillId: editing.skillId, hostId: editing.hostId, description, instructions });
        return json({ skillId: skill.id, name: skill.name, version: skill.version });
      },
    );
  }

  return server;
}

function guessKind(name: string): "video" | "audio" | "image" | "graphic" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["mp4", "mov", "mkv", "webm", "avi", "m4v", "mxf"].includes(ext)) return "video";
  if (["wav", "mp3", "aac", "m4a", "flac", "ogg", "aif", "aiff"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(ext)) return "image";
  if (["svg", "json", "lottie"].includes(ext)) return "graphic";
  return "video";
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

