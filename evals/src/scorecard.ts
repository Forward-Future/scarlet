/**
 * The dialogue scorecard: one scored run, or several, boiled down to a percentage for each thing a dialogue cut has
 * to get right, and one overall figure. Every figure is read from what run.ts already measured against the editor's
 * published video (evaluation.json), so a scorecard costs nothing to make: only the passes it reads cost tokens.
 *
 *   tsx evals/src/scorecard.ts <run dir | evaluation.json> [<another>] [--point automatic|recommended] [--labels main,change] [--ledger] [--json]
 *
 * Each path is one side of a comparison: eligible completed trials from its trials.json (or a standalone evaluation.json).
 * A side's figure for a recording is the mean of its trials, and its figure overall is the mean over recordings, so a long video counts once.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { cli, isMain, list, main } from "./args.ts";
import type { Evaluation } from "./evaluate.ts";
import { HALF_SENTENCE_WORDS, LONG_MISSED_WORDS, NOTICED_WORDS, STUTTER_SECONDS, type CutDetail, type Disagreement } from "./cutDetail.ts";
import type { TrialRow } from "./report.ts";
import { loadBoard, loadLedger, runChecks, type Verdict } from "./ledger.ts";
import type { PacingSummary } from "./metrics.ts";
import { checkedPath, fileComponent, readJson } from "./paths.ts";
import { RUBRIC, type Score, type OperatingPoint } from "./score.ts";

const USAGE = `Usage:
  tsx evals/src/scorecard.ts <run dir | evaluation.json> [<another> ...] [--point automatic|recommended] [--labels a,b] [--ledger] [--json]

Each path is one side: eligible completed trials from trials.json under it (or a standalone evaluation.json). Join
several runs into one side with commas, such as one run per recording.
--point selects which playable cut to score: recommended (default, after accepting AI cut picks) or automatic (applied cuts only).
--ledger also runs the free ledger checks on this checkout and adds their pass rate (about a minute, no model tokens).`;

export type FactorGroup = "watchability" | "editorial";

export type FactorId = "noWrongCuts" | "noMissedRetakes" | "noStutter"
  | "cutDecisions" | "takeChoice" | "linesKept" | "sameCuts" | "pausesLeft" | "pausesTrimmed" | "deadAir"
  | "cutCount" | "spaceAtCut" | "nothingLeftIn" | "knownMoments";

export interface Factor {
  id: FactorId;
  group: FactorGroup;
  label: string;
  /** What 100% means, in a sentence the editor can read. */
  means: string;
}

/**
 * Defect rates per 10 minutes of kept cut at which each Watchability factor drops to 50% (`100 * 0.5^(rate / halfLife)`).
 * Scoring craft defects by rate instead of dividing by hundreds of cut edges keeps 15 clipped words from reading as 95%.
 */
export const RATE_HALF_LIFE = {
  noWrongCuts: 3,
  noMissedRetakes: 3,
  noStutter: 2,
} as const;

/**
 * Watchability scores only the craft mistakes an editor's ears confirmed. In a listening check (2026-11-20) 2 of 12
 * mid-word flags were real and 2 of 12 "cut what the editor kept" were, mostly taste, while retakes left in were the
 * real mistakes: mid-word cuts are counted below the card until a better check proves itself by ear, and words the
 * editor kept are Editorial match. Every factor is 0–100 and higher is better. Watchability factors penalize viewer-audible craft bugs by rate per
 * 10 minutes of cut; Editorial match factors measure alignment on the scale of the editor's own cut, never of the
 * raw recording (two passes that left three times the editor's dead air scored 98% against the recording, 2026-11-18).
 */
export const FACTORS: readonly Factor[] = [
  { id: "noMissedRetakes", group: "watchability", label: "No missed retakes", means: `no line plays twice unasked: no run of ${LONG_MISSED_WORDS}+ words left in that the editor cut for another take Scarlet plays too, and Scarlet didn't ask about (50% at ${RATE_HALF_LIFE.noMissedRetakes}/10 min)` },
  { id: "noStutter", group: "watchability", label: "No stutter cuts", means: `no piece under ${STUTTER_SECONDS} s between two cuts (50% at ${RATE_HALF_LIFE.noStutter}/10 min)` },
  { id: "cutDecisions", group: "editorial", label: "Cut decisions", means: "every removal the editor made, Scarlet made, and no others; a removal counts once, long or short" },
  { id: "takeChoice", group: "editorial", label: "Take choice", means: "where a line was said twice, Scarlet kept the take the editor kept, and only that one" },
  { id: "linesKept", group: "editorial", label: "Lines kept", means: "every sentence the editor kept is still in" },
  { id: "noWrongCuts", group: "editorial", label: "Words the editor kept", means: `no run of ${NOTICED_WORDS}+ words cut that the editor kept (50% at ${RATE_HALF_LIFE.noWrongCuts}/10 min)` },
  { id: "sameCuts", group: "editorial", label: "Same cuts", means: "every cut of the editor's that can be told apart, Scarlet made between the same two words" },
  { id: "pausesLeft", group: "editorial", label: "Pauses left alone", means: "every pause the editor left as it was said, Scarlet left too" },
  { id: "pausesTrimmed", group: "editorial", label: "Pauses trimmed", means: "every pause the editor shortened, Scarlet shortened too" },
  { id: "deadAir", group: "editorial", label: "Dead air", means: "as much dead air left as the editor left" },
  { id: "cutCount", group: "editorial", label: "Cut count", means: "as many cuts as the editor made" },
  { id: "spaceAtCut", group: "editorial", label: "Space at a cut", means: "at cuts both made, the pause is within 0.1 s of the editor's" },
  { id: "nothingLeftIn", group: "editorial", label: "No restarts left in", means: "no more restarts or doubled words play than in the editor's cut" },
  { id: "knownMoments", group: "editorial", label: "Known mistakes", means: "every spot that went wrong before comes out right, or is asked about" },
];

export const WATCHABILITY_IDS: readonly FactorId[] = FACTORS.filter(f => f.group === "watchability").map(f => f.id);
export const EDITORIAL_IDS: readonly FactorId[] = FACTORS.filter(f => f.group === "editorial").map(f => f.id);

export interface FactorValue { pct: number | null; detail: string }
export type Factors = Record<FactorId, FactorValue>;

/** A pause at a cut within this of the editor's is the same pause: three frames. */
export const SAME_SPACE_MS = 100;

/** Runs of NOTICED_WORDS or more that a viewer would hear differ: the same words played from another take don't. */
const heard = (runs: readonly Disagreement[]) => runs.filter(x => x.words >= NOTICED_WORDS && !x.otherTake);
/** Runs of NOTICED_WORDS or more where the two cuts kept different sayings of the same words. */
const otherTakes = (d: CutDetail) => [...d.wronglyCut, ...d.leftIn].filter(x => x.words >= NOTICED_WORDS && x.otherTake).length;
/** Long runs left in that play a line twice, apart from those Scarlet asked the editor about. */
const missedRetakes = (d: CutDetail) => d.leftIn.filter(x => x.words >= LONG_MISSED_WORDS && x.retake && !x.asked);

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const none = (detail: string): FactorValue => ({ pct: null, detail });
const pctOf = (n: number, d: number) => r1(100 * n / d);

/** How close two amounts are, as the smaller over the larger: 100 when equal, 50 when one is twice the other, either way round. */
export function ratio(candidate: number, reference: number): number {
  const hi = Math.max(candidate, reference);
  return hi <= 0 ? 100 : clamp(100 * Math.min(candidate, reference) / hi);
}

/**
 * Rate-based craft score: 100 at zero defects, 50 at `halfLifePer10Min` defects per 10 minutes of kept cut,
 * decaying smoothly toward 0 as defects pile up. Returns null when kept duration is zero.
 */
export function rateScore(count: number, keptSeconds: number, halfLifePer10Min: number): number | null {
  if (keptSeconds <= 0 || halfLifePer10Min <= 0) return null;
  const per10 = Math.max(0, count) / (keptSeconds / 600);
  return r1(clamp(100 * Math.pow(0.5, per10 / halfLifePer10Min)));
}

/**
 * The factors of one scored run, read at what the editor gets by accepting Scarlet's own picks on every staged cut.
 * `detail` is the cut read decision by decision against the published video (cutDetail.ts); without the case's words
 * the factors that need it have no figure.
 */
export function factors(score: Score, at: OperatingPoint = "recommended"): Factors {
  const { cut: point, detail, seconds, pacing: left, sharedJoins: shared, moments = [] } = score.playable[at];
  const ref = score.pacing.reference;
  const noReference = none("no published video for this recording");
  const noDetail = ref ? none("the case's words aren't here to read the cut by") : noReference;
  const per10 = (n: number) => seconds > 0 ? r1(n / (seconds / 600)) : null;

  const wrongRuns = detail ? heard(detail.wronglyCut).length : null;
  const noWrongCuts: FactorValue = !detail ? noDetail
    : seconds <= 0 ? none("kept duration not recorded")
      : { pct: rateScore(wrongRuns!, seconds, RATE_HALF_LIFE.noWrongCuts), detail: `${wrongRuns} runs of ${NOTICED_WORDS}+ words cut that the editor kept (${per10(wrongRuns!)}/10 min)` };

  // A long run said only once is content the editor chose to drop, and one the editor played from another take is a
  // swap of takes: neither plays a line twice, so neither counts here.
  // A retake Scarlet staged or flagged reached the editor: it is counted below the card as left for their call.
  const retakeRuns = detail ? missedRetakes(detail).length : null;
  const noMissedRetakes: FactorValue = !detail ? noDetail
    : seconds <= 0 ? none("kept duration not recorded")
      : { pct: rateScore(retakeRuns!, seconds, RATE_HALF_LIFE.noMissedRetakes), detail: `${retakeRuns} runs of ${LONG_MISSED_WORDS}+ words left in that the editor cut for another take (${per10(retakeRuns!)}/10 min)` };

  const pc = detail?.pieces;
  const noStutter: FactorValue = !pc ? noDetail : !pc.total ? none("no cuts")
    : seconds > 0
      ? { pct: rateScore(pc.short, seconds, RATE_HALF_LIFE.noStutter), detail: `${pc.short} of ${pc.total} pieces play for under ${STUTTER_SECONDS} s (${per10(pc.short)}/10 min; editor's cut: ${pc.editorShort} of ${pc.editorTotal})` }
      : { pct: pctOf(pc.total - pc.short, pc.total), detail: `${pc.short} of ${pc.total} pieces play for under ${STUTTER_SECONDS} s (the editor's cut: ${pc.editorShort} of ${pc.editorTotal})` };

  const words = point?.words;
  const d = detail?.decisions;
  let cutDecisions = noDetail;
  if (d && d.editor + d.scarlet > 0) {
    const precision = d.scarlet ? d.scarletMatched / d.scarlet : 0, recall = d.editor ? d.editorMatched / d.editor : 0;
    cutDecisions = {
      pct: r1(precision + recall ? 100 * 2 * precision * recall / (precision + recall) : 0),
      detail: `Scarlet made ${d.editorMatched} of the editor's ${d.editor} removals; ${d.scarletMatched} of Scarlet's ${d.scarlet} the editor made too` +
        (words?.f1 != null ? ` (by words, which flatters: ${Math.round(100 * words.f1)}%)` : ""),
    };
  }

  const t = detail?.takes;
  const takeChoice: FactorValue = !detail ? noDetail : !t!.decided ? none("no line said twice that the editor kept one take of")
    : { pct: pctOf(t!.same, t!.decided), detail: `${t!.same} of ${t!.decided} the same take; ${t!.both} with both left in, ${t!.other} the other take, ${t!.neither} with neither` };

  const lines = point?.requiredLines;
  const linesKept: FactorValue = !lines?.required ? noReference
    : { pct: pctOf(lines.required - lines.missing, lines.required), detail: `${lines.missing} of ${lines.required} lines the editor kept are cut` };

  const sameCuts: FactorValue = !shared?.eligible ? noReference
    : { pct: pctOf(shared.shared, shared.eligible), detail: `${shared.shared} of the editor's ${shared.eligible} cuts that can be told apart` };

  const ps = detail?.pauses;
  const editorLeft = ps ? ps.total - ps.editorTrimmed : 0, overTrimmed = ps ? ps.scarletTrimmed - ps.bothTrimmed : 0;
  const pausesLeft: FactorValue = !ps ? noDetail : !editorLeft ? none("the editor left no pause as it was said")
    : { pct: pctOf(editorLeft - overTrimmed, editorLeft), detail: `Scarlet trimmed ${overTrimmed} of the ${editorLeft} pauses the editor left alone` };
  const pausesTrimmed: FactorValue = !ps ? noDetail : !ps.editorTrimmed ? none("the editor trimmed no pause")
    : { pct: pctOf(ps.bothTrimmed, ps.editorTrimmed), detail: `Scarlet trimmed ${ps.bothTrimmed} of the ${ps.editorTrimmed} pauses the editor trimmed` };

  const deadAir: FactorValue = !ref ? noReference : {
    pct: r1(ratio(left.gaps.excessSeconds, ref.gaps.excessSeconds)),
    detail: `${left.gaps.excessSeconds} s left, the editor left ${ref.gaps.excessSeconds} s`,
  };

  const cutCount: FactorValue = !ref?.joins ? noReference
    : { pct: r1(ratio(left.joins, ref.joins)), detail: `${left.joins} cuts, the editor made ${ref.joins}` };

  const within = shared?.matched.filter(m => Math.abs(m.errorMs) <= SAME_SPACE_MS).length ?? 0;
  const spaceAtCut: FactorValue = !shared?.matched.length ? none(ref ? "no cut in the same place as one of the editor's" : noReference.detail)
    : { pct: pctOf(within, shared.matched.length), detail: `${within} of ${shared.matched.length} cuts both made, median ${shared.medianAbsErrorMs} ms off` };

  const restartCount = (s: PacingSummary) => s.restarts + s.repeats.total;
  const allowed = ref ? restartCount(ref) : 0;
  // One more than the editor's cut plays counts against the editor's own figure, not the recording's.
  const nothingLeftIn: FactorValue = {
    pct: r1(clamp(100 * (allowed + 1) / (Math.max(restartCount(left), allowed) + 1))),
    detail: `${restartCount(left)} restarts and doubled words play${ref ? `, the editor's cut plays ${allowed}` : ""}`,
  };

  const ok = moments.filter(m => m.outcome === "right").length;
  const knownMoments: FactorValue = !moments.length ? none("no known spots in this recording")
    : { pct: pctOf(ok, moments.length), detail: `${ok} of ${moments.length} play the expected words` };

  return {
    noWrongCuts, noMissedRetakes, noStutter,
    cutDecisions, takeChoice, linesKept, sameCuts, pausesLeft, pausesTrimmed, deadAir, cutCount, spaceAtCut, nothingLeftIn, knownMoments,
  };
}

/**
 * Hard viewer-audible mistakes counted across the cut and per 10 minutes, plus short 2–5 word editorial
 * tightenings left in (reported separately so taste diffs don't inflate bug counts).
 */
export interface Mistakes {
  wronglyCut: number;
  /** Runs of LONG_MISSED_WORDS+ left in that the editor cut for another take of them: the line plays twice. */
  longMissed: number;
  /** Runs of LONG_MISSED_WORDS+ left in that the editor cut and that are said only once: content, which is taste. */
  contentLeftIn: number;
  /** Retakes left in that Scarlet staged or flagged for the editor: their call, not a silent miss. */
  askedRetakes: number;
  /** Runs of NOTICED_WORDS+ words where Scarlet and the editor kept different sayings of the same words: not a mistake. */
  otherTake: number;
  /** Counted, not scored until checked by ear: joins that land inside a sounding word, a word doubled at a join, and half a sentence left at one. */
  clippedWords: number;
  doubledAtJoin: number;
  halfSentence: number;
  stutters: number;
  /** Craft mistakes the editor's ears confirmed: longMissed + stutters. */
  total: number;
  per10Min: number | null;
  /** Short runs (NOTICED_WORDS .. LONG_MISSED_WORDS - 1) Scarlet left in that the editor trimmed. */
  styleLeftIn: number;
  stylePer10Min: number | null;
  /** All left-in runs of NOTICED_WORDS+ words a viewer would hear differ (longMissed + askedRetakes + contentLeftIn + styleLeftIn). */
  leftIn: number;
}

/**
 * Craft mistakes are a retake left in (6+ words the editor cut for another delivery Scarlet plays too) and a stutter piece
 * under 1 s. Runs cut that the editor kept are counted as agreement with the editor; joins inside a sounding word, a word
 * doubled at a join and half a sentence left at one are counted until a listening check shows they are mistakes. Long passages the editor
 * cut as content (a sponsor read, a tangent) and short 2–5 word phrases the editor trimmed ("kind of", "And so") are
 * taste, counted separately; single-word edge drift is ignored.
 */
export function mistakes(score: Score, at: OperatingPoint = "recommended"): Mistakes | null {
  const { detail, seconds, edges } = score.playable[at];
  if (!detail || edges.unknown || seconds <= 0) return null;
  const wronglyCut = heard(detail.wronglyCut).length;
  const longMissed = missedRetakes(detail).length;
  const askedRetakes = detail.leftIn.filter(x => x.words >= LONG_MISSED_WORDS && x.retake && x.asked).length;
  // A swap of takes plays the line once either way: Take choice reads it, not these counts.
  const contentLeftIn = heard(detail.leftIn).filter(x => x.words >= LONG_MISSED_WORDS && !x.retake).length;
  const styleLeftIn = heard(detail.leftIn).filter(x => x.words < LONG_MISSED_WORDS).length;
  const clippedWords = edges.clippedOnSound;
  const stutters = detail.pieces.short;
  const doubledAtJoin = detail.joins?.doubled.length ?? 0, halfSentence = detail.joins?.halfSentence.length ?? 0;
  const total = longMissed + stutters;
  return {
    wronglyCut,
    longMissed,
    contentLeftIn,
    askedRetakes,
    otherTake: otherTakes(detail),
    clippedWords,
    doubledAtJoin,
    halfSentence,
    stutters,
    total,
    per10Min: seconds > 0 ? r1(total / (seconds / 600)) : null,
    styleLeftIn,
    stylePer10Min: seconds > 0 ? r1(styleLeftIn / (seconds / 600)) : null,
    leftIn: longMissed + askedRetakes + contentLeftIn + styleLeftIn,
  };
}

/** A figure over passes. `variance` is the passes' sample variance, when there are two or more. */
export interface Stat { mean: number; min: number; max: number; n: number; variance?: number }
type Summary = "overall" | "watchability" | "editorial";
const COUNT_KEYS = ["wronglyCut", "longMissed", "askedRetakes", "contentLeftIn", "clippedWords", "doubledAtJoin", "halfSentence", "stutters", "styleLeftIn", "leftIn", "otherTake"] as const;
type CountKey = (typeof COUNT_KEYS)[number];
export interface Card {
  point: OperatingPoint;
  rubric: typeof RUBRIC;
  label: string;
  trials: number;
  cases: string[];
  /** Content hash of the frozen grading inputs (source, evidence, reference, moments, edgeOptions) per recording. */
  gradingByCase?: Record<string, string>;
  factors: Record<FactorId, Stat | null>;
  /** Mean of the rate-based Watchability (craft) factors this side has. */
  watchability: number | null;
  /** Mean of the Editorial match factors this side has. */
  editorial: number | null;
  /** Geometric mean of Watchability and Editorial match (compare two sides on `overallOf` over common factors). */
  overall: number | null;
  /** Hard craft mistakes in every ten minutes of the cut: lower is better. */
  mistakesPer10Min: Stat | null;
  /** Short 2–5 word editorial tightenings left in per ten minutes: reported separately from hard bugs. */
  stylePer10Min: Stat | null;
  mistakeCounts: Record<CountKey, Stat | null>;
  byCase: Record<string, Record<FactorId, Stat | null>>;
  /** Each recording's passes as Overall, Watchability and Editorial figures: what the ± on those rows is read from. */
  summaryByCase: Record<string, Record<Summary, Stat | null>>;
  /** Each recording's passes' counts below the card, per 10 minutes and in the whole video. */
  countsByCase: Record<string, Record<CountKey | "per10Min" | "stylePer10Min", Stat | null>>;
  /** Not scored: for the editor's eye. */
  facts: { asks: Stat | null; tokens: Stat | null; minutes: Stat | null; finishMinutes: Stat | null; cents: Stat | null;
    steps?: Stat | null; cacheMisses?: Stat | null };
}
export interface Trial { caseId?: string; gradingSha256?: string; score: Score }

export const stat = (values: number[]): Stat | null => {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean: r1(mean), min: Math.min(...values), max: Math.max(...values), n: values.length,
    ...(values.length > 1 && { variance: values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1) }) };
};
const numbers = (values: Array<number | null | undefined>) => values.filter((v): v is number => typeof v === "number");
/** Recordings count equally; the spread is over every trial. */
export const acrossCases = (perCase: Array<Stat | null>): Stat | null => {
  const have = perCase.filter((s): s is Stat => !!s);
  return have.length ? { mean: r1(have.reduce((a, s) => a + s.mean, 0) / have.length), min: Math.min(...have.map(s => s.min)),
    max: Math.max(...have.map(s => s.max)), n: have.reduce((a, s) => a + s.n, 0) } : null;
};

/** One side's card from its scored trials. A trial with no reference still counts toward the factors that need none. */
export function card(label: string, trials: readonly Trial[], at: OperatingPoint = "recommended"): Card {
  const groups = new Map<string, Trial[]>();
  for (const t of trials) groups.set(t.caseId ?? "(no case)", [...(groups.get(t.caseId ?? "(no case)") ?? []), t]);
  const byCase: Card["byCase"] = {};
  const gradingByCase: Record<string, string> = {};
  const countsByCase: Card["countsByCase"] = {};
  const perTrial = new Map<string, Factors[]>();
  for (const [id, ts] of groups) {
    const hashes = new Set(ts.map(t => t.gradingSha256).filter((h): h is string => !!h));
    if (hashes.size > 1 || (hashes.size === 1 && ts.some(t => !t.gradingSha256))) {
      throw new Error(`Trials for ${id} were graded on different frozen inputs.`);
    }
    if (hashes.size === 1) gradingByCase[id] = [...hashes][0]!;
    const fs = ts.map(t => factors(t.score, at));
    perTrial.set(id, fs);
    byCase[id] = Object.fromEntries(FACTORS.map(f => [f.id, fs.every(x => x[f.id].pct !== null) ? stat(numbers(fs.map(x => x[f.id].pct))) : null])) as Record<FactorId, Stat | null>;
    const ms = ts.map(t => mistakes(t.score, at)).filter((m): m is Mistakes => m !== null);
    countsByCase[id] = Object.fromEntries(([...COUNT_KEYS, "per10Min", "stylePer10Min"] as const)
      .map(k => [k, ms.length === ts.length ? stat(numbers(ms.map(m => m[k]))) : null])) as Card["countsByCase"][string];
  }
  const all = Object.fromEntries(FACTORS.map(f => [f.id, acrossCases(Object.values(byCase).map(c => c[f.id]))])) as Record<FactorId, Stat | null>;
  // Each pass's own Overall, Watchability and Editorial figures, over the factors this side has, for the ± on those rows.
  const have = FACTORS.map(f => f.id).filter(id => all[id]);
  const summaryByCase: Card["summaryByCase"] = {};
  for (const [id, fs] of perTrial) {
    const of = (f: Factors) => Object.fromEntries(have.map(k => [k, f[k].pct === null ? null : { mean: f[k].pct, min: f[k].pct, max: f[k].pct, n: 1 }])) as Record<FactorId, Stat | null>;
    const pick = (ids: readonly FactorId[]) => stat(numbers(fs.map(f => overallOf(of(f), ids.filter(k => have.includes(k))))));
    summaryByCase[id] = { overall: pick(FACTORS.map(f => f.id)), watchability: pick(WATCHABILITY_IDS), editorial: pick(EDITORIAL_IDS) };
  }
  const headline = (k: string) => stat(numbers(trials.map(t => t.score.headline[k])));
  // What reached the editor to decide or check: calls, and applied edits the pass flagged.
  const asks = () => stat(numbers(trials.map(t => {
    const calls = t.score.headline.needsYourCall, flags = t.score.headline.flaggedForYou;
    return calls == null && flags == null ? null : (calls ?? 0) + (flags ?? 0);
  })));
  const count = (k: CountKey | "per10Min" | "stylePer10Min") => acrossCases(Object.values(countsByCase).map(m => m[k]));
  const watchability = meanOf(all, WATCHABILITY_IDS);
  const editorial = meanOf(all, EDITORIAL_IDS);
  return {
    label, rubric: RUBRIC, point: at,
    trials: trials.length,
    cases: [...groups.keys()],
    ...(Object.keys(gradingByCase).length && { gradingByCase }),
    factors: all,
    watchability,
    editorial,
    overall: overallOf(all, FACTORS.map(f => f.id)),
    byCase, summaryByCase, countsByCase,
    mistakesPer10Min: count("per10Min"),
    stylePer10Min: count("stylePer10Min"),
    mistakeCounts: Object.fromEntries(COUNT_KEYS.map(k => [k, count(k)])) as Record<CountKey, Stat | null>,
    facts: { asks: asks(), tokens: headline("tokens"), minutes: headline("activeMinutes"), finishMinutes: headline("finishMinutes"),
      // In cents, so the one-decimal mean keeps a cheap pass's cost.
      cents: stat(numbers(trials.map(t => t.score.headline.costUsd)).map(v => v * 100)),
      steps: headline("modelSteps"), cacheMisses: headline("cacheMisses") },
  };
}

const WATCHABILITY_SET = new Set<FactorId>(WATCHABILITY_IDS);

function meanOf(of: Record<FactorId, Stat | null>, ids: readonly FactorId[]): number | null {
  const have = ids.filter(id => of[id]);
  return have.length ? r1(have.reduce((a, id) => a + of[id]!.mean, 0) / have.length) : null;
}

/**
 * Combined score over the named factors: when both Watchability and Editorial match factors are present, returns
 * their geometric mean `sqrt(watchability * editorial)` so severe craft defects cannot hide behind high editorial
 * averages. When only one group is present, returns that group's mean.
 */
export function overallOf(of: Record<FactorId, Stat | null>, ids: readonly FactorId[]): number | null {
  if (ids.some(id => WATCHABILITY_SET.has(id)) && ids.some(id => !WATCHABILITY_SET.has(id)) &&
    (!WATCHABILITY_IDS.every(id => of[id]) || !of.linesKept)) return null;
  const w = meanOf(of, ids.filter(id => WATCHABILITY_SET.has(id)));
  const e = meanOf(of, ids.filter(id => !WATCHABILITY_SET.has(id)));
  if (w !== null && e !== null) return r1(Math.sqrt(w * e));
  return w ?? e;
}

/** The share of the ledger's free checks that pass: the mistakes already reported that the code still gets right. */
export function ledgerPct(results: ReadonlyArray<{ verdict: Verdict }>): { pct: number | null; pass: number; checked: number } {
  const checked = results.filter(r => r.verdict === "pass" || r.verdict === "fail" || r.verdict === "error");
  const pass = checked.filter(r => r.verdict === "pass").length;
  return { pct: checked.length ? r1(100 * pass / checked.length) : null, pass, checked: checked.length };
}

const show = (s: Stat | null) => !s ? "–" : s.n > 1 && s.max - s.min >= 0.1 ? `${s.mean}% (${s.min}–${s.max})` : `${s.mean}%`;

/**
 * The standard error of a side's figure: how far it moves from one set of passes to the next by luck alone. It comes
 * from how much passes of the same recording disagree, pooled over every recording with two passes or more (over
 * `pooledFrom`, both sides' recordings when comparing), and shrinks with the passes each recording has. The recordings
 * themselves don't add to it: both sides cut the same ones, so their differences cancel. Null with one pass a recording.
 */
export function standardError(perCase: ReadonlyArray<Stat | null>, pooledFrom: ReadonlyArray<Stat | null> = perCase): number | null {
  const spread = pooledFrom.filter((x): x is Stat => !!x && x.variance !== undefined);
  const df = spread.reduce((sum, x) => sum + x.n - 1, 0);
  const have = perCase.filter((x): x is Stat => !!x);
  if (!df || !have.length) return null;
  const pooled = spread.reduce((sum, x) => sum + (x.n - 1) * x.variance!, 0) / df;
  return Math.sqrt(have.reduce((sum, x) => sum + pooled / x.n, 0)) / have.length;
}

/** Two standard errors: a figure from the same code lands within this of the last about 95 times in 100. */
const band = (se: number | null) => se === null ? null : r1(2 * se);

/**
 * One side against another on one figure: the change, its ± (luck alone moves a difference this far about one time in
 * twenty), whether it is more than luck, and on how many recordings it went the same way.
 */
export function compareFigure(a: Record<string, Stat | null>, b: Record<string, Stat | null>, delta: number | null, lowerIsBetter = false) {
  if (delta === null) return { text: "–", real: false, band: null as number | null };
  const ids = Object.keys(a).filter(id => a[id] && b[id]);
  const pooled = [...Object.values(a), ...Object.values(b)];
  const sa = standardError(ids.map(id => a[id]!), pooled), sb = standardError(ids.map(id => b[id]!), pooled);
  const width = sa === null || sb === null ? null : band(Math.sqrt(sa ** 2 + sb ** 2));
  const d = r1(delta);
  const real = width !== null && Math.abs(d) > width;
  const up = ids.filter(id => b[id]!.mean - a[id]!.mean > 0.05).length, down = ids.filter(id => b[id]!.mean - a[id]!.mean < -0.05).length;
  const moved = Math.abs(d) < 0.05 ? "same" : real ? `**${d > 0 ? "+" : ""}${d}**` : `${d > 0 ? "+" : ""}${d}`;
  const verdict = width === null ? "no ±" : real ? `±${width}, ${(d < 0) === lowerIsBetter ? "better" : "worse"}` : `±${width}, could be luck`;
  const where = ids.length > 1 && Math.abs(d) >= 0.05 ? ` · ${d > 0 ? `up on ${up}` : `down on ${down}`} of ${ids.length} recordings` : "";
  return { text: `${moved} (${verdict})${where}`, real, band: width };
}

/** The cards as a table: each figure with its ±, and with two sides the change, whether it is more than luck, and on how many recordings it went that way. `details` spells out one trial's figures. */
export function scorecardMarkdown(cards: readonly Card[], ledger?: { label: string; pct: number | null; pass: number; checked: number }, details?: Factors): string {
  const [a, b] = cards, two = cards.length === 2;
  const common = FACTORS.map(f => f.id).filter(id => cards.every(c => c.factors[id]));
  const commonWatch = common.filter(id => WATCHABILITY_SET.has(id));
  const commonEdit = common.filter(id => !WATCHABILITY_SET.has(id));
  if (cards.some(c => c.rubric !== a?.rubric || c.point !== a?.point || [...c.cases].sort().join("\0") !== [...a!.cases].sort().join("\0"))) {
    throw new Error("Compare the same rubric, recordings, and operating point.");
  }
  for (const id of a?.cases ?? []) {
    const hashes = new Set(cards.map(c => c.gradingByCase?.[id]).filter((h): h is string => !!h));
    if (hashes.size > 1 || (hashes.size === 1 && cards.some(c => !c.gradingByCase?.[id]))) {
      throw new Error(`Sides were graded on different frozen inputs for ${id}.`);
    }
  }
  const lines = ["# Dialogue scorecard", "", `Rubric: ${RUBRIC}. Cut: ${a?.point}.`, "",
    cards.map(c => `**${c.label}**: ${c.trials} pass${c.trials === 1 ? "" : "es"} on ${c.cases.join(", ")}`).join(" · "), "",
    `| Factor | ${cards.map(c => c.label).join(" | ")} |${two ? " Change |" : ""} 100% means |`,
    `|---|${cards.map(() => "---").join("|")}|${two ? "---|" : ""}---|`];
  let missingBand = false;
  const pm = (perCase: Record<string, Stat | null>) => {
    const width = band(standardError(Object.values(perCase)));
    if (width === null) missingBand = true;
    return width === null ? "" : ` ±${width}`;
  };
  const perCaseOf = (c: Card, id: FactorId) => Object.fromEntries(Object.entries(c.byCase).map(([k, v]) => [k, v[id]]));
  const factorRow = (f: Factor) => {
    const cells = cards.map(c => c.factors[f.id] ? `${c.factors[f.id]!.mean}%${pm(perCaseOf(c, f.id))}` : "–");
    const change = two ? ` ${compareFigure(perCaseOf(a!, f.id), perCaseOf(b!, f.id), a!.factors[f.id] && b!.factors[f.id] ? b!.factors[f.id]!.mean - a!.factors[f.id]!.mean : null).text} |` : "";
    lines.push(`| ${f.label} | ${cells.join(" | ")} |${change} ${f.means} |`);
  };
  const summaryRow = (label: string, key: Summary, pick: (c: Card) => number | null, means: string) => {
    const perCase = (c: Card) => Object.fromEntries(Object.entries(c.summaryByCase).map(([k, v]) => [k, v[key]]));
    const cell = (c: Card) => pick(c) === null ? "–" : `**${pick(c)}%**${pm(perCase(c))}`;
    const change = two ? ` ${compareFigure(perCase(a!), perCase(b!), pick(a!) !== null && pick(b!) !== null ? pick(b!)! - pick(a!)! : null).text} |` : "";
    lines.push(`| **${label}** | ${cards.map(cell).join(" | ")} |${change} ${means} |`);
  };
  const overallDesc = commonWatch.length && commonEdit.length
    ? `geometric mean of Watchability (${commonWatch.length}) and Editorial match (${commonEdit.length})`
    : `the mean of the ${common.length} factors every side has`;
  summaryRow("Overall", "overall", c => c.overall === null || !WATCHABILITY_IDS.every(id => common.includes(id)) || !common.includes("linesKept") ? null : overallOf(c.factors, common), overallDesc);
  if (commonWatch.length) summaryRow("Watchability", "watchability", c => overallOf(c.factors, commonWatch), `craft quality across ${commonWatch.length} rate-based bug factors`);
  for (const f of FACTORS.filter(f => f.group === "watchability")) factorRow(f);
  if (commonEdit.length) summaryRow("Editorial match", "editorial", c => overallOf(c.factors, commonEdit), `alignment with the editor across ${commonEdit.length} decision and pacing factors`);
  for (const f of FACTORS.filter(f => f.group === "editorial")) factorRow(f);
  if (cards.some(c => c.mistakesPer10Min)) {
    const n = (x: Stat | null) => !x ? "–" : `${x.mean}`;
    type Count = keyof Card["countsByCase"][string];
    const perCase = (c: Card, k: Count) => Object.fromEntries(Object.entries(c.countsByCase).map(([id, v]) => [id, v[k]]));
    const total = (c: Card, k: Count) => k === "per10Min" ? c.mistakesPer10Min : k === "stylePer10Min" ? c.stylePer10Min : c.mistakeCounts[k];
    const row = (label: string, k: Count, means: string) => {
      const cells = cards.map(c => total(c, k) ? `${n(total(c, k))}${pm(perCase(c, k)).replace(/^ ±/, " ±")}` : "–");
      const x = two ? total(a!, k) : null, y = two ? total(b!, k) : null;
      // Fewer is better here.
      const change = two ? ` ${compareFigure(perCase(a!, k), perCase(b!, k), x && y ? y.mean - x.mean : null, true).text} |` : "";
      return `| ${label} | ${cells.join(" | ")} |${change} ${means} |`;
    };
    lines.push("", "Counted, not scored as a percentage. Fewer is better.", "",
      `| Automated flags | ${cards.map(c => c.label).join(" | ")} |${two ? " Change |" : ""} What is counted |`, `|---|${cards.map(() => "---").join("|")}|${two ? "---|" : ""}---|`,
      row("**Craft mistakes per 10 finished min**", "per10Min", "retakes left in and stutter cuts: the craft mistakes an editor's ears confirmed"),
      row("Retake left in", "longMissed", `runs of ${LONG_MISSED_WORDS} words or more that play a line twice, the editor cut, and Scarlet didn't ask about, in the whole video`),
      row("Stutter cuts", "stutters", `pieces under ${STUTTER_SECONDS} s between two cuts`),
      row("*Checked by ear next:* words a cut lands inside", "clippedWords", "joins inside a sounding word by the transcript's timing; 2 of 12 were real by ear (2026-11-20), so not scored"),
      row("*Checked by ear next:* word doubled at a join", "doubledAtJoin", "the word either side of a join said twice, whole or begun (\u201cwith \u2016 without\u201d); not scored until checked"),
      row("*Checked by ear next:* half a sentence at a join", "halfSentence", `a join after ${HALF_SENTENCE_WORDS} words or fewer of a sentence that never finishes; not scored until checked`),
      row("Cut, and the editor kept it", "wronglyCut", `runs of ${NOTICED_WORDS} words or more, in the whole video; mostly taste by ear, scored in Editorial match`),
      row("Retake left for your call", "askedRetakes", `retakes left in that Scarlet staged or flagged for the editor, in the whole video; not counted above`),
      row("Content the editor cut, left in", "contentLeftIn", `runs of ${LONG_MISSED_WORDS} words or more the editor dropped with no other take kept (taste: a sponsor read, a tangent)`),
      row("Short tightenings left in (per 10 min)", "stylePer10Min", `${NOTICED_WORDS}\u2013${LONG_MISSED_WORDS - 1} word runs the editor trimmed (taste/tightness, separate from hard mistakes)`),
      row("Short tightenings left in", "styleLeftIn", `runs of ${NOTICED_WORDS}\u2013${LONG_MISSED_WORDS - 1} words, in the whole video`),
      row("Same words, another take", "otherTake", `runs of ${NOTICED_WORDS} words or more Scarlet and the editor each played from a different saying, in the whole video; not a mistake`));
  }
  if (ledger) lines.push(`| Past mistakes | ${cards.map((_, i) => i === cards.length - 1 ? (ledger.pct === null ? "–" : `${ledger.pct}%`) : "").join(" | ")} |${two ? " |" : ""} every reported mistake with a free check still passes (${ledger.pass} of ${ledger.checked}, ${ledger.label}) |`);
  const fact = (x: Stat | null, digits = 1, scale = 1) => x ? (x.mean / scale).toFixed(digits) : "–";
  lines.push("", "Not scored: " + cards.map(c => `${c.label}: ${fact(c.facts.asks)} calls and flags for the editor, ` +
    `${fact(c.facts.finishMinutes)} min to finish (${fact(c.facts.minutes)} active), ${fact(c.facts.tokens, 2, 1e6)}M tokens, ` +
    `${c.facts.cents ? `$${fact(c.facts.cents, 2, 100)}` : "no estimated cost"} a pass` +
    `${c.facts.steps ? `, ${fact(c.facts.steps, 0)} model steps and ${fact(c.facts.cacheMisses ?? null)} cache misses` : ""}`).join(" · ") + ".");
  lines.push("", "± is how far a figure moves by luck alone: run the same code again and it lands within the ± about 95 times in 100. " +
    "It comes from how much this run's passes of the same recording disagree. A change counts only when it moves more than its ±; " +
    "“could be luck” marks one that doesn't, and the recordings it went up or down on say whether it was one video or all of them.");
  if (missingBand) lines.push("", "No ± where a side has one pass on each recording: run at least two passes on a recording to measure the luck.");
  if (cards.some(c => c.cases.length < 3)) lines.push("", `Recordings: ${[...new Set(cards.flatMap(c => c.cases))].join(", ")}. With fewer than three, the figures describe these videos more than the cutting.`);
  if (cards.some(c => c.cases.length > 1)) {
    for (const c of cards) {
      lines.push("", `## ${c.label}, by recording`, "", `| Recording | ${FACTORS.map(f => f.label).join(" | ")} |`, `|---|${FACTORS.map(() => "---").join("|")}|`);
      for (const [id, fs] of Object.entries(c.byCase)) lines.push(`| ${id} | ${FACTORS.map(f => show(fs[f.id])).join(" | ")} |`);
    }
  }
  if (details) lines.push("", "## What each figure is made of", "", ...FACTORS.map(f => `- **${f.label}:** ${details[f.id].detail}.`));
  return lines.join("\n") + "\n";
}

export const configSlug = (config: string) => fileComponent(config.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, ""));

export function eligibleTrials(run: string, config?: string) {
  const rows = readJson<TrialRow[]>(checkedPath(run, join(run, "trials.json")));
  const seen = new Set<string>(), tasks = new Set<string>();
  return rows.filter(row => !config || row.config === config).filter(row => row.state === "done" && row.headline && !row.error).map(row => {
    if (!Number.isSafeInteger(row.trial) || row.trial < 1 || !row.taskId || tasks.has(row.taskId)) throw new Error("Invalid or duplicated trial identity");
    const file = checkedPath(run, join(run, fileComponent(row.caseId), configSlug(row.config), `trial-${row.trial}`, "evaluation.json"));
    if (seen.has(file)) throw new Error("Duplicate trial path");
    seen.add(file); tasks.add(row.taskId);
    return { file, row };
  });
}

function configMatches(label: string, cfg: Evaluation["config"]): boolean {
  if (!cfg.agent || !label.startsWith(`${cfg.agent}:`)) return false;
  const rest = label.slice(cfg.agent.length + 1);
  const models = cfg.model ? [cfg.model, "default"] : ["default"];
  const efforts = cfg.effort ? [cfg.effort, "default"] : ["default"];
  return models.some(m => efforts.some(e => rest === `${m}:${e}` || rest.startsWith(`${m}:${e}:`)));
}

export function readTrial(file: string, row?: TrialRow): Evaluation {
  const ev = readJson<Evaluation>(file);
  if (row) {
    if (ev.taskId !== row.taskId || ev.caseId !== row.caseId || !configMatches(row.config, ev.config)) {
      throw new Error("Trial does not match manifest: " + file);
    }
  }
  if (ev.score.trace?.state !== "done" || ev.score.rubric !== RUBRIC || !ev.score.playable?.automatic || !ev.score.playable?.recommended) {
    throw new Error(`Not a completed ${RUBRIC} evaluation; bring it up to date with regrade.ts (offline, no model tokens): ` + file);
  }
  return ev;
}

function trialsAt(path: string): Evaluation[] {
  const selected = resolve(path);
  if (!existsSync(selected)) throw new Error(`No such file or folder: ${path}`);
  const single = statSync(selected).isFile();
  let run = single ? dirname(selected) : selected;
  while (!existsSync(join(run, "trials.json")) && dirname(run) !== run) run = dirname(run);
  if (existsSync(join(run, "trials.json"))) {
    const entries = eligibleTrials(run).filter(({ file }) => {
      if (single) return file === selected;
      const rel = relative(selected, file);
      return rel !== ".." && !rel.startsWith(".." + sep);
    });
    if (new Set(entries.map(entry => entry.row.config)).size > 1) throw new Error("Choose one configuration per side.");
    return entries.map(({ file, row }) => readTrial(file, row));
  }
  if (single) return [readTrial(selected)];
  throw new Error("A run directory needs trials.json; use the exact file for a standalone evaluation.");
}

/** One side of a scorecard: the eligible trials under each path (a run, a configuration's folder in it, or one evaluation.json). */
export function loadSide(label: string, paths: string | readonly string[], at: OperatingPoint = "recommended"): { card: Card; details?: Factors } {
  const list = typeof paths === "string" ? [paths] : paths;
  const trials = list.flatMap(trialsAt);
  if (!trials.length) throw new Error("No eligible completed trials: " + list.join(", "));
  if (new Set(trials.map(t => `${t.config.agent}:${t.config.model}:${t.config.effort}`)).size > 1) throw new Error("Choose one configuration per side.");
  return { card: card(label, trials, at), ...(trials.length === 1 && { details: factors(trials[0]!.score, at) }) };
}

async function scorecardCli(argv = process.argv.slice(2)) {
  const { values, positionals } = cli({ point: { type: "string" }, labels: { type: "string" }, ledger: { type: "boolean" }, json: { type: "boolean" } }, USAGE, argv);
  const point = values.point ?? "recommended";
  if (!positionals.length || (point !== "automatic" && point !== "recommended")) throw new Error(USAGE);
  const labels = list(values.labels);
  // A side can join several runs, one per recording, with commas.
  const sides = positionals.map((p, i) => loadSide(labels[i] ?? (positionals.length === 1 ? "This run" : p.replace(/\/+$/, "").split("/").at(-1)!), p.split(","), point));
  let ledger: Parameters<typeof scorecardMarkdown>[1];
  if (values.ledger) {
    const { results } = await runChecks(loadLedger().entries, line => console.error(line));
    ledger = { label: "this checkout", ...ledgerPct(results) };
  } else {
    const last = loadBoard().at(-1);
    if (last) ledger = { label: `recorded ${last.at.slice(0, 10)}${last.label ? `, ${last.label}` : ""}`, ...ledgerPct(Object.values(last.results)) };
  }
  if (values.json) { console.log(JSON.stringify({ cards: sides.map(s => s.card), ledger }, null, 2)); return; }
  console.log(scorecardMarkdown(sides.map(s => s.card), ledger, sides.length === 1 ? sides[0]!.details : undefined));
}

if (isMain(import.meta.url)) void main(() => scorecardCli());
