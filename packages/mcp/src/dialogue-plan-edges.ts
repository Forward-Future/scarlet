/** Phase 2 of planning dialogue cuts: every removal's edges, measured against the audio and placed. */
import { clipDuration, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { audibleClipsByTrack, round2 as r2, round3 } from "./analysis.js";
import type { DialoguePlanSources } from "./dialogue-cut-resolve.js";
import { dialogueJoinChecker, quietFrameNote, SAME_WORD_UNHEARD } from "./dialogue-join.js";
import { audibleSourcePoints, joinText, keptText, timelineWordsNear } from "./dialogue-reading.js";
import type { DialoguePlanRequest, GateLine, PlannedDecision, ResolvedCut } from "./dialogue-plan-types.js";

/** Footage shorter than this between two cuts plays as a flash, not as something seen or heard: about three frames. */
const SLIVER_SECONDS = .1;
const CROSSES_SCOPE = "The measured edge would cross the selected range or footage marked to keep. The requested edges are staged for review.";

/** Phase 2: check every removal's edges against the audio, apply unsureJoins, clamp neighbor collisions, and snap slivers. */
export async function adjustDecisionEdges(
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
    // A hold for the selection or footage marked to keep keeps its own words: they are what keeps it held below.
    if (!found || !d.review || d.held === CROSSES_SCOPE) return;
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

/** Timeline seconds where the footage an audible track plays jumps: the joins earlier cuts left on this version. */
function versionJoins(tl: Timeline) {
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
