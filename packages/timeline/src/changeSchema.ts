/** Changes proposed to a timeline and notes on it: the review loop. */
import { z } from "zod/v3";
import { Id, Seconds, TimeRange } from "./schemaBase.js";

/**
 * The longest summary of an edit that is accepted. Agents are asked for one sentence, and the edit's card folds a
 * long one. The limit used to be 240: a proposal whose summaries ran over was refused whole, and writing its
 * timeline out again took the agent a minute and a half.
 */
export const SUMMARY_MAX = 600;
/** A plain sentence explaining why an edit was made. */
export const EditReason = z.string().trim().min(1).max(600);

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
   * editor never sees it (a call goes by its time), but it keeps the calls' order steady when a later ask lands earlier
   * in the video. It goes with the note onto a later part.
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
    /** Scarlet placed this staged cut on a same-word join, which nothing it measures can settle. Kept for stored passes; since 2026-11-21 it changes nothing about the review. */
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
  /**
   * The model the request handed this work to, as a kind of work the editor gave it in Task models: the hand-off run
   * that saved it, the kind of work by the editor's name for it, and the model. `taskId` stays the request's.
   */
  handedOff: z.object({ taskId: Id, name: z.string().max(40), agent: z.string(), model: z.string().optional() }).optional(),
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
