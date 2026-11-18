/**
 * Score one finished first-cut run: what it applied, what it staged for review, how clean its joins
 * are, how it compares with a reference cut, and what the agent did. Pure; evaluate.ts gathers inputs.
 */
import type { Change, Timeline } from "../../packages/timeline/src/index.ts";
import type { ReviewChangeExport } from "./engine.ts";
import { subtract, type Range } from "./intervals.ts";
import {
  DEFAULT_EDGE_OPTIONS, classifyEdges, compareToDecisions, compareToReference, cutEdges, joinEdges, pacing, planMetrics, removedSource,
  summarizeEdges, summarizeRemoval, traceMetrics, round, type CutRecord, type EdgeOptions, type EdgeReport, type EdgeSummary,
  type EventLike, type Kept, type LabeledRange, type MediaEvidence, type PacingGap, type PacingRepeat, type PacingSummary, type PlanMetrics,
  type ReferenceComparison, type RemovalSummary, type SubmittedPlan, type TaskLike, type TraceMetrics, type Word, overlap,
} from "./metrics.ts";
import { pictureAt } from "./layout.ts";
import { comparePicture, summarizePicture, type PictureComparison, type PictureSample, type PictureSummary } from "./picture.ts";
import { comparePublishedJoinSpacing, type PublishedReference } from "./published.ts";
import { dividedJoins, keptSource, playedWords, sourceSpan, sourceToTimeline, timelineRangeToSource, wordsWithout, type DividedJoin, type MediaInfo, type SourceRange } from "./timeline.ts";

export interface ScoreInput {
  media: MediaInfo[];
  timelines: { source: Timeline; applied: Timeline; proposed: Timeline; reviewBase?: Timeline; plan?: Timeline;
    /** The edit the task left playing, when its own later changes moved it on from `applied`. */
    final?: Timeline };
  appliedChange?: Change;
  /** A run saved in parts: every applied part with the version it started from, in order. Replaces appliedChange. */
  appliedParts?: Array<{ change: Change; from: Timeline }>;
  reviewChange?: Change;
  review?: ReviewChangeExport;
  /**
   * Cuts the task left staged for review on other versions than the scored review's, still waiting for the editor. They
   * go in with the editor's calls, so what the editor gets counts them.
   */
  waiting?: ReviewChangeExport[];
  plan?: SubmittedPlan;
  /** Every submitted plan with the version it was decided on. Replaces plan and timelines.plan. */
  plans?: Array<{ plan: SubmittedPlan; timeline: Timeline }>;
  /** Any version the run referred to, such as one it checked joins on. */
  timelineAt?: (version: string) => Timeline | undefined;
  evidence: ReadonlyMap<string, MediaEvidence>;
  reference?: { label: string; timeline?: Timeline; labels?: LabeledRange[]; published?: PublishedReference };
  task?: TaskLike;
  events?: EventLike[];
  edgeOptions?: EdgeOptions;
}

interface EdgeDetail extends EdgeReport { context?: string; reason?: string }
export interface Tier {
  version: string;
  removal: RemovalSummary;
  edges: EdgeSummary;
  /** Both edges of every listed cut, as the earlier hand analysis counted (adjacent items and shared joins included). */
  perCutEdges: EdgeSummary;
  /** The same joins measured on the waveform used by the agent's audio tools. */
  engineView?: EdgeSummary;
  edgeList: EdgeDetail[];
  cuts: Array<CutRecord & { timeline: Range }>;
}
interface ReviewTier extends Tier {
  items: number;
  ai: { cut: number; keep: number; ask: number; unassessed: number; inspected: number };
  editor: { approved: number; skipped: number; pending: number; unknown: number };
  /** AI recommendation × editor decision, for decided items. */
  aiVsEditor: Record<string, number>;
  /** Staged cuts the agent submitted as "cut": Scarlet held them for review. */
  heldByScarlet: number;
}
interface PictureScore extends PictureComparison { summary: PictureSummary }
type ScoredReference = Omit<ReferenceComparison, "edges"> & { edges: ReferenceComparison["edges"] | null };

/** The dead air and doubled words each version plays. The lists are the applied version's, longest gaps first. */
interface PacingScore {
  source: PacingSummary;
  applied: PacingSummary;
  proposed: PacingSummary;
  /** The edit the task left playing, when its own later changes moved it on from the applied version. */
  final?: PacingSummary;
  /** The edit the task left with every staged cut the agent recommended cutting taken out too: what the editor gets by accepting its picks. */
  recommended?: PacingSummary;
  reference?: PacingSummary;
  sharedJoins?: Record<"applied" | "proposed", ReturnType<typeof comparePublishedJoinSpacing>>;
  appliedGaps: PacingGap[];
  appliedRepeats: PacingRepeat[];
  /** The applied version's joins that took words out of a sentence, with the words either side: to read, for stray words and cut-off sentences. */
  appliedDividedJoins: DividedJoin[];
  /** The longest gaps of the edit the task left, when that is not the applied version. */
  finalGaps?: PacingGap[];
}
export interface Score {
  versions: { source: string; applied: string; proposed: string; final?: string };
  applied: Tier;
  review: ReviewTier | null;
  pacing: PacingScore;
  /** The picture against the published video's, at the moments both play: layout, the presenter's inset, the framing under it. */
  picture: null | { reference: PictureSummary; applied: PictureScore; proposed: PictureScore };
  plan: PlanMetrics | null;
  trace: TraceMetrics | null;
  reference: null | {
    label: string;
    /** A published video is the reference: its words say what was kept, and where its cut edges sat is not known. */
    published?: Omit<PublishedReference, "kept" | "played" | "pieces" | "picture">;
    operatingPoints: Record<"applied" | "recommended" | "proposed", { cut?: ScoredReference; decisions?: ReturnType<typeof compareToDecisions> }>;
  };
  headline: Record<string, number | null>;
}

const AUTO = [
  { pattern: /possible filler left in the edit/i, category: "filler" },
  { pattern: /remaining quiet time/i, category: "pause" },
  { pattern: /^Trimmed a quiet [\d.]+ s pause/i, category: "pause" },
];

/** Category of each applied or staged cut: the submitted plan item it overlaps most, else Scarlet's own additions by their reason. */
function cutRecords(change: Change | undefined, from: Timeline | undefined, media: MediaInfo[], plan: Array<SourceRange & { kind?: string; decision?: string }>): Array<CutRecord & { timeline: Range }> {
  if (!change?.cutReasons || !from) return [];
  return change.cutReasons.flatMap(r => {
    const sources = timelineRangeToSource(from, media, r);
    const span = sourceSpan(from, media, r);
    if (!span) return [];
    let best: (typeof plan)[number] | undefined, most = 0;
    for (const p of plan) {
      const o = sources.reduce((sum, s) => sum + (s.mediaId === p.mediaId ? overlap(s, p) : 0), 0);
      if (o > most) { most = o; best = p; }
    }
    const auto = best ? undefined : AUTO.find(a => a.pattern.test(r.reason));
    return [{ ...span, timelineSeconds: r.end - r.start, timeline: { start: r.start, end: r.end },
      category: best?.kind ?? auto?.category ?? "unknown", ...(auto && { auto: true }), decision: best?.decision, reason: r.reason }];
  });
}

function edgeContext(words: readonly Word[] | undefined, t: number, span = 1.5): string | undefined {
  if (!words?.length) return undefined;
  const before = words.filter(w => w.end > t - span && w.start < t && (w.start + w.end) / 2 <= t).map(w => w.text.trim()).join(" ");
  const after = words.filter(w => w.start < t + span && w.end > t && (w.start + w.end) / 2 > t).map(w => w.text.trim()).join(" ");
  return `…${before} ‖ ${after}…`;
}

function tier(version: string, before: Kept, after: Kept, cuts: Array<CutRecord & { timeline: Range }>, programSeconds: number,
  evidence: ReadonlyMap<string, MediaEvidence>, opts: EdgeOptions): Tier {
  const removed = removedSource(before, after);
  const joins = joinEdges(before, after);
  const reports = classifyEdges(joins, evidence, opts);
  const engineEvidence = new Map([...evidence].flatMap(([id, e]) => {
    const levels = (e as MediaEvidence & { engineLevels?: MediaEvidence["levels"] }).engineLevels;
    return levels ? [[id, { ...e, levels }] as const] : [];
  }));
  const reasonAt = (r: EdgeReport) => cuts.find(c => c.mediaId === r.mediaId && Math.abs((r.side === "out" ? c.start : c.end) - r.at) < 0.002)?.reason;
  return {
    version,
    removal: summarizeRemoval(cuts.length ? cuts : [...removed].flatMap(([mediaId, rs]) => rs.map(r => ({ ...r, mediaId, category: "uncategorized", timeline: r }))),
      removed, programSeconds),
    edges: summarizeEdges(reports, opts),
    perCutEdges: summarizeEdges(classifyEdges(cutEdges(cuts), evidence, opts), opts),
    ...(engineEvidence.size && { engineView: summarizeEdges(classifyEdges(joins, engineEvidence, opts), opts) }),
    edgeList: reports.map(r => ({ ...r, context: edgeContext(evidence.get(r.mediaId)?.words, r.at), reason: reasonAt(r) })),
    cuts,
  };
}

const duration = (tl: Timeline) => Math.max(0, ...tl.tracks.flatMap(t => t.clips.map(c =>
  c.kind === "media" ? c.timelineIn + (c.sourceOut - c.sourceIn) / (c.speed ?? 1) : c.timelineOut)));

export function scoreRun(input: ScoreInput): Score {
  const opts = input.edgeOptions ?? DEFAULT_EDGE_OPTIONS;
  const { media, timelines, evidence } = input;
  const kS = keptSource(timelines.source, media), kA = keptSource(timelines.applied, media), kR = keptSource(timelines.proposed, media);
  const plans = input.plans ?? (input.plan ? [{ plan: input.plan, timeline: timelines.plan ?? timelines.source }] : []);
  // A range given as words names them by their index in the recording's transcript; the words say where it sits.
  const wordSpan = (c: SubmittedPlan["cuts"][number]): SourceRange[] => {
    const words = c.mediaId === undefined ? undefined : evidence.get(c.mediaId)?.words;
    // A pause reference names the word before the pause: the range is the silence up to the next word.
    const before = words?.[c.afterWord ?? -1], after = words?.[(c.afterWord ?? -2) + 1];
    if (before && after) return [{ mediaId: c.mediaId!, start: before.end, end: after.start }];
    const first = words?.[c.fromWord ?? -1], last = words?.[c.toWord ?? -1];
    return first && last ? [{ mediaId: c.mediaId!, start: first.start, end: last.end }] : [];
  };
  const planSources = plans.flatMap(({ plan, timeline }) => plan.cuts.filter(c => c.decision !== "keep")
    .flatMap(c => (c.fromWord === undefined && c.afterWord === undefined ? timelineRangeToSource(timeline, media, c) : wordSpan(c)).map(s => ({ ...s, kind: c.kind, decision: c.decision }))));
  const parts = input.appliedParts ?? (input.appliedChange ? [{ change: input.appliedChange, from: timelines.source }] : []);

  const applied = tier(timelines.applied.version, kS, kA, parts.flatMap(p => cutRecords(p.change, p.from, media, planSources)),
    duration(timelines.source) - duration(timelines.applied), evidence, opts);

  let review: ReviewTier | null = null;
  if (input.reviewChange) {
    const base = timelines.reviewBase ?? timelines.applied;
    const t = tier(timelines.proposed.version, kA, kR, cutRecords(input.reviewChange, base, media, planSources),
      duration(base) - duration(timelines.proposed), evidence, opts);
    const cuts = input.review?.cuts ?? [];
    const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
    const aiVsEditor: Record<string, number> = {};
    for (const c of cuts) {
      if (c.decision !== "approved" && c.decision !== "skipped") continue;
      const key = `${c.assessment?.verdict ?? "unassessed"}→${c.decision}`;
      aiVsEditor[key] = (aiVsEditor[key] ?? 0) + 1;
    }
    review = {
      ...t,
      items: cuts.length,
      ai: { cut: count(cuts, c => c.assessment?.verdict === "cut"), keep: count(cuts, c => c.assessment?.verdict === "keep"),
        ask: count(cuts, c => c.assessment?.verdict === "ask"), unassessed: count(cuts, c => !c.assessment), inspected: count(cuts, c => !!c.assessment?.inspected) },
      editor: { approved: count(cuts, c => c.decision === "approved"), skipped: count(cuts, c => c.decision === "skipped"),
        pending: count(cuts, c => c.decision === "pending"), unknown: count(cuts, c => c.decision === "unknown") },
      aiVsEditor,
      heldByScarlet: count(t.cuts, c => c.decision === "cut"),
    };
  }

  const words = (tl: Timeline) => playedWords(tl, media, evidence);
  const appliedWords = words(timelines.applied), proposedWords = words(timelines.proposed);
  const { gapList, repeatList, ...appliedPacing } = pacing(appliedWords);
  const summary = ({ gapList: _gaps, repeatList: _repeats, ...rest }: ReturnType<typeof pacing>): PacingSummary => rest;
  const published = input.reference?.published;
  const pacingScore: PacingScore = {
    source: summary(pacing(words(timelines.source))), applied: appliedPacing, proposed: summary(pacing(proposedWords)),
    ...(published ? {
      reference: summary(pacing(published.played)),
      sharedJoins: { applied: comparePublishedJoinSpacing(published, appliedWords), proposed: comparePublishedJoinSpacing(published, proposedWords) },
    } : input.reference?.timeline && { reference: summary(pacing(words(input.reference.timeline))) }),
    appliedGaps: gapList.sort((a, b) => b.seconds - a.seconds).slice(0, 60), appliedRepeats: repeatList,
    appliedDividedJoins: dividedJoins(timelines.applied, media, evidence),
  };
  // What the task left playing: the edit it ended on, with its own later changes (closing repairs, picks it applied).
  const left = timelines.final ?? timelines.applied;
  const leftWords = timelines.final ? words(timelines.final) : appliedWords;
  const { gapList: leftGapList, repeatList: _leftRepeats, ...leftPacing } = timelines.final ? pacing(leftWords) : { ...appliedPacing, gapList, repeatList };
  if (timelines.final) { pacingScore.final = leftPacing; pacingScore.finalGaps = leftGapList.sort((a, b) => b.seconds - a.seconds).slice(0, 60); }
  // Every staged cut still waiting for the editor: the scored review's unless the task applied it, and those it staged on
  // earlier versions. They are placed by their source ranges, so they land on the edit the task left whatever version
  // they were staged on; one whose footage that edit no longer plays takes nothing out.
  const waiting = input.waiting ?? [];
  const staged = [...(input.review && input.reviewChange?.state !== "approved" ? input.review.cuts : []), ...waiting.flatMap(w => w.cuts)];
  const pickedSources = staged.filter(c => c.assessment?.verdict === "cut").flatMap(c => c.sources);
  const recommendedPacing = staged.length || timelines.final
    ? summary(pacing(wordsWithout(leftWords, sourceToTimeline(left, media, pickedSources)))) : undefined;
  if (recommendedPacing) pacingScore.recommended = recommendedPacing;

  // The agent's own call, before the editor: what the task left, less the staged cuts it recommended cutting.
  const without = (kept: Kept, sources: readonly SourceRange[]) => {
    const out = new Map(kept);
    for (const s of sources) out.set(s.mediaId, subtract(out.get(s.mediaId) ?? [], [s]));
    return out;
  };
  const kLeft = timelines.final ? keptSource(timelines.final, media) : kA;
  const recommended = without(kLeft, pickedSources);
  // Every staged item cut. Without later changes or staged cuts from other versions, the proposed version is exactly that.
  const kProposed = timelines.final || waiting.length ? without(kLeft, staged.flatMap(c => c.sources)) : kR;

  let reference: Score["reference"] = null;
  if (input.reference && (input.reference.published || input.reference.timeline || input.reference.labels?.length)) {
    const kRef: Kept | undefined = published ? new Map(Object.entries(published.kept)) : input.reference.timeline && keptSource(input.reference.timeline, media);
    const point = (candidate: Kept) => {
      const cut = kRef && compareToReference(kS, candidate, kRef, evidence);
      // The transcript locates words, but its inferred silence padding is not an observed edit edge.
      return {
        ...(cut && { cut: published ? { ...cut, edges: null } : cut }),
        ...(input.reference!.labels?.length && { decisions: compareToDecisions(kS, candidate, input.reference!.labels) }),
      };
    };
    const { kept: _kept, played: _played, pieces: _pieces, picture: _picture, ...matched } = published ?? ({} as PublishedReference);
    reference = { label: input.reference.label, ...(published && { published: matched }), operatingPoints: { applied: point(kA), recommended: point(recommended), proposed: point(kProposed) } };
  }

  const measured = input.reference?.published?.picture;
  const pictured = (tl: Timeline): PictureScore => {
    const at = (s: PictureSample) => pictureAt(tl, s.mediaId, s.source);
    return { ...comparePicture(measured!, at), summary: summarizePicture(measured!.flatMap(s => at(s) ?? [])) };
  };
  const picture = measured?.length ? { reference: summarizePicture(measured), applied: pictured(timelines.applied), proposed: pictured(timelines.proposed) } : null;

  const trace = input.task ? traceMetrics(input.task, input.events ?? []) : null;
  const timelineAt = (v: string) => input.timelineAt?.(v) ?? plans.find(p => p.plan.version === v)?.timeline;
  const plan = planMetrics(plans.map(p => p.plan), input.events ?? [], undefined, (v, r) => {
    const tl = timelineAt(v);
    return tl && sourceSpan(tl, media, r);
  });
  const proposedRef = reference?.operatingPoints.proposed.cut;
  // The engine's usage totals keep input separate from cache reads and writes; totalTokens adds them up.
  const usage = trace?.usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined;
  const tokens = usage ? (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) || null : null;
  return {
    versions: { source: timelines.source.version, applied: timelines.applied.version, proposed: timelines.proposed.version,
      ...(timelines.final && { final: timelines.final.version }) },
    applied, review, pacing: pacingScore, picture, plan, trace, reference,
    headline: {
      appliedCuts: applied.removal.cuts,
      appliedSeconds: applied.removal.seconds,
      appliedEdges: applied.edges.total,
      appliedSpeechEdges: applied.edges.speech,
      reviewCuts: review?.removal.cuts ?? 0,
      reviewItems: review?.items ?? 0,
      reviewSeconds: review?.removal.seconds ?? 0,
      reviewEdges: review?.edges.total ?? 0,
      reviewSpeechEdges: review?.edges.speech ?? 0,
      needsYourCall: review || waiting.length ? (review?.ai.ask ?? 0) + waiting.reduce((n, w) => n + w.cuts.filter(c => c.assessment?.verdict === "ask").length, 0) : null,
      // Staged cuts on other versions than the scored review's, still waiting for the editor.
      stagedWaiting: waiting.reduce((n, w) => n + w.cuts.length, 0),
      heldByScarlet: review?.heldByScarlet ?? null,
      // What the task left playing, with its own changes after its last dialogue part.
      gapsLeft: leftPacing.gaps.inside + leftPacing.gaps.atJoins,
      looseJoins: leftPacing.gaps.atJoins,
      deadAirSeconds: leftPacing.gaps.excessSeconds,
      // Accepting the agent's picks on every staged cut still waiting. Without one that is what the task left.
      recommendedDeadAirSeconds: (recommendedPacing ?? leftPacing).gaps.excessSeconds,
      recommendedLooseJoins: (recommendedPacing ?? leftPacing).gaps.atJoins,
      restartsLeft: (recommendedPacing ?? leftPacing).restarts,
      silencesLeft: (recommendedPacing ?? leftPacing).silences,
      // Joins that divide a sentence in the applied cut: each is one the closing check has the pass read.
      dividedJoins: pacingScore.appliedDividedJoins.length,
      repeatsLeft: leftPacing.repeats.total,
      repeatsAtJoins: leftPacing.repeats.atJoins,
      sharedAppliedJoins: pacingScore.sharedJoins?.applied.shared ?? null,
      sharedAppliedJoinGapMedianAbsErrorMs: pacingScore.sharedJoins?.applied.medianAbsErrorMs ?? null,
      layoutAgreement: picture?.applied.layoutAgreement ?? null,
      framingAgreement: picture?.applied.main?.sameFraming ?? null,
      clippedWordsOnSound: applied.edges.clippedOnSound + (review?.edges.clippedOnSound ?? 0),
      checkJoinCoverage: plan?.checkJoinCoverage ?? null,
      wordF1: proposedRef?.words.f1 ?? null,
      timeF1: proposedRef?.time.f1 ?? null,
      edgeF1At20ms: proposedRef?.edges?.f1["20ms"]?.f1 ?? null,
      requiredLinesMissing: proposedRef?.requiredLines.missing ?? null,
      toolCalls: trace?.toolCalls ?? null,
      toolErrors: trace?.errors ?? null,
      activeMinutes: trace?.activeSeconds == null ? null : round(trace.activeSeconds / 60, 1),
      firstCallMinutes: trace?.firstCallSeconds == null ? null : round(trace.firstCallSeconds / 60, 1),
      tokens,
    },
  };
}
