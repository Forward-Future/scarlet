import { expect, it } from "vitest";
import { madeSentence, sentenceText } from "./madeSentence";

const length = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const cut = (start: number, end: number) => ({ label: "A stumble", beforeCut: { version: "v0", removed: { start, end } } });
const say = (edits: Parameters<typeof madeSentence>[0]) => sentenceText(madeSentence(edits, length));

it("says how much the cuts took out, with the figures in bold", () => {
  const parts = madeSentence([cut(0, 60), cut(100, 171)], length);
  expect(sentenceText(parts)).toBe("Took out 2:11 in 2 cuts.");
  expect(parts.filter(part => typeof part !== "string")).toEqual([{ strong: "2:11" }, { strong: "2 cuts" }]);
});

it("counts what isn't a cut by what it did, after the cuts", () => {
  expect(say([cut(0, 60), cut(100, 171), { label: "Punch in on Matt", kind: "zoom" }, { label: "Punch in on the guest", kind: "zoom" }, { label: "Host full-frame", kind: "reframe" }]))
    .toBe("Took out 2:11 in 2 cuts, and made 2 zooms and 1 reframe.");
  // A kind with no word of its own is an edit beside the others.
  expect(say([cut(0, 60), cut(100, 171), { label: "Assemble the call" }])).toBe("Took out 2:11 in 2 cuts, and made 1 other edit.");
});

it("names a few edits that aren't cuts, and counts many by kind", () => {
  expect(say([{ label: "music bed", kind: "audio" }, { label: "captions", kind: "text" }, { label: "wrap" }])).toBe("Made 3 edits: music bed, captions, wrap.");
  const frames = ["Frame the watch", "Frame the prompt", "Frame the card", "Frame the chart"].map(label => ({ label, kind: "reframe" as const }));
  expect(say(frames)).toBe("Made 4 reframes.");
  expect(say([...frames, { label: "Lower-third: Matt", kind: "overlay" }, { label: "Assemble" }])).toBe("Made 4 reframes, 1 overlay and 1 other edit.");
  expect(say(["One", "Two", "Three", "Four"].map(label => ({ label })))).toBe("Made 4 edits.");
});

it("says what Scarlet said about the one edit a request made", () => {
  expect(say([{ label: "Camera full-frame for the intro", summary: "Made the host camera fill the frame for the intro lines." }])).toBe("Made the host camera fill the frame for the intro lines.");
  // An edit saved before Scarlet wrote summaries reads as its title, then its reason to look.
  expect(say([{ label: "Trim the pause", check: "The join lands on a breath" }])).toBe("Trim the pause. The join lands on a breath.");
  expect(say([cut(0, 4.2)])).toBe("A stumble.");
});

it("counts an edit made in several places once, and says so when it is the only one", () => {
  const same = { label: "Camera full screen", kind: "reframe" as const };
  expect(say([same, same, same])).toBe("Camera full screen, in 3 places.");
  expect(say([same, same, { label: "music bed", kind: "audio" }])).toBe("Made 2 edits: Camera full screen, music bed.");
  // Over a list with a row for each place, the sentence counts the places, as that list does.
  expect(sentenceText(madeSentence([cut(0, 60), same, same, same], length, true))).toBe("Took out 1:00 in 1 cut, and made 3 reframes.");
});

it("says nothing for a request with no edits, and counts cuts whose length isn't known", () => {
  expect(madeSentence([], length)).toEqual([]);
  expect(say([cut(5, 5), cut(9, 9)])).toBe("Made 2 cuts.");
});
