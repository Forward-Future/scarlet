import { z } from "zod/v3";
import { Author, Id } from "@scarlet/timeline";
import { RunChoice } from "./agents.js";

/**
 * A standing rule Scarlet picked up from a request, for one of the editor's skills. It changes nothing until the
 * editor approves it; approving it has an agent work it into the skill.
 */
export const LearningState = z.enum(["suggested", "saving", "saved", "declined"]);
export type LearningState = z.infer<typeof LearningState>;
const LearningRule = z.string().trim().min(1).max(280).regex(/^[^\r\n]+$/);
/** What a skill already says that a rule would change, quoted from it. */
const LearningReplaces = z.array(z.string().trim().min(1).max(600)).max(6);
/**
 * One of the editor's decisions a rule was learned from, as it was when the rule was offered: Keep or Reject on a cut
 * or edit Scarlet made (a call of a pass included), or a revision they asked of one. `id` is the one the check cited.
 * `ref` and `threadId` open the cut or edit it was about, where it is still listed; `time` is where it was then.
 */
export const LearningDecision = z.object({
  id: z.string().min(1).max(200),
  decision: z.enum(["kept", "rejected", "revised"]),
  /** The cut or edit's short summary. */
  label: z.string(),
  projectId: Id,
  threadId: Id.optional(),
  ref: z.object({ changeId: Id, spot: z.number().int().nonnegative() }).optional(),
  time: z.number().nonnegative().optional(),
  /** What the editor said with a revision. */
  note: z.string().optional(),
});
export type LearningDecision = z.infer<typeof LearningDecision>;
export const Learning = z.object({
  id: Id,
  projectId: Id,
  /** The rule in one sentence, as it would read in the skill. */
  rule: LearningRule,
  /** What the editor said in the request it came from. */
  said: z.string(),
  /** The request it came from. */
  taskId: Id,
  /**
   * When the rule came from what the editor decided rather than what they said: the decisions, and what they were in
   * the check's words as they read after their count ("cuts you rejected").
   */
  learnedFrom: z.object({ what: z.string().min(1), decisions: z.array(LearningDecision).min(1) }).optional(),
  /** The skill it would go into: the agent's pick, or the editor's once they chose another. */
  skillId: Id,
  /**
   * What that skill already says that the rule contradicts or overrides, quoted from it word for word. The editor
   * sees it beside the rule before deciding, and approving the rule chooses it over these. Only for the skill the
   * rule was offered for: approved for another, it is dropped.
   */
  // A later approval can cover additional passages quoted to the editor after the original offer.
  replaces: z.array(z.string().min(1)).optional(),
  state: LearningState,
  /** Who approved it. The skill edit that saves it runs in their name. */
  approvedBy: Author.optional(),
  /** The model chosen when it was approved. The skill edit that saves it runs on it. */
  runWith: RunChoice.optional(),
  /** The skill edit saving it, once one has started. */
  editTaskId: Id.optional(),
  /** Why the last attempt to save it changed nothing. */
  error: z.string().optional(),
  /** Why the save before this approval changed nothing, which the editor read before approving again. */
  approvedAfter: z.string().optional(),
  createdAt: z.string().datetime().optional(),
});
export type Learning = z.infer<typeof Learning>;

/**
 * A rule an agent offers from the request it is working on, the skill it belongs in, by id or exact name, and what
 * that skill already says that the rule would change.
 */
const LearningFrom = z.object({
  decisions: z.array(z.string().trim().min(1).max(200)).min(1).max(40),
  what: z.string().trim().min(1).max(60).regex(/^[^\r\n]+$/),
});
export const SuggestLearningRequest = z.object({ rule: LearningRule, skill: z.string().trim().min(1).max(200), replaces: LearningReplaces.optional(),
  from: LearningFrom.optional() });
export type SuggestLearningRequest = z.infer<typeof SuggestLearningRequest>;
/** The editor's approval, with the skill they chose when it isn't the suggested one, and the model chosen now. */
export const ApproveLearningRequest = RunChoice.extend({ skillId: Id.optional() });
export type ApproveLearningRequest = z.infer<typeof ApproveLearningRequest>;
/** The editor's own wording for a rule that waits on them. It is saved to the skill as they wrote it. */
export const ReviseLearningRequest = z.object({ rule: LearningRule });
export type ReviseLearningRequest = z.infer<typeof ReviseLearningRequest>;
