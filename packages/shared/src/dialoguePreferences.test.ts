import { describe, expect, it } from "vitest";
import { applyDialoguePreferences, describeDialoguePreferences, DialoguePreferences, preferenceEvidence } from "./dialoguePreferences.js";

const levels = (aiCuts: Record<string, string> = {}) => DialoguePreferences.parse({ aiCuts }).aiCuts;
const cut = (start: number, kind?: "pause" | "filler" | "retake" | "coaching", review = false) => ({ start, end: start + 1, kind, review, reason: `cut at ${start}` });

describe("the editor's dialogue preferences", () => {
  it("default to cutting every kind with natural pauses and a 2-frame crossfade, and refuse a level or kind that doesn't exist", () => {
    expect(DialoguePreferences.parse({})).toEqual({ aiCuts: { pause: "cut", filler: "cut", retake: "cut", coaching: "cut" }, pauseTightness: "natural", crossfadeFrames: 2 });
    expect(DialoguePreferences.parse({ aiCuts: { filler: "off" }, pauseTightness: "tight", crossfadeFrames: 0 })).toEqual({
      aiCuts: { pause: "cut", filler: "off", retake: "cut", coaching: "cut" }, pauseTightness: "tight", crossfadeFrames: 0 });
    expect(DialoguePreferences.safeParse({ aiCuts: { filler: "sometimes" } }).success).toBe(false);
    expect(DialoguePreferences.safeParse({ pauseTightness: "tighter" }).success).toBe(false);
    expect(DialoguePreferences.safeParse({ crossfadeFrames: 1.5 }).success).toBe(false);
    expect(DialoguePreferences.safeParse({ crossfadeFrames: -1 }).success).toBe(false);
  });

  it("leave a plan alone when every kind is set to Cut", () => {
    const plan = [cut(1, "pause"), cut(5, "retake", true), cut(9)];
    expect(applyDialoguePreferences(plan, levels())).toEqual({ cuts: plan.map((c, index) => ({ ...c, index })), decisions: [] });
  });

  it("drop cuts of a kind set to Off and stage cuts of a kind set to Suggest, reporting each one it changed", () => {
    const plan = [cut(1, "pause"), cut(5, "filler"), cut(9, "retake"), cut(13, "retake", true), cut(17), cut(21, "coaching")];
    const { cuts, decisions } = applyDialoguePreferences(plan, levels({ filler: "off", retake: "suggest" }));
    // Each kept cut carries its place in the submitted plan, so results can be matched back after some are dropped.
    expect(cuts.map(c => [c.index, c.start, c.review])).toEqual([[0, 1, false], [2, 9, true], [3, 13, true], [4, 17, false], [5, 21, false]]);
    expect(cuts[1]).toMatchObject({ kind: "retake", reason: "cut at 9", end: 10 });
    // A cut the agent already staged for review isn't something the setting changed.
    expect(decisions).toEqual([
      { index: 1, kind: "filler", level: "off", outcome: "dropped", start: 5, end: 6 },
      { index: 2, kind: "retake", level: "suggest", outcome: "review", start: 9, end: 10 },
    ]);
    expect(plan[2]!.review).toBe(false);
  });

  it("pass a cut with no kind unchanged whatever the levels, and drop everything else when all are Off", () => {
    const all = levels({ pause: "off", filler: "off", retake: "off", coaching: "off" });
    const { cuts, decisions } = applyDialoguePreferences([cut(1, "pause"), cut(5), cut(9, "coaching", true)], all);
    expect(cuts).toEqual([{ ...cut(5), index: 1 }]);
    expect(decisions.map(d => [d.index, d.outcome])).toEqual([[0, "dropped"], [2, "dropped"]]);
    expect(applyDialoguePreferences([], all)).toEqual({ cuts: [], decisions: [] });
  });

  it("say what a setting did to a cut, and give the agent the settings in one line", () => {
    expect(preferenceEvidence({ kind: "filler", level: "off" })).toBe("Editor set fillers to Off, so Scarlet keeps this footage.");
    expect(preferenceEvidence({ kind: "coaching", level: "suggest" })).toBe("Editor set production talk to Suggest, so the editor decides each one.");
    expect(describeDialoguePreferences(DialoguePreferences.parse({ aiCuts: { filler: "off", retake: "suggest" }, pauseTightness: "tight" }))).toBe(
      "AI may cut: pauses cut, fillers off, retakes suggest, production talk cut. Pause air: tight (x0.6). Joins: Scarlet adds a 2-frame audio crossfade. " +
      "suggest = Scarlet stages every cut of that kind for the editor; off = Scarlet drops cuts of that kind. Plan editorially as usual.");
    expect(describeDialoguePreferences(DialoguePreferences.parse({ pauseTightness: "loose" }))).toContain("Pause air: loose (x1.5).");
    expect(describeDialoguePreferences(DialoguePreferences.parse({ crossfadeFrames: 0 }))).toContain("Joins: straight cuts (crossfade off).");
  });
});
