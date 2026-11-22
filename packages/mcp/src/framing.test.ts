import { describe, expect, it } from "vitest";
import { applyOps, clipEnd, createProject, emptyTimeline, makeMediaClip, makeTrack, Transform, type MediaAsset, type MediaClip, type Timeline } from "@scarlet/timeline";
import { boxInCorner, frameShown, framingOps, pictureBox, placeFrame, type Box } from "./framing.js";
import { framingReport, moveSize } from "./framing-report.js";

const canvas = { width: 1920, height: 1080 };
const source = { width: 3840, height: 2160 };
const media: MediaAsset[] = [
  { id: "screen", kind: "video", name: "screen", path: "screen.mp4", ...source },
  { id: "camera", kind: "video", name: "camera", path: "camera.mp4", ...source },
  { id: "title", kind: "graphic", name: "title", path: "title.mov", width: 1920, height: 1080, hasAlpha: true },
];
/** The camera in the bottom-right corner, as a pass lays it. */
const inset = Transform.parse({ scale: 0.3, x: 0.326, y: 0.315, cropLeft: 0.105, cropRight: 0.05, cornerRadius: 0.095 });
const contains = (outer: Box, inner: Box, slack = 1e-3) =>
  outer[0] <= inner[0] + slack && outer[1] <= inner[1] + slack && outer[2] >= inner[2] - slack && outer[3] >= inner[3] - slack;
const close = (a: Box, b: Box, slack = 2e-3) => a.every((n, i) => Math.abs(n - b[i]!) <= slack);

/** A screen demo cut into clips at `cuts` (timeline seconds), each jumping a second ahead in its source, with the camera inset over all of it. */
function demo(cuts: number[], end: number): Timeline {
  const tl = emptyTimeline(createProject("Demo").id);
  const upper = makeTrack("video", "Camera", "v2");
  const edges = [0, ...cuts, end];
  edges.slice(0, -1).forEach((start, i) => {
    const length = edges[i + 1]! - start, from = start + i;
    tl.tracks[0]!.clips.push(makeMediaClip("screen", from, from + length, start, { id: `screen_${i}`, volume: 0 }));
    upper.clips.push(makeMediaClip("camera", from, from + length, start, { id: `camera_${i}`, transform: inset }));
  });
  tl.tracks.splice(1, 0, upper);
  return tl;
}
const clip = (tl: Timeline, id: string) => tl.tracks.flatMap(t => t.clips).find(c => c.id === id) as MediaClip;
/** The area of the screen recording on the canvas at a timeline second. */
function shownAt(tl: Timeline, time: number) {
  const playing = tl.tracks[0]!.clips.find(c => c.timelineIn <= time && time < clipEnd(c)) as MediaClip;
  return frameShown(playing, time - playing.timelineIn, source, canvas);
}

describe("placeFrame", () => {
  it("fills the canvas around a tall area instead of leaving bars beside it", () => {
    // The pane a pass cropped to, 0.83:1, which played with background on both sides.
    const pane: Box = [0.355, 0.096, 0.73, 0.9];
    const { frame, hidden, beyondWithin } = placeFrame(pane, undefined, [], 1);
    expect(contains(frame, pane)).toBe(true);
    expect(frame[2] - frame[0]).toBeCloseTo(frame[3] - frame[1], 3);
    expect(frame[3] - frame[1]).toBeCloseTo(0.804, 3);
    expect(contains([0, 0, 1, 1], frame)).toBe(true);
    expect(hidden).toBe(0);
    expect(beyondWithin).toBeUndefined();
  });

  it("keeps the area clear of a picture laid over the canvas", () => {
    const corner = pictureBox({ transform: inset }, 0, source, canvas);
    const chart: Box = [0.3, 0.2, 0.7, 0.8];
    const { frame, hidden } = placeFrame(chart, undefined, [corner], 1);
    expect(hidden).toBe(0);
    // Where the inset sits in the source picture at this frame: none of the chart is under it.
    const fw = frame[2] - frame[0], fh = frame[3] - frame[1];
    const under: Box = [frame[0] + corner[0] * fw, frame[1] + corner[1] * fh, frame[0] + corner[2] * fw, frame[1] + corner[3] * fh];
    expect(under[0] >= chart[2] - 1e-3 || under[1] >= chart[3] - 1e-3).toBe(true);
    expect(contains(frame, chart)).toBe(true);
  });

  it("stays inside the area it may show, and says how far past it a frame had to reach", () => {
    const window: Box = [0.3, 0.05, 0.9, 0.95];
    const inside = placeFrame([0.32, 0.1, 0.6, 0.5], window, [], 1);
    expect(contains(window, inside.frame)).toBe(true);
    expect(inside.beyondWithin).toBeUndefined();
    // A window taller than the canvas's shape can't hold a frame of its full height.
    const tall = placeFrame([0.36, 0.1, 0.72, 0.9], [0.355, 0.096, 0.73, 0.9], [], 1);
    expect(contains(tall.frame, [0.36, 0.1, 0.72, 0.9])).toBe(true);
    expect(tall.beyondWithin!.left).toBeGreaterThan(0.2);
    expect(tall.beyondWithin!.right).toBeGreaterThan(0.2);
    expect(tall.beyondWithin!.top).toBeUndefined();
    // Staying inside the window instead shows its full width and a little over half of the area asked for.
    expect(contains([0.355, 0.096, 0.73, 0.9], tall.insideWithin!.frame)).toBe(true);
    expect(tall.insideWithin!.frame[2] - tall.insideWithin!.frame[0]).toBeCloseTo(0.375, 3);
    expect(tall.insideWithin!.hidden).toBeCloseTo(1 - 0.375 / 0.8, 2);
  });

  it("says how much of an area it could not show", () => {
    const corner = pictureBox({ transform: inset }, 0, source, canvas);
    const all = placeFrame([0, 0, 1, 1], undefined, [corner], 1);
    expect(all.frame).toEqual([0, 0, 1, 1]);
    expect(all.hidden).toBeGreaterThan(0.05);
    expect(all.hidden).toBeLessThan(0.12);
  });

  it("fills an upright canvas from a wide picture", () => {
    const shape = (16 / 9) / (9 / 16);
    const { frame } = placeFrame([0.4, 0.2, 0.6, 0.8], undefined, [], shape);
    expect((frame[2] - frame[0]) * shape).toBeCloseTo(frame[3] - frame[1], 3);
    expect(contains([0, 0, 1, 1], frame)).toBe(true);
  });
});

describe("framingOps", () => {
  it("holds one frame over a whole demo as a crop that fills the canvas", () => {
    const tl = demo([10, 20], 30);
    const pane: Box = [0.355, 0.096, 0.73, 0.9];
    const { ops, frames, clips } = framingOps(tl, media, canvas, [{ at: 0, show: pane, over: 1 }], { mediaId: "screen" });
    expect(clips).toBe(3);
    const made = applyOps(tl, ops);
    for (const id of ["screen_0", "screen_1", "screen_2"]) {
      const framed = clip(made, id);
      expect(framed.keyframes).toEqual([]);
      const on = pictureBox(framed, 0, source, canvas);
      expect(on[0]).toBeLessThanOrEqual(0);
      expect(on[2]).toBeGreaterThanOrEqual(1);
      expect(on[1]).toBeLessThanOrEqual(0);
      expect(on[3]).toBeGreaterThanOrEqual(1);
    }
    expect(frames[0]).toMatchObject({ arrives: "cut", settles: 0, holds: 30, hidden: 0, clipId: "screen_0", sourceTime: 0 });
    expect(frames[0]!.covers).toHaveLength(1);
    expect(contains(shownAt(made, 5)!, pane, 4e-3)).toBe(true);
    // The camera inset is left as it was.
    expect(clip(made, "camera_1")).toEqual(clip(tl, "camera_1"));
  });

  it("eases between frames across the cut that splits a demo into clips", () => {
    const tl = demo([10], 30);
    const wide: Box = [0.1, 0.1, 0.9, 0.9], tight: Box = [0.2, 0.2, 0.45, 0.45];
    const { ops, frames } = framingOps(tl, media, canvas, [{ at: 0, show: wide, over: 1 }, { at: 9.5, show: tight, over: 1 }], { mediaId: "screen" });
    const made = applyOps(tl, ops);
    expect(frames.map(f => f.arrives)).toEqual(["cut", "move"]);
    expect(frames[1]).toMatchObject({ settles: 10.5, holds: 19.5, clipId: "screen_1" });
    expect(clip(made, "screen_0").keyframes).toHaveLength(2);
    // The second clip carries the same move, begun before it starts.
    expect(clip(made, "screen_1").keyframes![0]!.time).toBeCloseTo(-0.5, 4);
    const before = shownAt(made, 9.999)!, after = shownAt(made, 10)!;
    expect(close(before, after)).toBe(true);
    expect(close(shownAt(made, 5)!, frames[0]!.frame, 4e-3)).toBe(true);
    expect(close(shownAt(made, 12)!, frames[1]!.frame, 4e-3)).toBe(true);
    // Halfway through, the frame is between the two and still fills the canvas.
    const mid = shownAt(made, 10)!;
    expect(mid[2] - mid[0]).toBeLessThan(frames[0]!.frame[2] - frames[0]!.frame[0]);
    expect(mid[2] - mid[0]).toBeGreaterThan(frames[1]!.frame[2] - frames[1]!.frame[0]);
  });

  it("cuts to a frame when asked, with nothing of it showing before", () => {
    const tl = demo([], 30);
    const { ops } = framingOps(tl, media, canvas, [{ at: 0, show: [0.1, 0.1, 0.9, 0.9], over: 1 }, { at: 12, show: [0.5, 0.5, 0.8, 0.8], over: 0 }], { mediaId: "screen" });
    const made = applyOps(tl, ops);
    expect(close(shownAt(made, 11.99)!, shownAt(made, 1)!)).toBe(true);
    expect(close(shownAt(made, 12)!, shownAt(made, 20)!)).toBe(true);
    expect(close(shownAt(made, 11.99)!, shownAt(made, 12)!)).toBe(false);
  });

  it("leaves footage outside the stretch as it was, moving on from the frame in place", () => {
    const tl = demo([], 30);
    const first = framingOps(tl, media, canvas, [{ at: 0, show: [0.1, 0.1, 0.9, 0.9], over: 1 }], { mediaId: "screen" });
    const framed = applyOps(tl, first.ops);
    const { ops, frames } = framingOps(framed, media, canvas, [{ at: 10, show: [0.2, 0.2, 0.4, 0.4], over: 1 }], { mediaId: "screen", to: 20 });
    const made = applyOps(framed, ops);
    expect(ops.filter(op => op.op === "splitClip")).toHaveLength(2);
    expect(frames[0]).toMatchObject({ arrives: "move", settles: 11, holds: 9 });
    expect(close(shownAt(made, 5)!, first.frames[0]!.frame, 4e-3)).toBe(true);
    expect(close(shownAt(made, 10)!, first.frames[0]!.frame, 4e-3)).toBe(true);
    expect(close(shownAt(made, 15)!, frames[0]!.frame, 4e-3)).toBe(true);
    expect(close(shownAt(made, 25)!, first.frames[0]!.frame, 4e-3)).toBe(true);
  });

  it("moves the inset to another corner with the frame, and places the frame clear of it there", () => {
    const tl = demo([10], 30);
    const page: Box = [0.3, 0.3, 0.9, 0.9];
    const { ops, frames, insetClips } = framingOps(tl, media, canvas,
      [{ at: 0, show: [0.1, 0.1, 0.5, 0.5], over: 1 }, { at: 9.5, show: page, over: 1, inset: "top-left" }, { at: 20, show: page, over: 0, inset: "bottom-right" }], { mediaId: "screen" });
    const made = applyOps(tl, ops);
    const corner = pictureBox({ transform: inset }, 0, source, canvas), moved = boxInCorner(corner, "top-left");
    expect(moved[0]).toBeCloseTo(1 - corner[2], 4);
    expect(moved[1]).toBeCloseTo(1 - corner[3], 4);
    expect(insetClips).toBe(2);
    const camera = (time: number) => {
      const playing = made.tracks[1]!.clips.find(c => c.timelineIn <= time && time < clipEnd(c)) as MediaClip;
      return pictureBox(playing, time - playing.timelineIn, source, canvas);
    };
    // It stays put until the move starts, travels through the cut, and is in the new corner once the frame settles.
    expect(close(camera(5) as Box, corner)).toBe(true);
    expect(close(camera(9.999) as Box, camera(10) as Box)).toBe(true);
    expect(camera(10)[0]).toBeLessThan(corner[0]);
    expect(close(camera(15) as Box, moved)).toBe(true);
    // Back on a cut, with nothing of the old corner after it.
    expect(close(camera(19.99) as Box, moved)).toBe(true);
    expect(close(camera(20) as Box, corner)).toBe(true);
    // The frame keeps the page clear of the inset where it now is.
    expect(frames[1]!.covers.map(c => close(c, moved))).toEqual([true]);
    expect(frames[1]!.hidden).toBe(0);
    expect(frames[2]!.covers.map(c => close(c, corner))).toEqual([true]);
    // The size, crop and rounded corners of the inset are as they were.
    expect(made.tracks[1]!.clips.every(c => c.kind === "media" && c.transform!.scale === 0.3 && c.transform!.cornerRadius === 0.095)).toBe(true);
  });

  it("leaves the inset alone when no framing moves it", () => {
    const tl = demo([10], 30);
    const { ops, insetClips } = framingOps(tl, media, canvas, [{ at: 0, show: [0.1, 0.1, 0.5, 0.5], over: 1 }], { mediaId: "screen" });
    expect(insetClips).toBe(0);
    expect(applyOps(tl, ops).tracks[1]).toEqual(tl.tracks[1]);
  });

  it("doesn't take a graphic for a cover, and says when the recording is under another picture", () => {
    const tl = demo([], 30);
    const top = makeTrack("video", "Titles", "v3");
    top.clips.push(makeMediaClip("title", 0, 4, 2, { id: "title_0" }));
    tl.tracks.splice(2, 0, top);
    // The camera fills the frame from 20 s on.
    const camera = clip(tl, "camera_0");
    const full = applyOps(tl, [{ op: "splitClip", clipId: camera.id, at: 20, newClipId: "camera_full" }, { op: "updateClip", clipId: "camera_full", patch: { transform: Transform.parse({}) } }]);
    const { frames } = framingOps(full, media, canvas, [{ at: 0, show: [0.2, 0.2, 0.6, 0.6], over: 1 }, { at: 21, show: [0.3, 0.3, 0.6, 0.6], over: 0 }], { mediaId: "screen" });
    expect(frames[0]!.covers).toHaveLength(1);
    expect(frames[0]!.notOnPicture).toBeUndefined();
    expect(frames[1]!.notOnPicture).toBe(true);
  });

  it("names every framing that falls where the recording doesn't play", () => {
    const tl = demo([], 30);
    expect(() => framingOps(tl, media, canvas, [{ at: 40, show: [0, 0, 1, 1], over: 1 }, { at: 50, show: [0.5, 0, 0.4, 1], over: 1 }], { mediaId: "screen" }))
      .toThrow(/framings\[1\]\.show needs right greater than left.*framings\[0\]\.at 40 s: screen doesn't play there.*framings\[1\]\.at 50 s/s);
    expect(() => framingOps(tl, media, canvas, [{ at: 1, show: [0, 0, 1, 1], over: 1 }], { mediaId: "nope" })).toThrow("not a picture in this project");
  });

  it("places a frame without crashing when two overlays occupy opposite corners", () => {
    const covers: Box[] = [[0, 0, 0.25, 0.25], [0.75, 0.75, 1, 1]];
    const placed = placeFrame([0.3, 0.3, 0.7, 0.7], undefined, covers, 1);
    expect(placed.hidden).toBe(0);
    expect(contains(placed.frame, [0.3, 0.3, 0.7, 0.7])).toBe(true);
  });

  it("samples keyframes in timeline-local time rather than multiplying by clip speed", () => {
    const tl = emptyTimeline(createProject("Speed").id);
    // A 10s timeline clip at 2x speed (20s of source) with a 1s zoom from timeline-local 7s to 8s.
    tl.tracks[0]!.clips.push(makeMediaClip("screen", 0, 20, 0, {
      id: "fast",
      speed: 2,
      keyframes: [
        { time: 0, transform: Transform.parse({ scale: 1 }) },
        { time: 7, transform: Transform.parse({ scale: 1 }) },
        { time: 8, transform: Transform.parse({ scale: 2 }) },
        { time: 10, transform: Transform.parse({ scale: 2 }) },
      ],
    }));
    const stretches = framingReport(null, tl, media, canvas);
    expect(stretches).toHaveLength(1);
    // Timeline-local sampling places the move at 7..8s rather than speed-multiplied 3.5..4s.
    expect(stretches[0]!.moves).toHaveLength(1);
    expect(stretches[0]!.moves[0]!.from).toBeCloseTo(7, 0);
    expect(stretches[0]!.moves[0]!.to).toBeCloseTo(8, 0);
  });
});

describe("moveSize", () => {
  it("says how much a move zooms and shifts, so a barely-there reframe shows as one", () => {
    // The Benchmarks table, reframed across a jump cut from 71% of the width to 70%: a 1.4% zoom the viewer barely sees.
    expect(moveSize([10, 5, 81, 76], [11, 5.5, 81, 75.5])).toEqual({ zoom: 1.4, shift: 0.7 });
    expect(moveSize([0, 0, 100, 100], [25, 25, 75, 75])).toEqual({ zoom: 100, shift: 0 });
    expect(moveSize([25, 25, 75, 75], [0, 0, 100, 100])).toEqual({ zoom: -50, shift: 0 });
    expect(moveSize([], [0, 0, 100, 100])).toEqual({});
  });
});
