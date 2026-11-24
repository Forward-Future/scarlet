/**
 * The planning step of dialogue_apply_cuts, without I/O: resolve word references, validate the plan,
 * verify optional quotes, check every retake, filler and quoted production edge against the recording,
 * and record each change Scarlet makes for the agent's gate report. The MCP tool supplies live reads;
 * offline replay (evals/src/replay.ts) supplies stored ones, so both run the same code.
 */
import { cutScope, type DialogueDetections } from "@scarlet/shared";
import { clipDuration, clipsAt, indexClipsAt, timelineDuration, timelineToSource, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { round2 } from "./analysis.js";
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
  dialogueAudioStream,
  joinEvidence,
  readResumeQuote,
  soundBesideEdge,
} from "./dialogue-join.js";
import {
  NOTE_QUOTE_REACH,
  cutReading,
  joinPlays,
  keptText,
  quotesAwayFromCut,
  timelineWordsNear,
} from "./dialogue-reading.js";
import { adjustDecisionEdges } from "./dialogue-plan-edges.js";
import { verifySurvivingJoins } from "./dialogue-plan-joins.js";
import type { DialoguePlan, DialoguePlanRequest, DisputedEdge, GateLine, PlannedDecision, ResolvedCut } from "./dialogue-plan-types.js";

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

/** One dialogue-scan page as join evidence, built the same way for the live tool and for replay. */
export function dialogueScanPage(mediaId: string, from: number, to: number, audioStream: number, segments: DialogueDetections["segments"],
  wf: Parameters<typeof joinEvidence>[1]) {
  return { mediaId, start: from, end: to, audioStream, edges: joinEvidence(segments.flatMap(s => s.words), wf), segments };
}

const r2 = round2;

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

  // Quotes are opt-in assertions about the exact cut the agent submitted. A production quote that conflicts goes
  // back to the caller before any part of the plan is written; a resume quote that does is reported on its cut.
  const quoted = removals.filter(c => c.decision === "cut" &&
    ((c.kind === "retake" && c.resumeWith) || (c.kind === "coaching" && c.productionQuote)));
  const project = await sources.project();
  if (quoted.length) {
    const disputedEdges = quoted.flatMap(c => {
      let reason: string | undefined;
      if (c.kind === "coaching" && c.productionQuote) {
        reason = sources.evidence.checkProductionQuote(c, c.productionQuote, tl, project);
      } else if (c.resumeWith) {
        // A resume quote the scan reads differently is reported, not refused: the scan and the transcript the agent
        // quotes from are two readings of the recording, and neither is the recording. On two passes all nine cuts
        // set aside this way were right, spelled or timed differently by the two (“open ai” and “OpenAI”, “gonna” and
        // “going to”, a first “It” the transcript lacked), and each was sent again without its quote. One was a false
        // start the editor paused the pass after: the resumed pass never heard of it and it played (2026-11-22).
        const read = readResumeQuote(tl, project, c.end, sources.evidence.scans, c.resumeWith);
        if (read.result === "different") c.notes = [...(c.notes ?? []),
          `After this cut the scan reads “${read.heard}”, where your resumeWith quote says “${c.resumeWith}”. Saved as you placed it.`];
        if (read.result === "unverified") c.notes = [...(c.notes ?? []),
          "The scan has no words after this cut to compare your resumeWith quote with. Saved as you placed it."];
      }
      return reason ? [{ start: c.start, end: c.end, reason, cuts: [c.input] }] : [];
    });
    if (disputedEdges.length) return { early: { outcome: "needsRevision", disputedEdges } };
  }
  return { project, duration, scope, sorted, removals, kept };
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
        // The gap is in the recording's seconds: said as it plays in the video.
        const seen = (gap / speed).toFixed(2);
        close.push(side === "out" ? `the removed sound starts ${seen} s after the cut` : `the removed sound ends ${seen} s before the join`);
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
