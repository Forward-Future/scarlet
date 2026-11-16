import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, makeMediaClip, type MediaClip, type Project, type Timeline, type Transition } from "@scarlet/timeline";
import { buildFilterGraph, runCapture, segmentKey } from "./index.js";
import { planTransitions } from "./transitions.js";

let dir: string;
const size = 64 * 64 * 3;
const project: Project = createProject("Joins", { width: 64, height: 64, fps: 30, aspect: "custom" });
const movie = (id: string) => ({ id, kind: "video" as const, name: id, path: `${id}.mp4`, duration: 4, fps: 30, width: 64, height: 64, hasAudio: false, hasAlpha: false });
const edit = (clips: MediaClip[]): Timeline => ({ version: "draft", parent: null, projectId: project.id, name: "Main", background: "#000000", markers: [],
  tracks: [{ id: "video", kind: "video", name: "video", muted: false, hidden: false, clips }] });
/** Red from 0 to 2 s, then blue to 4 s, from the middle of each source so both have footage to spare. */
const join = (transition?: Transition, blueIn = 1) => edit([
  makeMediaClip("red", 1, 3, 0, { id: "red-clip" }),
  makeMediaClip("blue", blueIn, blueIn + 2, 2, { id: "blue-clip", transitionIn: transition }),
]);

/** Every frame of the range as raw RGB, composited as a render composites it. */
async function pictures(timeline: Timeline, range: { start: number; end: number }) {
  const graph = await buildFilterGraph(project, timeline, range, { mediaRoot: dir, pictureOnly: true });
  try {
    const { stdout } = await runCapture("ffmpeg", ["-v", "error", ...graph.args, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    return Array.from({ length: stdout.length / size }, (_, frame) => stdout.subarray(frame * size, (frame + 1) * size));
  } finally { await graph.cleanup(); }
}
/** The colour at a point of a frame: r(ed), b(lue), m (a mix of the two), . (black) or ?. */
const at = (frame: Buffer, x: number, y = 32) => {
  const [r, , b] = frame.subarray((y * 64 + x) * 3);
  return r! > 200 && b! < 60 ? "r" : b! > 200 && r! < 60 ? "b" : r! > 70 && b! > 70 ? "m" : r! < 30 && b! < 30 ? "." : "?";
};
const frameAt = async (timeline: Timeline, t: number) => (await pictures(timeline, { start: t, end: t + 1 / 30 }))[0]!;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-transitions-"));
  for (const colour of ["red", "blue"]) {
    await runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=64x64:r=30:d=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, `${colour}.mp4`)]);
  }
  project.media = [movie("red"), movie("blue")];
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("transitions", () => {
  it("pushes the next picture in from the right across the join, with both pictures on screen at the join", async () => {
    const timeline = join({ type: "push", duration: 1, direction: "left" });
    // Before the transition, red alone; after it, blue alone.
    expect(at(await frameAt(timeline, 1.2), 32)).toBe("r");
    expect(at(await frameAt(timeline, 2.8), 32)).toBe("b");
    // Halfway, at the join: red has gone halfway off to the left and blue has come halfway in from the right.
    const middle = await frameAt(timeline, 2);
    expect([at(middle, 8), at(middle, 56)]).toEqual(["r", "b"]);
    // Pushed right, it is the other way round.
    const right = await frameAt(join({ type: "push", duration: 1, direction: "right" }), 2);
    expect([at(right, 8), at(right, 56)]).toEqual(["b", "r"]);
  });

  it("dissolves one picture into the other and dips through black, and leaves the cut straight without one", async () => {
    expect(at(await frameAt(join({ type: "dissolve", duration: 1, direction: "left" }), 2), 32)).toBe("m");
    const dip = join({ type: "dip", duration: 1, direction: "left" });
    expect(at(await frameAt(dip, 1.98), 32)).toBe(".");
    // Halfway into the dip the red channel is about half-bright. Allow for rounding to a video frame.
    const middle = (32 * 64 + 32) * 3;
    const [red, green, blue] = (await frameAt(dip, 1.75)).subarray(middle, middle + 3);
    expect(red).toBeGreaterThan(95);
    expect(red).toBeLessThan(160);
    expect(Math.max(green!, blue!)).toBeLessThan(15);
    expect(at(await frameAt(join(), 1.98), 32)).toBe("r");
    expect(at(await frameAt(join(), 2), 32)).toBe("b");
  });

  it("runs shorter on the side whose clip has no footage before the join, and says so", async () => {
    // Blue starts at the very top of its source, so the push can only start at the join.
    const timeline = join({ type: "push", duration: 1, direction: "left" }, 0);
    const plan = planTransitions(timeline, new Map(project.media.map(m => [m.id, m])), 30);
    expect(plan.joins).toEqual([expect.objectContaining({ clipId: "blue-clip", at: 2, start: 2, end: 2.5,
      note: expect.stringMatching(/Only 0 s of the next clip's footage before the join and 0\.5 s of the last one's after it, so it runs 0\.5 s/) })]);
    expect(at(await frameAt(timeline, 1.9), 32)).toBe("r");
    const middle = await frameAt(timeline, 2.25);
    expect([at(middle, 8), at(middle, 56)]).toEqual(["r", "b"]);
  });

  it("keeps the join's sound as it was: the layers it adds are picture only", async () => {
    const plan = planTransitions(join({ type: "whip", duration: 0.6, direction: "left" }), new Map(project.media.map(m => [m.id, m])), 30);
    const layers = plan.timeline.tracks[0]!.clips;
    expect(layers.map(c => c.id)).toEqual(["red-clip", "red-clip~transition-out", "blue-clip~transition-in", "blue-clip"]);
    expect(layers.filter(c => plan.layers.has(c.id)).map(c => c.kind === "media" && [c.volume, c.timelineIn, c.sourceIn, c.sourceOut]))
      .toEqual([[0, 2, 3, 3.3], [0, 1.7, 0.7, 1]]);
  });

  it("draws the same frames whether the join's sections are rendered apart or together", async () => {
    for (const type of ["dissolve", "push", "dip", "whip"] as const) {
      const timeline = join({ type, duration: 1, direction: "left" });
      const whole = await pictures(timeline, { start: 1, end: 3 });
      const parts = [...await pictures(timeline, { start: 1, end: 2 }), ...await pictures(timeline, { start: 2, end: 3 })];
      expect(parts.length).toBe(whole.length);
      const differs = parts.map((frame, i) => frame.reduce((most, v, k) => Math.max(most, Math.abs(v - whole[i]![k]!)), 0));
      expect(Math.max(...differs), type).toBeLessThanOrEqual(3);
    }
  });

  it("moves from a colour card that ends at the join, wherever the card is stored on the track", async () => {
    const card = { id: "card", kind: "color" as const, color: "#ff0000", timelineIn: 0, timelineOut: 2, enabled: true, opacity: 1 };
    const blue = makeMediaClip("blue", 1, 3, 2, { id: "blue-clip", transitionIn: { type: "push", duration: 1, direction: "left" } });
    for (const clips of [[card, blue], [blue, card]]) {
      const timeline: Timeline = { ...edit([]), tracks: [{ id: "video", kind: "video", name: "video", muted: false, hidden: false, clips }] };
      const plan = planTransitions(timeline, new Map(project.media.map(m => [m.id, m])), 30);
      expect(plan.joins).toEqual([expect.objectContaining({ clipId: "blue-clip", start: 1.5, end: 2.5, note: undefined })]);
      expect(plan.motions.get("card")).toEqual([expect.objectContaining({ role: "out", type: "push" })]);
      // The card is pushed off to the left as the clip comes in from the right.
      const middle = await frameAt(timeline, 2);
      expect([at(middle, 8), at(middle, 56)]).toEqual(["r", "b"]);
    }
    const dip = { ...edit([]), tracks: [{ id: "video", kind: "video" as const, name: "video", muted: false, hidden: false,
      clips: [card, { ...blue, transitionIn: { type: "dip" as const, duration: 1, direction: "left" as const } }] }] };
    expect(planTransitions(dip, new Map(project.media.map(m => [m.id, m])), 30).joins[0]!.note).toBeUndefined();
    expect(at(await frameAt(dip, 1.98), 32)).toBe(".");
  });

  it("changes the key of the sections it touches and no others", () => {
    const plain = join(), pushed = join({ type: "push", duration: 1, direction: "left" });
    const key = (timeline: Timeline, start: number, end: number) => segmentKey(project, timeline, { start, end }, "preview");
    expect(key(pushed, 0, 1)).toBe(key(plain, 0, 1));
    expect(key(pushed, 3, 4)).toBe(key(plain, 3, 4));
    expect(key(pushed, 1, 2)).not.toBe(key(plain, 1, 2));
    expect(key(pushed, 2, 3)).not.toBe(key(plain, 2, 3));
  });
});
