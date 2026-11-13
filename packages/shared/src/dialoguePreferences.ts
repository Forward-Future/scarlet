import { z } from "zod/v3";

/**
 * The editor's standing preferences for dialogue passes. Scarlet enforces them when a plan is
 * submitted and shows them to the agent; which footage to remove stays the model's judgment.
 */
export const DialogueCutKind = z.enum(["pause", "filler", "retake", "coaching"]);
export type DialogueCutKind = z.infer<typeof DialogueCutKind>;

/** cut: apply confident cuts · suggest: every cut of that kind waits for the editor · off: never remove that kind. */
export const AiCutLevel = z.enum(["cut", "suggest", "off"]);
export type AiCutLevel = z.infer<typeof AiCutLevel>;

/** Air around a cut edge and the threshold and target for an undecided, measured quiet pause in a dialogue plan. */
export const PauseTightness = z.enum(["loose", "natural", "tight"]);
export type PauseTightness = z.infer<typeof PauseTightness>;

export const DialoguePreferences = z.object({
  aiCuts: z.object({
    pause: AiCutLevel.default("cut"),
    filler: AiCutLevel.default("cut"),
    retake: AiCutLevel.default("cut"),
    coaching: AiCutLevel.default("cut"),
  }).default({}),
  pauseTightness: PauseTightness.default("natural"),
  /**
   * A centered audio-only crossfade on each join a dialogue cut makes, in project frames of total overlap; 0 is a
   * straight cut. Scarlet adds it to the joins `dialogue_apply_cuts` applies, to staged cuts' previews and to the cuts
   * the editor approves, from real source handles.
   */
  crossfadeFrames: z.number().int().min(0).max(12).default(2),
});
export type DialoguePreferences = z.infer<typeof DialoguePreferences>;

/** Multiplies the air Scarlet leaves after and before speech at an edge it places. */
export const PAUSE_AIR_SCALE: Record<PauseTightness, number> = { loose: 1.5, natural: 1, tight: 0.6 };

export const DIALOGUE_CUT_KINDS = DialogueCutKind.options;
/** Plural, lowercase, for sentences ("Editor set fillers to Suggest."). */
export const DIALOGUE_CUT_KIND_NOUN: Record<DialogueCutKind, string> = {
  pause: "pauses", filler: "fillers", retake: "retakes", coaching: "production talk",
};
export const AI_CUT_LEVEL_LABEL: Record<AiCutLevel, string> = { cut: "Cut", suggest: "Suggest", off: "Off" };

/** What an editor preference did to one cut of a submitted dialogue plan. */
export interface DialoguePreferenceDecision {
  /** Index into the submitted cuts. */
  index: number;
  kind: DialogueCutKind;
  level: Exclude<AiCutLevel, "cut">;
  /** review: staged for the editor instead of applied · dropped: removed from the plan, so the footage stays. */
  outcome: "review" | "dropped";
  start: number;
  end: number;
}

/**
 * The editor's crossfade on the joins one dialogue submission made: on the applied cuts' version and in the staged
 * cuts' version (what review plays, and what approving them keeps). Scarlet fades each join from real source handles;
 * a join it can't fade stays a straight cut, listed with why.
 */
export interface JoinCrossfades {
  /** The editor's setting: total overlap in project frames. 0: crossfade off, nothing faded. */
  frames: number;
  /** Joins that got the crossfade. */
  faded: number;
  /** Joins left a straight cut. `at` is in seconds on `version`. */
  plain: Array<{ version: string; at: number; reason: string }>;
}

export function preferenceEvidence(d: Pick<DialoguePreferenceDecision, "kind" | "level">): string {
  return `Editor set ${DIALOGUE_CUT_KIND_NOUN[d.kind]} to ${AI_CUT_LEVEL_LABEL[d.level]}` +
    (d.level === "off" ? ", so Scarlet keeps this footage." : ", so the editor decides each one.");
}

/**
 * Apply the editor's levels to a dialogue plan. Off drops the cut; Suggest stages a confident cut for review.
 * A cut without a kind is unclassified and passes unchanged.
 */
export function applyDialoguePreferences<C extends { kind?: DialogueCutKind; review: boolean; start: number; end: number }>(
  cuts: readonly C[], levels: DialoguePreferences["aiCuts"],
): { cuts: Array<C & { index: number }>; decisions: DialoguePreferenceDecision[] } {
  const decisions: DialoguePreferenceDecision[] = [];
  const kept = cuts.flatMap((c, index) => {
    const level = c.kind ? levels[c.kind] : "cut";
    if (!c.kind || level === "cut") return [{ ...c, index }];
    if (level === "off") {
      decisions.push({ index, kind: c.kind, level, outcome: "dropped", start: c.start, end: c.end });
      return [];
    }
    if (!c.review) decisions.push({ index, kind: c.kind, level, outcome: "review", start: c.start, end: c.end });
    return [{ ...c, review: true, index }];
  });
  return { cuts: kept, decisions };
}

/** One compact line for the agent before it plans. */
export function describeDialoguePreferences(p: DialoguePreferences): string {
  const levels = DIALOGUE_CUT_KINDS.map(k => `${DIALOGUE_CUT_KIND_NOUN[k]} ${p.aiCuts[k]}`).join(", ");
  const joins = p.crossfadeFrames ? `Scarlet adds a ${p.crossfadeFrames}-frame audio crossfade` : "straight cuts (crossfade off)";
  return `AI may cut: ${levels}. Pause air: ${p.pauseTightness} (x${PAUSE_AIR_SCALE[p.pauseTightness]}). Joins: ${joins}. ` +
    "suggest = Scarlet stages every cut of that kind for the editor; off = Scarlet drops cuts of that kind. Plan editorially as usual.";
}
