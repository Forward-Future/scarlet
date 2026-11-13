/**
 * Outcome metrics for an AI dialogue cut. Pure functions over source-clock intervals, waveform levels,
 * transcript words and task traces. Nothing here talks to the engine.
 *
 * Conventions: every time is in SOURCE seconds of one recording unless a name says "timeline". An edge
 * is a point where kept audio stops ("out", a removal starts) or resumes ("in", a removal ends).
 */
import { normalizeTranscriptToken as token } from "../../packages/shared/src/transcriptSearch.ts";
import { covered, intersect, median, merge, quantile, subtract, total, overlap, type Range } from "./intervals.ts";

export interface Word { text: string; start: number; end: number }
/** RMS level in dBFS per bucket, on the source clock. */
export interface Levels { from: number; step: number; db: number[] }
export interface MediaEvidence { mediaId: string; duration?: number; words?: Word[]; levels?: Levels }

export type EdgeSide = "out" | "in";
export interface Edge { mediaId: string; at: number; side: EdgeSide }
export type EdgeClass = "silence" | "low" | "speech" | "unknown";

export interface Grid { label: string; step: number; phase: number }
export interface EdgeOptions {
  /** "around": loudest bucket within ±windowSeconds. "kept": loudest bucket over windowSeconds on the kept side. */
  window: "around" | "kept";
  windowSeconds: number;
  /** Silence: below the recording's floor plus this. */
  silenceAboveFloorDb: number;
  /** Speech: at or above the recording's typical speech level minus this. In between is "low". */
  lowBelowSpeechDb: number;
  floorPercentile: number;
  speechPercentile: number;
  /** A word is clipped when the edge falls more than this far inside it. */
  wordMargin: number;
  grids: Grid[];
  gridTolerance: number;
}

export const DEFAULT_EDGE_OPTIONS: EdgeOptions = {
  window: "around",
  windowSeconds: 0.02,
  silenceAboveFloorDb: 8,
  lowBelowSpeechDb: 18,
  floorPercentile: 15,
  speechPercentile: 85,
  wordMargin: 0.02,
  grids: [{ label: "1s", step: 1, phase: 0 }, { label: "0.5s", step: 0.5, phase: 0 }, { label: "1s+0.48", step: 1, phase: 0.48 }],
  gridTolerance: 0.006,
};

/** Hand-analysis compatible settings (loudest 50 ms on the kept side). */
export const KEPT_SIDE_EDGE_OPTIONS: EdgeOptions = { ...DEFAULT_EDGE_OPTIONS, window: "kept", windowSeconds: 0.05 };

// ---------------------------------------------------------------------------
// Levels and edge classification
// ---------------------------------------------------------------------------

export interface LevelStats { floorDb: number; speechDb: number }

/** Room floor and typical speech level from the recording's own level distribution (digital silence excluded). */
export function levelStats(levels: Levels, opts: Pick<EdgeOptions, "floorPercentile" | "speechPercentile"> = DEFAULT_EDGE_OPTIONS): LevelStats | undefined {
  const values = levels.db.filter(v => Number.isFinite(v) && v > -100);
  if (!values.length) return undefined;
  return { floorDb: quantile(values, opts.floorPercentile / 100)!, speechDb: quantile(values, opts.speechPercentile / 100)! };
}

/** Loudest bucket overlapping [start, end). */
export function levelIn(levels: Levels, start: number, end: number): number | undefined {
  if (end <= start) return undefined;
  const first = Math.max(0, Math.floor((start - levels.from) / levels.step + 1e-9));
  const last = Math.min(levels.db.length - 1, Math.ceil((end - levels.from) / levels.step - 1e-9) - 1);
  let loudest: number | undefined;
  for (let i = first; i <= last; i++) {
    const v = levels.db[i]!;
    if (loudest === undefined || v > loudest) loudest = v;
  }
  return loudest;
}

export function onGrid(t: number, grid: Grid, tolerance: number): boolean {
  const r = (((t - grid.phase) % grid.step) + grid.step) % grid.step;
  return Math.min(r, grid.step - r) <= tolerance;
}

export function clippedWord(words: readonly Word[] | undefined, t: number, margin: number): Word | undefined {
  return words?.find(w => w.start + margin < t && t < w.end - margin);
}

export interface EdgeReport extends Edge {
  db?: number;
  overFloorDb?: number;
  class: EdgeClass;
  clippedWord?: string;
  grids: string[];
}

export function classifyEdges(edges: readonly Edge[], evidence: ReadonlyMap<string, MediaEvidence>, opts: EdgeOptions = DEFAULT_EDGE_OPTIONS): EdgeReport[] {
  const stats = new Map<string, LevelStats | undefined>();
  return edges.map(edge => {
    const ev = evidence.get(edge.mediaId);
    if (ev?.levels && !stats.has(edge.mediaId)) stats.set(edge.mediaId, levelStats(ev.levels, opts));
    const s = stats.get(edge.mediaId);
    const w = opts.windowSeconds;
    const [a, b] = opts.window === "around" ? [edge.at - w, edge.at + w] : edge.side === "out" ? [edge.at - w, edge.at] : [edge.at, edge.at + w];
    const db = ev?.levels ? levelIn(ev.levels, a, b) : undefined;
    let cls: EdgeClass = "unknown";
    if (db !== undefined && s) cls = db < s.floorDb + opts.silenceAboveFloorDb ? "silence" : db < s.speechDb - opts.lowBelowSpeechDb ? "low" : "speech";
    const clipped = clippedWord(ev?.words, edge.at, opts.wordMargin);
    return {
      ...edge,
      ...(db !== undefined && { db: round(db, 1) }),
      ...(db !== undefined && s && { overFloorDb: round(db - s.floorDb, 1) }),
      class: cls,
      ...(clipped && { clippedWord: clipped.text.trim() }),
      grids: opts.grids.filter(g => onGrid(edge.at, g, opts.gridTolerance)).map(g => g.label),
    };
  });
}

export interface EdgeSummary {
  total: number;
  silence: number;
  low: number;
  speech: number;
  unknown: number;
  silencePct: number | null;
  speechPct: number | null;
  /** Transcript word timing crosses the edge by more than wordMargin. Word timings drift, so read with clippedOnSound. */
  clippedWords: number;
  /** A clipped word where the recording is not silent at the edge. */
  clippedOnSound: number;
  onGrid: Record<string, number>;
}

export function summarizeEdges(reports: readonly EdgeReport[], opts: EdgeOptions = DEFAULT_EDGE_OPTIONS): EdgeSummary {
  const count = (c: EdgeClass) => reports.filter(r => r.class === c).length;
  const known = reports.length - count("unknown");
  return {
    total: reports.length,
    silence: count("silence"),
    low: count("low"),
    speech: count("speech"),
    unknown: count("unknown"),
    silencePct: known ? round(100 * count("silence") / known, 1) : null,
    speechPct: known ? round(100 * count("speech") / known, 1) : null,
    clippedWords: reports.filter(r => r.clippedWord).length,
    clippedOnSound: reports.filter(r => r.clippedWord && (r.class === "low" || r.class === "speech")).length,
    onGrid: Object.fromEntries(opts.grids.map(g => [g.label, reports.filter(r => r.grids.includes(g.label)).length])),
  };
}

// ---------------------------------------------------------------------------
// Removals and edges between two cuts
// ---------------------------------------------------------------------------

export type Kept = ReadonlyMap<string, readonly Range[]>;

/** Source material `before` plays that `after` no longer plays, per recording. */
export function removedSource(before: Kept, after: Kept): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  for (const [id, kept] of before) {
    const gone = subtract(kept, after.get(id) ?? []);
    if (gone.length) out.set(id, gone);
  }
  return out;
}

/**
 * Joins introduced by `after`: boundaries of its kept material that were not boundaries in `before`.
 * The head and tail of the recording are edges only if `after` trimmed them.
 */
export function joinEdges(before: Kept, after: Kept, eps = 0.001): Edge[] {
  const edges: Edge[] = [];
  for (const [id, kept] of after) {
    const base = merge(before.get(id) ?? []);
    const isStart = (t: number) => base.some(r => Math.abs(r.start - t) <= eps);
    const isEnd = (t: number) => base.some(r => Math.abs(r.end - t) <= eps);
    for (const r of merge(kept)) {
      if (!isStart(r.start)) edges.push({ mediaId: id, at: r.start, side: "in" });
      if (!isEnd(r.end)) edges.push({ mediaId: id, at: r.end, side: "out" });
    }
  }
  return edges.sort((a, b) => a.mediaId.localeCompare(b.mediaId) || a.at - b.at);
}

/** Both edges of every individual cut, as the earlier hand analysis counted them. Skips the recording's very start. */
export function cutEdges(cuts: ReadonlyArray<Range & { mediaId: string }>, minimum = 0.05): Edge[] {
  return cuts.flatMap(c => [
    ...(c.start >= minimum ? [{ mediaId: c.mediaId, at: c.start, side: "out" as const }] : []),
    { mediaId: c.mediaId, at: c.end, side: "in" as const },
  ]);
}

/** One proposed or applied cut with its editorial category. Times are source seconds. */
export interface CutRecord extends Range {
  mediaId: string;
  /** Seconds removed from the program (timeline), when known. */
  timelineSeconds?: number;
  category: string;
  /** Added by Scarlet rather than requested by the agent. */
  auto?: boolean;
  decision?: string;
  reason?: string;
}

export interface RemovalSummary {
  cuts: number;
  joins: number;
  seconds: number;
  byCategory: Record<string, { cuts: number; seconds: number }>;
}

export function summarizeRemoval(cuts: readonly CutRecord[], removed: ReadonlyMap<string, readonly Range[]>, programSeconds?: number): RemovalSummary {
  const byCategory: RemovalSummary["byCategory"] = {};
  for (const c of cuts) {
    const entry = byCategory[c.category] ??= { cuts: 0, seconds: 0 };
    entry.cuts++;
    entry.seconds = round(entry.seconds + (c.timelineSeconds ?? c.end - c.start), 3);
  }
  const joins = Math.max(0, ...[...removed.values()].map(r => r.length));
  const sourceSeconds = Math.max(0, ...[...removed.values()].map(total));
  return { cuts: cuts.length, joins, seconds: round(programSeconds ?? sourceSeconds, 3), byCategory };
}

// ---------------------------------------------------------------------------
// Against a reference cut
// ---------------------------------------------------------------------------

export type Label = "keep" | "cut";

function keptFraction(w: Range, kept: readonly Range[]): number {
  if (w.end - w.start <= 1e-6) return kept.some(r => r.start <= w.start && w.start < r.end) ? 1 : 0;
  return covered(w, kept) / (w.end - w.start);
}

/** Label each word kept or cut by `version`. Words the base cut had already removed are out of scope (undefined). */
export function labelWords(words: readonly Word[], baseKept: readonly Range[], versionKept: readonly Range[]): Array<Label | undefined> {
  const base = merge(baseKept), version = merge(versionKept);
  return words.map(w => keptFraction(w, base) < 0.5 ? undefined : keptFraction(w, version) >= 0.5 ? "keep" : "cut");
}

export interface PRF { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }

export function prf(tp: number, fp: number, fn: number): PRF {
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : tp + fp + fn ? 0 : null;
  return { tp, fp, fn, precision: r3(precision), recall: r3(recall), f1: r3(f1) };
}

/** One-to-one matches of edges on the same recording and side within `window` seconds, nearest first. */
export function matchEdges(candidate: readonly Edge[], reference: readonly Edge[], window: number): Array<{ candidate: Edge; reference: Edge; error: number }> {
  const pairs: Array<{ i: number; j: number; error: number }> = [];
  candidate.forEach((c, i) => reference.forEach((r, j) => {
    if (c.mediaId === r.mediaId && c.side === r.side && Math.abs(c.at - r.at) <= window + 1e-9) pairs.push({ i, j, error: c.at - r.at });
  }));
  pairs.sort((a, b) => Math.abs(a.error) - Math.abs(b.error));
  const usedC = new Set<number>(), usedR = new Set<number>();
  const out: Array<{ candidate: Edge; reference: Edge; error: number }> = [];
  for (const p of pairs) {
    if (usedC.has(p.i) || usedR.has(p.j)) continue;
    usedC.add(p.i); usedR.add(p.j);
    out.push({ candidate: candidate[p.i]!, reference: reference[p.j]!, error: p.error });
  }
  return out;
}

export interface Sentence extends Range { mediaId: string; words: Word[]; text: string }

/** Split transcript words into sentences at terminal punctuation or a long gap. */
export function sentences(mediaId: string, words: readonly Word[], maxGap = 1.5): Sentence[] {
  const out: Sentence[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length) out.push({ mediaId, start: current[0]!.start, end: current.at(-1)!.end, words: current, text: current.map(w => w.text.trim()).join(" ") });
    current = [];
  };
  const sorted = words.filter(w => w.text.trim()).slice().sort((a, b) => a.start - b.start);
  for (const w of sorted) {
    const last = current.at(-1);
    if (last && w.start - last.end > maxGap) flush();
    current.push(w);
    if (/[.?!]["'”’)\]]*$/u.test(w.text.trim())) flush();
  }
  flush();
  return out;
}

export interface ReferenceOptions {
  edgeTolerances: number[];
  /** Pairs further apart than this are separate edges when measuring placement error. */
  edgeMatchWindow: number;
  /** A sentence is required when the reference keeps at least this share of its words. */
  requiredKeepShare: number;
  /** A required sentence is missing when the candidate cuts at least this share of its words. */
  missingCutShare: number;
}
export const DEFAULT_REFERENCE_OPTIONS: ReferenceOptions = { edgeTolerances: [0.02, 0.1, 0.5], edgeMatchWindow: 1, requiredKeepShare: 0.8, missingCutShare: 0.5 };

export interface ReferenceComparison {
  words: PRF & { inScope: number };
  time: PRF & { candidateSeconds: number; referenceSeconds: number; overlapSeconds: number };
  edges: { candidate: number; reference: number; f1: Record<string, PRF>; matched: number; medianAbsErrorMs: number | null; p90AbsErrorMs: number | null };
  requiredLines: { required: number; missing: number; missingSeconds: number; lines: Array<{ mediaId: string; start: number; end: number; text: string; cutShare: number }> };
}

export function compareToReference(base: Kept, candidate: Kept, reference: Kept, evidence: ReadonlyMap<string, MediaEvidence>,
  opts: ReferenceOptions = DEFAULT_REFERENCE_OPTIONS): ReferenceComparison {
  let tp = 0, fp = 0, fn = 0, inScope = 0;
  let candSec = 0, refSec = 0, both = 0;
  const lines: ReferenceComparison["requiredLines"]["lines"] = [];
  let required = 0;
  for (const [id, kept] of base) {
    const cand = candidate.get(id) ?? [], ref = reference.get(id) ?? [];
    const candRemoved = subtract(kept, cand), refRemoved = subtract(kept, ref);
    candSec += total(candRemoved); refSec += total(refRemoved); both += total(intersect(candRemoved, refRemoved));
    const words = evidence.get(id)?.words ?? [];
    const cl = labelWords(words, kept, cand), rl = labelWords(words, kept, ref);
    words.forEach((_, i) => {
      if (!cl[i] || !rl[i]) return;
      inScope++;
      if (cl[i] === "cut" && rl[i] === "cut") tp++;
      else if (cl[i] === "cut") fp++;
      else if (rl[i] === "cut") fn++;
    });
    const index = new Map(words.map((w, i) => [w, i]));
    for (const s of sentences(id, words)) {
      const labeled = s.words.map(w => index.get(w)!).filter(i => cl[i] && rl[i]);
      if (!labeled.length) continue;
      if (labeled.filter(i => rl[i] === "keep").length / labeled.length < opts.requiredKeepShare) continue;
      required++;
      const cutShare = labeled.filter(i => cl[i] === "cut").length / labeled.length;
      if (cutShare >= opts.missingCutShare) lines.push({ mediaId: id, start: s.start, end: s.end, text: s.text, cutShare: round(cutShare, 2) });
    }
  }
  const candEdges = joinEdges(base, candidate), refEdges = joinEdges(base, reference);
  const f1: Record<string, PRF> = {};
  for (const tol of opts.edgeTolerances) {
    const m = matchEdges(candEdges, refEdges, tol).length;
    f1[`${Math.round(tol * 1000)}ms`] = prf(m, candEdges.length - m, refEdges.length - m);
  }
  const matched = matchEdges(candEdges, refEdges, opts.edgeMatchWindow);
  const errors = matched.map(m => Math.abs(m.error) * 1000);
  return {
    words: { ...prf(tp, fp, fn), inScope },
    time: { ...prf(both, candSec - both, refSec - both), candidateSeconds: round(candSec, 3), referenceSeconds: round(refSec, 3), overlapSeconds: round(both, 3) },
    edges: { candidate: candEdges.length, reference: refEdges.length, f1, matched: matched.length,
      medianAbsErrorMs: r1(median(errors)), p90AbsErrorMs: r1(quantile(errors, 0.9)) },
    requiredLines: { required, missing: lines.length, missingSeconds: round(total(merge(lines)), 3), lines },
  };
}

/** A labeled source range: the editor approved ("cut") or skipped ("keep") this proposed removal. */
export interface LabeledRange extends Range { mediaId: string; label: Label; origin?: string; kind?: string }

/** How a candidate cut treats each labeled decision. A range counts as cut when the candidate removes most of its base-kept part. */
export function compareToDecisions(base: Kept, candidate: Kept, labels: readonly LabeledRange[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0, scored = 0;
  for (const l of labels) {
    const kept = base.get(l.mediaId) ?? [];
    const scope = intersect([l], kept);
    const len = total(scope);
    if (len <= 1e-6) continue;
    scored++;
    const cut = total(subtract(scope, candidate.get(l.mediaId) ?? [])) / len >= 0.5;
    if (cut && l.label === "cut") tp++;
    else if (cut) fp++;
    else if (l.label === "cut") fn++;
    else tn++;
  }
  return { ...prf(tp, fp, fn), tn, scored, agreement: scored ? r3((tp + tn) / scored) : null };
}

// ---------------------------------------------------------------------------
// Pacing: the dead air and doubled words a version still plays
// ---------------------------------------------------------------------------

/**
 * A word as a version plays it, in TIMELINE seconds. A piece is a run of one recording with nothing removed inside
 * it, so two words in different pieces have a join between them.
 */
export interface PlayedWord extends Word { mediaId: string; piece: number }

export interface PacingOptions {
  /** A stretch without words this long counts as a gap. */
  gapSeconds: number;
  longGapSeconds: number;
  /** What a gap would come down to. The time over it is the dead air a tight cut would still take out. */
  beatSeconds: number;
  /** Optional maximum phrase length for a score restricted to repeats of short phrases. */
  repeatWords?: number;
  /** Maximum gap between the end of one saying and the start of the next. */
  repeatWithinSeconds: number;
}
export const DEFAULT_PACING_OPTIONS: PacingOptions = { gapSeconds: 0.5, longGapSeconds: 1, beatSeconds: 0.25, repeatWithinSeconds: 3 };

export interface PacingGap { mediaId: string; at: number; seconds: number; after: string; before: string; join: boolean }
export interface PacingRepeat { mediaId: string; at: number; text: string; words: number; join: boolean }
export interface PacingSummary {
  words: number;
  joins: number;
  /** Gaps of gapSeconds or more: inside a kept piece, across a join, and of longGapSeconds or more wherever they are. */
  gaps: { inside: number; atJoins: number; long: number; excessSeconds: number };
  medianJoinGapSeconds: number | null;
  /** A word or a run of words said twice in a row. A count to compare between cuts: deliberate emphasis is in it too. */
  repeats: { total: number; singleWords: number; phrases: number; atJoins: number };
}
export interface Pacing extends PacingSummary { gapList: PacingGap[]; repeatList: PacingRepeat[] }

const endsSentence = (text: string) => /[.?!]["'”’)\]]*$/u.test(text.trim());

/** Gaps and doubled words in what a version plays. Each recording is read on its own, in playback order. */
export function pacing(played: readonly PlayedWord[], opts: PacingOptions = DEFAULT_PACING_OPTIONS): Pacing {
  const gapList: PacingGap[] = [], repeatList: PacingRepeat[] = [], joinGaps: number[] = [];
  let words = 0, joins = 0;
  const streams = new Map<string, PlayedWord[]>();
  for (const w of played) {
    if (!token(w.text) || /^\[.*\]$/.test(w.text.trim())) continue;
    const stream = streams.get(w.mediaId);
    if (stream) stream.push(w); else streams.set(w.mediaId, [w]);
  }
  for (const [mediaId, unsorted] of streams) {
    const stream = unsorted.slice().sort((a, b) => a.start - b.start);
    const tokens = stream.map(w => token(w.text));
    words += stream.length;
    // The last word to finish holds the outgoing edge, as in overlapping speech.
    let left = stream[0];
    for (const right of stream.slice(1)) {
      const seconds = right.start - left!.end, join = left!.piece !== right.piece;
      if (join) { joins++; joinGaps.push(Math.max(0, seconds)); }
      if (seconds >= opts.gapSeconds - 1e-9) gapList.push({ mediaId, at: round(left!.end, 3), seconds: round(seconds, 3), after: left!.text.trim(), before: right.text.trim(), join });
      if (join || right.end >= left!.end) left = right;
    }
    let lastRestart = 0;
    for (let i = 0; i < stream.length - 1;) {
      // Bound the search by spoken time. Keep counting short repeats even in very slow speech.
      while (lastRestart + 1 < stream.length && stream[lastRestart + 1]!.start <= stream[i]!.start + 25) lastRestart++;
      const maxWords = opts.repeatWords ?? Math.max(5, lastRestart - i);
      let found = 0;
      for (let n = Math.min(maxWords, Math.floor((stream.length - i) / 2)); n >= 1 && !found; n--) {
        if (tokens[i] !== tokens[i + n]) continue;
        if (stream[i + n]!.start - stream[i + n - 1]!.end >= opts.repeatWithinSeconds) continue;
        // "…it. It…" ends one sentence and starts the next.
        if (n === 1 && endsSentence(stream[i]!.text)) continue;
        let matched = 1;
        while (matched < n && tokens[i + matched] === tokens[i + n + matched]) matched++;
        if (matched === n) found = n;
      }
      if (!found) { i++; continue; }
      const said = stream.slice(i, i + 2 * found);
      repeatList.push({ mediaId, at: round(said[0]!.start, 3), text: said.map(w => w.text.trim()).join(" "), words: found, join: said.some(w => w.piece !== said[0]!.piece) });
      i += found;
    }
  }
  const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  return {
    words, joins,
    gaps: { inside: count(gapList, g => !g.join), atJoins: count(gapList, g => g.join), long: count(gapList, g => g.seconds >= opts.longGapSeconds - 1e-9),
      excessSeconds: round(gapList.reduce((sum, g) => sum + g.seconds - opts.beatSeconds, 0), 1) },
    medianJoinGapSeconds: joinGaps.length ? round(median(joinGaps)!, 3) : null,
    repeats: { total: repeatList.length, singleWords: count(repeatList, r => r.words === 1), phrases: count(repeatList, r => r.words > 1), atJoins: count(repeatList, r => r.join) },
    gapList, repeatList,
  };
}

// ---------------------------------------------------------------------------
// Trace: what the agent did
// ---------------------------------------------------------------------------

export interface TaskLike {
  id: string;
  state: string;
  agent?: string;
  model?: string;
  effort?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string | null;
  error?: string;
  usage?: unknown;
}
export interface EventLike { at?: string; type: string; text: string; data?: Record<string, unknown> }

export const toolName = (raw: string) => raw.replace(/^.*(?:__|\.)/, "");

const AUDIO_TOOLS = new Set(["source_audio"]);
const AUDIO_FLAG_TOOLS = new Set(["dialogue_check_join", "dialogue_review_inspect", "change_review_cut"]);
const VISUAL_TOOLS = new Set(["frame_contact_sheet", "frame_contact_sheet_batch", "media_frame", "change_review_cut", "dialogue_review_inspect"]);
const LEVEL_TOOLS = new Set(["dialogue_check_join", "waveform_get", "dialogue_scan"]);

export interface TraceMetrics {
  state: string;
  agent?: string;
  model?: string;
  effort?: string;
  activeSeconds: number | null;
  queueSeconds: number | null;
  waitingSeconds: number;
  firstChangeSeconds: number | null;
  /** When the editor could first make a call: the first staged cut for review. How soon the editor can start deciding. */
  firstCallSeconds: number | null;
  /** When the agent saved its first recommendation on a staged cut. */
  firstRecommendationSeconds: number | null;
  toolCalls: number;
  byTool: Record<string, number>;
  errors: number;
  errorsByTool: Record<string, number>;
  questions: number;
  usage: Record<string, number> | null;
  inspection: { listened: number; listenedByTool: Record<string, number>; visual: number; levels: number; usedAudio: boolean; usedVisual: boolean };
}

const ms = (a?: string, b?: string) => a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null;

/** Numeric token counts from `task.usage`, whatever its exact shape (flat or nested one level). */
export function usageNumbers(usage: unknown): Record<string, number> | null {
  if (!usage || typeof usage !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "number" && Number.isFinite(v2)) out[`${k}.${k2}`] = v2;
  }
  return Object.keys(out).length ? out : null;
}

export function traceMetrics(task: TaskLike, events: readonly EventLike[]): TraceMetrics {
  const byTool: Record<string, number> = {}, errorsByTool: Record<string, number> = {}, listenedByTool: Record<string, number> = {};
  let visual = 0, levels = 0, waiting = 0, asked: string | undefined, questions = 0, firstChange: string | undefined;
  let firstCall: string | undefined, firstRecommendation: string | undefined;
  for (const e of events) {
    if (e.type === "tool") {
      const name = toolName(String(e.data?.tool ?? e.text.split(" ")[0]));
      byTool[name] = (byTool[name] ?? 0) + 1;
      const input = (e.data?.input ?? {}) as Record<string, unknown>;
      if (AUDIO_TOOLS.has(name) || (AUDIO_FLAG_TOOLS.has(name) && input.includeAudio === true)) listenedByTool[name] = (listenedByTool[name] ?? 0) + 1;
      if (VISUAL_TOOLS.has(name)) visual++;
      if (LEVEL_TOOLS.has(name)) levels++;
      if (name === "dialogue_review_save" && !firstRecommendation) firstRecommendation = e.at;
    } else if (e.type === "error") {
      const name = toolName(/^(\S+) failed/.exec(e.text)?.[1] ?? "agent");
      errorsByTool[name] = (errorsByTool[name] ?? 0) + 1;
    } else if (e.type === "question") {
      questions++;
      asked = e.at;
    } else if (e.type === "answer" && asked) {
      waiting += ms(asked, e.at) ?? 0;
      asked = undefined;
    } else if (e.type === "change") {
      firstChange ??= e.at;
      // A dialogue part's staged cuts arrive as its review change (chg_<plan>_review).
      if (String(e.data?.changeId ?? "").endsWith("_review")) firstCall ??= e.at;
    }
  }
  if (asked) waiting += ms(asked, task.finishedAt) ?? 0;
  const span = ms(task.startedAt, task.finishedAt);
  const listened = Object.values(listenedByTool).reduce((a, b) => a + b, 0);
  return {
    state: task.state, agent: task.agent, model: task.model, effort: task.effort,
    activeSeconds: span === null ? null : round(span - waiting, 1),
    queueSeconds: r1(ms(task.createdAt, task.startedAt)),
    waitingSeconds: round(waiting, 1),
    firstChangeSeconds: r1(ms(task.startedAt, firstChange)),
    firstCallSeconds: r1(ms(task.startedAt, firstCall)),
    firstRecommendationSeconds: r1(ms(task.startedAt, firstRecommendation)),
    toolCalls: Object.values(byTool).reduce((a, b) => a + b, 0),
    byTool: sortCounts(byTool),
    errors: Object.values(errorsByTool).reduce((a, b) => a + b, 0),
    errorsByTool: sortCounts(errorsByTool),
    questions,
    usage: usageNumbers(task.usage),
    inspection: { listened, listenedByTool, visual, levels, usedAudio: listened > 0, usedVisual: visual > 0 },
  };
}

/** The plan submitted to dialogue_apply_cuts (the last call on `version`, or the last call). */
export interface PlanCut extends Range {
  /** A word reference names the removed words instead of seconds. */
  mediaId?: string;
  fromWord?: number;
  toWord?: number;
  /** A pause reference names the word the pause follows, and optionally how long it should still play. */
  afterWord?: number;
  leave?: number;
  kind?: string;
  decision?: string;
  picture?: string;
  productionQuote?: string;
  reason?: string;
}
export interface SubmittedPlan { version: string; cuts: PlanCut[]; range?: Range; only?: string; crossfadeFrames?: number; at?: string }

export function submittedPlans(events: readonly EventLike[]): SubmittedPlan[] {
  return events.filter(e => e.type === "tool" && toolName(String(e.data?.tool ?? "")) === "dialogue_apply_cuts").flatMap(e => {
    const input = e.data?.input as Partial<SubmittedPlan> | undefined;
    return input?.version && Array.isArray(input.cuts) ? [{ version: input.version, cuts: input.cuts, range: input.range, only: input.only, crossfadeFrames: input.crossfadeFrames, at: e.at }] : [];
  });
}

/** Cuts whose edges the tool checks against the recording. */
export const isEdged = (c: PlanCut) => c.decision !== "keep" && c.picture !== "protect" &&
  (c.kind === "retake" || c.kind === "filler" || (c.kind === "coaching" && !!c.productionQuote));

export interface PlanMetrics {
  cuts: number;
  byKindDecision: Record<string, number>;
  edged: number;
  /** Share of edged cuts that a dialogue_check_join call covered: both edges within `reach` on the same version, or on the same
   * recording when `toSource` maps the versions, or the same word reference. */
  checkJoinCoverage: number | null;
}

type JoinCheck = { version: string; start?: number; end?: number; mediaId?: string; fromWord?: number; toWord?: number };

/** A run saved in parts submits several plans, each on the version its part started from. */
export function planMetrics(plans: SubmittedPlan | readonly SubmittedPlan[] | undefined, events: readonly EventLike[], reach = 0.75,
  toSource?: (version: string, range: Range) => { mediaId: string; start: number; end: number } | undefined): PlanMetrics | null {
  const list = plans === undefined ? [] : Array.isArray(plans) ? plans : [plans as SubmittedPlan];
  if (!list.length) return null;
  // One call checks one range or a list of them.
  const checks = events.filter(e => e.type === "tool" && toolName(String(e.data?.tool ?? "")) === "dialogue_check_join").flatMap(e => {
    const input = e.data?.input as (JoinCheck & { cuts?: Array<Omit<JoinCheck, "version">> }) | undefined;
    if (!input?.version) return [];
    return input.cuts ? input.cuts.map(c => ({ ...c, version: input.version })) : [input];
  });
  const near = (a: Range, b: Range) => Math.abs(a.start - b.start) <= reach && Math.abs(a.end - b.end) <= reach;
  // A part saved later starts from a newer version, so a check made earlier is compared on the recording.
  const source = (version: string, r: { start?: number; end?: number }) => typeof r.start === "number" && typeof r.end === "number"
    ? toSource?.(version, { start: r.start, end: r.end }) : undefined;
  const covers = (k: JoinCheck, c: PlanCut, version: string) => {
    if (k.mediaId !== undefined) return k.mediaId === c.mediaId && k.fromWord === c.fromWord && k.toWord === c.toWord;
    if (typeof k.start !== "number" || typeof k.end !== "number") return false;
    if (k.version === version) return near({ start: k.start, end: k.end }, c);
    const a = source(k.version, k), b = source(version, c);
    return !!a && !!b && a.mediaId === b.mediaId && near(a, b);
  };
  const byKindDecision: Record<string, number> = {};
  let cuts = 0, edged = 0, checked = 0;
  for (const plan of list) {
    cuts += plan.cuts.length;
    for (const c of plan.cuts) byKindDecision[`${c.kind ?? "?"}/${c.decision ?? "?"}`] = (byKindDecision[`${c.kind ?? "?"}/${c.decision ?? "?"}`] ?? 0) + 1;
    for (const c of plan.cuts.filter(isEdged)) {
      edged++;
      if (checks.some(k => covers(k, c, plan.version))) checked++;
    }
  }
  return { cuts, byKindDecision: sortCounts(byKindDecision), edged, checkJoinCoverage: edged ? round(checked / edged, 3) : null };
}

// ---------------------------------------------------------------------------

function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
const r1 = (v: number | null | undefined) => v === null || v === undefined ? null : round(v, 1);
const r3 = (v: number | null | undefined) => v === null || v === undefined ? null : round(v, 3);
export { overlap };
