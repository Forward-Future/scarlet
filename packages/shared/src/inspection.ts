import { z } from "zod/v3";
import type { TimeRange, TranscriptSegment } from "@scarlet/timeline";
import type { FragmentEvidence } from "./joinFragments.js";

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
  /**
   * The phrase comes back after other words: `first` is the whole first attempt, the phrase and what followed it
   * (`between`), up to where the phrase starts again; `second` is the phrase as said again.
   */
  restart?: true;
  between?: string;
}
/** A stretch the edit plays with no word in it, on any dialogue recording. Timeline seconds. */
export interface SilenceLeft { id: string; start: number; end: number; seconds: number; mediaId: string;
  /** Where it starts in the recording. */
  source: number; after: string; before: string; atJoin: boolean }
/**
 * A wordless stretch this long that a pass leaves playing is accounted for: cut, or kept for what the viewer sees or
 * hears in it. The default when the check isn't given one; how long a silence may play unremarked is the skill's pace.
 */
export const SILENCE_LEFT_SECONDS = 2;
/** A join whose sound, read letter by letter, doesn't match the words the transcript says it plays. */
export interface JoinHearing { at: number; mediaId: string; side: "out" | "in"; issue: "clipped" | "fragment"; heard: string;
  /** A clipped word: the transcript's word the cut goes through. */
  expected?: string;
  /** A fragment: the kept word beside it, which plays whole, and where it starts (in) or ends (out) in the recording. */
  keptWord?: string; keptWordAt?: number;
  source: number }
/**
 * A join that took words out of a sentence, with what the edit plays either side of it (`FragmentEvidence`). `at` is the
 * join in timeline seconds, `out` and `in` where the removed stretch starts and ends in the recording, and `lastWord`
 * and `firstWord` the transcript's indices of the last word played before it and the first after it.
 */
export interface JoinFragment extends FragmentEvidence { id: string; at: number; mediaId: string; out: number; in: number }
/** How many played joins have a side in a recording whose language can't be read letter by letter, and the timeline seconds they span. */
export interface UnheardJoins { mediaId: string; reason: string; joins: number; from: number; to: number }
export interface RepeatAuditResult {
  version: string;
  /** The version the check named, when the edit had moved on from it and the check read the current one instead. */
  readInsteadOf?: string;
  heard: number;
  remaining: number;
  repeats: RepeatEvidence[];
  /** Wordless stretches still playing that the pass has neither cut nor kept. They count in `remaining`. */
  silences?: SilenceLeft[];
  /**
   * Joins that divide a sentence and that the pass has neither repaired nor kept, 25 from `offset`: a stray word, a
   * sentence cut off, or a join that reads whole. They count in `remaining`.
   */
  fragments?: JoinFragment[];
  staged: number;
  nextOffset?: number;
  unavailable?: { mediaId: string; reason: string }[];
  /** Joins in scope that sound cut through a kept word or play a leftover of a removed one. */
  joins?: JoinHearing[];
  /** Joins in scope with a side that wasn't heard, per recording. */
  unheardJoins?: UnheardJoins[];
  /**
   * What the picture does that the pass has neither changed nor kept: a picture on screen for under a second between
   * two others, or a recording laid over the main picture that is off it while it still shows what it showed. They
   * count in `remaining`.
   */
  pictures?: PictureCheckFinding[];
}

/** A picture finding the closing check lists, read by Scarlet's MCP server on the version checked. */
export const PictureCheckFinding = z.object({ id: z.string().min(1), kind: z.enum(["brief", "offPicture"]),
  from: z.number().finite(), to: z.number().finite() }).passthrough();
export type PictureCheckFinding = z.infer<typeof PictureCheckFinding>;

/** Subtracting two times in seconds can land a hair past an exact limit (16.1 - 8.1 > 8): a window that long still counts. */
const WINDOW_SLACK = 1e-6;

export const RepeatAuditRequest = z.object({
  version: z.string().min(1), startedAt: z.string().optional(),
  keep: z.array(z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(300) })).max(100).default([]),
  offset: z.number().int().nonnegative().default(0),
  silencesFrom: z.number().finite().min(0.3).max(30).default(SILENCE_LEFT_SECONDS),
  /** What the picture does on `version`, read beside the dialogue: the check counts what isn't kept. */
  pictures: z.object({ version: z.string().min(1), findings: z.array(PictureCheckFinding).max(500) }).optional(),
});

export const SheetOptions = {
  from: z.number().finite().nonnegative(), to: z.number().finite().positive(),
  count: z.number().int().min(2).max(12).default(9),
  mode: z.enum(["uniform", "scene", "activity"]).default("uniform"),
  focus: z.number().finite().nonnegative().optional().describe("Include frames immediately before and at this time"),
};
export const SheetRequest = z.object({
  ...SheetOptions, mediaId: z.string().min(1).optional(), version: z.string().min(1).optional(),
}).refine(v => !v.mediaId || !v.version, "Choose source mediaId or timeline version")
  .refine(v => v.to > v.from && v.to - v.from <= 120 + WINDOW_SLACK, "Choose a positive window up to 120 seconds")
  .refine(v => v.mode !== "activity" || v.to <= v.from + 12 + WINDOW_SLACK, "Check screen activity in windows up to twelve seconds")
  .refine(v => v.focus === undefined || (v.focus >= v.from && v.focus < v.to), "Focus must be within the window");
/** Moments of an edit as the viewer would see them: a saved version, or that version with `ops` applied and not saved. */
export const TimelinePicturesRequest = z.object({
  version: z.string().min(1),
  ops: z.array(z.record(z.unknown())).max(2000).optional(),
  times: z.array(z.number().finite().nonnegative()).min(1).max(12),
  width: z.number().int().min(320).max(1280).default(960),
});
/** Up to 24 source windows whose frame-to-frame change is measured without drawing a sheet. */
export const PictureActivityRequest = z.object({
  windows: z.array(z.object({ mediaId: z.string().min(1), from: z.number().finite().nonnegative(), to: z.number().finite().positive() })
    .refine(w => w.to > w.from && w.to - w.from <= 120 + WINDOW_SLACK, "Choose a positive window up to 120 seconds")).min(1).max(24),
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
  /** The requested cached speech frames are unavailable. An empty measured window has no such flag. */
  keptSideUnavailable?: true;
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
  .refine(v => v.to <= v.from + 85 + WINDOW_SLACK, "Choose up to 85 source seconds");
export const DialogueScanRequest = DialogueRangeRequest.and(z.object({ taskId: z.string().min(1), startedAt: z.string().datetime().optional() }));
export const JOIN_WORD_SECONDS = 8;
export const DialogueWindowRequest = DialogueRangeRequest
  .and(z.object({ taskId: z.string().min(1).optional(), startedAt: z.string().datetime().optional(),
    /** Decode just the speech surviving on one side of a proposed join, in its source clock. */
    keptSide: z.object({ audioStream: z.number().int().nonnegative().optional(),
      /** Read only prepared character emissions. Never fall back to transcription. */
      cachedOnly: z.literal(true).optional() }).optional() }))
  .refine(v => !v.keptSide || v.to <= v.from + JOIN_WORD_SECONDS + 1e-6, `A kept-side reading covers up to ${JOIN_WORD_SECONDS} seconds`)
  .refine(v => v.to <= v.from + 60, "Choose up to sixty source seconds");
export const SourceAudioRequest = z.object(SourceAudioOptions)
  .refine(v => v.to > v.from && v.to - v.from <= 8 + WINDOW_SLACK, "Choose a source audio window up to eight seconds");
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
  .refine(v => v.to > v.from && v.to - v.from <= 15 + WINDOW_SLACK, "Choose a passage of up to fifteen source seconds");
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
  /** Something about the picture its reader should know, such as labels Scarlet couldn't draw. */
  note?: string;
}
export type InspectionResult =
  | { state: "preparing"; renderIds: string[] }
  | { state: "ready"; windows: InspectionWindow[]; index?: number; total?: number; newEvents?: CutEvent[] };
