/**
 * The planning step of dialogue_apply_cuts, without I/O: resolve word references, validate the plan,
 * verify optional quotes, check every retake, filler and quoted production edge against the recording,
 * and record each change Scarlet makes for the agent's gate report. The MCP tool supplies live reads;
 * offline replay (evals/src/replay.ts) supplies stored ones, so both run the same code.
 */
import { cutScope, normalizeTranscriptToken, selectedRange, type DialogueCutKind, type DialogueDetections, type Task } from "@scarlet/shared";
import { clipDuration, clipsAt, frameAlignedRemoval, indexClipsAt, mergeRanges, timelineDuration, timelineToSource, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { audibleClipsByTrack, round2, round3 } from "./analysis.js";
import {
  CutNotPlaced,
  NoPauseToTrim,
  SETTLED_MARGIN,
  equivalentShifts,
  resolveCutRange,
  resolveWordCut,
  secondsPauseHolds,
  type DialogueCutInput,
  type DialoguePlanSources,
} from "./dialogue-cut-resolve.js";
import {
  checkKeptWords,
  checkResumeQuote,
  dialogueAudioStream,
  dialogueCutPreview,
  dialogueJoinChecker,
  dialogueJoinWords,
  joinEvidence,
  quietFrameNote,
  soundBesideEdge,
  SAME_WORD_UNHEARD,
  type JoinPace,
} from "./dialogue-join.js";
import {
  NOTE_QUOTE_REACH,
  audibleClipsInTrackOrder,
  cutReading,
  joinPlays,
  joinText,
  keptText,
  quotesAwayFromCut,
  timelineWordsNear,
} from "./dialogue-reading.js";
import { edgeOvershoots } from "./edge-overshoot.js";
import { quietKeptWords, type QuietKeptWord } from "./quiet-kept-word.js";
import { timelineWords } from "./timeline-perception.js";

export {
  CutNotPlaced,
  NOTE_QUOTE_REACH,
  NoPauseToTrim,
  SETTLED_MARGIN,
  cutReading,
  equivalentShifts,
  joinPlays,
  keptText,
  quotesAwayFromCut,
  resolveCutRange,
  timelineWordsNear,
  type DialogueCutInput,
  type DialoguePlanSources,
};

/** An applied cut's edge this close to the sound it removes is reported to the agent: about two frames at 30 fps. */
export const SPEECH_BESIDE_EDGE = 0.06;
/** How far either side of a join its words are read, in timeline seconds: room for the words a restart is judged by. */
const JOIN_CONTEXT_SECONDS = 12;
/** Words of each side quoted when a join comes back for taking words out of a sentence. */
const EDGE_WORDS_SHOWN = 6;
/** Footage shorter than this between two cuts plays as a flash, not as something seen or heard: about three frames. */
export const SLIVER_SECONDS = .1;

/**
 * How far into each recording a set of cuts reaches: the source time under the end of its furthest cut. A stretch the
 * agent decided from the transcript alone was never paged through dialogue_scan, and cuts saved there reach it all the
 * same, on every recording under them.
 */
export function cutsReach(tl: Timeline, cuts: readonly TimeRange[]) {
  const reach = new Map<string, number>();
  const at = cuts.length > 1 ? indexClipsAt(tl) : (time: number) => clipsAt(tl, time);
  for (const cut of cuts) {
    // The last instant the cut removes. Its end is the first instant kept, which can be past the last clip.
    for (const { clip } of at(Math.max(cut.start, cut.end - 1e-6))) {
      if (clip.kind === "media") reach.set(clip.mediaId, Math.max(reach.get(clip.mediaId) ?? 0, timelineToSource(clip, cut.end)));
    }
  }
  return reach;
}

/** Each audible source instant under the given timeline times. */
export function audibleSourcePoints(tl: Timeline, times: number[]) {
  const clips = times.length > 2 ? indexClipsAt(tl) : (time: number) => clipsAt(tl, time);
  return times.flatMap(at => clips(at).flatMap(({ clip, track }) =>
    clip.kind === "media" && !track.muted && clip.enabled && clip.volume > 0 && track.kind !== "caption"
      ? [{ mediaId: clip.mediaId, t: timelineToSource(clip, at) }] : []));
}

/** One dialogue-scan page as join evidence, built the same way for the live tool and for replay. */
export function dialogueScanPage(mediaId: string, from: number, to: number, audioStream: number, segments: DialogueDetections["segments"],
  wf: Parameters<typeof joinEvidence>[1]) {
  return { mediaId, start: from, end: to, audioStream, edges: joinEvidence(segments.flatMap(s => s.words), wf), segments };
}

type ResolvedCut = Omit<DialogueCutInput, "mediaId" | "fromWord" | "toWord" | "afterWord" | "leave"> & {
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
interface PlannedDecision extends TimeRange {
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

type DialoguePlan =
  | { outcome: "preserved"; kept?: TimeRange[] }
  | { outcome: "needsRevision"; disputedEdges: Array<Partial<TimeRange> & { reason: string; quietKeptWord?: QuietKeptWord;
      /** The submitted cuts, by index, whose edges make this dispute: set them aside and the rest can be planned. */
      cuts: number[] }> }
  | { outcome: "ready"; removals: ResolvedCut[]; decisions: PlannedDecision[]; gate: Map<number, GateLine>;
      /** Ranges the plan keeps on purpose, in timeline seconds: keep decisions, however they were given, and protected pictures. */
      kept: TimeRange[];
      unreadJoinAudio?: Array<{ cut: number; reasons: string[] }> };

interface DialoguePlanRequest {
  tl: Timeline;
  cuts: DialogueCutInput[];
  /** What the calling tool accepts to resolve a repeated phrase, when it takes keeps instead of removals. */
  repeatHint?: string;
  range?: TimeRange;
  only?: DialogueCutKind;
  /** /tighten-pauses-here: pauses only, in a local passage. */
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
const CROSSES_SCOPE = "The measured edge would cross the selected range or footage marked to keep. The requested edges are staged for review.";

/** The removals whose ranges meet a disputed stretch: those either side of a piece it keeps, or those inside a join. */
const owners = (removals: ResolvedCut[], at: TimeRange) =>
  removals.filter(c => c.start <= at.end + 0.05 && c.end >= at.start - 0.05).map(c => c.input);
const phrase = (s: string) => s.trim().split(/\s+/u).map(normalizeTranscriptToken).join(" ");
const r2 = round2;

type DisputedEdge = Extract<DialoguePlan, { outcome: "needsRevision" }>["disputedEdges"][number];

/**
 * A batch as dialogue_apply_cuts saves it, shared with offline replay. A dispute names the cuts whose edges make it,
 * and the rest of the batch is saved without them, so a pass resubmits only what was disputed instead of the whole
 * batch: a refused batch cost a pass a turn and every cut again, five to seven times a pass (2026-11-16). A cut Scarlet
 * could not place is named before any edge is measured, so the rest can raise a dispute of its own once it is set
 * aside. Each round sets aside what the last one named.
 */
export async function planDialogueBatch(req: DialoguePlanRequest, sources: DialoguePlanSources): Promise<{ plan: DialoguePlan; setAside?: { cuts: number[]; disputedEdges: DisputedEdge[] } }> {
  const plan = await planDialogueCuts(req, sources);
  if (plan.outcome !== "needsRevision") return { plan };
  const disputed = new Set<number>(), edges = [...plan.disputedEdges];
  let rest: DialoguePlan | undefined = plan;
  for (let round = 0; round < 3 && rest?.outcome === "needsRevision"; round++) {
    const named: number[] = rest.disputedEdges.flatMap(d => d.cuts).filter(i => !disputed.has(i));
    if (round) edges.push(...rest.disputedEdges);
    for (const i of named) disputed.add(i);
    rest = named.length && req.cuts.some((c, i) => !disputed.has(i) && c.decision !== "keep" && c.picture !== "protect")
      ? await planDialogueCuts({ ...req, setAside: disputed }, sources).catch(() => undefined) : undefined;
  }
  return rest?.outcome === "ready" ? { plan: rest, setAside: { cuts: [...disputed].sort((a, b) => a - b), disputedEdges: edges } } : { plan };
}

/** Phase 1: resolve every cut input into timeline seconds, enforce scope and non-overlap, and check opt-in quotes. */
async function resolveAndValidatePlanCuts(req: DialoguePlanRequest, sources: DialoguePlanSources): Promise<
  | { early: DialoguePlan }
  | { early?: undefined; project: Project; duration: number; scope: TimeRange; sorted: ResolvedCut[]; removals: ResolvedCut[]; kept: TimeRange[] }
> {
  const { tl, cuts: requested, range, only, localPauses } = req;
  const otherKinds = [...new Set(requested.filter(c => c.kind !== "pause").map(c => c.kind))];
  if (localPauses && ((only && only !== "pause") || otherKinds.length))
    throw new Error(`The editor requested only pauses in the local passage (/tighten-pauses-here). Remove the ${otherKinds.join(" and ") || only} decisions.`);
  if (only && requested.some(c => c.kind !== only)) throw new Error(`only is "${only}", so every decision must be kind "${only}".`);
  // Word references become timeline seconds first; everything after is the same plan.
  const unplaced: Array<{ reason: string; cuts: number[] }> = [];
  const duration = timelineDuration(tl);
  const resolvedCuts = (await Promise.all(requested.map(async (c, i): Promise<ResolvedCut | undefined> => {
    // A cut set aside is not in this plan, so it is not placed again either.
    if (req.setAside?.has(i)) return undefined;
    const { occurrence: _occurrence, mediaId: _m, fromWord: _f, toWord: _t, afterWord, leave: _l, voiceIn: _v, ...rest } = c;
    if (afterWord !== undefined && c.kind !== "pause") throw new Error(`cuts[${i}]: afterWord names a pause. Give a ${c.kind} as its removed words or in seconds.`);
    const resolved = await resolveCutRange(tl, c, `cuts[${i}]`, sources, false, duration).catch(err => {
      // A pause with nothing to trim is a finding about that pause alone, as a cut that can't be placed is: beside
      // other cuts it is set aside with its reason and they save. Asked for on its own it is still refused, which is
      // how a caller placing one pause learns to leave the recording playing there (first-cut-ranges.ts).
      const noTrim = err instanceof NoPauseToTrim && requested.some((_, k) => k !== i && !req.setAside?.has(k));
      if (!(err instanceof CutNotPlaced) && !noTrim) throw err;
      unplaced.push({ reason: `cuts[${i}]: ${err.message}${noTrim ? " It was left out of this save; the other cuts are unaffected." : ""}`, cuts: [i] });
    });
    if (!resolved) return undefined;
    // A pause is quiet, and trimming one takes out quiet. Sound at speaking level in it is words the transcript missed
    // or mistimed, and whether they stay is a decision about words, which nobody made by asking for a shorter pause.
    // Applied with a note, as it once was, a trim after “Opus” took out the “5.5” of “Opus 5.5” (2026-11-16).
    if ("holdsSound" in resolved && resolved.holdsSound) {
      unplaced.push({ reason: `cuts[${i}]: ${resolved.notes.join(" ")} A pause trim removes quiet only, so this one was not saved.` +
        (resolved.heard ? ` ${resolved.heard} Decide on those words as you would on any: a take said again is a retake to cut, ` +
          `and words that belong play as they are.` : ` Nothing more could be read from it.`) +
        ` To remove sound there, give the range in timeline seconds as the kind of cut it is.`, cuts: [i] });
      return undefined;
    }
    // A pause given in seconds is read for what it holds, as one named by its word is.
    if (c.kind === "pause" && c.decision !== "keep" && c.picture !== "protect" && afterWord === undefined && c.mediaId === undefined) {
      const holds = await secondsPauseHolds(tl, resolved, sources);
      if (holds.length) {
        unplaced.push({ reason: `cuts[${i}]: ${holds.join(" ")} A pause trim removes quiet only, so this one was not saved. Decide on those words as you would ` +
          `on any: a take said again is a retake to cut, and words that belong play as they are. To remove them with the wait, give the range as the kind of cut it is.`, cuts: [i] });
        return undefined;
      }
    }
    // A word range whose edges found no measured quiet goes to the editor. When the same words play from another
    // saying of them with quiet at both edges, the agent can pick that one and the cut can apply as decided: on one
    // pass, two of eight such held cuts had one.
    const clean = c.mediaId !== undefined && c.fromWord !== undefined && c.toWord !== undefined && "problems" in resolved && resolved.problems.length
      ? await resolveWordCut(tl, { mediaId: c.mediaId, fromWord: c.fromWord, toWord: c.toWord }, sources, true)
        .then(r => ("alternativeWordRanges" in r ? r.alternativeWordRanges ?? [] : []).filter(a => !a.problems.length)).catch(() => [])
      : [];
    return { ...rest, start: resolved.start, end: resolved.end, input: i, ...("air" in resolved && resolved.air && { air: resolved.air }),
      ...(clean.length && { cleanAlternatives: clean.map(a => ({ fromWord: a.fromWord, toWord: a.toWord })) }),
      ...("wordRef" in resolved && { words: resolved.words, wordEdgeProblems: resolved.problems,
        ...("spoken" in resolved && { spoken: resolved.spoken, wordEdgeDips: resolved.dips, ...(resolved.breath && { wordEdgeBreath: resolved.breath }) }),
        ...("notes" in resolved && { notes: resolved.notes }) }) };
  }))).filter(c => c !== undefined);
  // Named before anything else is checked, so the caller can set these aside and plan the rest.
  if (unplaced.length) return { early: { outcome: "needsRevision", disputedEdges: unplaced.sort((a, b) => a.cuts[0]! - b.cuts[0]!) } };
  const cuts = resolvedCuts;
  const scope = cutScope(tl, req.anchor, range, localPauses);
  for (const c of cuts) {
    if (!c.spoken || c.spoken.start < scope.start || c.spoken.end > scope.end) continue;
    if (c.start < scope.start || c.end > scope.end) {
      c.start = Math.max(c.start, scope.start);
      c.end = Math.min(c.end, scope.end);
      c.wordEdgeProblems = [...(c.wordEdgeProblems ?? []), "The selected range bounds the silence beside the named words. Check the edge at the selection."];
    }
  }
  const outside = cuts.filter(c => c.start < scope.start || c.end > scope.end);
  if (outside.length) throw new Error(`cuts ${outside.map(c => c.input).join(", ")} fall outside the range ${scope.start}–${scope.end} s.`);
  // A range given as words has its edges placed by Scarlet in the silence beside the words. When the agent decides
  // that silence in the range next to it, as a pause cut before a retake, the placed edge lands inside that range
  // and the plan used to be refused: once or twice on most passes, a turn each. The placed edge gives way to the
  // range beside it, and the gate says so. The words themselves reaching into another range is still the agent's overlap to fix.
  for (const placed of cuts) {
    if (!placed.spoken) continue;
    for (const other of cuts) {
      if (other === placed || other.end <= placed.start || other.start >= placed.end) continue;
      const edge = other.end <= placed.spoken.start + 1e-6 ? "start" : other.start >= placed.spoken.end - 1e-6 ? "end" : undefined;
      if (!edge) continue;
      const was = placed[edge];
      placed[edge] = edge === "start" ? Math.max(placed.start, other.end) : Math.min(placed.end, other.start);
      if (Math.abs(placed[edge] - was) > 1e-6) placed.notes = [...(placed.notes ?? []),
        `Scarlet placed its ${edge} at ${r2(was)} s, inside cut ${other.input}; it moved to ${r2(placed[edge])} s to meet that cut.`];
    }
  }
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  // Say which range and where it landed: a range given as words is placed by Scarlet, so the agent can't see that it
  // reached into the one beside it, and "cuts 1" alone cost a pass three tries.
  const placed = (c: ResolvedCut) => `cut ${c.input} (${c.words ? "words placed at " : ""}${r2(c.start)}–${r2(c.end)} s)`;
  const bad = sorted.flatMap((c, i) => c.end <= c.start ? [`${placed(c)} is empty`]
    : c.end > duration ? [`${placed(c)} runs past the edit's end at ${duration.toFixed(2)} s`]
    : i && sorted[i - 1]!.end > c.start ? [`${placed(c)} overlaps ${placed(sorted[i - 1]!)}`] : []);
  if (bad.length) throw new Error(`${bad.join("; ")}. Submit distinct nonoverlapping ranges, protected ranges included.`);
  const removals = sorted.filter(c => c.decision !== "keep" && c.picture !== "protect");
  const kept = sorted.filter(c => c.decision === "keep" || c.picture === "protect").map(({ start, end }) => ({ start, end }));
  if (!removals.length) return { early: { outcome: "preserved", kept } };

  // Quotes are opt-in assertions about the exact cut the agent submitted.
  // Return conflicts to the caller before writing any part of the plan.
  const quoted = removals.filter(c => c.decision === "cut" &&
    ((c.kind === "retake" && c.resumeWith) || (c.kind === "coaching" && c.productionQuote)));
  const project = await sources.project();
  if (quoted.length) {
    const disputedEdges = quoted.flatMap(c => {
      let reason: string | undefined;
      if (c.kind === "coaching" && c.productionQuote) {
        reason = sources.evidence.checkProductionQuote(c, c.productionQuote, tl, project);
      } else if (c.resumeWith) {
        const result = checkResumeQuote(tl, project, c.end, sources.evidence.scans, c.resumeWith);
        if (result === "different") reason = "The surviving dialogue starts with different words than the supplied quote.";
        if (result === "unverified") reason = "The scan cannot confirm the supplied quote here.";
      }
      return reason ? [{ start: c.start, end: c.end, reason, cuts: [c.input] }] : [];
    });
    if (disputedEdges.length) return { early: { outcome: "needsRevision", disputedEdges } };
  }
  return { project, duration, scope, sorted, removals, kept };
}

/** Phase 2: check every removal's edges against the audio, apply unsureJoins, clamp neighbor collisions, and snap slivers. */
async function adjustDecisionEdges(
  req: DialoguePlanRequest,
  sources: DialoguePlanSources,
  project: Project,
  scope: TimeRange,
  sorted: ResolvedCut[],
  removals: ResolvedCut[],
  kept: TimeRange[],
  report: GateLine[],
): Promise<PlannedDecision[]> {
  const { tl } = req;
  // Every removal's edges are measured. A production aside given in seconds without its quote used to skip the check
  // and apply as typed: one ended between "this game" and "let me", in continuous speech (2026-11-15).
  if (removals.length) await sources.measure(audibleSourcePoints(tl, removals.flatMap(c => [c.start, c.end])));
  const checkJoin = dialogueJoinChecker(tl, project, sources.pages(), sources.pace);
  // An edge Scarlet could not move out of sound. The held cut is the model's to settle: an edge inside a word that is
  // sounding there is never applied as placed, and dialogue_review_save neither asks the editor about it nor cuts it
  // there. Of eighteen calls one pass handed the editor, fifteen were held this way, asked about as "listen for the end
  // of …", and most were a word or a few frames off (2026-11-16).
  const inSound = new Map<number, { reason: string; inWord: boolean }>();
  const decisions = removals.map(c => {
    const decided: PlannedDecision = { start: c.start, end: c.end, reason: c.reason, review: c.decision === "review", kind: c.kind,
      originalRange: undefined, ...(c.check && { check: c.check }), ...(c.summary && { summary: c.summary }) };
    const adjust = (next: PlannedDecision, found: string) => {
      const reach = next.originalRange ?? next;
      if (reach.start < scope.start || reach.end > scope.end || kept.some(k => reach.start < k.end && reach.end > k.start)) {
        const evidence = CROSSES_SCOPE;
        next = { ...decided, review: true, held: evidence };
        found = `The measured range is ${r2(reach.start)}–${r2(reach.end)} s. ${evidence}`;
      }
      const moved = Math.abs(next.start - c.start) > 1e-6 || Math.abs(next.end - c.end) > 1e-6;
      report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: next.review ? "review" : "cut",
        range: [r2(next.start), r2(next.end)], ...(moved && { from: [r2(c.start), r2(c.end)] }), evidence: found });
      return next;
    };
    // A restart that begins on the word the first take broke off after, with no pause for the cut to start in: the
    // cut starts where that word begins, found by matching it to the retake's (sameWordJoin). Nothing here can hear
    // that join. Such a cut used to wait for the editor whatever unsureJoins said, and the engine let no later cut
    // replace it (his rule, 2026-11-17). Since 2026-11-21 it is held as any join Scarlet can't place cleanly is, and
    // unsureJoins cut applies it where Scarlet placed it: the model decides; the default is in the skill.
    const same = c.kind === "retake" && c.decision !== "keep" ? checkJoin({ start: c.start, end: c.end }, c.spoken, c.air) : undefined;
    const offered = same?.sameWordJoin, said = offered && "“" + offered.word + "”";
    // A range that starts right after kept words the take says again leaves them playing twice. Scarlet used to extend
    // the cut back over them; that took out words the model never named, so since 2026-11-21 the gate says where a cut
    // that takes them out starts, and the model resends it there or doesn't. The range goes on as given.
    if (offered?.takesFirst) {
      const twice = "“" + offered.takesFirst + "”", them = offered.takesFirst.includes(" ") ? "them" : "it";
      c.notes = [...(c.notes ?? []), `The range as given leaves the first ${twice} playing twice: the take says ${them} again right after the cut. ` +
        `A cut from ${offered.start.toFixed(3)} s takes ${them} out too: the first ${said} begins there, matched on its sound to the second, and the word before runs into it with no pause.`];
    }
    // Said of the cut as saved: the check's own words offer the seconds, and a pass sent the cut again on them.
    const placed = same?.sameWord ? { start: same.start, end: same.end, reason: same.reason ?? "" } : offered && !offered.takesFirst && { start: offered.start, end: offered.end,
      reason: `Placed from ${r2(offered.start)} s, where the first ${said} begins: the word before runs into it with no pause, so Scarlet found its start by matching it to the second ${said} on their sound. ` +
        `No kept word is cut as measured. ${SAME_WORD_UNHEARD}` };
    if (placed) {
      inSound.set(c.input, { inWord: false, reason: placed.reason });
      return adjust({ ...decided, start: placed.start, end: placed.end, review: true, held: placed.reason, unheard: true }, placed.reason);
    }
    // Word edges without measured silence fall back to word timings, which is not a confident edge.
    const fallback = c.wordEdgeProblems?.length && !decided.review
      ? { review: true, held: c.wordEdgeProblems.join(" ") } : undefined;
    const alternatives = c.cleanAlternatives?.map(a => `#${a.fromWord}–#${a.toWord}`).join(", ");
    const base = fallback ? adjust({ ...decided, ...fallback }, [...c.wordEdgeProblems!, ...(alternatives
      ? [`Words ${alternatives} leave the same words playing and have measured quiet at both edges.`] : [])].join(" ")) : decided;
    // Removed words whose two edges Scarlet placed itself, in the measured silence beside them or at the dip between
    // two words that run together, are not checked a second time: that check takes a brief dip for speech and held
    // every cut of a doubled word for the editor. What was measured at a dip goes back to the agent.
    if (c.spoken && !c.wordEdgeProblems?.length) return c.wordEdgeDips?.length ? adjust(decided, c.wordEdgeDips.join(" ")) : base;
    const join = same ?? checkJoin({ start: c.start, end: c.end }, c.spoken, c.air);
    // Without a measurement at the edge there is nothing to act on. The agent's own evidence stands.
    if (join.unmeasured) return base;
    // An edge left in sound: what Scarlet measured goes with the held cut, for the model's review. Named words say what
    // goes, so the quiet or low points that keep or take another word are no help there; a pass offered them resent
    // cuts that broke the sentence (2026-11-16).
    // A pause too: it is quiet from end to end, and one whose edge stays in sound was typed into speech. Applied as
    // typed, a pause given in seconds kept an edge inside a word (found reviewing the planner, 2026-11-20).
    if (join.inSound?.length) {
      const named = c.words !== undefined && c.kind !== "pause" && !join.inWord?.length;
      inSound.set(c.input, { inWord: !!join.inWord?.length, reason: named
        ? `The words named run on into the ones beside them at the ${join.inSound.join(" and ")}: no pause or low point where they part, a join in running speech.`
        : join.reason ?? "" });
    }
    // Both edges in quiet: one whose frame would round onto sound goes on a quiet frame, which the engine's rounding
    // keeps. A move of under a frame that would meet a neighbor, the selection's edge or footage marked to keep stays.
    if (join.status === "unchanged") {
      const i = sorted.indexOf(c), frame = 1 / project.settings.fps;
      const start = (!i || sorted[i-1]!.end <= join.start - frame) && join.start >= scope.start && !kept.some(k => k.end > join.start && k.end <= c.start) ? join.start : c.start;
      const end = (i === sorted.length - 1 || join.end + frame <= sorted[i+1]!.start) && join.end <= scope.end && !kept.some(k => k.start < join.end && k.start >= c.end) ? join.end : c.end;
      // An edge Scarlet moved is reported with what it measured, as every other move is.
      const moved = end > start ? quietFrameNote(c, { start, end }) : undefined;
      return moved ? adjust({ ...base, start, end }, moved) : base;
    }
    // A pause is quiet from end to end, so one whose edge is on sound was placed from a word's timing, which often
    // starts a tenth of a second after the word does. Its edges go onto the measured quiet beside them: that keeps
    // the word and leaves a little more air, so it stays the cut the agent decided. An edge with no quiet in reach
    // stays where the agent put it, and so does a pause whose move would reach into the range beside it.
    if (c.kind === "pause" && !join.inSound?.length) {
      const i = sorted.indexOf(c), frame = 1 / project.settings.fps + 1e-6;
      const removed = (n?: ResolvedCut) => n && n.decision !== "keep" && n.picture !== "protect" ? n : undefined;
      const before = removed(sorted[i-1]), after = removed(sorted[i+1]);
      // An edge that meets the removal beside it stays with it: moved inward it would leave a few frames of picture between the two.
      const start = before && c.start - before.end <= frame ? c.start : join.start;
      const end = after && after.start - c.end <= frame ? c.end : join.end;
      const clear = (!i || sorted[i-1]!.end <= start) && (i === sorted.length - 1 || end <= sorted[i+1]!.start);
      const moved = (join.status === "snapped" || join.status === "adjusted" || join.status === "partial") && (start !== c.start || end !== c.end);
      return moved && clear && end - start > 1e-6 ? adjust({ ...base, start, end },
        (join.reason ?? "").replace("Adjusted retake boundaries", "Moved the pause's edges onto the recording's quiet").replace(" Preview the join in context.", "")) : base;
    }
    // A few frames onto measured silence keeps every word. Apply it as decided unless it would meet a neighbor.
    const i = sorted.indexOf(c);
    if (join.status === "snapped" && (!i || sorted[i-1]!.end <= join.start) && (i === sorted.length - 1 || join.end <= sorted[i+1]!.start))
      return adjust({ ...base, start: join.start, end: join.end }, join.reason ?? "");
    if (join.status === "snapped") return adjust({ ...base, review: true, held: "The nearest silence at an edge overlaps the neighboring range." },
      "The nearest silence at an edge overlaps the neighboring range.");
    // A production aside keeps its verified quote range. Without measured silence at its edges it waits for audition.
    if (c.kind === "coaching") return adjust({ ...base, review: true, held: join.reason ?? "No measured silence at an edge of this production aside." }, join.reason ?? "");
    // The editor can restore the whole proposal. An edge may also move outward into a pause, so the range covers both.
    return adjust({ ...base, start: join.start, end: join.end, review: true,
      originalRange: join.status === "adjusted" || join.status === "partial"
        ? { start: Math.min(c.start, join.start), end: Math.max(c.end, join.end) } : undefined,
      ...(join.reason && { held: join.reason }) }, join.reason ?? "");
  });
  // What a held edge left in sound plays, with what was measured there, for the model's review: the join as placed,
  // and the passage as it plays if the cut is kept instead.
  await Promise.all(removals.map(async (c, i) => {
    const found = inSound.get(c.input), d = decisions[i]!;
    if (!found || !d.review) return;
    const range = { start: d.start, end: d.end };
    const heard = await timelineWordsNear(tl, project, range, mediaId => sources.words(mediaId, undefined, false), 6);
    const plays = joinText(heard, range), kept = keptText(heard, range);
    d.held = [found.reason, plays && `As placed the join plays “${plays}”.`, kept && `Kept, it plays “${kept}”.`]
      .filter(Boolean).join(" ").slice(0, 800);
  }));
  // A cut the model decided that Scarlet held only for how its join measured applies as placed when the model said
  // so. A hold for the selection or footage marked to keep stays: that is the editor's, not a measurement. So does an
  // edge inside a word that is sounding there: offered the way round, one pass sent 21 of its 33 saves with
  // unsureJoins cut and applied ten such edges (2026-11-16). A same-word join applies too (2026-11-21): no word is
  // clipped there, and whether a join no one has heard goes in is the model's call, by its skill.
  if (req.unsureJoins === "cut") decisions.forEach((d, i) => {
    const c = removals[i]!;
    if (c.decision !== "cut" || !d.review || !d.held || d.held === CROSSES_SCOPE || inSound.get(c.input)?.inWord) return;
    const { unheard: _staged, ...applied } = d;
    decisions[i] = { ...applied, review: false, held: undefined, originalRange: undefined, appliedAsPlaced: true };
    const line = report.findLast(l => l.cut === c.input);
    if (line) Object.assign(line, { outcome: "cut", evidence: `Applied as placed, as unsureJoins asked: ${line.evidence}` });
  });
  // The submitted ranges don't overlap, but an edge Scarlet moved can reach into the range beside it: two cuts that
  // meet at one instant, and the first one's end moved out into the pause the second removes. The engine rejects
  // overlapping ranges, and the agent can't see which edge moved. Hold each moved edge at its neighbor instead:
  // both stretches are decided either way, so nothing more or less comes out.
  for (let i = 1; i < decisions.length; i++) {
    const before = decisions[i - 1]!, after = decisions[i]!;
    const asked = { before: removals[i - 1]!, after: removals[i]! };
    const reach = (d: PlannedDecision) => ({ start: Math.min(d.start, d.originalRange?.start ?? d.start), end: Math.max(d.end, d.originalRange?.end ?? d.end) });
    if (reach(before).end <= reach(after).start + 1e-9) continue;
    // Somewhere between where the agent ended the first range and began the second, preferring the second's own start.
    const meet = Math.min(Math.max(after.start, asked.before.end), asked.after.start);
    const held = (d: PlannedDecision, c: ResolvedCut, range: TimeRange) => {
      const moved = Math.abs(range.start - d.start) > 1e-9 || Math.abs(range.end - d.end) > 1e-9;
      // An adjustment that leaves nothing of the range falls back to the range as asked, held for the agent's closer
      // look with what Scarlet measured, as every other cut it can't place is.
      const next: PlannedDecision = range.end - range.start > 1e-9 ? { ...d, ...range } : { ...d, start: c.start, end: c.end, review: true,
        ...(!d.review && { held: `Its edges as measured meet the neighboring range at ${r2(meet)} s, which leaves nothing of it to remove.` }) };
      const original = d.originalRange && { start: Math.max(d.originalRange.start, d === before ? -Infinity : meet), end: Math.min(d.originalRange.end, d === before ? meet : Infinity) };
      next.originalRange = original && original.end > original.start ? original : undefined;
      if (moved || next.review !== d.review) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: next.review ? "review" : "cut",
        range: [r2(next.start), r2(next.end)], from: [r2(c.start), r2(c.end)], evidence: `Held at the neighboring range at ${r2(meet)} s.` });
      return next;
    };
    decisions[i - 1] = held(before, asked.before, { start: before.start, end: Math.min(before.end, meet) });
    decisions[i] = held(after, asked.after, { start: Math.max(after.start, meet), end: after.end });
  }
  // A removal that stops a few frames short of a join an earlier save made leaves those frames playing between the
  // two, a flash of picture and a blip of sound: one pass left four of 1-3 frames, each where a cut given in seconds
  // ended or began just beside an earlier one (2026-11-16). The edge goes on to the join, and the gate says so.
  const joinsHere = versionJoins(tl);
  decisions.forEach((d, i) => {
    if (d.review) return;
    const c = removals[i]!;
    for (const side of ["start", "end"] as const) {
      const at = d[side];
      const join = joinsHere.find(t => side === "end" ? t > at + 1e-6 && t - at < SLIVER_SECONDS : t < at - 1e-6 && at - t < SLIVER_SECONDS);
      if (join === undefined || join < scope.start - 1e-6 || join > scope.end + 1e-6) continue;
      const reach = side === "end" ? { start: at, end: join } : { start: join, end: at };
      if (kept.some(k => k.start < reach.end - 1e-9 && k.end > reach.start + 1e-9)) continue;
      if (decisions.some((o, k) => k !== i && o.start < reach.end - 1e-9 && o.end > reach.start + 1e-9)) continue;
      d[side] = join;
      report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "cut", range: [r2(d.start), r2(d.end)],
        evidence: `The ${side} met the join at ${r2(join)} s: the ${Math.round(Math.abs(join - at) * 1000)} ms between would have played as a flash between two cuts.` });
    }
  });
  return decisions;
}

/** Phase 3: verify surviving joins for quiet kept words, repeat-at-join, pickup repeats, partial-word repeats, and overshoots. */
async function verifySurvivingJoins(
  req: DialoguePlanRequest,
  sources: DialoguePlanSources,
  project: Project,
  duration: number,
  scope: TimeRange,
  sorted: ResolvedCut[],
  removals: ResolvedCut[],
  decisions: PlannedDecision[],
  kept: TimeRange[],
  report: GateLine[],
): Promise<{ disputedEdges?: DisputedEdge[]; unreadJoinAudio: Array<{ cut: number; reasons: string[] }> }> {
  const { tl, only } = req;
  const checkRetakes = !only || only === "retake";
  const { media, settings: { fps } } = project;
  const retained = sorted.filter(c => c.decision === "keep" || c.picture === "protect");
  const unreadJoinAudio: Array<{ cut: number; reasons: string[] }> = [];
  const applied = mergeRanges(decisions.filter(d => !d.review), 1e-9);
  const align = (r: TimeRange) => frameAlignedRemoval(r, fps, scope, kept);
  const appliedFrames = applied.map(align);
  const quiet = await quietKeptWords(tl, project, appliedFrames, [...kept, ...decisions.filter(d => d.review)], scope, sources);
  if (quiet.length) return { disputedEdges: quiet.map(q => ({ ...q, cuts: owners(removals, q) })), unreadJoinAudio };
  const speechCuts = removals.flatMap((c, i) => c.kind !== "pause" && c.decision === "cut" ? [{ c, d: decisions[i]! }] : []);
  // A pause trim joins the words either side of it. Where they are the same, the pause was the gap of a restart, and
  // the trim plays the word twice: "every single ‖ single pastry" and "equals B7 ‖ equals B7" were saved as pauses on
  // one pass, among twelve pause saves sent at once (2026-11-16). The transcript's words say so; nothing is decoded.
  const pauseCuts = req.localPauses ? [] : removals.flatMap((c, i) => c.kind === "pause" && c.decision === "cut" && !decisions[i]!.review ? [{ c, d: decisions[i]! }] : []);
  if (!(speechCuts.length && checkRetakes) && !pauseCuts.length) return { unreadJoinAudio };

  const optional = mergeRanges(decisions.filter(d => d.review), 1e-9);
  const atAfter = (at: number, ranges: TimeRange[]) => at - ranges.reduce((removed, r) =>
    removed + Math.max(0, Math.min(at, r.end) - r.start), 0);
  const onApplied = optional.map(align).map(r => ({ start: atAfter(r.start, appliedFrames), end: atAfter(r.end, appliedFrames) }));
  const fade = (sources.crossfadeFrames ?? 0) / fps;
  let appliedTimeline: Timeline | undefined, stagedTimeline: Timeline | undefined;
  const appliedPreview = () => appliedTimeline ??= dialogueCutPreview(tl, media, appliedFrames, fade);
  const stagedPreview = () => stagedTimeline ??= dialogueCutPreview(appliedPreview(), media, mergeRanges(onApplied, 1e-9), fade);
  const pages = sources.pages();
  const selection = selectedRange(req.anchor) ? scope : undefined;
  const read = sources.readKeptWords;
  // The transcript words each recording plays, in transcript_get order, read once for every join of the plan.
  let transcriptsRead: Promise<Map<string, TranscriptWord[]>> | undefined;
  const transcripts = () => transcriptsRead ??= (async () => {
    const found = new Map<string, TranscriptWord[]>();
    await Promise.all([...new Set(audibleClipsInTrackOrder(tl).map(c => c.mediaId))].map(async id => {
      const words = await sources.words(id, undefined, false).catch(() => null);
      if (words?.length) found.set(id, words);
    }));
    return found;
  })();
  const middle = (w: TimeRange) => (w.start + w.end) / 2;
  // What one applied join plays and takes out, as words: the ones it removes on this version, and the ones the
  // version with this part's cuts plays up to it and from it on.
  const joinWords = (said: Map<string, TranscriptWord[]>, range: TimeRange, at: number) => {
    const around = timelineWords(appliedPreview(), said, { start: at - JOIN_CONTEXT_SECONDS, end: at + JOIN_CONTEXT_SECONDS });
    return { before: around.filter(w => middle(w) < at).map(w => w.text), after: around.filter(w => middle(w) >= at).map(w => w.text),
      removed: timelineWords(tl, said, range).filter(w => middle(w) >= range.start && middle(w) < range.end).map(w => w.text) };
  };
  const wordsAtJoin = async (range: TimeRange, at: number) => {
    const said = await transcripts();
    return said.size ? joinWords(said, range, at) : undefined;
  };
  // The scan's own reading of each recording, page after page: each page gives the words past the last one taken.
  let scanReading: Map<string, TranscriptWord[]> | undefined;
  const scanned = () => {
    if (scanReading) return scanReading;
    scanReading = new Map();
    for (const page of sources.evidence.scans.filter(s => s.segments?.length).sort((a, b) => a.start - b.start)) {
      const list = scanReading.get(page.mediaId) ?? [];
      const from = list.at(-1)?.end ?? -Infinity;
      list.push(...page.segments!.flatMap(s => s.words).filter(w => w.text.trim() && (w.start + w.end) / 2 >= from).sort((a, b) => a.start - b.start));
      scanReading.set(page.mediaId, list);
    }
    return scanReading;
  };
  /**
   * The same join in the words the scan read, when its pages hold both of the join's edges. A transcript tidies a
   * restart away and times the words it keeps on whichever take it likes: of “which is funny because, which is, uh,
   * which is funny because as a company” it had one “which is” on the take before the last, so a cut that ended
   * right before the last take read as taking “which is” from it (2026-11-19).
   */
  const scanWordsAtJoin = (range: TimeRange, at: number) => {
    const reading = scanned();
    const held = (t: number) => audibleClipsInTrackOrder(tl).some(c => {
      if (t < c.timelineIn || t >= c.timelineIn + clipDuration(c)) return false;
      const source = timelineToSource(c, t);
      return sources.evidence.scans.some(s => s.mediaId === c.mediaId && s.segments?.length && s.start <= source && source <= s.end);
    });
    return reading.size && held(Math.max(0, range.start - .5)) && held(Math.min(duration - 1e-3, range.end + .5)) ? joinWords(reading, range, at) : undefined;
  };
  // Existing doubled-word checks apply to the version that will actually be kept. A requested cut that
  // placement sends to review can still leave a partial repeat in its preview; return that to its author too.
  // A phrase that preview plays twice is reported on the held cut, not refused: the model settles a held cut
  // (AI-AGENTS rules 5 and 6). One pass left “in which it ‖ which it is about” held, and it reached the editor
  // unchecked (2026-11-21).
  const jobs = [{ joins: applied, preview: appliedPreview, forReview: false }];
  if (speechCuts.some(({ d }) => d.review))
    jobs.push({ joins: mergeRanges(decisions, 1e-9), preview: stagedPreview, forReview: true });
  const issuesByJoin = await Promise.all(jobs.flatMap(({ joins, preview, forReview }) => {
    const played = joins.map(align);
    return joins.map(async (join, i) => {
      const contributing = checkRetakes ? speechCuts.filter(({ d }) => d.review === forReview && join.start <= d.start && d.end <= join.end) : [];
      const range = played[i]!;
      const previous = Math.max(played[i - 1]?.end ?? 0, selection?.start ?? 0);
      const next = Math.min(played[i + 1]?.start ?? duration, selection?.end ?? duration);
      if (!contributing.length) {
        const trims = forReview ? [] : pauseCuts.filter(({ d }) => join.start <= d.start && d.end <= join.end);
        if (!trims.length) return [];
        const { repeatAtJoin } = await checkKeptWords(tl, project, range, dialogueJoinWords(tl, project, range, pages), undefined, previous, next);
        const keptRepeats = trims.flatMap(({ c }) => c.keepRepeat ?? []).map(phrase);
        if (!repeatAtJoin || keptRepeats.includes(phrase(repeatAtJoin.words))) return [];
        const { before, after, words } = repeatAtJoin, cut = trims[0]!.c.input;
        return [{ ...range, cut, repeat: repeatAtJoin, cuts: trims.map(({ c }) => c.input),
          reason: `The pause trim plays “${words}” twice, at ${before.start}–${before.end} s before it and ${after.start}–${after.end} s after it: ` +
            `the pause was the gap of a restart. Remove the first saying with the pause (mediaId with fromWord/toWord). If both belong, include “${words}” in keepRepeat on cut ${cut}.` }];
      }
      const playback = { preview, at: atAfter(range.start, played), partialOnly: forReview };
      const { repeatAtJoin, partialWordRepeat, pickupRepeats, unread } = await checkKeptWords(tl, project, range,
        dialogueJoinWords(tl, project, range, pages), read, previous, next, playback);
      if (unread.length) unreadJoinAudio.push({ cut: contributing[0]!.c.input, reasons: unread });
      const acknowledged = contributing.flatMap(({ c }) => c.keepRepeat ?? []).map(phrase);
      const issues = [];
      if (!forReview && repeatAtJoin && acknowledged.includes(phrase(repeatAtJoin.words))) kept.push(repeatAtJoin.before, repeatAtJoin.after);
      if (forReview && repeatAtJoin && !acknowledged.includes(phrase(repeatAtJoin.words))) {
        const { before, after, words } = repeatAtJoin;
        const evidence = `As staged, the join plays “${words}” twice, at ${before.start}–${before.end} s before the cut and ${after.start}–${after.end} s after it.`;
        for (const { c, d } of contributing) {
          d.held = [d.held, evidence].filter(Boolean).join(" ");
          report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "review", range: [r2(d.start), r2(d.end)], evidence });
        }
      }
      if (!forReview && repeatAtJoin && !acknowledged.includes(phrase(repeatAtJoin.words))) {
        const { before, after, words } = repeatAtJoin;
        issues.push({ cut: contributing[0]!.c.input, repeat: repeatAtJoin, words, reason: `The join plays “${words}” twice, at ${before.start}–${before.end} s before the cut and ${after.start}–${after.end} s after it.` });
      }
      for (const pickup of forReview ? [] : pickupRepeats) {
        const { first, second, side, words } = pickup;
        if (acknowledged.includes(phrase(words))) { kept.push(first, second); continue; }
        if (retained.some(r => r.start < second.end && first.start < r.end)) continue;
        const cut = (side === "start" ? contributing[0] : contributing.at(-1))!.c.input;
        issues.push({ cut, pickup, words, reason: `The kept take ${side === "end" ? "starts" : "ends"} with “${words}” twice, at ${first.start}–${first.end} s and ${second.start}–${second.end} s.` });
      }
      if (partialWordRepeat && !acknowledged.includes(phrase(partialWordRepeat.word))) {
        const { heard, word, side } = partialWordRepeat;
        const target = side === "start" ? contributing[0]! : contributing.at(-1)!;
        // Only the cut responsible for this outside edge can repair it. A neighbor may have been staged explicitly.
        if (side === "start" ? target.d.start === join.start : target.d.end === join.end)
          issues.push({ cut: target.c.input, partialWordRepeat, words: word,
            reason: `The ${side === "start" ? "outgoing" : "incoming"} audio plays “${heard}” from a cut-off “${word}” beside another “${word}”.` });
      }
      // A restart cut that runs past the restart takes words the sentence needs, and nothing at the join says them
      // again. Only a tool that takes removals can say they go on purpose (dropWords).
      const said = forReview || req.repeatHint ? undefined : await wordsAtJoin(range, playback.at);
      const dropped = contributing.flatMap(({ c }) => c.dropWords ?? []).map(phrase);
      const joinPlays = said && `…${said.before.slice(-EDGE_WORDS_SHOWN).join(" ")} ‖ ${said.after.slice(0, EDGE_WORDS_SHOWN).join(" ")}…`;
      // An overshoot the transcript shows and the scan's reading of the same join doesn't is the transcript's tidying.
      const asScanned = said ? scanWordsAtJoin(range, playback.at) : undefined;
      const alsoRead = asScanned && new Set(edgeOvershoots(asScanned.before, asScanned.removed, asScanned.after).map(o => o.side));
      for (const { side, words } of said ? edgeOvershoots(said.before, said.removed, said.after) : []) {
        if (dropped.includes(phrase(words)) || (alsoRead && !alsoRead.has(side))) continue;
        const target = side === "out" ? contributing[0]! : contributing.at(-1)!;
        if (side === "out" ? target.d.start !== join.start : target.d.end !== join.end) continue;
        const them = words.includes(" ") ? "them" : "it";
        issues.push({ cut: target.c.input, takenWords: { side, words }, words, joinPlays,
          reason: `The join would play “${joinPlays}”: the cut takes “${words}” ${side === "out"
            ? "from the end of what plays before it" : "from the start of the take it resumes with"}, and nothing either side of the join says ${them} again.`,
          hint: `If the restart ${side === "out" ? "starts after" : "ends before"} “${words}”, move that edge of the removal off ${them}. If “${words}” should go, include it in dropWords on cut ${target.c.input}.` });
      }
      return issues.map(({ cut, words, reason, hint, ...evidence }: { cut: number; words: string; reason: string; hint?: string } & Record<string, unknown>) =>
        ({ ...range, cut, ...evidence, cuts: contributing.map(({ c }) => c.input),
          reason: reason + " " + (hint ?? req.repeatHint ?? `Include one occurrence in the removal using word indices or new edges. If both belong, include “${words}” in keepRepeat on cut ${cut}.`) }));
    });
  }));
  const disputedEdges = issuesByJoin.flat();
  return { ...(disputedEdges.length && { disputedEdges }), unreadJoinAudio };
}

/** Phase 4: attach speech-beside-edge evidence, notes, seconds-placed retake readings, and merge the gate map. */
async function appendGateEvidence(
  tl: Timeline,
  project: Project,
  sources: DialoguePlanSources,
  removals: ResolvedCut[],
  decisions: PlannedDecision[],
  report: GateLine[],
): Promise<Map<number, GateLine>> {
  const { media } = project;
  // An applied cut whose edge sits right beside the sound it removes is reported to the agent: the picture can show a
  // word starting that the sound has not reached yet. It is evidence, not a flag. Whether the join needs the editor is
  // the agent's call, made with its own `check` or `edit_flag`: flagging every such join sent 13 of 81 cuts to the
  // editor on one pass (2026-11-14). Edges with no reading there are not reported.
  // A pause takes out a wait, and what sounds in it goes with it; this is about the words a cut takes out.
  const near = SPEECH_BESIDE_EDGE;
  const edgePages = sources.pages();
  removals.forEach((c, i) => {
    const d = decisions[i]!;
    if (d.review || d.check || c.kind === "pause") return;
    const close: string[] = [];
    for (const [at, side] of [[d.start, "out"], [d.end, "in"]] as const) {
      // The clip that plays the removed side: from the start onward, and up to the end. At a clip's edge the end's is
      // the clip that ends there, not the kept one that starts there.
      for (const { clip, track } of clipsAt(tl, side === "out" ? at : Math.max(d.start, at - 1e-6))) {
        if (clip.kind !== "media" || track.muted || !clip.enabled || !clip.volume || track.kind === "caption") continue;
        const asset = media.find(m => m.id === clip.mediaId);
        const stream = dialogueAudioStream(clip) ?? (asset && dialogueAudioStream(asset)) ?? 0;
        // Only what this clip plays of the removal: the recording before or after it isn't in the video.
        const speed = clip.speed ?? 1, inClip = side === "out" ? clip.timelineIn + clipDuration(clip) - at : at - clip.timelineIn;
        const gap = soundBesideEdge(edgePages, clip.mediaId, stream, timelineToSource(clip, at), side, Math.min(near, d.end - d.start, inClip) * speed);
        if (gap === undefined) continue;
        close.push(side === "out" ? `the removed sound starts ${gap.toFixed(2)} s after the cut` : `the removed sound ends ${gap.toFixed(2)} s before the join`);
        break;
      }
    }
    if (!close.length) return;
    report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "cut",
      range: [r2(d.start), r2(d.end)], evidence: `In the recording ${close.join(" and ")}, close enough for the picture to show it. The cut applies as decided.` });
  });
  removals.forEach((c, i) => {
    const d = decisions[i]!;
    if (c.notes?.length) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: d.review ? "review" : "cut",
      range: [r2(d.start), r2(d.end)], evidence: c.notes.join(" ") });
  });
  // An applied retake or coaching cut is reported with what it takes out and what its join plays, however it was named.
  // A range meant for the first take can sit on the pause after it or on the retake itself, and a word reference that
  // takes out the later try of a line never finished leaves the first playing as a fragment: a pass cut “they, they do
  // believe.” by its words and played “They do believe ‖ And so what happens” with nothing in its result saying so
  // (2026-11-22). Pauses and fillers take out no words a sentence needs, so they aren't read.
  await Promise.all(removals.map(async (c, i) => {
    const d = decisions[i]!;
    if (d.review || (c.kind !== "retake" && c.kind !== "coaching") || c.decision !== "cut") return;
    const heard = await cutReading(tl, project, d, mediaId => sources.words(mediaId, undefined, false));
    if (heard.plays) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "cut", range: [r2(d.start), r2(d.end)],
      ...(c.words === undefined && { removes: heard.removes ?? "" }), plays: heard.plays });
  }));
  // One line per submitted range: a later adjustment replaces an earlier one, keeping both reasons.
  const gate = new Map<number, GateLine>();
  for (const line of report) {
    const prior = gate.get(line.cut);
    gate.set(line.cut, prior ? { ...prior, ...line, evidence: [prior.evidence, line.evidence].filter(Boolean).join(" ") } : line);
  }
  for (const c of removals) if (c.words && !gate.has(c.input)) {
    const d = decisions[removals.indexOf(c)]!;
    gate.set(c.input, { cut: c.input, kind: c.kind, words: c.words, asked: c.decision, outcome: d.review ? "review" : "cut", range: [r2(d.start), r2(d.end)] });
  }
  // A breath after the last kept word is reported whichever side of it the cut starts, so the model sees what `breath` chose between.
  for (const c of removals) {
    const line = c.wordEdgeBreath ? gate.get(c.input) : undefined;
    if (line) line.evidence = [typeof line.evidence === "string" ? line.evidence : "", c.wordEdgeBreath].filter(Boolean).join(" ");
  }
  return gate;
}

/** Everything dialogue_apply_cuts decides before it sends the plan to the engine. Throws on an invalid plan. */
export async function planDialogueCuts(req: DialoguePlanRequest, sources: DialoguePlanSources): Promise<DialoguePlan> {
  const validated = await resolveAndValidatePlanCuts(req, sources);
  if (validated.early) return validated.early;
  const { project, duration, scope, sorted, removals, kept } = validated;
  // Every change Scarlet makes to the plan goes back to the agent with its evidence.
  const report: GateLine[] = [];
  const decisions = await adjustDecisionEdges(req, sources, project, scope, sorted, removals, kept, report);
  const verified = await verifySurvivingJoins(req, sources, project, duration, scope, sorted, removals, decisions, kept, report);
  if (verified.disputedEdges) return { outcome: "needsRevision", disputedEdges: verified.disputedEdges };
  const gate = await appendGateEvidence(req.tl, project, sources, removals, decisions, report);
  return { outcome: "ready", removals, decisions, gate, kept,
    ...(verified.unreadJoinAudio.length && { unreadJoinAudio: verified.unreadJoinAudio.sort((a, b) => a.cut - b.cut) }) };
}

/** Summarize measured adjustments in the order the model submitted its decisions. */
export function dialogueGate(plan: Extract<DialoguePlan, { outcome: "ready" }>) {
  const report = [...plan.gate.values()].sort((a, b) => a.cut - b.cut);
  return { unchangedCuts: plan.removals.length - report.length, decisions: report };
}

/** Timeline seconds where the footage an audible track plays jumps: the joins earlier cuts left on this version. */
export function versionJoins(tl: Timeline) {
  const joins = new Set<number>();
  for (const track of audibleClipsByTrack(tl)) {
    const clips = [...track].sort((a, b) => a.timelineIn - b.timelineIn);
    for (let k = 1; k < clips.length; k++) {
      const a = clips[k - 1]!, b = clips[k]!;
      // An audio crossfade overlaps the two clips by a frame or two around the cut, which is the overlap's middle: a cut
      // extended only to where the incoming clip's sound begins still left a frame of picture there (2026-11-16).
      const aEnd = a.timelineIn + clipDuration(a);
      if (Math.abs(aEnd - b.timelineIn) > .1) continue;
      if (a.mediaId === b.mediaId && Math.abs(a.sourceOut - b.sourceIn) < .01) continue;
      joins.add(round3(aEnd > b.timelineIn ? (aEnd + b.timelineIn) / 2 : b.timelineIn));
    }
  }
  return [...joins].sort((a, b) => a - b);
}
