import { describe, expect, it } from "vitest";
import { DialogueCutsRequest } from "@scarlet/shared";
import { createProject, emptyTimeline, makeMediaClip, type MediaAsset } from "@scarlet/timeline";
import { DialogueEvidence } from "./dialogue-decisions.js";
import { joinEvidence, type JoinPage } from "./dialogue-join.js";
import { cutsReach, dialogueGate, equivalentShifts, planDialogueCuts, resolveCutRange, type DialogueCutInput, type DialoguePlanSources } from "./dialogue-plan.js";

const words = [
  { start: 1, end: 1.38, text: "finish" }, { start: 1.8, end: 2.2, text: "first" },
  { start: 3.4, end: 3.86, text: "next" },
];
const voice = [{ start: .98, end: 1.44 }, { start: 1.8, end: 2.26 }, { start: 3.4, end: 3.94 }];
const levels = Array.from({ length: 250 }, (_, i) => voice.some(v => v.start <= i/50 && i/50 < v.end) ? .12 : .001);
const page: JoinPage = { mediaId: "mic", start: 0, end: 5, edges: joinEvidence(words, { from: 0, to: 5, peaks: levels, rms: levels, speechActivity: voice }) };

function fixture() {
  const p = createProject("Plan", { fps: 30 });
  p.media = [{ id: "mic", kind: "audio", name: "Mic", path: "mic.wav", hasAudio: true } satisfies MediaAsset];
  const tl = emptyTimeline(p.id);
  tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 5, 0)];
  const measured: Array<{ mediaId: string; t: number }> = [];
  const sources: DialoguePlanSources = { evidence: new DialogueEvidence(), pages: () => [page], project: async () => p,
    words: async () => words, measure: async points => { measured.push(...points); }, air: 1 };
  return { tl, sources, measured };
}
const cut = (c: Partial<DialogueCutInput>): DialogueCutInput => ({ kind: "retake", decision: "cut", reason: "Earlier take.", ...c });

describe("dialogue plan", () => {
  it("returns an edit that leaves a single word doubled immediately after the cut", async () => {
    const { tl, sources } = fixture();
    const heard = ["Okay.", "Take", "two.", "the", "the", "answer."].map((text, i) => ({ text, start: .5 * i, end: .5 * i + .15 }));
    const rms = Array.from({ length: 250 }, (_, i) => heard.some(w => w.start <= i / 50 && i / 50 < w.end) ? .1 : .0005);
    sources.pages = () => [{ ...page, edges: joinEvidence(heard, { from: 0, to: 5, rms, peaks: rms, speechActivity: heard }) }];
    const plan = (end: number, keepRepeat?: string) => planDialogueCuts({ tl, localPauses: false,
      cuts: [cut({ start: .3, end, kind: "coaching", keepRepeat })] }, sources);
    expect(await plan(1.3)).toMatchObject({ outcome: "needsRevision", disputedEdges: [{ pickup: { words: "the", side: "end" } }] });
    expect(await plan(1.8)).toMatchObject({ outcome: "ready" });
    expect(await plan(1.3, "the")).toMatchObject({ outcome: "ready" });
  });

  it("checks the surviving audio before saving even if both existing transcripts omit the extra word", async () => {
    const { tl, sources } = fixture();
    const recorded = [words[0]!, { start: 1.48, end: 1.64, text: "next" }, ...words.slice(1)];
    const windows: number[][] = [];
    sources.readKeptWords = async (mediaId, stream, from, to) => {
      expect([mediaId, stream]).toEqual(["mic", undefined]);
      windows.push([from, to]);
      return recorded.filter(w => w.start >= from && w.end <= to);
    };
    const plan = (start: number, keepRepeat?: string) => planDialogueCuts({ tl, localPauses: false,
      cuts: [cut({ start, end: 3.2, keepRepeat })] }, sources);
    expect(await plan(1.7)).toMatchObject({ outcome: "needsRevision", disputedEdges: [{ repeat: { words: "next",
      before: { start: 1.48, end: 1.64 }, after: { start: 3.4, end: 3.86 } } }] });
    expect(windows).toEqual([[0, 1.7], [3.2, 5]]);
    expect(await plan(1.45)).toMatchObject({ outcome: "ready" });
    expect(await plan(1.7, "next")).toMatchObject({ outcome: "ready" });
  });

  it("uses the measured occurrence in its chosen clip when the transcript misses a saying", async () => {
    const { tl, sources } = fixture();
    const duplicate = makeMediaClip("mic", 0, 5, 5);
    tl.tracks[1]!.clips.push(duplicate);
    sources.words = async () => { throw new Error("The saved transcript merged the two deliveries"); };
    const short = { text: "go", start: 1.8, end: 1.9 };
    const ref = { clipId: duplicate.id, mediaId: "mic", words: [short] };
    const result = await resolveCutRange(tl, { occurrence: ref }, "cut", sources);
    expect(result).toMatchObject({ start: 6.8, end: 6.9, words: "go", problems: [expect.any(String), expect.any(String)] });
    await expect(resolveCutRange(tl, { occurrence: ref, start: 0, end: 1 }, "cut", sources)).rejects.toThrow("already identifies");
  });

  it("returns the fragment audible inside a real crossfade to the author of the cut, including an automatically staged retake", async () => {
    const { tl, sources } = fixture();
    (await sources.project()).media[0]!.duration = 5;
    const scan = [{ start: 1.4, end: 1.88, text: "set" }, { start: 2.008, end: 2.2, text: "it" },
      { start: 3.26, end: 3.50, text: "it" }, { start: 3.55, end: 3.73, text: "down" }];
    const acoustic = [{ start: 1.44, end: 1.84, text: "set" }, { start: 2.012, end: 2.04, text: "i" },
      { start: 3.28, end: 3.46, text: "it" }, { start: 3.58, end: 3.70, text: "down" }];
    sources.crossfadeFrames = 2;
    sources.words = async () => scan;
    const rms = Array<number>(250).fill(.2);
    sources.pages = () => [{ ...page, edges: joinEvidence(scan, { from: 0, to: 5, rms, peaks: rms, speechActivity: [{ start: 0, end: 5 }] }) }];
    sources.readKeptWords = async (_id, _stream, from, to) => acoustic.filter(w => w.start < to && w.end > from)
      .map(w => ({ ...w, start: Math.max(from, w.start), end: Math.min(to, w.end) }));
    const plan = (options: Partial<DialogueCutInput> = {}, others: DialogueCutInput[] = []) => planDialogueCuts({
      tl, localPauses: false, cuts: [...others, cut({ start: 2, end: 3.2, ...options })] }, sources);
    const conflict = { outcome: "needsRevision", disputedEdges: [{ partialWordRepeat: { side: "start", word: "it", heard: "i" } }] };
    expect(await plan()).toMatchObject(conflict);
    expect(await plan({ kind: "coaching" }, [cut({ start: .3, end: .7, kind: "coaching" })])).toMatchObject(conflict);
    expect(await plan({ keepRepeat: "it" })).toMatchObject({ outcome: "ready", decisions: [{ review: true }] });
    expect(await plan({ decision: "review" })).toMatchObject({ outcome: "ready" });
    // While a neighboring staged removal meets this cut, the engine holds its fade.
    expect(await plan({ kind: "coaching" }, [cut({ start: 1.2, end: 2, kind: "coaching", decision: "review" })]))
      .toMatchObject({ outcome: "ready" });
    sources.crossfadeFrames = 0;
    expect(await plan()).toMatchObject({ outcome: "ready" });
    sources.crossfadeFrames = 2;
    sources.aiCuts = { retake: "suggest", pause: "cut", coaching: "cut", filler: "cut" };
    expect(await plan()).toMatchObject({ outcome: "ready" });
  });

  it("checks an automatically staged cut with unrelated words without decoding new audio", async () => {
    const { tl, sources } = fixture();
    const rms = Array<number>(250).fill(.2);
    sources.pages = () => [{ ...page, edges: joinEvidence(words, { from: 0, to: 5, rms, peaks: rms, speechActivity: [{ start: 0, end: 5 }] }) }];
    let reads = 0;
    sources.readKeptWords = async () => { reads++; return []; };
    expect(await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: .5, end: 4.5 })] }, sources))
      .toMatchObject({ outcome: "ready", decisions: [{ review: true }] });
    expect(reads).toBe(0);
  });

  it("catches both copies of a pickup on the kept side of a production cut even when the transcript drops one", async () => {
    const { tl, sources } = fixture();
    const tokens = ["Okay.", "Pack", "up.", "Let's", "go,", "let's", "go", "outside."];
    const scan = tokens.map((text, i) => ({ text, start: .5 * i, end: .5 * i + .15 }));
    const rms = Array.from({ length: 250 }, (_, i) => scan.some(w => w.start <= i / 50 && i / 50 < w.end) ? .1 : .0005);
    sources.pages = () => [{ ...page, edges: joinEvidence(scan, { from: 0, to: 5, rms, peaks: rms, speechActivity: scan }) }];
    sources.words = async () => scan.filter((_, i) => i !== 5 && i !== 6);
    const coaching = cut({ start: .3, end: 1.3, kind: "coaching" });
    const plan = (...cuts: DialogueCutInput[]) => planDialogueCuts({ tl, cuts, localPauses: false }, sources);
    const pickup = { words: "Let's go", side: "end", first: { start: 1.5, end: 2.15 }, second: { start: 2.5, end: 3.15 } };
    expect(await plan(coaching)).toMatchObject({ outcome: "needsRevision", disputedEdges: [{ cut: 0, pickup }] });
    expect(await plan({ ...coaching, end: 2.3 })).toMatchObject({ outcome: "ready", decisions: [{ review: false }] });
    expect(await plan({ ...coaching, keepRepeat: ["Let's go"] })).toMatchObject({ outcome: "ready" });
    expect(await plan(coaching, cut({ start: 1.45, end: 2.2, decision: "keep" }))).toMatchObject({ outcome: "ready" });
    expect(await plan(coaching, cut({ start: 2.3, end: 3.3 }))).toMatchObject({ outcome: "ready" });
    // The same restart ending before an outgoing edge.
    expect(await plan({ ...coaching, start: 3.3, end: 4.6 })).toMatchObject({ outcome: "needsRevision",
      disputedEdges: [{ pickup: { ...pickup, side: "start" } }] });
    sources.aiCuts = { retake: "off", pause: "cut", filler: "cut", coaching: "cut" };
    expect(await plan(coaching)).toMatchObject({ outcome: "ready" });
  });

  it("returns a retake that would double its opening word to the agent, with both timings from the scan", async () => {
    const { tl, sources } = fixture();
    const heard = [
      { start: .2, end: .6, text: "done." }, { start: .8, end: 1, text: "Next," },
      { start: 1.6, end: 1.8, text: "next" }, { start: 2, end: 2.4, text: "attempt." },
      { start: 3.5, end: 3.75, text: "next" }, { start: 3.9, end: 4.2, text: "stop." },
    ];
    const saved = [heard[0]!, { ...heard[1]!, end: 1.8 }, ...heard.slice(3)];
    const rms = Array.from({ length: 250 }, (_, i) => heard.some(w => w.start <= (i + .5) / 50 && (i + .5) / 50 < w.end) ? .1 : .0005);
    const reading = { ...page, edges: joinEvidence(heard, { from: 0, to: 5, rms, peaks: rms, speechActivity: heard }) };
    sources.pages = () => [reading];
    sources.words = async () => saved;
    const plan = (...cuts: DialogueCutInput[]) => planDialogueCuts({ tl, cuts, localPauses: false }, sources);
    const retake = cut({ start: 1.2, end: 3.3 });
    const conflict = { outcome: "needsRevision", disputedEdges: [{ cut: 0, repeat: { words: "Next",
      before: { start: .8, end: 1 }, after: { start: 3.5, end: 3.75 } } }] };
    expect(await plan(retake)).toMatchObject(conflict);
    expect(await plan({ ...retake, keepRepeat: "attempt" })).toMatchObject(conflict);
    expect(await plan({ ...retake, keepRepeat: "next!" })).toMatchObject({ outcome: "ready", decisions: [{ review: false }] });
    // Neither a staged cut nor one disabled in settings makes this join.
    expect(await plan({ ...retake, decision: "review" })).toMatchObject({ outcome: "ready" });
    sources.aiCuts = { retake: "off", pause: "cut", filler: "cut", coaching: "cut" };
    expect(await plan(retake)).toMatchObject({ outcome: "ready" });
    delete sources.aiCuts;
    // Two touching cuts make one join; removing the first saying as well resolves it.
    expect(await plan({ ...retake, end: 2.7 }, cut({ kind: "coaching", start: 2.7, end: 3.3 }))).toMatchObject(conflict);
    expect(await plan(cut({ kind: "coaching", start: .7, end: 1.2 }), retake)).toMatchObject({ outcome: "ready" });
  });

  it("narrows a retake whose edges fall on speech, stages it for review and reports the change", async () => {
    const { tl, sources, measured } = fixture();
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 1.15, end: 3.6 }), cut({ start: 4.2, end: 4.6, kind: "pause" }), cut({ start: 4.7, end: 4.9, kind: "pause", decision: "keep" }),
    ] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    expect(measured.map(m => m.t)).toEqual([1.15, 3.6, 4.2, 4.6]);
    expect(plan.decisions).toHaveLength(2);
    const [retake, pause] = plan.decisions;
    expect(retake).toMatchObject({ review: true, kind: "retake", originalRange: { start: 1.15, end: 3.6 } });
    expect(retake!.start).toBeGreaterThan(1.44);
    expect(retake!.end).toBeLessThan(3.4);
    expect(pause).toEqual({ start: 4.2, end: 4.6, reason: "Earlier take.", review: false, kind: "pause", originalRange: undefined });
    const gate = dialogueGate(plan, []);
    expect(gate.unchangedCuts).toBe(1);
    expect(gate.decisions).toEqual([expect.objectContaining({ cut: 0, asked: "cut", outcome: "review", from: [1.15, 3.6] })]);
  });

  it("keeps a staged repair inside its original range when an edge moves outward into a pause", async () => {
    const { tl, sources } = fixture();
    // The start clips "first" by 10 ms with quiet just before it; the end sits in "next", too far to snap.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 1.81, end: 3.6 })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const [d] = plan.decisions;
    expect(d!.start).toBeLessThan(1.8);
    expect(d!.originalRange).toEqual({ start: d!.start, end: 3.6 });
    // The engine rejects the whole submission when one repair falls outside its original range.
    expect(DialogueCutsRequest.safeParse({ fromVersion: "v1", description: "Plan", cuts: plan.decisions }).success).toBe(true);
  });

  it("keeps a measured repair and its restorable range inside the selection and clear of protected footage", async () => {
    const { tl, sources } = fixture();
    const retake = cut({ start: 1.81, end: 3.6 });
    const selection = { time: 1.81, end: 4 };
    for (const plan of [
      await planDialogueCuts({ tl, localPauses: false, anchor: selection, cuts: [retake] }, sources),
      await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 1.6, end: 1.81, picture: "protect" }), retake] }, sources),
    ]) {
      if (plan.outcome !== "ready") throw new Error(plan.outcome);
      expect(plan.decisions).toEqual([expect.objectContaining({ start: 1.81, end: 3.6, review: true, originalRange: undefined })]);
      expect(dialogueGate(plan, []).decisions[0]?.evidence).toMatch(/measured edge would cross/);
    }
  });

  it("holds an edge it moved at the range beside it, so adjoining cuts never overlap", async () => {
    const { tl, sources } = fixture();
    // A pause cut ends where a retake cut starts. The retake's start clips "first", and the quiet before it lies in the pause.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 1.45, end: 1.81, kind: "pause" }), cut({ start: 1.81, end: 3.6 })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const [pause, retake] = plan.decisions;
    expect(pause).toMatchObject({ start: 1.45, end: 1.81, review: false });
    // Alone, this retake's start moves out to before 1.8 s (the test above). Here it stays where the pause ends.
    expect(retake).toMatchObject({ start: 1.81, review: true });
    expect(retake!.originalRange!.start).toBe(1.81);
    expect(DialogueCutsRequest.safeParse({ fromVersion: "v1", description: "Plan", cuts: plan.decisions }).success).toBe(true);
    expect(dialogueGate(plan, []).decisions).toEqual([expect.objectContaining({ cut: 1, outcome: "review", evidence: expect.stringContaining("Held at the neighboring range at 1.81 s.") })]);
  });

  it("trims a pause named by the word it follows down to the beat, and to the length the agent asks", async () => {
    const { tl, sources } = fixture();
    // “first” ends at 2.2 s and “next” starts at 3.4 s: the pause plays 1.2 s.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ kind: "pause", mediaId: "mic", afterWord: 1 })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    expect(plan.decisions).toEqual([expect.objectContaining({ start: 2.35, end: 3.3, kind: "pause", review: false })]);
    expect(dialogueGate(plan, []).decisions).toEqual([expect.objectContaining({ cut: 0, words: "pause after “first”", outcome: "cut", range: [2.35, 3.3] })]);
    // Tight air shortens the beat. A named length holds whatever the tightness.
    const tight = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ kind: "pause", mediaId: "mic", afterWord: 1 })] }, { ...sources, air: .6 });
    const asked = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ kind: "pause", mediaId: "mic", afterWord: 1, leave: .6 })] }, { ...sources, air: .6 });
    if (tight.outcome !== "ready" || asked.outcome !== "ready") throw new Error("not ready");
    expect(tight.decisions[0]).toMatchObject({ start: 2.29, end: 3.34 });
    expect(asked.decisions[0]!.end - asked.decisions[0]!.start).toBeCloseTo(.6);
    // The sound of “first” runs to 2.26 s, past its timing: the edge waits for the quiet rather than clip it.
    expect(tight.decisions[0]!.start).toBeGreaterThanOrEqual(2.26 + .03 - 1e-9);
  });

  it("refuses a pause reference that has nothing to trim, names no pause, or belongs to another kind", async () => {
    const { tl, sources } = fixture();
    const plan = (c: Partial<DialogueCutInput>) => planDialogueCuts({ tl, localPauses: false, cuts: [cut({ kind: "pause", ...c })] }, sources);
    // “finish” to “first” plays 0.42 s.
    await expect(plan({ mediaId: "mic", afterWord: 0, leave: .5 })).rejects.toThrow("plays 0.42 s, which leaves nothing to trim down to 0.50 s");
    await expect(plan({ mediaId: "mic", afterWord: 2 })).rejects.toThrow("No word follows #2");
    await expect(plan({ mediaId: "mic", afterWord: 1, kind: "retake" })).rejects.toThrow("afterWord names a pause");
    await expect(plan({ mediaId: "mic", afterWord: 1, fromWord: 1, toWord: 1 })).rejects.toThrow("without fromWord or toWord");
    await expect(plan({ start: 2.4, end: 3.2, leave: .3 })).rejects.toThrow("leave goes with afterWord");
    // After an earlier cut the two words play in different clips: the pause is that join's.
    tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 2.5, 0), makeMediaClip("mic", 3, 5, 2.5)];
    await expect(plan({ mediaId: "mic", afterWord: 1 })).rejects.toThrow("does not play “first” and “next” (#1, #2) one after the other");
  });

  it("cuts a doubled word that follows the word before it without a pause, at the dip between the two", async () => {
    // “recognized that”, a pause, “that likely”: the first “that” runs straight on from “recognized”.
    const said = [{ start: 1, end: 1.4, text: "recognized" }, { start: 1.4, end: 1.7, text: "that" }, { start: 2.5, end: 2.8, text: "that" }, { start: 2.8, end: 3.2, text: "likely" }];
    const talk = [{ start: .98, end: 1.72 }, { start: 2.5, end: 3.22 }];
    const plan = async (between: number) => {
      // 20 ms between the two words at `between`; everything else in the voice is at speaking level.
      const rms = Array.from({ length: 250 }, (_, i) => i === 70 ? between : talk.some(v => v.start <= i/50 && i/50 < v.end) ? .12 : .001);
      const scan: JoinPage = { mediaId: "mic", start: 0, end: 5, edges: joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: talk }) };
      const { tl, sources } = fixture();
      const planned = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ mediaId: "mic", fromWord: 1, toWord: 1 })] },
        { ...sources, pages: () => [scan], words: async () => said });
      if (planned.outcome !== "ready") throw new Error(planned.outcome);
      return { decision: planned.decisions[0]!, gate: dialogueGate(planned, []).decisions[0]! };
    };
    // A level of .001 is -60 dBFS, room tone: the cut applies from that instant to the quiet before the repeat.
    const dipped = await plan(.001);
    expect(dipped.decision).toMatchObject({ review: false, start: 1.41, end: 2.4 });
    expect(dipped.gate).toMatchObject({ outcome: "cut", evidence: "No pause between “recognized” and “that”: the start is at the lowest level between them (-60 dBFS)." });
    // Spoken straight through, or with a dip no deeper than a sibilant's hiss, there is nowhere to cut, and the editor auditions it as before.
    for (const level of [.12, .005]) {
      const through = await plan(level);
      expect(through.decision.review).toBe(true);
      expect(through.gate.evidence).toContain("No measured silence between “recognized” and “that”");
    }
  });

  it("applies pause tightness to undecided quiet pauses and honors explicit ranges, durations, and keeps", async () => {
    const { tl, sources } = fixture();
    // “first” to “next” is 1.2 s with nothing in it; the levels say so.
    const quiet = { ...sources, sound: async () => ({ seconds: 0, runs: [] }) };
    const other = cut({ start: 4.2, end: 4.6, kind: "pause" });
    const plan = (cuts: DialogueCutInput[], from: DialoguePlanSources = quiet) => planDialogueCuts({ tl, localPauses: false, range: { start: 0, end: 5 }, cuts }, from)
      .then(p => { if (p.outcome !== "ready") throw new Error(p.outcome); return p; });
    // Left alone, it comes down to the beat as Scarlet's own cut, beside the agent's.
    const alone = await plan([other]);
    expect(alone.decisions).toHaveLength(1);
    expect(alone.trims).toEqual([expect.objectContaining({ start: 2.35, end: 3.3, kind: "pause", review: false, reason: "Trimmed a quiet 1.2 s pause after “first”.",
      mediaId: "mic", afterWord: 1, was: 1.2, plays: expect.closeTo(.25), after: "first", before: "next" })]);
    // Tight air trims from 0.6 s and leaves less.
    expect((await plan([other], { ...quiet, air: .6 })).trims.map(t => [t.after, t.plays])).toEqual([["first", expect.closeTo(.15)]]);
    // Even when the default would trim it further, the pause's explicit one-second beat survives.
    const asked = await plan([cut({ kind: "pause", mediaId: "mic", afterWord: 1, leave: 1 }), other]);
    expect(asked.trims).toEqual([]);
    expect(asked.decisions[0]).toMatchObject({ start: 2.8, end: 3, review: false });
    expect(dialogueGate(asked, []).decisions[0]).toMatchObject({ outcome: "cut", range: [2.8, 3] });
    const seconds = await plan([cut({ kind: "pause", start: 2.6, end: 2.7 }), other]);
    expect(seconds.trims).toEqual([]);
    expect(seconds.decisions[0]).toMatchObject({ start: 2.6, end: 2.7 });
    // Half a second is the agent's to ask for, and a pause it keeps or protects stays whole.
    expect((await plan([cut({ kind: "pause", mediaId: "mic", afterWord: 1, leave: .5 }), other])).decisions[0]!.end).toBeCloseTo(3.2);
    expect((await plan([cut({ kind: "pause", start: 2.3, end: 3.3, decision: "keep" }), other])).trims).toEqual([]);
    expect((await plan([cut({ kind: "pause", start: 2.3, end: 3.3, picture: "protect" }), other])).trims).toEqual([]);
    // Sound in it at speaking level is something said or done: the agent's to read, not a pause to trim.
    expect((await plan([other], { ...sources, sound: async () => ({ seconds: .4, runs: [{ start: 2.5, end: 2.9 }] }) })).trims).toEqual([]);
    // Without levels there is no saying it is quiet, and a request about fillers alone leaves pauses be.
    expect((await plan([other], sources)).trims).toEqual([]);
    expect((await planDialogueCuts({ tl, localPauses: false, range: { start: 0, end: 5 }, only: "filler", cuts: [cut({ start: 4.2, end: 4.6, kind: "filler" })] }, quiet) as { trims: unknown[] }).trims).toEqual([]);
  });

  it("requires measured quiet on every audible recording before adding a pause trim", async () => {
    const { tl, sources } = fixture();
    (await sources.project()).media.push({ id: "second", kind: "audio", name: "Second mic", path: "second.wav", hasAudio: true });
    tl.tracks[0]!.clips = [makeMediaClip("second", 0, 3, 1)];
    sources.words = async id => id === "mic" ? words : null;
    const quiet = { seconds: 0, runs: [] };
    for (const other of [undefined, { seconds: .4, runs: [{ start: 1.5, end: 1.9 }] }, quiet]) {
      const plan = await planDialogueCuts({ tl, localPauses: false, range: { start: 0, end: 5 },
        cuts: [cut({ start: 4.2, end: 4.6, kind: "pause" })] }, { ...sources, sound: async (mediaId, range) => {
          if (mediaId === "mic") return quiet;
          expect(range.start).toBeCloseTo(1.25);
          expect(range.end).toBeCloseTo(2.35);
          return other;
        } });
      if (plan.outcome !== "ready") throw new Error(plan.outcome);
      expect(plan.trims).toHaveLength(other === quiet ? 1 : 0);
    }
  });

  it("trims an undecided quiet pause only in the selected placement of a reused recording", async () => {
    const { tl, sources } = fixture();
    tl.tracks[1]!.clips.push(makeMediaClip("mic", 0, 5, 5));
    const plan = await planDialogueCuts({ tl, localPauses: false, range: { start: 5, end: 10 },
      cuts: [cut({ start: 9.2, end: 9.6, kind: "pause" })] }, { ...sources, sound: async () => ({ seconds: 0, runs: [] }) });
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    expect(plan.trims).toMatchObject([{ start: 7.35, end: 8.3 }]);
  });

  it("places a word reference in the measured silence beside the removed words", async () => {
    const { tl, sources } = fixture();
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ mediaId: "mic", fromWord: 1, toWord: 1 })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const [d] = plan.decisions;
    expect(d!.start).toBeGreaterThanOrEqual(1.44);
    expect(d!.end).toBeLessThanOrEqual(3.4);
    expect(d!.review).toBe(false);
    expect(dialogueGate(plan, []).decisions).toEqual([expect.objectContaining({ cut: 0, words: "first", outcome: "cut" })]);
  });

  it("measures at the kept words too when a pause is longer than the reading at its middle, and places the word reference beside them", async () => {
    const { tl, sources, measured } = fixture();
    const asked = () => measured.splice(0).map(m => Math.round(m.t * 100) / 100);
    const refer = async (fromWord: number, toWord: number) => {
      const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ mediaId: "mic", fromWord, toWord })] }, sources);
      if (plan.outcome !== "ready") throw new Error(plan.outcome);
      return plan.decisions[0]!;
    };
    // An ordinary gap is measured as before: at the middle of the gap either side of “first”, then at the cut's own edges.
    expect(await refer(1, 1)).toMatchObject({ start: 1.59, end: 3.3, review: false });
    expect(asked()).toEqual([1.59, 2.8, 1.59, 3.3]);
    // Eight seconds of silence either side of “two three” and no scan. As in the live tool, each instant asked about is
    // read with the five seconds around it.
    const spoken = [{ start: 1, end: 1.4, text: "one" }, { start: 9.4, end: 9.8, text: "two" }, { start: 10.2, end: 10.6, text: "three" }, { start: 18.6, end: 19, text: "four" }];
    const pages: JoinPage[] = [];
    tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 21, 0)];
    sources.words = async () => spoken;
    sources.pages = () => pages;
    sources.measure = async points => {
      measured.push(...points);
      for (const { t } of points) {
        const from = Math.max(0, Math.floor(t) - 2), to = Math.min(21, Math.floor(t) + 3);
        const level = Array.from({ length: (to - from) * 50 }, (_, i) => spoken.some(w => w.start <= from + (i + .5) / 50 && from + (i + .5) / 50 < w.end) ? .12 : .001);
        pages.push({ mediaId: "mic", start: from, end: to, edges: joinEvidence(spoken, { from, to, peaks: level, rms: level, speechActivity: spoken.map(({ start, end }) => ({ start, end })) }) });
      }
    };
    // Neither middle reading reaches the kept word, so each kept word's edge is read as well. The cut then leaves the
    // air beside “one” and “four”, not the 1.75 s and 1.7 s of silence the middle readings stop short of.
    const take = await refer(1, 2);
    expect(asked()).toEqual([5.4, 14.6, 1.4, 18.6, 1.55, 18.5]);
    expect(take).toMatchObject({ start: 1.55, end: 18.5, review: false });
  });

  it("keeps a removal of the edit's last words inside an edit that ends between two milliseconds", async () => {
    const { tl, sources } = fixture();
    // The clip ends on a frame of a 30 fps edit, 4.9666… s. Rounded to the millisecond, the word range would end past it.
    tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 149 / 30, 0)];
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ mediaId: "mic", fromWord: 2, toWord: 2, decision: "review" })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    expect(plan.decisions[0]!.end).toBe(149 / 30);
  });

  it("narrows a pause whose edge is on a word onto the quiet, keeps it a cut and reports the change", async () => {
    const { tl, sources } = fixture();
    // Placed from word timings: it ends a twentieth of a second into "next", whose sound starts at 3.4 s.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 2.5, end: 3.45, kind: "pause" })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const [pause] = plan.decisions;
    expect(pause).toMatchObject({ start: 2.5, review: false, kind: "pause", originalRange: undefined });
    expect(pause!.end).toBeLessThan(3.4);
    expect(pause!.end).toBeGreaterThan(3);
    expect(dialogueGate(plan, []).decisions).toEqual([expect.objectContaining({ cut: 0, kind: "pause", asked: "cut", outcome: "cut",
      from: [2.5, 3.45], evidence: expect.stringMatching(/end moved 0\.\d+ s earlier into the pause to preserve “next”/) })]);
    // A pause that starts in the tail of the word before it is narrowed the other way, and one in the quiet is left alone.
    const tail = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 2.22, end: 3.2, kind: "pause" })] }, sources);
    if (tail.outcome !== "ready") throw new Error(tail.outcome);
    expect(tail.decisions[0]).toMatchObject({ end: 3.2, review: false });
    expect(tail.decisions[0]!.start).toBeGreaterThan(2.26);
    const quiet = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 2.5, end: 3.2, kind: "pause" })] }, sources);
    if (quiet.outcome !== "ready") throw new Error(quiet.outcome);
    expect(quiet.decisions[0]).toMatchObject({ start: 2.5, end: 3.2, review: false });
    expect(dialogueGate(quiet, []).unchangedCuts).toBe(1);
  });

  it("leaves a pause's edge where it meets the removal beside it, so no few frames of picture stay between them", async () => {
    const { tl, sources } = fixture();
    // The same pause, now ending where a stretch of production talk starts.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 2.22, end: 3.45, kind: "pause" }), cut({ start: 3.45, end: 4.4, kind: "coaching" })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const [pause, talk] = plan.decisions;
    expect(pause!.end).toBe(3.45);
    expect(talk!.start).toBe(3.45);
    // Its other edge, in the tail of "first", still moves onto the quiet.
    expect(pause!.start).toBeGreaterThan(2.26);
    // Beside a range the agent keeps, the edge moves as before.
    const kept = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 2.5, end: 3.45, kind: "pause" }), cut({ start: 3.45, end: 4.4, kind: "coaching", decision: "keep" })] }, sources);
    if (kept.outcome !== "ready") throw new Error(kept.outcome);
    expect(kept.decisions[0]!.end).toBeLessThan(3.4);
  });

  it("preserves a wordless moment between two removals and between a selected removal and an earlier join", async () => {
    const { tl, sources } = fixture();
    // A pause cut stops five frames short of the production talk after it; nothing is said in between.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 2.5, end: 3.0, kind: "pause" }), cut({ start: 3.1667, end: 4.4, kind: "coaching" })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    expect(plan.decisions.map(d => [d.start, d.end])).toEqual([[2.5, 3], [3.1667, 4.4]]);
    expect(dialogueGate(plan, []).decisions).toEqual([]);
    // With a word in between, both stay where they were asked.
    const spoken = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 1.5, end: 1.7, kind: "pause" }), cut({ start: 2.3, end: 3.2, kind: "pause" })] }, sources);
    if (spoken.outcome !== "ready") throw new Error(spoken.outcome);
    expect(spoken.decisions.map(d => [d.start, d.end])).toEqual([[1.5, 1.7], [2.3, 3.2]]);
    // So does a piece the agent chose to keep.
    const kept = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 2.5, end: 2.8, kind: "pause" }),
      cut({ start: 2.8, end: 3.0, kind: "pause", decision: "keep" }), cut({ start: 3.0, end: 3.2, kind: "pause" })] }, sources);
    if (kept.outcome !== "ready") throw new Error(kept.outcome);
    expect(kept.decisions.map(d => [d.start, d.end])).toEqual([[2.5, 2.8], [3.0, 3.2]]);
    // An earlier part cut 2.4-2.6 s out. This part's pause starts four frames after that join.
    tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 2.4, 0), makeMediaClip("mic", 2.6, 5, 2.4)];
    const later = await planDialogueCuts({ tl, localPauses: false, anchor: { time: 2.5, end: 3.2 }, cuts: [cut({ start: 2.5333, end: 3.0, kind: "pause" })] }, sources);
    if (later.outcome !== "ready") throw new Error(later.outcome);
    expect(later.decisions.map(d => [d.start, d.end])).toEqual([[2.5333, 3]]);
    expect(dialogueGate(later, []).decisions).toEqual([]);
  });

  it("lets a word reference's placed edge give way to the range the agent decided beside it", async () => {
    const { tl, sources } = fixture();
    // A pause cut over the silence after "finish", then "first" by its index. Scarlet places the word cut's start in
    // that same silence, at 1.59 s, inside the pause cut. Both come out; the word cut starts where the pause ends.
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 1.5, end: 1.75, kind: "pause" }), { kind: "retake", decision: "cut", reason: "Earlier take.", mediaId: "mic", fromWord: 1, toWord: 1 }] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const [pause, take] = plan.decisions;
    expect(pause!.end).toBe(1.75);
    expect(take!.start).toBe(1.75);
    expect(take!.end).toBeCloseTo(3.3, 2);
    // The other way round: the pause after the word, given in seconds, starts inside the word cut's placed end.
    const after = await planDialogueCuts({ tl, localPauses: false, cuts: [
      { kind: "retake", decision: "cut", reason: "Earlier take.", mediaId: "mic", fromWord: 1, toWord: 1 }, cut({ start: 2.6, end: 3.35, kind: "pause" })] }, sources);
    if (after.outcome !== "ready") throw new Error(after.outcome);
    expect(after.decisions.map(d => d.kind)).toEqual(["retake", "pause"]);
    expect(after.decisions[0]!.end).toBe(2.6);
    expect(after.decisions[1]!.start).toBe(2.6);
    // A range that reaches into the words themselves is the agent's overlap, and is named.
    await expect(planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 1.5, end: 1.9, kind: "pause" }), { kind: "retake", decision: "cut", reason: "Earlier take.", mediaId: "mic", fromWord: 1, toWord: 1 }] }, sources))
      .rejects.toThrow(/cut 1 \(words placed at 1\.59–3\.3 s\) overlaps cut 0 \(1\.5–1\.9 s\)/);
  });

  it("takes a range to the edit's end, given to the millisecond, as ending there", async () => {
    const { tl, sources } = fixture();
    // The edit ends at 4.9666… s, which reads as 4.967.
    tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 149 / 30, 0)];
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 4.2, end: 4.967, kind: "pause" })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    expect(plan.decisions[0]).toMatchObject({ start: 4.2, end: 149 / 30 });
    // Further past the end is still refused.
    await expect(planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 4.2, end: 4.98, kind: "pause" })] }, sources)).rejects.toThrow("fall outside the range");
  });

  it("cites the editor's per-kind setting for a cut the engine staged", async () => {
    const { tl, sources } = fixture();
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 4.2, end: 4.6, kind: "pause" })] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    const gate = dialogueGate(plan, [{ index: 0, kind: "pause", level: "suggest", outcome: "review", start: 4.2, end: 4.6 }]);
    expect(gate.decisions[0]).toMatchObject({ cut: 0, outcome: "review", evidence: expect.stringMatching(/Editor set pauses to Suggest/) });
  });

  it("lists what the plan keeps on purpose in timeline seconds, a keep by its words and a protected picture included", async () => {
    const { tl, sources } = fixture();
    const plan = await planDialogueCuts({ tl, localPauses: false, cuts: [
      cut({ start: 4.2, end: 4.4, kind: "pause" }),
      // “first”, kept by its index: the range runs between the silences either side of the word.
      cut({ mediaId: "mic", fromWord: 1, toWord: 1, decision: "keep" }),
      cut({ start: 4.5, end: 4.9, kind: "pause", picture: "protect" }),
      cut({ start: .2, end: .6, kind: "pause", decision: "review" }),
    ] }, sources);
    if (plan.outcome !== "ready") throw new Error(plan.outcome);
    // Only the cut and the review go to the engine.
    expect(plan.decisions.map(d => [d.start, d.end, d.review])).toEqual([[.2, .6, true], [4.2, 4.4, false]]);
    expect(plan.kept).toHaveLength(2);
    const [byWords, protectedPicture] = plan.kept;
    expect(byWords!.start).toBeGreaterThan(1.38);
    expect(byWords!.start).toBeLessThan(1.8);
    expect(byWords!.end).toBeGreaterThan(2.2);
    expect(byWords!.end).toBeLessThan(3.4);
    expect(protectedPicture).toEqual({ start: 4.5, end: 4.9 });
  });

  it("preserves keeps, returns unverified quotes before saving and rejects invalid plans", async () => {
    const { tl, sources } = fixture();
    expect(await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 1, end: 2, decision: "keep" })] }, sources)).toEqual({ outcome: "preserved", kept: [{ start: 1, end: 2 }] });
    const quoted = await planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 1.44, end: 1.78, kind: "coaching", productionQuote: "first" })] }, sources);
    expect(quoted).toMatchObject({ outcome: "needsRevision", disputedEdges: [{ start: 1.44, end: 1.78 }] });
    await expect(planDialogueCuts({ tl, localPauses: false, cuts: [cut({ start: 1, end: 3 }), cut({ start: 2, end: 4 })] }, sources)).rejects.toThrow("cut 1 (2–4 s) overlaps cut 0 (1–3 s)");
    await expect(planDialogueCuts({ tl, localPauses: false, only: "pause", cuts: [cut({ start: 1, end: 2 })] }, sources)).rejects.toThrow(/only is "pause"/);
    await expect(planDialogueCuts({ tl, localPauses: true, range: { start: 0, end: 5 }, cuts: [cut({ start: 1, end: 2 })] }, sources)).rejects.toThrow(/only pauses/);
  });
});

describe("cutsReach", () => {
  it("says how far into each recording under them a part's cuts reach", () => {
    // A camera and a screen recording of the same take, synced, with an earlier cut already made at 20 s.
    const tl = emptyTimeline(createProject("Reach", { fps: 30 }).id);
    tl.tracks[0]!.clips = [makeMediaClip("screen", 2, 22, 0), makeMediaClip("screen", 32, 62, 20)];
    tl.tracks[1]!.clips = [makeMediaClip("camera", 0, 20, 0), makeMediaClip("camera", 30, 60, 20)];
    expect(cutsReach(tl, [])).toEqual(new Map());
    // A cut inside the first clip reaches its own end on both recordings.
    expect(cutsReach(tl, [{ start: 4, end: 6 }])).toEqual(new Map([["screen", 8], ["camera", 6]]));
    // The furthest cut counts, and one that runs to the end of the timeline reaches the end of the footage there.
    expect(cutsReach(tl, [{ start: 45, end: 50 }, { start: 4, end: 6 }])).toEqual(new Map([["screen", 62], ["camera", 60]]));
  });
});

describe("equivalent removals", () => {
  const t = (...texts: string[]) => texts.map(text => ({ text }));
  it("slides a removal along a restart while the same words play", () => {
    // sense because when, because when it: removing #1–#2 plays the same as #2–#3 or #3–#4.
    expect(equivalentShifts(t("sense", "because", "when,", "because", "when", "it"), 1, 2)).toEqual([0, 1, 2]);
    expect(equivalentShifts(t("sense", "because", "when,", "because", "when", "it"), 3, 4)).toEqual([0, -1, -2]);
    expect(equivalentShifts(t("a", "b", "c"), 1, 1)).toEqual([0]);
  });

  it("keeps the named performance for cut, review and keep and measures alternate indices on inspection", async () => {
    const p = createProject("Plan", { fps: 50 });
    p.media = [{ id: "mic", kind: "audio", name: "Mic", path: "mic.wav", hasAudio: true } satisfies MediaAsset];
    const tl = emptyTimeline(p.id);
    tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 5, 0)];
    // “sense because when, because when it”: no pause before the first try, a pause after it and after the second.
    const said = [["sense", .5, .9], ["because", .9, 1.2], ["when,", 1.2, 1.4], ["because", 1.8, 2.1], ["when", 2.1, 2.3], ["it", 2.8, 3]]
      .map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }));
    const rms = Array.from({ length: 250 }, (_, i) => said.some(w => w.start <= i / 50 && i / 50 < w.end) ? .12 : .001);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: .5, end: 1.4 }, { start: 1.8, end: 2.3 }, { start: 2.8, end: 3 }] });
    const sources: DialoguePlanSources = { evidence: new DialogueEvidence(), pages: () => [{ mediaId: "mic", start: 0, end: 5, edges }], project: async () => p,
      words: async () => said, measure: async () => {}, air: 1 };
    const ref = { mediaId: "mic", fromWord: 1, toWord: 2 };
    const inspected = await resolveCutRange(tl, ref, "Range", sources, true);
    expect(inspected).toMatchObject({ words: "because when,", problems: expect.any(Array),
      alternativeWordRanges: expect.arrayContaining([expect.objectContaining({ fromWord: 3, toWord: 4, problems: [], dips: [] })]) });
    expect(inspected.end).toBeLessThan(said[3]!.start);
    for (const decision of ["cut", "review", "keep"] as const) {
      const plan = await planDialogueCuts({ tl, cuts: [cut({ ...ref, decision })], localPauses: false }, sources);
      if (plan.outcome === "needsRevision") throw new Error(plan.outcome);
      const actual = plan.outcome === "ready" ? plan.decisions[0]! : plan.kept![0]!;
      expect(actual.start).toBeLessThan(said[2]!.start);
      expect(actual.end).toBeLessThan(said[3]!.start);
    }
    const chosen = await planDialogueCuts({ tl, cuts: [cut({ mediaId: "mic", fromWord: 3, toWord: 4 })], localPauses: false }, sources);
    expect(chosen).toMatchObject({ outcome: "ready", decisions: [{ review: false }] });
    if (chosen.outcome !== "ready") throw new Error(chosen.outcome);
    expect(chosen.decisions[0]!.start).toBeGreaterThan(1.4);
    expect(chosen.decisions[0]!.end).toBeGreaterThan(2.3);
  });
});
