import { z } from "zod/v3";
import type { TimeRange, TranscriptSegment } from "@scarlet/timeline";

type HeardWord = TimeRange & { text: string };
export interface RepeatOccurrence {
  mediaId: string;
  clipId: string;
  words: HeardWord[];
  before?: HeardWord;
  after?: HeardWord;
}
export interface RepeatEvidence {
  id: string;
  phrase: string;
  first: TimeRange;
  second: TimeRange;
  before: string;
  after: string;
  atJoin: boolean;
  precedingEnd?: number;
  followingStart?: number;
  protected?: "first" | "second";
  occurrences: Partial<Record<"first" | "second", RepeatOccurrence>>;
}
/** A join whose sound, read letter by letter, doesn't match the words the transcript says it plays. */
export interface JoinHearing { at: number; mediaId: string; side: "out" | "in"; issue: "clipped" | "fragment"; heard: string; expected?: string; source: number }
export interface RepeatAuditResult {
  version: string;
  heard: number;
  remaining: number;
  repeats: RepeatEvidence[];
  staged: number;
  nextOffset?: number;
  retakes?: "off";
  unavailable?: { mediaId: string; reason: string }[];
  /** Joins in scope that sound cut through a kept word or play a leftover of a removed one. */
  joins?: JoinHearing[];
}

export const RepeatAuditRequest = z.object({
  version: z.string().min(1), startedAt: z.string().optional(),
  keep: z.array(z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(300) })).max(100).default([]),
  offset: z.number().int().nonnegative().default(0),
});

export const SheetOptions = {
  from: z.number().finite().nonnegative(), to: z.number().finite().positive(),
  count: z.number().int().min(6).max(12).default(9),
  mode: z.enum(["uniform", "scene", "activity"]).default("uniform"),
  focus: z.number().finite().nonnegative().optional().describe("Include frames immediately before and at this time"),
};
export const SheetRequest = z.object({
  ...SheetOptions, mediaId: z.string().min(1).optional(), version: z.string().min(1).optional(),
}).refine(v => !v.mediaId || !v.version, "Choose source mediaId or timeline version")
  .refine(v => v.to > v.from && v.to - v.from <= 120, "Choose a positive window up to 120 seconds")
  .refine(v => v.mode !== "activity" || v.to <= v.from + 12, "Check screen activity in windows up to twelve seconds")
  .refine(v => v.focus === undefined || (v.focus >= v.from && v.focus < v.to), "Focus must be within the window");
/** Up to 24 source windows whose frame-to-frame change is measured without drawing a sheet. */
export const PictureActivityRequest = z.object({
  windows: z.array(z.object({ mediaId: z.string().min(1), from: z.number().finite().nonnegative(), to: z.number().finite().positive() })
    .refine(w => w.to > w.from && w.to - w.from <= 120, "Choose a positive window up to 120 seconds")).min(1).max(24),
});
/** How one source window's picture changes. Times are source seconds; areas are shares of the frame, 0 to 1. */
export interface PictureActivityWindow {
  mediaId: string; from: number; to: number;
  /** Frames that differ from the one before, of about `frames` in the window. */
  changedFrames: number; frames: number;
  largestArea?: number; typicalArea?: number;
  largestAt?: number; lastChangeAt?: number;
}
export const SourceAudioOptions = {
  voice: z.enum(["me", "other voices"]).optional().describe("Audition a confirmed isolated input; omit for the mix."),
  mediaId: z.string().min(1),
  from: z.number().finite().nonnegative(),
  to: z.number().finite().positive(),
};
export interface AcousticFiller extends TimeRange { confidence: number }
export interface DialogueDetections {
  segments: TranscriptSegment[];
  acoustic: AcousticFiller[];
  speechActivity?: TimeRange[];
  /** Stable recording-local speaker numbers, in source seconds. */
  speakerTurns?: Array<TimeRange & { speaker: number }>;
  speakerIssue?: string;
  /** Sound on the confirmed other input can include playback, music or a guest. */
  otherVoiceTurns?: Array<TimeRange & { text: string; meAlsoActive: boolean }>;
  voiceRoleIssue?: string;
}
export const DialogueRangeRequest = z.object(SourceAudioOptions).omit({ voice: true })
  .refine(v => v.to > v.from, "Choose a positive source range");
/** One minute of dialogue and up to 25 seconds of context from the previous page. */
export const AcousticWordsRequest = DialogueRangeRequest.and(z.object({ audioStream: z.number().int().nonnegative().optional() }))
  .refine(v => v.to <= v.from + 85, "Choose up to 85 source seconds");
export const DialogueScanRequest = DialogueRangeRequest.and(z.object({ taskId: z.string().min(1), startedAt: z.string().datetime().optional() }));
export const JOIN_WORD_SECONDS = 8;
export const DialogueWindowRequest = DialogueRangeRequest
  .and(z.object({ taskId: z.string().min(1).optional(), startedAt: z.string().datetime().optional(),
    /** Decode just the speech surviving on one side of a proposed join, in its source clock. */
    keptSide: z.object({ audioStream: z.number().int().nonnegative().optional() }).optional() }))
  .refine(v => !v.keptSide || v.to <= v.from + JOIN_WORD_SECONDS + 1e-6, `A kept-side reading covers up to ${JOIN_WORD_SECONDS} seconds`)
  .refine(v => v.to <= v.from + 60, "Choose up to sixty source seconds");
export const SourceAudioRequest = z.object(SourceAudioOptions)
  .refine(v => v.to > v.from && v.to - v.from <= 8, "Choose a source audio window up to eight seconds");
export const SoundPictureOptions = {
  mediaId: z.string().min(1),
  from: z.number().finite().nonnegative().describe("Start of the passage, source seconds"),
  to: z.number().finite().positive().describe("End of the passage, source seconds, up to 15 s after the start"),
  remove: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() })).max(6).optional()
    .describe("Source ranges inside the passage to take out. The picture then has a second row: the passage as it would play with them out."),
  voice: SourceAudioOptions.voice,
};
export const SoundPictureRequest = z.object({ ...SoundPictureOptions,
  /** The transcript's words in the passage, drawn at their times. */
  words: z.array(z.object({ text: z.string(), start: z.number().finite(), end: z.number().finite() })).max(300).optional() })
  .refine(v => v.to > v.from && v.to - v.from <= 15, "Choose a passage of up to fifteen source seconds");
/** Where each row's sound sits in a sound picture, in pixels, so a position can be turned into a time. */
export interface SoundPictureLayout {
  width: number; height: number; pixelsPerSecond: number;
  rows: Array<{ shows: "recorded" | "cut"; top: number; bottom: number; left: number; right: number; seconds: number }>;
}
export const CutReviewOptions = {
  changeId: z.string().min(1),
  index: z.number().int().nonnegative().default(0).describe("Zero-based chronological cut or changed spot"),
  edge: z.enum(["start", "end"]).default("start").describe("Boundary of a changed span to inspect"),
  handles: z.number().min(0.25).max(3).default(1.5).describe("Seconds either side of the boundary"),
  includeAudio: z.boolean().default(false).describe("Include short WAV auditions when your client can consume audio"),
};
export const InspectionReviewRequest = z.object(CutReviewOptions);
export interface CutEvent extends TimeRange {
  kind: "black" | "freeze" | "level-rise" | "level-drop";
  deltaDb?: number;
}
export interface InspectionWindow {
  label: string;
  clock: "source" | "timeline";
  id: string;
  range: TimeRange;
  focus?: number;
  timestamps: number[];
  changedFrames?: number;
  columns: number;
  jpeg: string;
  events?: CutEvent[];
  wav?: string;
}
export type InspectionResult =
  | { state: "preparing"; renderIds: string[] }
  | { state: "ready"; windows: InspectionWindow[]; index?: number; total?: number; newEvents?: CutEvent[] };
