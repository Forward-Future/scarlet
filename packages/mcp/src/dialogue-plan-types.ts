/** The plan dialogue_apply_cuts makes of a batch (dialogue-plan.ts), and what its phases pass each other. */
import type { DialogueCutKind, Task } from "@scarlet/shared";
import type { TimeRange, Timeline } from "@scarlet/timeline";
import type { DialogueCutInput } from "./dialogue-cut-resolve.js";
import type { JoinPace } from "./dialogue-join.js";
import type { QuietKeptWord } from "./quiet-kept-word.js";

export type ResolvedCut = Omit<DialogueCutInput, "mediaId" | "fromWord" | "toWord" | "afterWord" | "leave"> & {
  start: number;
  end: number;
  /** Index of the range in the submitted list. */
  input: number;
  words?: string;
  wordEdgeProblems?: string[];
  /** Edges Scarlet placed at a dip in the level between two words that run together. */
  wordEdgeDips?: string[];
  /** A breath Scarlet measured after the last kept word, and which side of it the cut starts (`breath`). */
  wordEdgeBreath?: string;
  /** What Scarlet measured in the range that the agent's words for it do not say. */
  notes?: string[];
  /** Where a word reference's words play. Its edges were placed by Scarlet in the silence beyond them. */
  spoken?: TimeRange;
  /** Other word ranges that leave the same words playing and found measured quiet at both edges. */
  cleanAlternatives?: Array<{ fromWord: number; toWord: number }>;
  /** The room tone a range in seconds asked its join to leave, with `leave` or `voiceIn`. */
  air?: JoinPace;
};
/** One cut as sent to the engine (DialogueCutsRequest). */
export interface PlannedDecision extends TimeRange {
  reason: string;
  summary?: string;
  review: boolean;
  kind: DialogueCutKind;
  originalRange: TimeRange | undefined;
  /** Marks an applied cut as needing the editor until they keep it. */
  check?: string;
  /** Why Scarlet held a cut the agent sent to apply: what it measured at the edges. The agent's reason stays its own. */
  held?: string;
  /** Staged where Scarlet placed a same-word join, which nothing it measures can settle. A record only: the engine treats it as any staged cut. */
  unheard?: true;
  /** Held for how its join measured, applied as placed only because the agent sent unsureJoins cut. */
  appliedAsPlaced?: true;
}
export type GateLine = Record<string, unknown> & { cut: number };

export type DialoguePlan =
  | { outcome: "preserved"; kept?: TimeRange[] }
  | { outcome: "needsRevision"; disputedEdges: Array<Partial<TimeRange> & { reason: string; quietKeptWord?: QuietKeptWord;
      /** The submitted cuts, by index, whose edges make this dispute: set them aside and the rest can be planned. */
      cuts: number[] }> }
  | { outcome: "ready"; removals: ResolvedCut[]; decisions: PlannedDecision[]; gate: Map<number, GateLine>;
      /** Ranges the plan keeps on purpose, in timeline seconds: keep decisions, however they were given, and protected pictures. */
      kept: TimeRange[];
      unreadJoinAudio?: Array<{ cut: number; reasons: string[] }> };

export interface DialoguePlanRequest {
  tl: Timeline;
  cuts: DialogueCutInput[];
  /** What the calling tool accepts to resolve a repeated phrase, when it takes keeps instead of removals. */
  repeatHint?: string;
  range?: TimeRange;
  only?: DialogueCutKind;
  /** The local-pauses operation (its built-in command): pauses only, in a local passage. */
  localPauses: boolean;
  /** The task's selection, which bounds the plan. */
  anchor?: Task["context"];
  /** Submitted cuts, by index, left out of this plan because their edges were disputed. The rest keep their indices. */
  setAside?: ReadonlySet<number>;
  /**
   * What happens to a cut the model decided when Scarlet can't place its join cleanly: "ask" holds it for the editor
   * with the evidence, "cut" applies it as placed and reports the evidence to the model. Its skill says which.
   */
  unsureJoins?: UnsureJoins;
}
export type UnsureJoins = "ask" | "cut";

export type DisputedEdge = Extract<DialoguePlan, { outcome: "needsRevision" }>["disputedEdges"][number];
