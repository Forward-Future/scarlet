import { expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import type { Timeline, Transcript } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { nameCutRowsByWords } from "./cutRowWords.js";

const said = "okay so the model the model is fast and it is cheap".split(" ");
// One word every half second, from 0 s.
const transcript = { id: "tr_1", segments: [{ start: 0, end: said.length / 2, text: said.join(" "),
  words: said.map((text, i) => ({ text, start: i / 2, end: i / 2 + 0.4 })) }] } as unknown as Transcript;
const ctx = { repos: { projects: { listMedia: () => [{ id: "m1", transcriptId: "tr_1" }] }, transcripts: { get: () => transcript } } } as unknown as Ctx;
// The version before the cuts plays the recording whole.
const before = { tracks: [{ kind: "video", clips: [{ kind: "media", enabled: true, mediaId: "m1", sourceIn: 0, sourceOut: 30, timelineIn: 0 }] }] } as unknown as Timeline;
const edit = (label: string, start: number, end: number, extra: Partial<ThreadEdit> = {}): ThreadEdit =>
  ({ changeId: "chg_pass", spot: start, label, range: { start, end: start }, previous: [], beforeCut: { version: "v0", removed: { start, end } }, ...extra });

it("names a cut saved without a summary by the words beside it, so a pass's rows don't all read the same", () => {
  const rows = nameCutRowsByWords(ctx, "prj_1", [
    edit("Shortened a pause", 0.45, 0.5),
    edit("Cut a false start", 0.5, 1.9),
    edit("Shortened a pause", 4.95, 5),
    // Scarlet's own summary, and an edit that isn't named by its kind, stay as they are.
    edit("Cut the repeat", 0.9, 2.4, { summary: "Cut the repeat" }),
    edit("Punched in on Matt", 3, 4, { beforeCut: undefined }),
    // Footage a video built from the pieces to keep left out, which Scarlet named nothing for: by its words, or the ones before it.
    edit("Cut", 0.95, 2.4),
    edit("Cut", 4.95, 5),
  ], () => before).map(e => e.label);
  expect(rows).toEqual([
    "Shortened the pause after “okay”",
    "Cut a false start: “so the model”",
    "Shortened the pause after “and it”",
    "Cut the repeat",
    "Punched in on Matt",
    "Cut “the model the”",
    "Cut after “and it”",
  ]);
});

it("keeps the row by its kind where there are no words to name it by", () => {
  expect(nameCutRowsByWords(ctx, "prj_2", [edit("Shortened a pause", 40, 41)], () => before)[0]!.label).toBe("Shortened a pause");
});
