import { expect, it } from "vitest";
import { clusterExcerpts } from "./speakerClusters.js";
import { labelTranscript, numberSpeakers } from "./speakerLabels.js";

it("reunites a returning voice across drifting native cluster IDs and abstains between two voiceprints", () => {
  const samples = [[1, 0], [0, 1], [.99, .02], [.02, .99], [.7, .7]]
    .map((v, i) => ({ start: i * 10, end: i * 10 + (i < 4 ? 4 : .85), speaker: i, voice: Float32Array.from(v) }));
  const turns = numberSpeakers(clusterExcerpts(samples));
  expect(turns.map(t => t.speaker)).toEqual([1, 2, 1, 2, 0]);
});

it("keeps overlapping speech unassigned even if its sound matches the same person", () => {
  const v = Float32Array.of(1, 0);
  const spans = [{ start: 0, end: 4, speaker: 0, voice: v }, { start: 3.6, end: 4.4, speaker: 1, voice: v }, { start: 6, end: 9, speaker: 0, voice: v }];
  const words = [{ start: 1, end: 2, text: "clean" }, { start: 3.7, end: 3.9, text: "overlap" }];
  const t = labelTranscript({ id: "t", mediaId: "m", segments: [{ id: "s", start: 0, end: 9, words, text: "clean overlap" }] }, numberSpeakers(clusterExcerpts(spans)));
  expect(t.segments[0]!.words.map(w => w.speaker)).toEqual(["Speaker 1", undefined]);
});

it("labels the other turns when the last one has no length", () => {
  const samples = [
    { start: 0, end: 4, speaker: 0, voice: Float32Array.of(1, 0) }, { start: 10, end: 14, speaker: 1, voice: Float32Array.of(0, 1) },
    { start: 20, end: 24, speaker: 2, voice: Float32Array.of(.99, .02) }, { start: 30, end: 30, speaker: 3 },
  ];
  const turns = clusterExcerpts(samples);
  expect(turns.at(-1)).toEqual({ start: 30, end: 30, speaker: -1 });
  expect(numberSpeakers(turns).map(t => t.speaker)).toEqual([1, 2, 1]);
  expect(clusterExcerpts([{ start: 5, end: 5, speaker: 0 }])).toEqual([{ start: 5, end: 5, speaker: -1 }]);
});
