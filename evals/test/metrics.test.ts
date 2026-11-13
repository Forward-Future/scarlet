import { describe, expect, it } from "vitest";
import { intersect, merge, subtract } from "../src/intervals.ts";
import {
  DEFAULT_EDGE_OPTIONS, DEFAULT_PACING_OPTIONS, KEPT_SIDE_EDGE_OPTIONS, classifyEdges, compareToDecisions, compareToReference, cutEdges, joinEdges, labelWords,
  levelIn, levelStats, matchEdges, pacing, planMetrics, prf, removedSource, sentences, summarizeEdges, traceMetrics, type EventLike, type MediaEvidence,
} from "../src/metrics.ts";
import { keptSource, playedWords, timelineRangeToSource } from "../src/timeline.ts";
import { BREATH_DB, FLOOR_DB, SPEECH_DB, cut, lines, media, recording } from "./fixtures.ts";

const MIC = "med_mic";
const speechy = () => recording(MIC, 6, [
  ["Hello", 0.5, 1.0], ["there", 1.0, 1.5], ["my", 1.5, 2.0], ["friend.", 2.0, 2.5],
  ["Second", 3.0, 3.6], ["line", 3.6, 4.2], ["here", 4.2, 4.8], ["now.", 4.8, 5.5],
], [[2.6, 2.8]]);

describe("intervals", () => {
  it("merges, subtracts and intersects", () => {
    expect(merge([{ start: 3, end: 4 }, { start: 0, end: 1 }, { start: 1, end: 2 }])).toEqual([{ start: 0, end: 2 }, { start: 3, end: 4 }]);
    expect(subtract([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 5, end: 6 }]))
      .toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 10 }]);
    expect(intersect([{ start: 0, end: 5 }], [{ start: 4, end: 8 }])).toEqual([{ start: 4, end: 5 }]);
  });
});

describe("edge classification", () => {
  const ev = speechy();
  const evidence = new Map([[MIC, ev]]);

  it("derives the room floor and speech level from the recording", () => {
    expect(levelStats(ev.levels!)).toEqual({ floorDb: FLOOR_DB, speechDb: SPEECH_DB });
    expect(levelIn(ev.levels!, 2.6, 2.62)).toBe(BREATH_DB);
    expect(levelIn(ev.levels!, 2.5, 2.55)).toBe(FLOOR_DB);
  });

  it("separates silence, low-level sound and speech, and names a clipped word", () => {
    const reports = classifyEdges([
      { mediaId: MIC, at: 2.55, side: "out" },
      { mediaId: MIC, at: 2.7, side: "in" },
      { mediaId: MIC, at: 1.25, side: "out" },
      { mediaId: MIC, at: 3.0, side: "in" },
    ], evidence);
    expect(reports.map(r => r.class)).toEqual(["silence", "low", "speech", "speech"]);
    expect(reports[2]!.clippedWord).toBe("there");
    // An edge at a word boundary sits next to speech but does not clip the word.
    expect(reports[3]!.clippedWord).toBeUndefined();
    expect(reports[0]!.overFloorDb).toBe(0);
    const summary = summarizeEdges(reports);
    expect(summary).toMatchObject({ total: 4, silence: 1, low: 1, speech: 2, clippedWords: 1, speechPct: 50 });
  });

  it("can read only the kept side, like the earlier hand analysis", () => {
    // The removed side (before 3.0) is room tone; the kept side starts with a word.
    const kept = classifyEdges([{ mediaId: MIC, at: 2.97, side: "in" }, { mediaId: MIC, at: 2.97, side: "out" }], evidence, KEPT_SIDE_EDGE_OPTIONS);
    expect(kept.map(r => r.class)).toEqual(["speech", "silence"]);
  });

  it("leaves the level unknown when the kept side ends at the first recorded sample", () => {
    const [out, into] = classifyEdges([{ mediaId: MIC, at: 0, side: "out" }, { mediaId: MIC, at: 0, side: "in" }], evidence, KEPT_SIDE_EDGE_OPTIONS);
    expect(out?.class).toBe("unknown");
    expect(into?.class).toBe("silence");
    expect(levelIn(ev.levels!, 1.25, 1.25)).toBeUndefined();
  });

  it("flags edges on coarse grids", () => {
    const [whole, phase, other] = classifyEdges([
      { mediaId: MIC, at: 2.0, side: "out" }, { mediaId: MIC, at: 3.482, side: "in" }, { mediaId: MIC, at: 3.47, side: "in" },
    ], evidence, DEFAULT_EDGE_OPTIONS);
    expect(whole!.grids).toEqual(["1s", "0.5s"]);
    expect(phase!.grids).toEqual(["1s+0.48"]);
    expect(other!.grids).toEqual([]);
  });

  it("reports unknown without levels", () => {
    const [r] = classifyEdges([{ mediaId: "med_other", at: 1, side: "in" }], evidence);
    expect(r!.class).toBe("unknown");
    expect(summarizeEdges([r!]).speechPct).toBeNull();
  });
});

describe("timelines on the source clock", () => {
  it("keeps only audible clips and maps timeline ranges to source", () => {
    const tl = cut("v1", MIC, [[0, 4], [6, 20]]);
    const kept = keptSource(tl, [media(MIC), media("med_screen")]);
    expect([...kept.keys()]).toEqual([MIC]);
    expect(kept.get(MIC)).toEqual([{ start: 0, end: 4 }, { start: 6, end: 20 }]);
    expect(timelineRangeToSource(tl, [media(MIC)], { start: 3, end: 5 }))
      .toEqual([{ mediaId: MIC, start: 3, end: 4 }, { mediaId: MIC, start: 6, end: 7 }]);
  });

  it("finds joins introduced by a cut, including a trimmed head", () => {
    const base = new Map([[MIC, [{ start: 0, end: 20 }]]]);
    const after = new Map([[MIC, [{ start: 1, end: 4 }, { start: 6, end: 20 }]]]);
    expect(joinEdges(base, after)).toEqual([
      { mediaId: MIC, at: 1, side: "in" }, { mediaId: MIC, at: 4, side: "out" }, { mediaId: MIC, at: 6, side: "in" },
    ]);
    expect(removedSource(base, after).get(MIC)).toEqual([{ start: 0, end: 1 }, { start: 4, end: 6 }]);
    // Adjacent review items that become one removal have one pair of edges; per-cut counting sees each item.
    expect(cutEdges([{ mediaId: MIC, start: 0, end: 1 }, { mediaId: MIC, start: 4, end: 5 }, { mediaId: MIC, start: 5, end: 6 }])).toHaveLength(5);
  });
});

describe("against a reference", () => {
  const ev: MediaEvidence = lines(MIC, 10);
  const evidence = new Map([[MIC, ev]]);
  const base = new Map([[MIC, [{ start: 0, end: 20 }]]]);
  const reference = new Map([[MIC, subtract([{ start: 0, end: 20 }], [{ start: 4, end: 6 }, { start: 10, end: 12 }])]]);
  const candidate = new Map([[MIC, subtract([{ start: 0, end: 20 }], [{ start: 4, end: 6 }, { start: 10.01, end: 12.05 }, { start: 14, end: 16 }])]]);

  it("labels words kept or cut, ignoring words the base had already removed", () => {
    const labels = labelWords(ev.words!, [{ start: 2, end: 20 }], candidate.get(MIC)!);
    expect(labels.slice(0, 6)).toEqual([undefined, undefined, "keep", "keep", "cut", "cut"]);
  });

  it("scores removed words, removed time, edges and missing lines", () => {
    const r = compareToReference(base, candidate, reference, evidence);
    expect(r.words).toMatchObject({ tp: 4, fp: 2, fn: 0, precision: 0.667, recall: 1, f1: 0.8, inScope: 20 });
    expect(r.time.candidateSeconds).toBeCloseTo(6.04, 6);
    expect(r.time.overlapSeconds).toBeCloseTo(3.99, 6);
    expect(r.time.recall).toBeCloseTo(0.998, 3);
    expect(r.edges).toMatchObject({ candidate: 6, reference: 4, matched: 4 });
    expect(r.edges.f1["20ms"]).toMatchObject({ tp: 3, fp: 3, fn: 1, f1: 0.6 });
    expect(r.edges.f1["100ms"]).toMatchObject({ tp: 4, f1: 0.8 });
    expect(r.edges.medianAbsErrorMs).toBe(5);
    expect(r.requiredLines).toMatchObject({ required: 8, missing: 1, missingSeconds: 1 });
    expect(r.requiredLines.lines[0]!.text).toBe("Line 7.");
  });

  it("is perfect against itself", () => {
    const r = compareToReference(base, reference, reference, evidence);
    expect([r.words.f1, r.time.f1, r.edges.f1["20ms"]!.f1, r.requiredLines.missing]).toEqual([1, 1, 1, 0]);
  });

  it("matches each edge once, nearest first, on the same side", () => {
    const m = matchEdges(
      [{ mediaId: MIC, at: 1.0, side: "out" }, { mediaId: MIC, at: 1.05, side: "out" }],
      [{ mediaId: MIC, at: 1.04, side: "out" }, { mediaId: MIC, at: 1.04, side: "in" }], 0.1);
    expect(m).toHaveLength(1);
    expect(m[0]!.candidate.at).toBe(1.05);
  });

  it("scores the editor's approve/skip decisions", () => {
    const r = compareToDecisions(base, candidate, [
      { mediaId: MIC, start: 4, end: 6, label: "cut" },
      { mediaId: MIC, start: 14, end: 16, label: "keep" },
      { mediaId: MIC, start: 16, end: 18, label: "keep" },
      { mediaId: MIC, start: 18, end: 20, label: "cut" },
    ]);
    expect(r).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1, scored: 4, agreement: 0.5 });
  });

  it("handles empty removals", () => {
    expect(prf(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null });
    expect(prf(0, 2, 0)).toMatchObject({ precision: 0, recall: null, f1: 0 });
  });

  it("splits sentences at punctuation and long gaps", () => {
    const s = sentences(MIC, [
      { text: "One", start: 0, end: 0.3 }, { text: "two.", start: 0.3, end: 0.6 },
      { text: "Three", start: 0.7, end: 1 }, { text: "four", start: 3, end: 3.4 },
    ]);
    expect(s.map(x => x.text)).toEqual(["One two.", "Three", "four"]);
  });
});

describe("pacing", () => {
  const w = (text: string, start: number, end: number, piece = 0) => ({ text, start, end, mediaId: MIC, piece });

  it("places a version's words on its timeline, one piece per unbroken run of the recording", () => {
    const evidence = new Map([[MIC, lines(MIC, 10)]]);
    // Line 2 (source 4–6) is removed: what follows plays two seconds sooner, in a second piece.
    const played = playedWords(cut("A", MIC, [[0, 4], [6, 20]]), [media(MIC), media("med_screen")], evidence);
    expect(played).toHaveLength(18);
    expect(played[3]).toMatchObject({ text: "1.", start: 3, end: 3.5, piece: 0 });
    expect(played[4]).toMatchObject({ text: "Line", start: 4.5, end: 5, piece: 1 });
    // A split with nothing removed, as for a change of framing, is not a join.
    expect(new Set(playedWords(cut("B", MIC, [[0, 4], [4, 20]]), [media(MIC), media("med_screen")], evidence).map(p => p.piece)).size).toBe(1);
  });

  it("counts gaps inside kept footage and across joins", () => {
    const p = pacing([w("So", 0, 0.3), w("here", 0.4, 0.7), w("we", 1.45, 1.7), w("go.", 1.8, 2), w("[BLANK_AUDIO]", 2.1, 2.5),
      w("Next", 2.65, 3, 1), w("up", 3.1, 3.3, 1), w("this", 4.55, 4.9, 1)]);
    expect(p).toMatchObject({ words: 7, joins: 1, medianJoinGapSeconds: 0.65, gaps: { inside: 2, atJoins: 1, long: 1, excessSeconds: 1.9 } });
    expect(p.gapList.map(g => [g.after, g.before, g.seconds, g.join])).toEqual([["here", "we", 0.75, false], ["go.", "Next", 0.65, true], ["up", "this", 1.25, false]]);
  });

  it("finds a word or a run of words said twice in a row, and the ones a join made", () => {
    // "…" stands for four seconds of something else. The join falls between "Now" and "now".
    const said = ["Now", "now", "that", "there", "are,", "that", "there", "are", "very,", "very", "good", "it.", "It", "works", "so", "…", "so"];
    let at = 0;
    const played = said.flatMap((text, i) => {
      if (text === "…") { at += 4; return []; }
      at += 0.3;
      return [w(text, at - 0.3, at - 0.1, i ? 1 : 0)];
    });
    const p = pacing(played);
    expect(p.repeatList.map(r => [r.text, r.words, r.join])).toEqual([["Now now", 1, true], ["that there are, that there are", 3, false], ["very, very", 1, false]]);
    expect(p.repeats).toEqual({ total: 3, singleWords: 2, phrases: 1, atJoins: 1 });
  });

  it("counts an entire repeated opening with a two-word name and distinguishes the clean take", () => {
    const opening = ["Our", "next", "guest", "is", "Robin", "Green"];
    const said = [...opening, ...opening, "from", "Boston."];
    const played = said.map((text, i) => w(text, i * 0.3, i * 0.3 + 0.2));
    expect(pacing(played).repeatList).toEqual([{ mediaId: MIC, at: 0, text: said.slice(0, 12).join(" "), words: 6, join: false }]);
    expect(pacing(played.slice(opening.length)).repeatList).toEqual([]);
    expect(pacing(played, { ...DEFAULT_PACING_OPTIONS, repeatWords: 5 }).repeatList).toEqual([]);
  });
});

describe("trace", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const events: EventLike[] = [
    { at: at(1), type: "tool", text: "scarlet.dialogue_scan", data: { tool: "scarlet.dialogue_scan", input: { mediaId: MIC } } },
    { at: at(2), type: "tool", text: "scarlet.dialogue_check_join", data: { tool: "scarlet.dialogue_check_join", input: { version: "v1", start: 10.2, end: 12.1, includeAudio: true } } },
    { at: at(3), type: "tool", text: "scarlet.frame_contact_sheet", data: { tool: "scarlet.frame_contact_sheet", input: { mode: "activity" } } },
    { at: at(4), type: "error", text: "scarlet.frame_contact_sheet failed: bad count" },
    { at: at(100), type: "question", text: "Which intro?" },
    { at: at(160), type: "answer", text: "The second." },
    { at: at(200), type: "tool", text: "scarlet.dialogue_apply_cuts", data: { tool: "scarlet.dialogue_apply_cuts", input: { version: "v1", description: "d", cuts: [
      { start: 10, end: 12, kind: "retake", decision: "cut", reason: "r" },
      { start: 20, end: 20.3, kind: "filler", decision: "review", reason: "r" },
      { start: 30, end: 31, kind: "pause", decision: "keep", reason: "r" },
    ] } } },
    { at: at(201), type: "change", text: "Removed 2 s", data: { changeId: "chg_1" } },
    { at: at(202), type: "change", text: "Review 1 optional dialogue cut", data: { changeId: "chg_abc_review" } },
    { at: at(260), type: "tool", text: "scarlet.dialogue_review_save", data: { tool: "scarlet.dialogue_review_save", input: {} } },
  ];
  const task = { id: "tsk_1", state: "done", agent: "codex", createdAt: at(-5), startedAt: at(0), finishedAt: at(600),
    usage: { inputTokens: 1000, outputTokens: 200, cache: { read: 50 } } };

  it("counts tools, errors, inspection and active time without the editor's wait", () => {
    const m = traceMetrics(task, events);
    expect(m).toMatchObject({ activeSeconds: 540, queueSeconds: 5, waitingSeconds: 60, firstChangeSeconds: 201, firstCallSeconds: 202,
      firstRecommendationSeconds: 260, toolCalls: 5, errors: 1, questions: 1 });
    expect(m.byTool).toMatchObject({ dialogue_scan: 1, dialogue_check_join: 1, frame_contact_sheet: 1, dialogue_apply_cuts: 1, dialogue_review_save: 1 });
    expect(m.errorsByTool).toEqual({ frame_contact_sheet: 1 });
    expect(m.inspection).toMatchObject({ listened: 1, usedAudio: true, usedVisual: true, levels: 2 });
    expect(m.usage).toEqual({ inputTokens: 1000, outputTokens: 200, "cache.read": 50 });
  });

  it("summarizes the submitted plan and how many edged cuts were checked", () => {
    const plan = { version: "v1", cuts: (events[6]!.data!.input as { cuts: [] }).cuts };
    expect(planMetrics(plan, events)).toMatchObject({ cuts: 3, edged: 2, checkJoinCoverage: 0.5,
      byKindDecision: { "retake/cut": 1, "filler/review": 1, "pause/keep": 1 } });
  });

  it("counts listed and word-reference join checks across a plan saved in parts", () => {
    const check = (version: string, input: object) => ({ at: at(1), type: "tool", text: "scarlet.dialogue_check_join",
      data: { tool: "scarlet.dialogue_check_join", input: { version, ...input } } });
    const checks = [
      check("v1", { cuts: [{ start: 10, end: 12 }, { mediaId: "m", fromWord: 4, toWord: 9 }] }),
      check("v2", { start: 30, end: 31 }),
    ];
    const parts = [
      { version: "v1", cuts: [{ start: 10.1, end: 12, kind: "retake", decision: "cut" }, { start: 0, end: 0, mediaId: "m", fromWord: 4, toWord: 9, kind: "retake", decision: "cut" }] },
      { version: "v2", cuts: [{ start: 30, end: 31, kind: "filler", decision: "review" }, { start: 40, end: 42, kind: "retake", decision: "cut" }] },
    ];
    expect(planMetrics(parts, checks)).toMatchObject({ cuts: 4, edged: 4, checkJoinCoverage: 0.75,
      byKindDecision: { "retake/cut": 3, "filler/review": 1 } });
    // A check on another version doesn't cover a part.
    expect(planMetrics([parts[1]!], [check("v1", { start: 30, end: 31 })])?.checkJoinCoverage).toBe(0);
    // Mapped to the recording, a check made before an earlier part removed 5 s still covers the same join.
    const recording = (v: string, r: { start: number; end: number }) => ({ mediaId: "m", start: r.start + (v === "v2" ? 5 : 0), end: r.end + (v === "v2" ? 5 : 0) });
    expect(planMetrics([parts[1]!], [check("v1", { start: 45, end: 47 }), check("v1", { start: 30, end: 31 })], undefined, recording)?.checkJoinCoverage).toBe(0.5);
  });
});
