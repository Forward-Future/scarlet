import { expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import type { JoinPage } from "./dialogue-join.js";
import { resolveOutgoingPause } from "./outgoing-pause.js";

const project = createProject("Interview", { fps: 30 });
project.media = [{ id: "mic", name: "Mic", kind: "audio", path: "mic.wav" }];
const timeline = emptyTimeline(project.id);
timeline.tracks[1]!.clips = [makeMediaClip("mic", 0, 20, 0)];
function page(start: number, end: number, wordEnd = 1.01): JoinPage {
  return { mediaId: "mic", start, end, edges: { words: start < wordEnd ? [{ text: "finished", start: .5, end: wordEnd }] : [],
    quiet: [], valleys: [], voice: [{ start, end }], levels: { from: start, step: .02, db: Array(Math.round((end - start) / .02)).fill(-60) } } };
}

it("keeps the last syllable, honors a requested hold, and spans multiple readings in a long pause", () => {
  const pages = [page(0, 3), page(2.8, 8)];
  const result = resolveOutgoingPause(timeline, project, { start: 7, end: 10 }, pages, .2);
  expect(result).toMatchObject({ status: "moved", start: 37 / 30, end: 10, word: { text: "finished" } });
  expect(resolveOutgoingPause(timeline, project, { start: 37 / 30, end: 10 }, pages, .2)).toMatchObject({ status: "already-at-target" });
});

it("leaves a cut for inspection when a word straddles it, audio is missing, or another sound fills the pause", () => {
  const range = { start: 2, end: 3 };
  expect(resolveOutgoingPause(timeline, project, range, [page(0, 3, 2.3)])).toMatchObject({ status: "unavailable" });
  expect(resolveOutgoingPause(timeline, project, range, [page(0, 1.3)])).toMatchObject({ status: "unavailable" });
  const noisy = page(0, 3);
  noisy.edges!.levels!.db.fill(-15, 75, 85);
  expect(resolveOutgoingPause(timeline, project, range, [noisy])).toMatchObject({ status: "unavailable" });
});

it("checks audio layers that end within the pause and sound spanning two waveform pages", () => {
  const tl = structuredClone(timeline);
  const layered = structuredClone(project);
  layered.media.push({ id: "layer", name: "Second mic", kind: "audio", path: "second.wav" });
  tl.tracks[1]!.clips.push(makeMediaClip("layer", 0, 1, 2));
  const layer: JoinPage = { ...page(0, 1), mediaId: "layer" };
  layer.edges!.words = [];
  const first = page(0, 3), next = page(2.5, 6);
  const range = { start: 5, end: 6 };
  expect(resolveOutgoingPause(tl, layered, range, [first, next])).toMatchObject({ status: "unavailable" });
  expect(resolveOutgoingPause(tl, layered, range, [first, next, layer])).toMatchObject({ status: "moved" });
  first.edges!.levels!.db.fill(-15, 147);
  next.edges!.levels!.db.fill(-15, 22, 28);
  expect(resolveOutgoingPause(tl, layered, range, [first, next, layer])).toMatchObject({ status: "unavailable" });
});
