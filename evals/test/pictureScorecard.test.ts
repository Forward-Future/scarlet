import { describe, expect, it } from "vitest";
import type { MediaClip, Timeline } from "../../packages/timeline/src/index.ts";
import { checkSentences, flashes, layoutRuns, pictureCard, pictureFactors, pictureMarkdown } from "../src/pictureScorecard.ts";
import { checkLabel, exampleOrder, keptWords, screensOf, screensShown, sentences, type TalkedFile } from "../src/talkedAbout.ts";

type Transform = { x?: number; y?: number; scale?: number; cropLeft?: number; cropRight?: number; cropTop?: number; cropBottom?: number };
function clip(id: string, mediaId: string, timelineIn: number, sourceIn: number, sourceOut: number, transform?: Transform): MediaClip {
  return { id, kind: "media", mediaId, timelineIn, sourceIn, sourceOut, speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0,
    videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true, ...(transform && { transform }) } as MediaClip;
}

const BOTTOM_RIGHT = { x: 0.33, y: 0.33, scale: 0.3 }, TOP_LEFT = { x: -0.33, y: -0.33, scale: 0.3 };
/**
 * A cut of a presenter (`cam`) and a screen recording (`screen`) in stretches of one layout each, the screen running
 * 2 s behind the camera. The camera track sits over the screen track, as Scarlet builds it.
 */
function cut(stretches: Array<[layout: "camera" | "inset" | "screen", seconds: number, look?: Transform]>, screenLook?: Transform): Timeline {
  const camera: MediaClip[] = [], screen: MediaClip[] = [];
  let at = 0;
  stretches.forEach(([layout, seconds, look], i) => {
    if (layout !== "camera") screen.push(clip(`s${i}`, "screen", at, at - 2 < 0 ? 0 : at - 2, at - 2 + seconds, screenLook));
    if (layout !== "screen") camera.push(clip(`c${i}`, "cam", at, at, at + seconds, layout === "inset" ? look ?? BOTTOM_RIGHT : undefined));
    at += seconds;
  });
  return { version: "v", parent: null, projectId: "prj", name: "Main", markers: [], background: "#000000", tracks: [
    { id: "screen", kind: "video", name: "Screen", muted: false, hidden: false, clips: screen },
    { id: "cam", kind: "video", name: "Camera", muted: false, hidden: false, clips: camera },
    { id: "voice", kind: "audio", name: "Voice", muted: false, hidden: false, clips: [clip("v", "cam", 0, 0, at)] },
  ] } as unknown as Timeline;
}

/** Two sentences marked: the first about the bottom right of the screen, the second about its top left. */
const marks: TalkedFile = { schema: 1, project: "prj", camera: "cam", screen: "screen", offset: -2, labels: [
  { from: 22, to: 26, text: "Here is the score in the corner.", boxes: [{ left: 0.7, top: 0.7, right: 0.95, bottom: 0.95 }], at: "" },
  { from: 32, to: 36, text: "And the title up top.", boxes: [{ left: 0.05, top: 0.05, right: 0.4, bottom: 0.2 }], at: "" },
  { from: 50, to: 52, text: "Thanks for watching.", boxes: [], none: true, at: "" },
] };

describe("the picture scorecard", () => {
  it("scores a marked sentence by how much of it the camera leaves in view, and a placement that keeps every mark clear at 100%", () => {
    const inCorner = cut([["camera", 20], ["inset", 20], ["camera", 20]]);
    expect(checkSentences(inCorner, marks).map(s => [s.seen, s.underCamera])).toEqual([[0, 1], [1, 0]]);
    const moved = cut([["camera", 20], ["inset", 10, TOP_LEFT], ["inset", 10, BOTTOM_RIGHT], ["camera", 20]]);
    expect(checkSentences(moved, marks).map(s => s.seen)).toEqual([1, 1]);
    const f = pictureFactors(inCorner, "cam", marks);
    expect(f.clearOfTalk).toEqual({ pct: 50, detail: "on average 50% of the main thing is on screen over 2 marked sentences (the camera hides 50%, zooms and crops cut off 0%); least at 0:22 0%" });
    expect(f.shownWhileTalked.pct).toBe(100);
    // Half the mark under the camera is half a sentence's score.
    const half = cut([["camera", 20], ["inset", 20, { x: 0.33, y: 0.33, scale: 0.3 }], ["camera", 20]]);
    const halfMarks: TalkedFile = { ...marks, labels: [{ ...marks.labels[0]!, boxes: [{ left: 0.58, top: 0.7, right: 0.78, bottom: 0.9 }] }] };
    expect(checkSentences(half, halfMarks)[0]!.seen).toBeCloseTo(0.5, 5);
  });

  it("scores a zoom by how much of a mark it keeps, and counts a sentence said over the camera alone as off picture", () => {
    // A 2× zoom shows the middle half of the screen: a corner of the first mark, none of the second.
    const zoomed = checkSentences(cut([["camera", 20], ["screen", 20], ["camera", 20]], { scale: 2 }), marks);
    expect(zoomed[0]!.seen).toBeCloseTo(0.04, 5);
    expect(zoomed[1]!.seen).toBe(0);
    expect(zoomed[1]!.cutOff).toBe(1);
    const cameraOnly = pictureFactors(cut([["camera", 60]]), "cam", marks);
    expect(cameraOnly.shownWhileTalked).toEqual({ pct: 0, detail: "0 of 2 marked sentences play with the screen on picture (off at 0:22, 0:32)" });
    expect(cameraOnly.clearOfTalk.pct).toBeNull();
  });

  it("lets a zoom cut off the wider view and only reports the camera over it", () => {
    const withWider: TalkedFile = { ...marks, labels: [{ ...marks.labels[0]!, boxes: [
      { left: 0.7, top: 0.7, right: 0.95, bottom: 0.95 }, { left: 0.3, top: 0.3, right: 1, bottom: 1, wider: true }] }] };
    // A zoom that keeps the main thing whole but cuts off most of the wider view.
    const zoomed = cut([["camera", 20], ["screen", 20], ["camera", 20]], { scale: 2, x: -0.5, y: -0.5 });
    expect(checkSentences(zoomed, withWider).map(s => s.seen)).toEqual([1]);
    // The camera at top left is clear of the main thing and sits over the wider view.
    const topLeft = cut([["camera", 20], ["inset", 20, { x: -0.1, y: -0.1, scale: 0.5 }], ["camera", 20]]);
    const [check] = checkSentences(topLeft, withWider);
    expect([check!.seen, check!.widerCovered]).toEqual([1, true]);
    expect(pictureFactors(topLeft, "cam", withWider).clearOfTalk.detail).toMatch(/camera sits over the wider view in 1 \(0:22\), not counted/);
  });

  it("counts a screen shown while you said it mustn't be", () => {
    const backstage: TalkedFile = { ...marks, labels: [{ from: 5, to: 8, text: "Notes up.", boxes: [], hide: true, at: "" }, { from: 25, to: 28, text: "Script.", boxes: [], hide: true, at: "" }] };
    const f = pictureFactors(cut([["camera", 20], ["inset", 20], ["camera", 20]]), "cam", backstage);
    expect(f.keptOff).toEqual({ pct: 50, detail: '1 of 2 sentences marked "don\'t show the screen" keep it off (shown at 0:25)' });
  });

  it("finds a layout flashed between two others", () => {
    const flashing = cut([["camera", 20], ["screen", 1], ["camera", 19], ["inset", 20]]);
    expect(layoutRuns(flashing, "cam").map(r => [r.layout, Math.round(r.seconds)])).toEqual([["camera", 20], ["screen", 1], ["camera", 19], ["inset", 20]]);
    expect(flashes(flashing, "cam").map(f => [f.layout, f.start])).toEqual([["screen", 20]]);
  });

  it("adds a ± once a recording has two cuts", () => {
    const passes = [cut([["camera", 20], ["inset", 20], ["camera", 20]]), cut([["camera", 20], ["inset", 20, TOP_LEFT], ["camera", 20]])]
      .map(tl => ({ caseId: "neon", factors: pictureFactors(tl, "cam", marks) }));
    const card = pictureCard("main", passes);
    expect(card.factors.clearOfTalk?.mean).toBe(55.7); // 50% and 61.4%: the camera at top left hides 77% of the title
    expect(pictureMarkdown([card])).toMatch(/\| Clear of what you talk about \| 55.7% ±\d/);
  });
});

describe("marking what you talk about", () => {
  it("cuts the words into sentences at a full stop or a pause, folds in scraps, and splits a long run at its longest pause", () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end });
    expect(sentences([w("Hi", 0, 0.3), w("there.", 0.35, 1.2), w("so", 1.3, 1.5), w("this", 2.4, 2.7), w("works", 2.8, 3.6)]).map(s => s.text)).toEqual(["Hi there.", "so this works"]);
    const long = Array.from({ length: 30 }, (_, i) => w("word", i * 0.5, i * 0.5 + 0.45));
    long[14] = w("word", 7, 7.2);
    expect(sentences(long).map(s => s.to - s.from).every(d => d <= 12)).toBe(true);
  });

  it("offers only the words the cut plays, and never runs a sentence across a cut", () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end });
    const said = [w("so", 0, 0.3), w("the", 0.35, 0.5), w("uh", 0.55, 0.7), w("score", 0.75, 1), w("is", 1.05, 1.2), w("61", 1.25, 1.5)];
    // The cut takes out "uh" and runs the clip after it in two pieces with no gap.
    const kept = keptWords(said, [{ sourceIn: 0, sourceOut: 0.52 }, { sourceIn: 0.72, sourceOut: 1.1 }, { sourceIn: 1.1, sourceOut: 2 }]);
    expect(kept.map(k => k.text)).toEqual(["so", "the", "score", "is", "61"]);
    expect(sentences(kept).map(s => s.text)).toEqual(["so the", "score is 61"]);
  });

  it("tells one screen from the next, but not a pointer moving on it", () => {
    const page = new Uint8Array(48 * 27).fill(200), pointer = page.slice(), other = new Uint8Array(48 * 27).fill(40);
    pointer.fill(0, 100, 104);
    expect(screensOf([page, pointer, page, other, other, page])).toEqual([0, 0, 0, 1, 1, 2]);
  });

  it("leaves out a screen the video never shows", () => {
    const video = cut([["camera", 20], ["inset", 20], ["camera", 20]]);
    const said = [{ from: 5, to: 8, text: "my notes", screen: 0 }, { from: 22, to: 26, text: "the score", screen: 1 }, { from: 45, to: 48, text: "the score again", screen: 1 }];
    expect([...screensShown(video, "cam", "screen", said)]).toEqual([1]);
  });

  it("asks about the most different screens first, one a screen, then comes back for more", () => {
    const pic = (v: number) => new Uint8Array(48 * 27).fill(v);
    const said = [0, 0, 0, 0, 1, 2, 2].map((screen, k) => ({ from: k * 30, to: k * 30 + 4 + (k === 2 ? 3 : 0), text: `s${k}`, screen }));
    const pictures = [pic(100), pic(100), pic(100), pic(100), pic(110), pic(250), pic(250)];
    const order = exampleOrder(said, pictures);
    // Screen 0 has the most said over it and its longest sentence leads; then the screen least like it (2), then 1.
    expect(order.map(o => o.index)).toEqual([2, 5, 4, 0, 6, 1, 3]);
    expect(order.map(o => o.round)).toEqual([1, 1, 1, 2, 2, 3, 4]);
  });

  it("keeps a mark inside the picture and refuses boxes with nothing on screen", () => {
    expect(checkLabel({ from: 1, to: 2, text: "x", boxes: [{ left: 0.1, top: 0.1, right: 0.4, bottom: 0.3 }] }).boxes).toHaveLength(1);
    expect(() => checkLabel({ from: 1, to: 2, text: "x", boxes: [{ left: 0.1, top: 0.1, right: 1.4, bottom: 0.3 }] })).toThrow("bad box");
    expect(() => checkLabel({ from: 1, to: 2, text: "x", none: true, boxes: [{ left: 0.1, top: 0.1, right: 0.4, bottom: 0.3 }] })).toThrow();
    expect(() => checkLabel({ from: 1, to: 2, text: "x", hide: true, none: true, boxes: [] })).toThrow();
    expect(checkLabel({ from: 1, to: 2, text: "x", hide: true, boxes: [] })).toMatchObject({ hide: true });
    expect(() => checkLabel({ from: 1, to: 2, text: "x", boxes: [{ left: 0.1, top: 0.1, right: 0.4, bottom: 0.3, wider: true }] })).toThrow("main thing");
    expect(checkLabel({ from: 1, to: 2, text: "x", boxes: [{ left: 0.2, top: 0.2, right: 0.3, bottom: 0.3 }, { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4, wider: true }] }).boxes[1]).toMatchObject({ wider: true });
  });
});
