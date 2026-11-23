/** Clips, tracks, markers and the timeline that holds them. */
import { z } from "zod/v3";
import { timelinePlanningIssue } from "./time.js";
import { Id, RenderColor, Seconds } from "./schemaBase.js";
import { AudioTrackSelection } from "./mediaSchema.js";

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

/**
 * A clip's level at `time` (seconds from the clip's start, as a transform keyframe's): `db` on top of its `volume`.
 * Before the first the level is the first's, after the last the last's; between two it moves in dB as the earlier's
 * ease says.
 */
export const VolumeKeyframe = z.object({
  time: z.number().finite(),
  db: z.number().min(-96).max(24),
  ease: TransformKeyframe.shape.ease,
});
export type VolumeKeyframe = z.infer<typeof VolumeKeyframe>;

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
  /** The level moving over the clip, such as music dipping under speech. */
  volumeKeyframes: z.array(VolumeKeyframe).optional(),
  /** Audio fade durations in seconds. */
  audioFadeIn: Seconds.default(0),
  audioFadeOut: Seconds.default(0),
  /** Optional per-clip audio stream override (`0..N-1` or `"all"`). Absent inherits the asset's `audioTrack` (default `0`). */
  audioTrack: AudioTrackSelection.optional(),
  /** Video fade durations in seconds (fade from/to black or transparent). */
  videoFadeIn: Seconds.default(0),
  videoFadeOut: Seconds.default(0),
  effects: z.array(Effect).default([]),
  /** The transition into this clip from the one before it on its track. Absent: a straight cut. */
  transitionIn: Transition.optional(),
  /**
   * A split edit at this sound's ends: `leads`, the seconds it starts before the picture it belongs to cuts in (a J
   * cut); `trails`, the seconds it carries on after that picture has cut away (an L cut). Set on the sound a split
   * moved, which plays on an audio track apart from its silent picture (`splitJoinOps`). It only says what the edit
   * did: the clip's own times are what play. Absent: its sound cuts with its picture.
   */
  splitEdit: z.object({ leads: Seconds.optional(), trails: Seconds.optional() }).optional(),
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
