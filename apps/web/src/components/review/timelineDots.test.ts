// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { bandLabel, gapLabel, layoutMarks, nearestMark, type TimelineDot } from "./TimelineScrubber";

const dot = (time: number, n: number): TimelineDot => ({ time, n, title: `Edit ${n}` });
const shapes = (layout: ReturnType<typeof layoutMarks>) => layout.map(m => `${m.label}${m.quiet ? "|" : ""}`);

describe("layoutMarks", () => {
  // 100 s across 1000 px: 1 s is 10 px, and a numbered circle needs 20 px to its neighbour.
  const marks = [dot(10, 1), dot(11, 2), dot(12, 3), dot(50, 4), dot(90, 5), dot(90.5, 6)];

  it("shares one pill between edits whose circles would touch, and gives an edit with room its own circle", () => {
    const layout = layoutMarks(marks, 0, 100, 1000);
    expect(shapes(layout)).toEqual(["1–3", "4", "5–6"]);
    // The pill sits over the middle of its run and stands for every edit in it.
    expect(layout[0]).toMatchObject({ time: 10, times: [10, 11, 12], at: 11 });
  });

  it("gives each edit its circle once zoomed in far enough", () => {
    expect(shapes(layoutMarks(marks, 9, 4, 1000))).toEqual(["1", "2", "3"]);
  });

  it("reaches back when sharing widens a pill into the marker before it", () => {
    // 1 and 2 have room for two circles. 3 joins 2, and their wider pill no longer clears 1.
    expect(shapes(layoutMarks([dot(10, 1), dot(12, 2)], 0, 100, 1000))).toEqual(["1", "2"]);
    expect(shapes(layoutMarks([dot(10, 1), dot(12, 2), dot(12.5, 3)], 0, 100, 1000))).toEqual(["1–3"]);
  });

  it("shows the lowest number and a plus when the edits sharing a pill skip numbers", () => {
    expect(shapes(layoutMarks([dot(10, 4), dot(10.5, 9)], 0, 100, 1000))).toEqual(["4+"]);
  });

  it("shares one marker between edits on the same frame", () => {
    expect(shapes(layoutMarks([dot(10, 4), dot(10, 5), dot(30, 9), dot(30, 7)], 0, 100, 1000))).toEqual(["4–5", "7+"]);
  });

  it("keeps duplicates and unnumbered calls out of contiguous number ranges", () => {
    const shared = [dot(10, 5), dot(10.1, 3), dot(10.2, 3), dot(10.3, 6)];
    expect(shapes(layoutMarks(shared, 0, 100, 1000))).toEqual(["3+"]);
    expect(shapes(layoutMarks([dot(10, 1), { time: 10.01, title: "Call" }], 0, 100, 1000))).toEqual(["1+"]);
  });

  it("leaves a settled edit as a faint tick that joins no pill and takes no room", () => {
    const settled = { ...dot(10.2, 1), quiet: true };
    expect(shapes(layoutMarks([dot(10, 2), settled, dot(40, 3)], 0, 100, 1000))).toEqual(["2", "1|", "3"]);
    expect(shapes(layoutMarks([{ ...dot(10, 1), quiet: true }, { ...dot(10.4, 2), quiet: true }], 0, 100, 1000))).toEqual(["1|", "2|"]);
  });

  it("never puts a call's number and an edit's in one pill, though their circles would touch", () => {
    // Calls 1 and 2 sit a second and a half apart, with an edit numbered 1 between them. The two calls share a pill;
    // the edit keeps its own circle.
    const call = (time: number, n: number): TimelineDot => ({ ...dot(time, n), group: "call" });
    const layout = layoutMarks([call(10, 1), dot(11, 1), call(11.5, 2), dot(50, 2)], 0, 100, 1000);
    expect(layout.map(m => [m.label, m.dots.map(d => d.group ?? "edit")])).toEqual([["1–2", ["call", "call"]], ["1", ["edit"]], ["2", ["edit"]]]);
    // On the same frame too, and each marker has its own name.
    const same = layoutMarks([call(10, 3), dot(10, 4)], 0, 100, 1000);
    expect(same.map(m => m.label)).toEqual(["3", "4"]);
    expect(new Set(same.map(m => m.key)).size).toBe(2);
  });

  it("draws circles before the track is measured", () => {
    expect(shapes(layoutMarks(marks.slice(0, 2), 0, 100, 0))).toEqual(["1", "2"]);
  });
});

describe("nearestMark", () => {
  const layout = layoutMarks([dot(10, 1), dot(11, 2), dot(50, 3)], 0, 100, 1000);

  it("picks the pill anywhere along the crowded run it stands for", () => {
    expect(nearestMark(layout, 10.1, 1000)?.label).toBe("1–2");
    expect(nearestMark(layout, 11.2, 1000)?.label).toBe("1–2");
  });

  it("picks nothing far from every edit", () => {
    expect(nearestMark(layout, 30, 1000)).toBeUndefined();
    expect(nearestMark(layout, 52, 1000)?.label).toBe("3");
  });

  it("picks the circle drawn under the pointer, though a settled cut's tick inside it is nearer", () => {
    // Edit 7's circle spans 91.5 to 108.5 px. Settled edit 8's tick takes no room, so it sits inside the circle at 103 px.
    const crowded = layoutMarks([dot(10, 7), { ...dot(10.3, 8), quiet: true }], 0, 100, 1000);
    expect(shapes(crowded)).toEqual(["7", "8|"]);
    expect([10, 10.2, 10.3, 10.5, 10.7].map(at => nearestMark(crowded, at, 1000)?.label)).toEqual(["7", "7", "7", "7", "7"]);
    // Past the circle's edge the tick is the nearer marker again.
    expect(nearestMark(crowded, 10.9, 1000)?.label).toBe("8");
  });
});

describe("gapLabel", () => {
  const gap = { label: "Cut at 12:05", shortLabel: "12:05" };

  it("names the cut in full where the gap has room", () => {
    expect(gapLabel(gap, 200)).toBe("Cut at 12:05");
  });

  it("falls back to the cut's time on a narrow gap, so the tag isn't cut off", () => {
    expect(gapLabel(gap, 85)).toBe("12:05");
  });

  it("draws no label on a gap too narrow for even the time, rather than one cut off mid-word", () => {
    expect(gapLabel(gap, 43)).toBe("12:05");
    expect(gapLabel(gap, 24)).toBe("");
  });

  it("keeps the full label before the track is measured, or without a short one", () => {
    expect(gapLabel(gap, 0)).toBe("Cut at 12:05");
    expect(gapLabel({ label: "Cut at 12:05" }, 40)).toBe("Cut at 12:05");
  });
});

describe("bandLabel", () => {
  it("keeps the open edit's label whole while it fits its band, then just the amount, then nothing", () => {
    expect(bandLabel("Removed · 7.2 s", 320)).toBe("Removed · 7.2 s");
    // A one-second cut zoomed with five seconds either side is a band a few dozen pixels wide.
    expect(bandLabel("Removed · 1.4 s", 60)).toBe("1.4 s");
    expect(bandLabel("Removed · 0.5 s", 30)).toBe("");
    // A label with no amount is whole or absent, never cut off mid-word.
    expect(bandLabel("Audio", 60)).toBe("Audio");
    expect(bandLabel("Audio", 20)).toBe("");
    // Before the track is measured there is nothing to fit it to.
    expect(bandLabel("Removed · 1.4 s", 0)).toBe("Removed · 1.4 s");
  });
});
