import { expect, it } from "vitest";
import type { MappedWord } from "../../lib/transcriptMap";
import { transcriptTurns } from "./transcriptTurns";

function word(index: number, speaker?: string, start = index * .2): MappedWord {
  return { index, word: { text: "word", start, end: start + .18, speaker }, mediaId: "a",
    segmentId: "seg-" + index, placements: [{ start, end: start + .18 }], cut: false, indexInSegment: 0 };
}

it("uses a single heading across transcription chunks and short unassigned gaps", () => {
  const words = [word(0, "me"), word(1), word(2, "me"), word(3, "other voices"), word(4, "other voices")];
  const groups = transcriptTurns(words);
  expect(groups.map(g => [g.voice, g.words.length])).toEqual([["me", 3], ["other voices", 2]]);
  expect(groups.flatMap(g => g.paragraphs.flat())).toEqual(words);
  expect(words[1]!.word.speaker).toBeUndefined();
});

it("separates long unknown passages, recording changes and a return after a long silence", () => {
  const words = [word(0, "me"), ...Array.from({ length: 9 }, (_, i) => word(i + 1)), word(10, "me"), word(11, "me", 70), { ...word(12, "me", 70.2), mediaId: "b" }];
  words[0]!.word.text = "Yes.";
  words[9]!.word.text = "unknown.";
  expect(transcriptTurns(words).map(g => g.words.length)).toEqual([1, 9, 1, 1, 1]);
});

it("keeps short same-speaker utterances flowing in one paragraph across moderate pauses instead of one word per line", () => {
  const words = [
    word(0, undefined, 5),
    word(1, undefined, 21),
    word(2, undefined, 38),
    word(3, undefined, 87),
    word(4, undefined, 160),
  ];
  words[0]!.word.text = "Thank";
  words[1]!.word.text = "you.";
  words[2]!.word.text = "Thank";
  words[3]!.word.text = "you.";
  words[4]!.word.text = "Later.";
  // 5s..87s pauses (< 60s) stay together; 87s..160s (>= 60s) starts a new section.
  expect(transcriptTurns(words).map(g => g.words.length)).toEqual([4, 1]);
});

it("keeps uncertainty inside a sentence and gives a short spoken reply its own turn", () => {
  const words = ["Where", "do", "we", "go?", "Absolutely.", "Next."].map((text, i) => {
    const w = word(i, ["me", undefined, "other voices", "me", "other voices", "me"][i]);
    w.word.text = text;
    return w;
  });
  expect(transcriptTurns(words).map(t => t.words.map(w => w.word.text).join(" "))).toEqual(["Where do we go?", "Absolutely.", "Next."]);
});
