/** Versions, changes and notes: what the review loop sends the engine and gets back. */
import { z } from "zod/v3";
import {
  Author,
  Change,
  CutAssessment,
  EditIntent,
  Id,
  Note,
  Project,
  Seconds,
  TimelineOp,
  TimeRange,
  WritableTimeline,
} from "@scarlet/timeline";
import { ModelTuning } from "./agents.js";
import { MarkedRange, MessageTime, Task } from "./tasks.js";

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
  reason: Change.shape.reason,
  noteIds: z.array(Id).optional(),
  taskId: Id.optional(),
  /** Override author (agent hosts set this to the agent/model that did the work). */
  author: Author.partial().optional(),
  autoApprove: z.boolean().optional(),
  timelineEdits: Change.shape.timelineEdits,
  /** Skip before/after segment renders (e.g. metadata-only changes). */
  skipRender: z.boolean().optional(),
  /** This task's own suggestions or alternatives, still waiting for review, that this change replaces. They leave the review. */
  withdraws: z.array(Id).max(20).optional(),
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
    originalRange: TimeRange.optional(), review: z.boolean(), reason: z.string().min(1), summary: CutAssessment.shape.summary,
    /** Editorial classification, also used to enforce the scope of a local pause edit. */
    kind: DialogueCutKind.optional(),
    /** A doubt the editor must settle by listening or looking. Marks an applied cut as needing them until they keep it. */
    check: z.string().trim().min(1).max(120).optional(),
    /** Why Scarlet held a cut the agent sent to apply: what it measured. Kept apart from the agent's reason. */
    held: z.string().trim().min(1).max(800).optional(),
    /** Scarlet placed this staged cut on a same-word join, which nothing it measures can settle. A record only: since 2026-11-21 it is staged as any held cut is. */
    unheard: z.literal(true).optional(),
    /** Scarlet held this cut for how its join measured, and it applies as placed only because the agent sent it with unsureJoins cut. */
    appliedAsPlaced: z.literal(true).optional() })
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
  summary: CutAssessment.shape.summary,
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

export const ReviseRequest = ModelTuning.extend({
  skillIds: z.array(Id).optional(),
  position: Note.pick({ time: true, end: true, clipIds: true }).extend({ version: Id.optional(), mediaId: Id.optional(), cutIndex: z.number().int().nonnegative().optional(),
    /** A stretch the editor marked on the timeline for this request, besides the cut or edit it is about. */
    markedRange: MarkedRange.optional(),
    /** The frame the editor paused on while writing to this cut or edit. */
    messageTime: MessageTime.optional() }).optional(),
  text: z.string().min(1),
  voiceTranscript: z.string().optional(),
  /** Agent to send the revision to. Defaults to the change's author. */
  assignTo: z.string().optional(),
});
export type ReviseRequest = z.infer<typeof ReviseRequest>;

/** A doubt about an applied edit, with the playback passage to inspect when it is known. */
export const FlagEditRequest = z.object({
  check: z.string().trim().min(1).max(120),
  range: TimeRange.optional(),
  version: Id.optional(),
  changeId: Id.optional(),
  spot: z.number().int().nonnegative().optional(),
  taskId: Id.optional(),
}).refine(b => (b.changeId !== undefined) === (b.spot !== undefined), "changeId and spot go together")
  .refine(b => b.changeId !== undefined || b.range !== undefined, "Give range or changeId with spot")
  .refine(b => b.version === undefined || b.range !== undefined, "Give range with version");
export type FlagEditRequest = z.infer<typeof FlagEditRequest>;

/**
 * Edits the editor kept, by the identity their Keep is recorded under (`reviewRef` when the edit carries a later save's
 * reason to look), with what they read on it. The engine fills the name and reason from the change when not given.
 */
export const KeepEditsRequest = z.object({
  threadId: Id,
  version: Id.optional(),
  edits: z.array(z.object({ changeId: Id, spot: z.number().int().nonnegative(), recheck: z.string().max(64).optional(),
    label: z.string().trim().min(1).optional(), check: z.string().trim().min(1).optional(), range: TimeRange.optional() })).min(1).max(500),
});
export type KeepEditsRequest = z.infer<typeof KeepEditsRequest>;
/** Keeps the editor took back with ⌘Z, named as they were recorded. The edits wait on the editor again. */
export const UnkeepEditsRequest = z.object({
  threadId: Id,
  edits: z.array(z.object({ changeId: Id, spot: z.number().int().nonnegative(), recheck: z.string().max(64).optional() })).min(1).max(500),
});
export type UnkeepEditsRequest = z.infer<typeof UnkeepEditsRequest>;
/** An edit the editor kept, as a run of its request hears of it. */
export interface KeptEdit { changeId: string; spot: number; label: string; check?: string; at: string; place?: { version: string; range: TimeRange } }

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
export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;
