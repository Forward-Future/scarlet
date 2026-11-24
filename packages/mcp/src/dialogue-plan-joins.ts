/** Phase 3 of planning dialogue cuts: what each join the plan leaves plays, checked before anything is saved. */
import { normalizeTranscriptToken, selectedRange } from "@scarlet/shared";
import { clipDuration, frameAlignedRemoval, mergeRanges, timelineToSource, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { round2 as r2 } from "./analysis.js";
import type { DialoguePlanSources } from "./dialogue-cut-resolve.js";
import { checkKeptWords, dialogueCutPreview, dialogueJoinWords } from "./dialogue-join.js";
import { audibleClipsInTrackOrder } from "./dialogue-reading.js";
import { edgeOvershoots } from "./edge-overshoot.js";
import { quietKeptWords } from "./quiet-kept-word.js";
import { timelineWords } from "./timeline-perception.js";
import type { DialoguePlanRequest, DisputedEdge, GateLine, PlannedDecision, ResolvedCut } from "./dialogue-plan-types.js";

/** How far either side of a join its words are read, in timeline seconds: room for the words a restart is judged by. */
const JOIN_CONTEXT_SECONDS = 12;
/** Words of each side quoted when a join comes back for taking words out of a sentence. */
const EDGE_WORDS_SHOWN = 6;

/** The removals whose ranges meet a disputed stretch: those either side of a piece it keeps, or those inside a join. */
const owners = (removals: ResolvedCut[], at: TimeRange) =>
  removals.filter(c => c.start <= at.end + 0.05 && c.end >= at.start - 0.05).map(c => c.input);
const phrase = (s: string) => s.trim().split(/\s+/u).map(normalizeTranscriptToken).join(" ");

/** Phase 3: verify surviving joins for quiet kept words, repeat-at-join, pickup repeats, partial-word repeats, and overshoots. */
export async function verifySurvivingJoins(
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
        const plays = `“${heard}” from a cut-off “${word}” beside another “${word}”`;
        if (forReview) {
          // A held cut plays only once the editor has heard it, so what its join would play is evidence on it, as a
          // phrase played twice is. Refused, it left the retake playing with no one asked: “and that's what makes this
          // so ‖ and that's what makes this so” was refused for 11 ms of a cut-off “and”, and the pass marked a To do
          // instead (reimann 2, 2026-11-23).
          const evidence = `As staged, the ${side === "start" ? "outgoing" : "incoming"} audio plays ${plays}.`;
          target.d.held = [target.d.held, evidence].filter(Boolean).join(" ");
          report.push({ cut: target.c.input, kind: target.c.kind, ...(target.c.words && { words: target.c.words }), asked: target.c.decision,
            outcome: "review", range: [r2(target.d.start), r2(target.d.end)], evidence });
        } else if (side === "start" ? target.d.start === join.start : target.d.end === join.end)
          issues.push({ cut: target.c.input, partialWordRepeat, words: word,
            reason: `The ${side === "start" ? "outgoing" : "incoming"} audio plays ${plays}.` });
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
