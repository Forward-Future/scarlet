import { expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { DialogueEvidence, matchFillers } from "./dialogue-decisions.js";
import { findRepeatedTakes } from "./dialogue-retakes.js";

it("keeps local speaker changes separate when surfacing repeated phrases", () => {
  const phrase = (at: number, speaker: string) => ["Raise", "the", "flag"].map((text, i) =>
    ({ start: at + i * .25, end: at + i * .25 + .2, text, speaker }));
  expect(findRepeatedTakes([...phrase(1, "host"), ...phrase(2, "guest")])).toEqual([]);
  expect(findRepeatedTakes([...phrase(1, "host"), ...phrase(60, "host")])).toEqual([]);
  expect(findRepeatedTakes([...phrase(1, "host"), ...phrase(2, "host")])).toMatchObject([
    { first: { start: 1 }, next: { start: 2 }, immediateRestart: true },
  ]);
  expect(findRepeatedTakes([...phrase(1, "host").slice(0, 2), ...phrase(2, "host")])).toMatchObject([
    { phrase: "Raise the", immediateRestart: true },
  ]);
});

it("reports each detector's filler observations for comparison", () => {
  const words = [{ start: 1, end: 1.3, text: "um" }, { start: 4, end: 4.3, text: "uh" }];
  const acoustic = [{ start: 1.03, end: 1.27, confidence: .86 }, { start: 6.5, end: 6.8, confidence: .97 }];
  expect(matchFillers(words, acoustic)).toEqual([
    { start: 1.03, end: 1.27, uhm: acoustic[0], whisper: words[0] },
    { start: 4, end: 4.3, whisper: words[1] },
    { start: 6.5, end: 6.8, uhm: acoustic[1] },
  ]);
});

it("reports whether an explicitly supplied production quote matches a shared mic", () => {
  const project = createProject("Recording");
  project.media = [{ id: "mic", name: "Shared mic", kind: "audio", path: "mic.wav" }];
  const tl = emptyTimeline(project.id);
  tl.tracks[0]!.clips = [makeMediaClip("screen", 0, 6, 0, { volume: 0 })];
  tl.tracks[1]!.clips = [makeMediaClip("mic", 10, 16, 0)];
  const words = ["Cut", "that", "in", "post"].map((text, i) => ({ start: 11 + i/4, end: 11.2 + i/4, text }));
  const segments = [{ id: "note", start: 11, end: 11.95, text: "Cut that in post", words }];
  const ev = new DialogueEvidence();
  const page = { mediaId: "mic", start: 10, end: 16, segments,
    edges: { words, voice: [{ start: 11, end: 11.95 }], quiet: [], valleys: [] } };
  ev.scans.push(page);
  const range = { start: .95, end: 2 };
  const check = (quote = "Cut that in post.", at = range) => ev.checkProductionQuote(at, quote, tl, project);
  expect(check()).toBeUndefined();
  expect(check("Cut that")).toMatch(/quote/i);
  expect(check(undefined, { ...range, end: 2.8 })).toBeUndefined(); // the extra time contains no transcribed words
  expect(check(undefined, { ...range, start: 1.08 })).toMatch(/complete timing/i);
  ev.scans[0] = { ...page, edges: undefined };
  expect(check()).toBeUndefined();
  ev.scans[0] = { ...page, segments: segments.map(s => ({ ...s, words: [] })) };
  expect(check()).toMatch(/word timings/i);
});
