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
/** A plain sentence explaining why an edit was made. */
export const EditReason = z.string().trim().min(1).max(600);

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
  /** The run that added it, set by the engine from the run's own attempt. */
  taskId: Id.optional(),
  createdAt: z.string().datetime().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** The part of a picture in use, as fractions of its width and height. */
export const FrameBox = z.object({
  left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1),
}).refine(b => b.right > b.left && b.bottom > b.top, "right and bottom must be past left and top");
export type FrameBox = z.infer<typeof FrameBox>;

/**
 * Where a picture or clip from outside the project came from, such as an article or a post Scarlet framed as B-roll:
 * the page's address, when it was captured, the page as captured and the part of it in the video.
 */
export const WebSource = z.object({
  url: z.string().trim().max(2048).url().refine(u => /^https?:\/\//i.test(u), "a web address"),
  capturedAt: z.string().datetime().optional(),
  /** The page as captured, an image relative to the project's folder. */
  capture: z.string().optional(),
  /** The part of the capture in the video. */
  region: FrameBox.optional(),
});
export type WebSource = z.infer<typeof WebSource>;

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
  /** Where it came from on the web, shown on the card of the edit that uses it. */
  source: WebSource.optional(),
  /** A graphic Scarlet drew from a web page: the page it keeps, so a later request can revise it. */
  graphic: z.object({
    /** The page, relative to the project's folder. Files it links to sit beside it. */
    source: z.string(),
    /** Earlier builds filled graphics from saved templates. Kept so those projects still open. */
    templateId: Id.optional(),
    fields: z.record(z.string()).optional(),
  }).optional(),
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

/**
 * How the picture moves from the clip before to this one, centred on the join between them. A dip passes through a
 * colour; the others play the incoming picture over the outgoing one, using the footage either side of the join,
 * so with little footage to spare they run shorter (the render reports it). Sound is untouched: the join's audio stays
 * as it was.
 */
export const TransitionType = z.enum(["dissolve", "dip", "push", "slide", "whip"]);
export type TransitionType = z.infer<typeof TransitionType>;
export const TransitionDirection = z.enum(["left", "right", "up", "down"]);
export type TransitionDirection = z.infer<typeof TransitionDirection>;
export const Transition = z.object({
  type: TransitionType,
  /** Seconds, centred on the join. */
  duration: z.number().positive().max(10),
  /** push, slide and whip: the way the picture travels ("left" brings the next picture in from the right). */
  direction: TransitionDirection.default("left"),
  /** dip: the colour it passes through (default black). */
  color: RenderColor.optional(),
  /** Earlier builds named the saved template a transition came from. Kept so those timelines still open. */
  template: z.string().max(64).optional(),
});
export type Transition = z.infer<typeof Transition>;

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
  /** The transition into this clip from the one before it on its track. Absent: a straight cut. */
  transitionIn: Transition.optional(),
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

/**
 * The style guide the editor gave this project, one per project. Scarlet reads it as written and follows it for every
 * graphic it makes here. `text` is what the editor pasted; `file` is a file they attached, under the project's folder.
 */
export const StyleGuide = z.object({
  /** How the chat and the $ list name it: the file's name, or the guide's own title for pasted text. */
  name: z.string().min(1).max(200),
  text: z.string().max(200_000).optional(),
  /** Path relative to the project's folder. */
  file: z.string().max(1024).optional(),
  savedAt: z.string().datetime(),
});
export type StyleGuide = z.infer<typeof StyleGuide>;

export const Project = z.object({
  /** Orders saved project metadata independently of the timeline head and the displayed Last edited time. */
  rowRevision: z.number().int().nonnegative().optional(),
  /** Last conversation revision filed by the editor, independently of the timeline head. */
  completedThreads: z.record(z.string()).optional(),
  mediaPaused: z.boolean().optional(),
  /** The editor stopped project edits and must release the queue before any more start. */
  editingPaused: z.boolean().optional(),
  id: Id,
  archived: z.boolean().optional(),
  branch: z.string().optional(),
  name: z.string(),
  settings: ProjectSettings,
  media: z.array(MediaAsset).default([]),
  /** Version id of the current (head) timeline. */
  head: Id.nullable().default(null),
  styleGuide: StyleGuide.optional(),
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
  /** The version of the aligner that placed these word times. Absent on a transcript aligned before versions were kept. */
  alignment: z.number().int().positive().optional(),
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
  /** Short account of the proposed cut for the chat row. */
  summary: z.string().trim().min(1).max(SUMMARY_MAX).optional(),
  /** Set by the agent host after inspecting this exact range and version. */
  inspected: z.boolean().optional(),
  /** A fallback note carried onto a staged cut that the pass still has to check. */
  provisional: z.literal(true).optional(),
  /** Set by the engine on a cut the editor sent back, once revised: it waits for their call whatever the recommendation. */
  revised: z.boolean().optional(),
  /**
   * Set by the engine on a cut the editor sent back whose revision leaves its footage in. It waits for their call all
   * the same: Approve takes the revision and keeps the footage, Skip leaves the revision out and cuts as first staged.
   */
  proposes: z.literal("keep").optional(),
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
  /** Editorial reason for the change as a whole or a change without named edits. */
  reason: EditReason.optional(),
  author: Author,
  /** Editorial reasons on the pre-proposal timeline. Adjacent removals can share one review item. */
  cutReasons: z.array(z.object({ start: Seconds, end: Seconds, reason: z.string(), summary: CutAssessment.shape.summary, originalRange: TimeRange.optional(),
    /** Requested overlap in seconds at submission time. Older changes have one duration in joinFades. */
    crossfade: Seconds.optional(),
    /** An unassessed cut staged under the retired Suggest setting still needs the editor if recommended. */
    legacySuggest: z.literal(true).optional(),
    kind: z.enum(["pause", "filler", "retake", "coaching"]).optional(),
    /** Why the editor should look or listen before keeping this applied cut. */
    check: z.string().trim().min(1).max(120).optional(),
    /** Why Scarlet held this cut for a closer look: what it measured at the edges. For the agent; the editor reads `reason`. */
    held: z.string().optional(),
    /** Nothing Scarlet measures can settle this cut's join, so it waits for the editor to hear it and no later cut replaces it. */
    unheard: z.literal(true).optional() })).optional(),
  /** Second-pass recommendations on the immutable chronological cut-review plan. */
  cutAssessments: z.array(CutAssessment).optional(),
  /** A call rechecked against newer footage. Its index still identifies the same call in the original pass. */
  cutEdits: z.array(z.object({ index: z.number().int().nonnegative(), version: Id, range: TimeRange, previewVersion: Id.optional() })).optional(),
  /** The editor's calls on staged cuts, saved as they make them so a reload or the pass's next part keeps them. */
  cutChoices: z.array(CutChoice).optional(),
  /** Apply the editor's calls as soon as the pass that staged them finishes. */
  applyWhenDone: z.object({ userId: Id, at: z.string().datetime() }).optional(),
  /** This pass has published calls while its run is checking cuts. It can apply after the run finishes even if media preparation was paused. */
  assessedForReview: z.literal(true).optional(),
  /** First decision’s self-contained review movie. Its completion and the task creation time measure brief-to-playable latency. */
  firstDecisionPreview: z.object({ index: z.number().int().nonnegative(), renderId: Id, queuedAt: z.string().datetime(),
    briefToPlayableMs: z.number().nonnegative().optional() }).optional(),
  /** Note(s) this change responds to. */
  noteIds: z.array(Id).default([]),
  /** The editor rejected the edits this change's own `replaces`: it put back what they changed, and nothing else. */
  rejects: z.literal(true).optional(),
  /** Named, individually playable edits on toVersion. Overlapping edits keep distinct identities. */
  timelineEdits: z.array(z.object({ label: z.string().trim().min(1).max(180), range: TimeRange,
    /** Editorial reason shown on the edit's card. Optional for earlier edits. */
    reason: EditReason.optional(),
    /** Why the editor should look or listen before keeping this edit. */
    check: z.string().trim().min(1).max(120).optional(),
    /** Short sentence in the chat on what the edit did, including notable side effects. */
    summary: z.string().trim().min(1).max(SUMMARY_MAX).optional(), replaces: z.object({ changeId: Id, spot: z.number().int().nonnegative() }).optional() })).optional(),
  /**
   * Doubts a later request raised about this change's edits once they were in the video: the edit (`spot`, as its
   * request lists it), the few words the editor reads and the run that raised it. That request lists the edit as one
   * that needs the editor until they keep it there.
   */
  flags: z.array(z.object({ spot: z.number().int().nonnegative(), check: z.string().trim().min(1).max(120), taskId: Id,
    at: z.string().datetime(),
    /** The passage the editor should inspect, in the clock of the version where it was checked. */
    location: z.object({ version: Id, range: TimeRange }).optional() })).optional(),
  /**
   * Edits of this change the editor kept (`spot`, as the request in `threadId` lists it), with the name and reason to
   * look they read then and where the edit was on the video. A run hears of them, so a doubt the editor has settled
   * isn't raised again (2026-11-16: a pass flagged a hold the editor had kept in each of its next two saves). `recheck`
   * is the later doubt (`flags`) the Keep settles.
   */
  kept: z.array(z.object({ spot: z.number().int().nonnegative(), threadId: Id, at: z.string().datetime(), recheck: z.string().optional(),
    label: z.string().max(180).optional(), check: z.string().max(120).optional(),
    place: z.object({ version: Id, range: TimeRange }).optional() })).optional(),
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
    joins: z.array(z.object({ at: Seconds, removed: TimeRange, reviewIndex: z.number().int().nonnegative().optional(),
      /** Join position on the proposal, for matching its named note after review moves the join. */
      proposedAt: Seconds.optional() })),
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
   * `toVersion`) and what (`removed`, on `version`). No joins when it was looked for and none was found. `reading` is
   * the reading that found the joins (`LEFT_OUT_READING`): one found by an earlier reading is read again as Scarlet starts.
   */
  leftOut: z.object({ version: Id.optional(), joins: z.array(z.object({ at: Seconds, removed: TimeRange })), reading: z.number().int().optional() }).optional(),
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
