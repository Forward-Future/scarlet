import type { TranscriptWord } from "@scarlet/timeline";
import { expect, it } from "vitest";
import { labelTranscript, numberSpeakers } from "./speakerLabels.js";

function transcript(words: TranscriptWord[]) {
  return { id: "t", mediaId: "m", segments: [{ id: "s", start: 0, end: 10, text: "hello", words }] };
}

it("uses the same number on a speaker's return and abstains on overlap or silence", () => {
  const turns = numberSpeakers([{ start: 2, end: 4, speaker: 15 }, { start: 4, end: 5, speaker: 15 }, { start: 0, end: 2, speaker: 8 },
    { start: 4, end: 6, speaker: 8 }, { start: 8, end: 7, speaker: 3 }]);
  const words = [0, 3, 4, 5, 9].map(start => ({ start, end: start + .5, text: "hello" }));
  const original = transcript(words);
  const annotated = labelTranscript(original, turns);
  expect(annotated.speakerAnalysis?.count).toBe(2);
  expect(annotated.segments[0]!.words.map(w => w.speaker)).toEqual(["Speaker 1", "Speaker 2", undefined, "Speaker 1", undefined]);
  expect(annotated.segments[0]!.speaker).toBeUndefined();
  expect(original.segments[0]!.words).toEqual(words);
});

it("anchors a confirmed host, respects existing names, and defers to isolated audio", () => {
  const words = Array.from({ length: 10 }, (_, start) => ({ start, end: start + .8, text: "hello" } as TranscriptWord));
  for (const w of words.slice(0, 6)) Object.assign(w, { speaker: "me", voiceRoleInput: 2 });
  Object.assign(words[7]!, { speaker: "other voices", voiceRoleInput: 3 });
  Object.assign(words[8]!, { speaker: "Guest" });
  Object.assign(words[9]!, { speaker: "other voices", voiceRoleInput: 3 });
  // A short contrary observation must not overwrite the clean source attribution.
  words[7]!.end = 7.2;
  const t = labelTranscript(transcript(words), [{ start: 0, end: 8, speaker: 1 }, { start: 8, end: 10, speaker: 2 }]);
  expect(t.segments[0]!.words.slice(6).map(w => [w.speaker, w.detectedSpeaker])).toEqual([
    ["me", 1], ["other voices", undefined], ["Guest", 2], ["other voices · Speaker 2", 2],
  ]);
});

it("does not introduce a new person on a brief interruption or overlapping speech alone", () => {
  const turns = numberSpeakers([{ start: 0, end: 4, speaker: 8 }, { start: .1, end: .6, speaker: 7 },
    { start: 4.1, end: 4.4, speaker: 2 }, { start: 5, end: 8, speaker: 8 }]);
  const t = labelTranscript(transcript([{ text: "both", start: .1, end: .6 }, { text: "clear", start: 2, end: 3 }]), turns);
  expect(t.speakerAnalysis?.count).toBe(1);
  expect(t.segments[0]!.words.map(w => w.speaker)).toEqual([undefined, "Speaker 1"]);
});

it("refreshes earlier detected labels and clears stale segment attribution on an uncertain word", () => {
  const previous = labelTranscript(transcript([0, 1].map(start => ({ start, end: start + .5, text: "hello" }))),
    [{ start: 0, end: 2, speaker: 1 }]);
  const updated = labelTranscript(previous, [{ start: 0, end: .5, speaker: 2 }]);
  expect(updated.segments[0]!.speaker).toBeUndefined();
  expect(updated.segments[0]!.words.map(w => [w.speaker, w.detectedSpeaker])).toEqual([["Speaker 2", 2], [undefined, undefined]]);
});
