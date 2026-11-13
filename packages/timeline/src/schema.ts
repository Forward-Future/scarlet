/**
 * Scarlet cut-list schema.
 *
 * All times are seconds (floating point) on the project timeline or in source
 * media. Frame snapping happens at render time using the project frame rate.
 * Agents think in seconds (transcripts are in seconds), so the format does too.
 *
 * Positions and sizes in transforms are normalized to the project canvas:
 * x/y are offsets from center in units of canvas width/height (0 = centered,
 * 0.5 = half a canvas to the right/down). scale 1 = fit source to canvas.
 */
import { z } from "zod/v3";
import { parseColor } from "./color.js";
import { timelinePlanningIssue } from "./time.js";

export const RenderColor = z.string().refine((value) => !!parseColor(value), "invalid render color");

export const Id = z.string().min(1);

export const Seconds = z.number().finite().min(0);

export const TimeRange = z
  .object({
    start: Seconds,
    end: Seconds,
  })
  .refine((r) => r.end >= r.start, { message: "end must be >= start" });
export type TimeRange = z.infer<typeof TimeRange>;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MediaKind = z.enum(["video", "audio", "image", "graphic"]);
export type MediaKind = z.infer<typeof MediaKind>;

/** Source previews are independently playable MP4s on this fixed time grid. */
export const SOURCE_PREVIEW_SECONDS = 8;
/**
 * The longest summary of an edit that is accepted. Agents are asked for one sentence, and the edit's card folds a
 * long one. The limit used to be 240: a proposal whose summaries ran over was refused whole, and writing its
 * timeline out again took the agent a minute and a half.
 */
export const SUMMARY_MAX = 600;

/** Default output height for preview renders and source proxies. */
export const DEFAULT_PREVIEW_HEIGHT = 540;

/** Who or what produced an asset. */
export const Provenance = z.object({
  /** "human" | "agent" | "scarlet" */
  by: z.enum(["human", "agent", "scarlet"]),
  name: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  /** Change that introduced the asset, if any. */
  changeId: Id.optional(),
  createdAt: z.string().datetime().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** One-based audio stream ordinals confirmed for this particular recording. */
export const DialogueVoiceRoles = z.object({
  me: z.number().int().min(1).max(3), other: z.number().int().min(1).max(3),
}).refine(v => v.me !== v.other, "Choose two different isolated inputs");
export type DialogueVoiceRoles = z.infer<typeof DialogueVoiceRoles>;

export const MediaAsset = z.object({
  voiceRoles: DialogueVoiceRoles.optional(),
  id: Id,
  /** The desktop import that created this asset, retained so retrying that request returns the same file. */
  importId: z.string().uuid().optional(),
  kind: MediaKind,
  /** Human-facing name, usually the original filename. */
  name: z.string(),
  /** Storage key relative to the project's media root. */
  path: z.string(),
  /** Content hash (sha256 hex) so renders can be cached by content. */
  hash: z.string().optional(),
  fingerprintStamp: z.object({ size: z.number().nonnegative(), mtimeMs: z.number(), ctimeMs: z.number() }).optional(),
  /** Source clock needed to place an independently decoded proxy chunk on an exact frame. */
  previewClock: z.object({ frameRate: z.string(), startPts: z.number(), videoStart: z.number().optional() }).optional(),
  /** MIME type and codecs of the probed original, for the native player's canPlayType check. */
  originalPlaybackType: z.string().optional(),
  previewMode: z.literal("on-demand").optional(),
  duration: Seconds.optional(),
  fps: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasAudio: z.boolean().optional(),
  hasAlpha: z.boolean().optional(),
  /** Automatic transcription permitted at import, retained across interrupted preparation. */
  transcriptionOnImport: z.enum(["openai", "whispercpp"]).optional(),
  /** Provider revision when imported. An older import without it needs a new transcription request. */
  transcriptionRevisionOnImport: z.number().int().nonnegative().optional(),
  /** Transcript id for media with speech. */
  transcriptId: Id.optional(),
  /** Last successful transcription, preserved when its words are relabelled or a new attempt fails. */
  lastTranscription: z.object({
    completedAt: z.string().datetime().optional(),
    /** Recorded model name, without local directory paths. */
    model: z.string().optional(),
  }).optional(),
  provenance: Provenance.optional(),
  /** Authenticated user who uploaded or imported the asset. */
  uploadedBy: Id.optional(),
  /** Server-side ingest state. Absent means ready. */
  status: z.enum(["ingesting", "ready", "failed"]).optional(),
  preparation: z.object({
    stage: z.enum(["preview", "waveform", "fingerprint"]),
    fraction: z.number().min(0).max(1),
    remainingSeconds: z.number().nonnegative().optional(),
  }).optional(),
  error: z.string().optional(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

/** Waveform extraction starts only after the source audio or finished video proxy is playable. */
export function isPlayableMedia(media: MediaAsset): boolean {
  if (media.kind !== "audio" && media.kind !== "video") return false;
  return (media.status === "ingesting" && media.preparation?.stage === "fingerprint") || media.preparation?.stage === "waveform" || media.status === "ready" || (media.status === undefined && !!media.duration);
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export const Transform = z.object({
  /** Offset from center as a fraction of canvas width. */
  x: z.number().default(0),
  /** Offset from center as a fraction of canvas height. */
  y: z.number().default(0),
  /** 1 = source fitted to canvas (contain). */
  scale: z.number().positive().default(1),
  /** Degrees, clockwise. */
  rotation: z.number().default(0),
  /** Crop as fractions of the source dimensions, 0 = none. */
  cropLeft: z.number().min(0).max(1).default(0),
  cropRight: z.number().min(0).max(1).default(0),
  cropTop: z.number().min(0).max(1).default(0),
  cropBottom: z.number().min(0).max(1).default(0),
  /** Radius as a fraction of the cropped layer's shorter side. Omitted or zero keeps square corners. */
  cornerRadius: z.number().min(0).max(0.5).optional(),
});
export type Transform = z.infer<typeof Transform>;

/** A keyframed transform: value at `time` (timeline seconds, relative to clip start). */
export const TransformKeyframe = z.object({
  /** A preceding keyframe can land before zero after a trim; keep its easing curve intact. */
  time: z.number().finite(),
  transform: Transform.omit({ cornerRadius: true }).partial(),
  /** linear by default */
  ease: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("linear"),
});
export type TransformKeyframe = z.infer<typeof TransformKeyframe>;

export const Effect = z.object({
  type: z.string(), // e.g. "blur", "lut", "eq", "compressor", "denoise"
  params: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type Effect = z.infer<typeof Effect>;

const ClipBase = z.object({
  id: Id,
  /** Timeline position (seconds). */
  timelineIn: Seconds,
  /** Free-form label shown in the UI. */
  label: z.string().optional(),
  /** Soft-disable without removing. */
  enabled: z.boolean().default(true),
});

export const MediaClip = ClipBase.extend({
  kind: z.literal("media"),
  mediaId: Id,
  /** Source in/out (seconds in the source file). For images, out-in = display duration. */
  sourceIn: Seconds,
  sourceOut: Seconds,
  /** Playback speed. 1 = normal. Duration on timeline = (sourceOut-sourceIn)/speed. */
  speed: z.number().positive().default(1),
  transform: Transform.optional(),
  keyframes: z.array(TransformKeyframe).optional(),
  opacity: z.number().min(0).max(1).default(1),
  /** Linear gain multiplier for the clip's audio. 0 = mute. */
  volume: z.number().min(0).default(1),
  /** Audio fade durations in seconds. */
  audioFadeIn: Seconds.default(0),
  audioFadeOut: Seconds.default(0),
  /** Video fade durations in seconds (fade from/to black or transparent). */
  videoFadeIn: Seconds.default(0),
  videoFadeOut: Seconds.default(0),
  effects: z.array(Effect).default([]),
});
export type MediaClip = z.infer<typeof MediaClip>;

export const CaptionStyle = z.object({
  fontFamily: z.string().default("Inter"),
  fontSize: z.number().positive().default(0.05), // fraction of canvas height
  color: RenderColor.default("#FFFFFF"),
  backgroundColor: RenderColor.optional(), // e.g. "#000000AA"
  outlineColor: RenderColor.optional(),
  outlineWidth: z.number().min(0).default(0),
  /** Vertical position as fraction of canvas height from the top. */
  y: z.number().min(0).max(1).default(0.85),
  align: z.enum(["left", "center", "right"]).default("center"),
  maxWidth: z.number().min(0).max(1).default(0.9),
  uppercase: z.boolean().default(false),
  /** Highlight the currently spoken word (needs word timings). */
  highlightColor: RenderColor.optional(),
});
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const CaptionWord = z.object({
  text: z.string(),
  /** Timeline seconds. */
  start: Seconds,
  end: Seconds,
});

export const CaptionClip = ClipBase.extend({
  kind: z.literal("caption"),
  timelineOut: Seconds,
  text: z.string(),
  /** Optional per-word timings for karaoke-style highlighting. */
  words: z.array(CaptionWord).optional(),
  style: CaptionStyle.partial().optional(),
});
export type CaptionClip = z.infer<typeof CaptionClip>;

/** Solid colour (backgrounds, white cards behind graphics). */
export const ColorClip = ClipBase.extend({
  kind: z.literal("color"),
  timelineOut: Seconds,
  color: RenderColor.default("#000000"),
  transform: Transform.optional(),
  opacity: z.number().min(0).max(1).default(1),
});
export type ColorClip = z.infer<typeof ColorClip>;

export const Clip = z.discriminatedUnion("kind", [MediaClip, CaptionClip, ColorClip]);
export type Clip = z.infer<typeof Clip>;

// ---------------------------------------------------------------------------
// Tracks, markers, timeline
// ---------------------------------------------------------------------------

export const TrackKind = z.enum(["video", "audio", "caption"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z.object({
  id: Id,
  kind: TrackKind,
  name: z.string(),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Clip-level style defaults for caption tracks. */
  captionStyle: CaptionStyle.partial().optional(),
  clips: z.array(Clip).default([]),
});
export type Track = z.infer<typeof Track>;

export const Marker = z.object({
  id: Id,
  time: Seconds,
  /** Optional range marker. */
  end: Seconds.optional(),
  kind: z.enum(["note", "chapter", "todo", "agent"]).default("note"),
  text: z.string(),
  author: z.string().optional(),
  color: z.string().optional(),
  /** Link to a review note. */
  noteId: Id.optional(),
  resolved: z.boolean().default(false),
});
export type Marker = z.infer<typeof Marker>;

export const Timeline = z.object({
  /** Content-addressed version id (assigned by the store; "draft" while unsaved). */
  version: Id,
  parent: Id.nullable().default(null),
  projectId: Id,
  name: z.string().default("Main"),
  tracks: z.array(Track).default([]),
  markers: z.array(Marker).default([]),
  /** Default caption style for the whole timeline. */
  captionStyle: CaptionStyle.partial().optional(),
  /** Background colour under all video tracks. */
  background: RenderColor.default("#000000"),
  createdAt: z.string().datetime().optional(),
});
export type Timeline = z.infer<typeof Timeline>;

export function duplicateClipId(tracks: Track[]): string | undefined {
  const seen = new Set<string>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (seen.has(clip.id)) return clip.id;
      seen.add(clip.id);
    }
  }
}

/** Validate new writes while keeping historical versions readable. */
export const WritableTimeline = Timeline.superRefine((timeline, ctx) => {
  const issue = timelinePlanningIssue(timeline);
  if (issue) ctx.addIssue({ code: "custom", path: ["tracks"], message: issue });
  const duplicate = duplicateClipId(timeline.tracks);
  if (duplicate !== undefined) {
    ctx.addIssue({ code: "custom", path: ["tracks"], message: `duplicate clip id: ${duplicate}` });
  }
});

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const AspectPreset = z.enum(["16:9", "9:16", "1:1", "4:5", "custom"]);

export const ProjectSettings = z.object({
  fps: z.number().positive().default(30),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  aspect: AspectPreset.default("16:9"),
  sampleRate: z.number().int().positive().default(48000),
  audioChannels: z.number().int().min(1).max(2).default(2),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const Project = z.object({
  /** Last conversation revision filed by the editor, independently of the timeline head. */
  completedThreads: z.record(z.string()).optional(),
  mediaPaused: z.boolean().optional(),
  id: Id,
  archived: z.boolean().optional(),
  branch: z.string().optional(),
  name: z.string(),
  settings: ProjectSettings,
  media: z.array(MediaAsset).default([]),
  /** Version id of the current (head) timeline. */
  head: Id.nullable().default(null),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export const TranscriptWord = z.object({
  /** Recording-local voice number established from the audio. */
  detectedSpeaker: z.number().int().positive().optional(),
  /** Input behind a speaker-role annotation in a saved transcript revision. */
  voiceRoleInput: z.number().int().min(1).max(3).optional(),
  /** Attribution to an isolated input stream, separate from speaker identity. */
  audioSource: z.string().optional(),
  text: z.string(),
  start: Seconds,
  end: Seconds,
  confidence: z.number().min(0).max(1).optional(),
  speaker: z.string().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const TranscriptSegment = z.object({
  id: Id,
  start: Seconds,
  end: Seconds,
  text: z.string(),
  speaker: z.string().optional(),
  words: z.array(TranscriptWord).default([]),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const LocalTranscriptionModel = z.enum(["crisperwhisper", "whispercpp", "custom"]);
export type LocalTranscriptionModel = z.infer<typeof LocalTranscriptionModel>;

export const Transcript = z.object({
  speakerAnalysis: z.object({ version: z.number().int().positive(), count: z.number().int().nonnegative() }).optional(),
  /**
   * Present while word alignment is still under way. Words that end before `through` (source seconds) are placed on
   * the recorded audio and won't move; later words keep the provider's estimates, which can be a few hundred
   * milliseconds off. Word order and indices never change. Absent once every time is final.
   */
  aligning: z.object({ through: Seconds }).optional(),
  id: Id,
  mediaId: Id,
  language: z.string().optional(),
  provider: z.string().optional(),
  /** Actual local model that produced the words, including when the selected preset used its fallback. */
  localModel: LocalTranscriptionModel.optional(),
  /** Model or adapter recorded when these words were transcribed, retained on speaker revisions. */
  modelLabel: z.string().optional(),
  segments: z.array(TranscriptSegment).default([]),
  createdAt: z.string().datetime().optional(),
});
export type Transcript = z.infer<typeof Transcript>;

// ---------------------------------------------------------------------------
// Changes and notes (review loop)
// ---------------------------------------------------------------------------

export const Author = z.object({
  type: z.enum(["human", "agent", "scarlet"]),
  /** User id or agent name. */
  id: z.string().optional(),
  name: z.string(),
  model: z.string().optional(),
});
export type Author = z.infer<typeof Author>;

export const ChangeState = z.enum([
  "proposed", // diff accepted, render queued
  "rendering",
  "ready", // clip rendered, awaiting review
  "approved", // committed to head
  "rejected",
  "revising", // reviewer sent it back with a note
  "failed",
]);
export type ChangeState = z.infer<typeof ChangeState>;

export const EditIntent = z.enum(["requested", "suggestion", "alternative"]);

export const CutAssessment = z.object({
  index: z.number().int().nonnegative(), start: Seconds, end: Seconds,
  verdict: z.enum(["cut", "keep", "ask"]), reason: z.string().trim().min(1).max(800),
  /** Set by the agent host after inspecting this exact range and version. */
  inspected: z.boolean().optional(),
  /** A fallback note carried onto a staged cut that the pass still has to check. */
  provisional: z.literal(true).optional(),
  /** Set by the engine on a cut the editor sent back, once revised: it waits for their call whatever the recommendation. */
  revised: z.boolean().optional(),
  /**
   * Set by the engine on a cut Scarlet asks the editor about: the order its pass's asks reached them in, from 1. The
   * editor's number for the call goes by it, so a later ask, earlier in the video, doesn't renumber the calls they've
   * seen. It goes with the note onto a later part.
   */
  askOrder: z.number().int().positive().optional(),
});
export type CutAssessment = z.infer<typeof CutAssessment>;

export function isPublishedCall(assessment: CutAssessment): boolean {
  return assessment.verdict === "ask" && !assessment.provisional;
}

/** cut removes the staged range; keep leaves its footage in. Range is the cut's original range, as on its assessment. */
export const CutChoice = z.object({
  index: z.number().int().nonnegative(), start: Seconds, end: Seconds, choice: z.enum(["cut", "keep"]),
});
export type CutChoice = z.infer<typeof CutChoice>;

export const JoinFades = z.object({
  /** Total overlap in seconds. A join with a different recorded overlap carries its own duration. */
  duration: Seconds,
  fades: z.array(z.object({ at: Seconds, trackId: Id, duration: Seconds.optional() })),
  plain: z.array(z.object({ at: Seconds, reason: z.string() })).default([]),
});
export type JoinFades = z.infer<typeof JoinFades>;

export const Change = z.object({
  intent: EditIntent.optional(),
  autoApplied: z.boolean().optional(),
  revertsVersion: Id.optional(),
  id: Id,
  projectId: Id,
  /** Version this change was proposed against. */
  fromVersion: Id,
  /** Version produced by applying the change. */
  toVersion: Id,
  firstCut: z.boolean().optional(),
  description: z.string(),
  author: Author,
  /** Editorial reasons on the pre-proposal timeline. Adjacent removals can share one review item. */
  cutReasons: z.array(z.object({ start: Seconds, end: Seconds, reason: z.string(), originalRange: TimeRange.optional(),
    /** Requested overlap in seconds at submission time. Older changes have one duration in joinFades. */
    crossfade: Seconds.optional(),
    /** An unassessed cut staged under the retired Suggest setting still needs the editor if recommended. */
    legacySuggest: z.literal(true).optional(),
    kind: z.enum(["pause", "filler", "retake", "coaching"]).optional() })).optional(),
  /** Second-pass recommendations on the immutable chronological cut-review plan. */
  cutAssessments: z.array(CutAssessment).optional(),
  /** A call rechecked against newer footage. Its index still identifies the same call in the original pass. */
  cutEdits: z.array(z.object({ index: z.number().int().nonnegative(), version: Id, range: TimeRange, previewVersion: Id.optional() })).optional(),
  /** The editor's calls on staged cuts, saved as they make them so a reload or the pass's next part keeps them. */
  cutChoices: z.array(CutChoice).optional(),
  /** Apply the editor's calls as soon as the pass that staged them finishes. */
  applyWhenDone: z.object({ userId: Id, at: z.string().datetime() }).optional(),
  /** First decision's proposed playback. Its render completion and the task creation time measure brief-to-playable latency. */
  firstDecisionPreview: z.object({ index: z.number().int().nonnegative(), renderId: Id, queuedAt: z.string().datetime(),
    briefToPlayableMs: z.number().nonnegative().optional() }).optional(),
  /** Note(s) this change responds to. */
  noteIds: z.array(Id).default([]),
  /** Named, individually playable edits on toVersion. Overlapping edits keep distinct identities. */
  timelineEdits: z.array(z.object({ label: z.string().trim().min(1).max(180), range: TimeRange,
    /** Why the editor should look or listen before keeping this edit. */
    check: z.string().trim().min(1).max(120).optional(),
    /** One sentence on what the edit did, side effects included. The edit's card shows this and nothing else. */
    summary: z.string().trim().min(1).max(SUMMARY_MAX).optional(), replaces: z.object({ changeId: Id, spot: z.number().int().nonnegative() }).optional() })).optional(),
  /** Timeline ranges affected by the change (merged, with handles applied by the renderer). */
  ranges: z.array(TimeRange).default([]),
  state: ChangeState.default("proposed"),
  /** Proposal to return to when this revision and its siblings finish without a replacement. */
  revisionFrom: z.object({ state: ChangeState, error: z.string().optional(), taskId: Id }).optional(),
  /** Render ids for the before/after clips, keyed by range index. */
  renders: z
    .array(
      z.object({
        range: TimeRange,
        /** Present on on-demand previews. Each side uses its own version's timeline coordinates. */
        beforeRange: TimeRange.optional(),
        before: Id.nullable().default(null),
        after: Id.nullable().default(null),
      }),
    )
    .default([]),
  /** Agent task that produced it, if any. */
  taskId: Id.optional(),
  /** The thread (one request and everything that followed) this change belongs to. */
  threadId: Id.optional(),
  /**
   * The edit ops, when the change was proposed as ops (validated as
   * TimelineOp by the engine). Kept so the change can be re-applied onto a cut
   * that moved since, or applied spot by spot.
   */
  ops: z.array(z.record(z.unknown())).optional(),
  /** Whether the visible spots can be approved independently. Absent on older rows. */
  canApproveSpots: z.boolean().optional(),
  /** Verified against this proposal's immutable base, operations and ranges at the given frame rate. */
  spotAssignment: z.object({ fps: z.number().positive(), owners: z.array(z.number().int().nonnegative().nullable()).nullable() }).optional(),
  /** Once approved: the version it produced, and the version it was applied onto. */
  appliedVersion: Id.optional(),
  appliedOnto: Id.optional(),
  /** Actual intervals when a proposal was rebased or only partly applied. */
  appliedWindows: z.array(z.object({ spot: TimeRange, range: TimeRange, beforeRange: TimeRange })).optional(),
  /** Indices into `ranges` that were approved, when only some spots were. */
  approvedSpots: z.array(z.number().int().min(0)).optional(),
  restoredCuts: z.array(z.number().int().min(0)).optional(),
  appliedReview: z.object({
    originalVersion: Id,
    joins: z.array(z.object({ at: Seconds, removed: TimeRange, reviewIndex: z.number().int().nonnegative().optional() })),
    originalDuration: Seconds,
    duration: Seconds,
  }).optional(),
  /**
   * The requested crossfades on the dialogue joins this change made on `toVersion`: the overlap in seconds, each join
   * faded and each join left a straight cut with why. Its ops hold only the removals; undoing an earlier edit replays
   * the removals and then these fades.
   */
  joinFades: JoinFades.optional(),
  /**
   * The footage this change left out as it built `toVersion` from pieces of a recording, read once it was applied:
   * `version` plays `toVersion` with every such stretch back in, and each join is where one came out (`at`, on
   * `toVersion`) and what (`removed`, on `version`). No joins when it was looked for and none was found.
   */
  leftOut: z.object({ version: Id.optional(), joins: z.array(z.object({ at: Seconds, removed: TimeRange })) }).optional(),
  /** The same on `appliedVersion`, when the editor's calls or a moved edit applied other cuts than `toVersion` holds. */
  appliedJoinFades: JoinFades.optional(),
  /** Who approved/rejected and why, once decided. */
  decidedBy: Author.optional(),
  rejectReason: z.string().optional(),
  /** Preserves the review state for Undo rejection, including dismissed render failures. */
  rejectedFrom: ChangeState.optional(),
  /** The later change from the same run that took this one's place, such as the next part of a dialogue pass. */
  replacedBy: Id.optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Change = z.infer<typeof Change>;

export const Note = z.object({
  id: Id,
  projectId: Id,
  /** Version the reviewer was watching. */
  version: Id,
  time: Seconds,
  end: Seconds.optional(),
  /** Clip(s) under the playhead when the note was made. */
  clipIds: z.array(Id).default([]),
  text: z.string(),
  /** Raw transcription if the note was spoken. */
  voiceTranscript: z.string().optional(),
  audioPath: z.string().optional(),
  author: Author,
  /** Agent (and model) the note is assigned to, if any. */
  assignedTo: z.string().optional(),
  /** Change this note is about, when replying to a change clip. */
  changeId: Id.optional(),
  state: z.enum(["open", "in_progress", "resolved", "dismissed"]).default("open"),
  /**
   * What was said back about the note, oldest first: an agent explaining what it did. Kept apart from `text`, which
   * stays the author's own words.
   */
  replies: z.array(z.object({ text: z.string(), author: Author, createdAt: z.string().datetime().optional() })).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Note = z.infer<typeof Note>;
